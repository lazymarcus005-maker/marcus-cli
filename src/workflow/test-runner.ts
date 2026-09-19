import { randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { PolicyExecutor, redactExecutionText } from "../execution/policy-executor.js";
import { ExecutionLogStore } from "../execution/execution-log-store.js";
import type { StateStore } from "../state/state-store.js";
import { readGitContext } from "./git-context.js";
import { evaluateTestEvidence, type TestReportFormat } from "./test-evidence.js";

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function reportFingerprint(path: string | undefined): Promise<string | null> {
  if (!path) return null;
  try {
    const info = await lstat(path, { bigint: true });
    return `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function runTestCommand(input: {
  root: string;
  sessionId: string;
  runId?: string;
  command: string;
  reportPath?: string;
  format: TestReportFormat;
  stateStore: StateStore;
  authorize: ConstructorParameters<typeof PolicyExecutor>[0]["authorize"];
  signal?: AbortSignal;
}): Promise<{ evidenceId: string; result: Awaited<ReturnType<PolicyExecutor["execute"]>>; evidence: ReturnType<typeof evaluateTestEvidence> }> {
  const root = await realpath(input.root);
  const reportPath = input.reportPath ? resolve(root, input.reportPath) : undefined;
  if (reportPath && (!isWithin(root, reportPath) || reportPath === root)) throw new Error("Test report path must be inside the authorized worktree");
  if ((input.format === "junit" || input.format === "trx") && !reportPath) throw new Error("JUnit/TRX evidence requires a report path");
  const startedAt = Date.now();
  const before = await readGitContext(root);
  const reportBefore = await reportFingerprint(reportPath);
  const executor = new PolicyExecutor({
    authorize: input.authorize,
    journal: input.stateStore,
    logStore: new ExecutionLogStore(root),
  });
  const executionId = randomUUID();
  const result = await executor.execute({
    command: input.command,
    cwd: root,
    timeoutMs: 600_000,
    allowedEnvironment: ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"],
    ...(input.signal ? { signal: input.signal } : {}),
    identity: { executionId, sessionId: input.sessionId, ...(input.runId ? { runId: input.runId } : {}), effectClass: "test-build" },
  });

  let report = input.format === "node-json" ? result.stdout : "";
  let reportFresh: boolean | undefined = input.format === "node-json" ? true : input.format === "unknown" ? undefined : false;
  try {
    if (!reportPath) throw new Error("Node JSON report is captured from stdout");
    const info = await lstat(reportPath);
    const actual = await realpath(reportPath);
    if (!info.isFile() || info.isSymbolicLink() || !isWithin(root, actual)) throw new Error("Test report must be a regular file inside the worktree");
    if (info.size > 8 * 1024 * 1024) throw new Error("Test report exceeds 8 MiB");
    const reportAfter = await reportFingerprint(reportPath);
    if (reportAfter === reportBefore) throw new Error("Test report was not refreshed by this execution");
    report = await readFile(actual, "utf8");
    reportFresh = true;
  } catch { /* absence or stale report is retained as unknown evidence */ }
  const after = await readGitContext(root);
  const evidence = evaluateTestEvidence({
    format: input.format,
    report,
    execution: result,
    snapshotBefore: before.snapshotDigest,
    snapshotAfter: after.snapshotDigest,
    snapshotValid: before.isRepository && after.isRepository,
    ...(reportFresh !== undefined ? { reportFresh } : {}),
  });
  const evidenceId = randomUUID();
  input.stateStore.recordTestEvidence({
    evidenceId,
    sessionId: input.sessionId,
    snapshotDigest: evidence.snapshotDigest,
    status: evidence.status,
    payload: {
      command: redactExecutionText(input.command),
      cwd: root,
      durationMs: Date.now() - startedAt,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      outputComplete: result.outputComplete,
      parserStatus: evidence.parserStatus,
      tests: evidence.tests,
      passed: evidence.passed,
      failed: evidence.failed,
      skipped: evidence.skipped,
      reason: evidence.reason ?? null,
      logRef: result.logRef ?? null,
      logTruncated: result.logTruncated ?? false,
      format: input.format,
      reportFresh,
    },
  });
  return { evidenceId, result, evidence };
}
