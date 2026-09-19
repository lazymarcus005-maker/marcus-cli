import type { DurableRun, DurableTask } from "../state/state-store.js";
import type { GitContext } from "./git-context.js";

interface TestEvidenceView {
  evidenceId: string;
  snapshotDigest: string;
  status: string;
  payload: unknown;
}

/** Deterministic close-out summary; it reports evidence and explicit gaps, not semantic approval. */
export function formatReviewReport(input: {
  context: GitContext;
  evidence: TestEvidenceView[];
  unresolvedExecutions: Array<{ executionId: string; status: string }>;
  runs: DurableRun[];
  tasks: DurableTask[];
  ledger?: Array<{ revision: number; payload: unknown }>;
}): string {
  const output: string[] = ["Changed:"];
  if (input.context.changedFiles.length) {
    for (const file of input.context.changedFiles) output.push(`  ${file.status} ${file.path}`);
  } else output.push("  no current Git changes detected");

  const latest = input.evidence.at(-1);
  output.push("Tested:");
  if (latest) {
    const payload = typeof latest.payload === "object" && latest.payload !== null ? latest.payload as Record<string, unknown> : {};
    output.push(`  ${latest.status}; evidence=${latest.evidenceId}; snapshot=${latest.snapshotDigest}; command=${String(payload.command ?? "unknown")}; durationMs=${String(payload.durationMs ?? "unknown")}; tests=${String(payload.tests ?? "unknown")} passed=${String(payload.passed ?? "unknown")} failed=${String(payload.failed ?? "unknown")} parser=${String(payload.parserStatus ?? "unknown")} exit=${String(payload.exitCode ?? "unknown")} signal=${String(payload.signal ?? "none")} timeout=${String(payload.timedOut ?? "unknown")} cancelled=${String(payload.cancelled ?? "unknown")} outputComplete=${String(payload.outputComplete ?? "unknown")} logRef=${String(payload.logRef ?? "none")}`);
    if (latest.snapshotDigest !== input.context.snapshotDigest || latest.status === "stale") output.push("  WARNING: evidence is stale for the current workspace snapshot");
  } else output.push("  no test evidence recorded");

  output.push("Remaining Risk:");
  const risks = [
    !input.context.isRepository ? "Git snapshot unavailable; change/evidence freshness cannot be fully established" : undefined,
    !latest ? "No test evidence; test status is unknown" : latest.status !== "passed" ? `Latest test evidence is ${latest.status}` : undefined,
    latest && latest.snapshotDigest !== input.context.snapshotDigest ? "Latest test evidence does not match the current workspace snapshot" : undefined,
    input.context.changedFiles.some((file) => file.status === "untracked") ? "Untracked files are present and may not be covered by Git-based evidence" : undefined,
    input.tasks.some((task) => task.status === "in_progress") ? "One or more durable tasks remain in progress" : undefined,
  ].filter((risk): risk is string => Boolean(risk));
  if (risks.length) output.push(...risks.map((risk) => `  ${risk}`));
  else output.push("  no additional risk detected by this bounded report; this is not a semantic code review");

  output.push("Unresolved Issue:");
  const unknownRuns = input.runs.filter((run) => run.status === "unknown");
  const blockedTasks = input.tasks.filter((task) => task.status === "blocked");
  const recordedBlockers = (input.ledger ?? []).filter((revision) => typeof revision.payload === "object" && revision.payload !== null && (revision.payload as { kind?: unknown }).kind === "blocker").slice(-16);
  const unresolvedCount = input.unresolvedExecutions.length + unknownRuns.length + blockedTasks.length + recordedBlockers.length;
  if (unresolvedCount) {
    for (const execution of input.unresolvedExecutions) output.push(`  execution ${execution.executionId}: ${execution.status}`);
    for (const run of unknownRuns) output.push(`  run ${run.runId}: interrupted outcome unknown`);
    for (const task of blockedTasks) output.push(`  task ${task.id}: blocked — ${task.title}`);
    for (const revision of recordedBlockers) {
      const text = typeof revision.payload === "object" && revision.payload !== null ? (revision.payload as { text?: unknown }).text : undefined;
      output.push(`  blocker revision ${revision.revision}: ${typeof text === "string" ? text : "recorded blocker"}`);
    }
  } else output.push("  none recorded in durable session state");
  return `${output.join("\n")}\n`;
}
