import type { UnresolvedExecutionDetail } from "../state/state-store.js";

const MAX_RECOVERY_ITEMS = 25;
const MAX_COMMAND_CHARACTERS = 500;

export interface RecoveryReportInput {
  executions: UnresolvedExecutionDetail[];
  unknownRunIds: string[];
  repositoryIdentityIssue?: string;
}

/** Render only bounded, redacted intent and blocker metadata; never include raw event payloads. */
export function formatRecoveryReport(input: RecoveryReportInput): string {
  const itemCount = input.executions.length + input.unknownRunIds.length + (input.repositoryIdentityIssue ? 1 : 0);
  if (!itemCount) return "No unresolved recovery items are recorded.\n";

  const lines = ["Recovery is paused. No command will be replayed automatically."];
  let remaining = MAX_RECOVERY_ITEMS;
  for (const execution of input.executions.slice(0, remaining)) {
    const intent = execution.intentSummary.slice(0, MAX_COMMAND_CHARACTERS);
    const truncated = execution.intentSummary.length > intent.length;
    lines.push(`Execution ${JSON.stringify(execution.executionId)} [${JSON.stringify(execution.status)}; ${JSON.stringify(execution.effectClass)}]: ${JSON.stringify(intent)}${truncated ? " (intent summary truncated)" : ""}`);
    remaining--;
  }
  for (const runId of input.unknownRunIds.slice(0, remaining)) {
    lines.push(`Run ${JSON.stringify(runId)} has an unknown outcome; it was not replayed.`);
    remaining--;
  }
  if (input.repositoryIdentityIssue && remaining > 0) {
    lines.push(`Repository identity: ${JSON.stringify(input.repositoryIdentityIssue.slice(0, MAX_COMMAND_CHARACTERS))}${input.repositoryIdentityIssue.length > MAX_COMMAND_CHARACTERS ? " (detail truncated)" : ""}`);
    remaining--;
  }
  const omitted = itemCount - MAX_RECOVERY_ITEMS;
  if (omitted > 0) lines.push(`${omitted} additional recovery item(s) omitted from this bounded report.`);
  lines.push("Inspect the worktree or external service and reconcile the listed effects. After review, use /clear to start a fresh session; the old session's evidence is retained.");
  return `${lines.join("\n")}\n`;
}
