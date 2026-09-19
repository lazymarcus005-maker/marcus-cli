import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  acquireWorktreeMutationLock,
  openStateStore,
} from "../src/state/state-store.js";
import { buildCompactionInstructions, createDurableCheckpoint, reconcileDurableCheckpoints, verifyCheckpointSources } from "../src/workflow/checkpoints.js";

const tempDirectories: string[] = [];

after(async () => {
  await Promise.all(tempDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "macus-state-test-"));
  tempDirectories.push(path);
  return path;
}

describe("durable session state", () => {
  it("persists a session identity and its worktree binding across reopen", async () => {
    const root = await temporaryDirectory();
    const databasePath = join(root, ".macus", "state", "state.db");
    const initial = openStateStore(databasePath);
    initial.createSession({
      sessionId: "session-one",
      worktreeRoot: root,
      gitDirectory: join(root, ".git"),
      gitBranch: "main",
      gitHead: "a".repeat(40),
      gitIdentityCaptured: true,
    });
    initial.close();

    const reopened = openStateStore(databasePath);
    assert.deepEqual(reopened.getSession("session-one"), {
      sessionId: "session-one",
      worktreeRoot: root,
      gitDirectory: join(root, ".git"),
      gitBranch: "main",
      gitHead: "a".repeat(40),
      gitIdentityCaptured: true,
    });
    reopened.close();
  });

  it("keeps sessions isolated by session identity", async () => {
    const root = await temporaryDirectory();
    const store = openStateStore(join(root, "state.db"));
    store.createSession({
      sessionId: "first",
      worktreeRoot: root,
      gitDirectory: null,
    });

    assert.equal(store.getSession("first")?.sessionId, "first");
    assert.equal(store.getSession("other"), undefined);
    store.close();
  });

  it("journals execution intent before launch and records observed outcomes", async () => {
    const root = await temporaryDirectory();
    const store = openStateStore(join(root, "state.db"));
    store.createSession({ sessionId: "journal-session", worktreeRoot: root, gitDirectory: null });
    store.prepareExecution({
      executionId: "execution-one",
      sessionId: "journal-session",
      toolCallId: "tool-call-one",
      redactedInput: { command: "npm test" },
      effectClass: "test-build",
    });
    assert.equal(store.getExecutionStatus("execution-one"), "prepared");
    assert.equal(store.getLatestTestBuildExecutionId("journal-session"), "execution-one");
    assert.deepEqual(store.listUnresolvedExecutions("journal-session"), [
      { executionId: "execution-one", status: "prepared" },
    ]);
    store.recordExecutionEvent("execution-one", "started", { pid: 123 });
    assert.deepEqual(store.listUnresolvedExecutions("journal-session"), [
      { executionId: "execution-one", status: "started" },
    ]);
    store.recordExecutionEvent("execution-one", "unknown", { reason: "crash during execution" });
    assert.equal(store.getExecutionStatus("execution-one"), "unknown");
    assert.deepEqual(store.listUnresolvedExecutions("journal-session"), [
      { executionId: "execution-one", status: "unknown" },
    ]);
    assert.throws(() => store.recordExecutionEvent("execution-one", "completed", {}), /Invalid execution transition/);
    store.close();
  });

  it("refuses to replay a tool call whose execution already reached durable completion", async () => {
    const root = await temporaryDirectory();
    const store = openStateStore(join(root, "state.db"));
    store.createSession({ sessionId: "tool-replay-session", worktreeRoot: root, gitDirectory: null });
    store.prepareExecution({ executionId: "completed-exec", sessionId: "tool-replay-session", toolCallId: "pi-call-1", redactedInput: { command: "publish" }, effectClass: "external" });
    store.recordExecutionEvent("completed-exec", "started", {});
    store.recordExecutionEvent("completed-exec", "completed", { exitCode: 0 });
    assert.throws(
      () => store.prepareExecution({ executionId: "replayed-exec", sessionId: "tool-replay-session", toolCallId: "pi-call-1", redactedInput: { command: "publish" }, effectClass: "external" }),
      /automatic replay is refused/,
    );
    assert.equal(store.getExecutionStatus("replayed-exec"), undefined);
    assert.equal(store.getExecutionStatus("completed-exec"), "completed");
    store.close();
  });

  it("requires review for cancelled executions that may have had side effects", async () => {
    const root = await temporaryDirectory();
    const store = openStateStore(join(root, "state.db"));
    store.createSession({ sessionId: "cancel-recovery-session", worktreeRoot: root, gitDirectory: null });
    store.prepareExecution({ executionId: "cancelled-write", sessionId: "cancel-recovery-session", redactedInput: { command: "write then cancel" }, effectClass: "external" });
    store.recordExecutionEvent("cancelled-write", "started", {});
    store.recordExecutionEvent("cancelled-write", "cancelled", { signal: "SIGTERM" });
    assert.deepEqual(store.listUnresolvedExecutions("cancel-recovery-session"), [
      { executionId: "cancelled-write", status: "cancelled" },
    ]);
    store.close();
  });

  it("persists run identities and marks interrupted runs unknown on recovery", async () => {
    const root = await temporaryDirectory();
    const store = openStateStore(join(root, "state.db"));
    store.createSession({ sessionId: "run-session", worktreeRoot: root, gitDirectory: null });
    store.startRun({ runId: "interrupted-run", sessionId: "run-session", prompt: "user goal with possible secret" });
    store.startRun({ runId: "complete-run", sessionId: "run-session", prompt: "finish task" });
    store.finishRun("complete-run", "completed", { modelTurns: 2 });
    const interrupted = store.markInterruptedRunsUnknown("run-session");
    assert.deepEqual(interrupted.map((run) => [run.runId, run.status]), [["interrupted-run", "unknown"]]);
    assert.deepEqual(store.listRuns("run-session").map((run) => [run.runId, run.status]), [["interrupted-run", "unknown"], ["complete-run", "completed"]]);
    assert.equal(JSON.stringify(store.listLedgerRevisions("run-session")).includes("possible secret"), false);
    store.close();
  });

  it("persists session tasks and enforces transitions and one active task", async () => {
    const root = await temporaryDirectory();
    const store = openStateStore(join(root, "state.db"));
    store.createSession({ sessionId: "tasks-session", worktreeRoot: root, gitDirectory: null });
    const first = store.createTask({ sessionId: "tasks-session", title: " Add tests ", relatedFiles: ["src/app.ts"] });
    const second = store.createTask({ sessionId: "tasks-session", title: "Run checks" });
    assert.equal(first.title, "Add tests");
    assert.equal(store.transitionTask("tasks-session", first.id, "in_progress").status, "in_progress");
    assert.throws(() => store.transitionTask("tasks-session", second.id, "in_progress"), /already in progress/);
    assert.equal(store.transitionTask("tasks-session", first.id, "completed").relatedFiles[0], "src/app.ts");
    assert.equal(store.transitionTask("tasks-session", second.id, "in_progress").status, "in_progress");
    assert.equal(store.listLedgerRevisions("tasks-session").length, 5);
    store.close();
    const reopened = openStateStore(join(root, "state.db"));
    assert.deepEqual(reopened.listTasks("tasks-session").map((task) => task.status), ["completed", "in_progress"]);
    assert.deepEqual(reopened.listTasks("tasks-session")[0]?.evidenceIds, []);
    assert.deepEqual(reopened.listTestEvidence("tasks-session"), []);
    reopened.close();
  });

  it("pauses on durable blockers until explicitly resolved in the same session", async () => {
    const root = await temporaryDirectory();
    const store = openStateStore(join(root, "state.db"));
    store.createSession({ sessionId: "blockers-session", worktreeRoot: root, gitDirectory: null });
    const blocker = store.recordWorkflowNote("blockers-session", "blocker", "Need approval before changing deployment config");
    assert.deepEqual(store.listActiveBlockers("blockers-session").map((item) => [item.revision, item.text]), [[blocker.revision, "Need approval before changing deployment config"]]);
    assert.throws(() => store.resolveWorkflowBlocker("blockers-session", blocker.revision + 1), /No active blocker/);
    store.resolveWorkflowBlocker("blockers-session", blocker.revision);
    assert.deepEqual(store.listActiveBlockers("blockers-session"), []);
    assert.equal(store.listLedgerRevisions("blockers-session").length, 2);
    store.close();
  });

  it("persists a session-scoped working set and rejects paths outside the repository", async () => {
    const root = await temporaryDirectory();
    const databasePath = join(root, "state.db");
    const store = openStateStore(databasePath);
    store.createSession({ sessionId: "working-set-session", worktreeRoot: root, gitDirectory: null });
    const entry = store.recordWorkingSetEntry({
      sessionId: "working-set-session",
      path: "src\\auth.ts",
      sourceSha256: "a".repeat(64),
      status: "ACTIVE",
      tier: "HOT",
      startLine: 3,
      endLine: 8,
      symbolId: "symbol-one",
      reason: "verified-read",
    });
    assert.equal(entry.path, "src/auth.ts");
    assert.throws(() => store.recordWorkingSetEntry({ ...entry, path: "../outside" }), /repository-relative/);
    store.markWorkingSetStale("working-set-session", "src/auth.ts");
    assert.equal(store.listWorkingSet("working-set-session")[0]?.status, "STALE");
    store.close();
    const reopened = openStateStore(databasePath);
    assert.equal(reopened.listWorkingSet("working-set-session")[0]?.sourceSha256, "a".repeat(64));
    reopened.close();
  });

  it("commits ledger revisions and checkpoints with transcript and unknown-execution references", async () => {
    const root = await temporaryDirectory();
    const store = openStateStore(join(root, "state.db"));
    store.createSession({ sessionId: "checkpoint-session", worktreeRoot: root, gitDirectory: null });
    const first = store.appendLedgerRevision("checkpoint-session", { goal: "finish safely", decisions: [], files: [] });
    const second = store.appendLedgerRevision("checkpoint-session", { goal: "finish safely", decisions: ["keep source"], files: [] });
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 2);
    store.prepareExecution({ executionId: "unknown-checkpoint-op", sessionId: "checkpoint-session", redactedInput: { command: "unknown" }, effectClass: "external" });
    store.recordExecutionEvent("unknown-checkpoint-op", "started", {});
    const checkpoint = store.createCheckpoint("checkpoint-session", {
      transcriptEntryId: "pi-entry-12",
      goal: "finish safely",
      taskStates: [],
      fileHashes: [{ path: "src/app.ts", sha256: "a".repeat(64) }],
      nextAction: "inspect execution outcome",
    });
    assert.equal(checkpoint.stateRevision, 2);
    assert.equal(checkpoint.payload.transcriptEntryId, "pi-entry-12");
    assert.equal((checkpoint.payload.unresolvedExecutions as Array<{ executionId: string }>)[0]?.executionId, "unknown-checkpoint-op");
    assert.equal(store.getCheckpoint("checkpoint-session", checkpoint.checkpointId, root).checkpointId, checkpoint.checkpointId);
    assert.throws(() => store.getCheckpoint("checkpoint-session", checkpoint.checkpointId, `${root}/other`), /identity/);
    assert.equal(store.listLedgerRevisions("checkpoint-session").length, 2);
    store.close();
  });

  it("records attributable source changes by before/after hash and session", async () => {
    const root = await temporaryDirectory();
    const store = openStateStore(join(root, "state.db"));
    store.createSession({ sessionId: "attribution-session", worktreeRoot: root, gitDirectory: null });
    store.recordWorkingSetEntry({ sessionId: "attribution-session", path: "src/auth.ts", sourceSha256: "a".repeat(64), status: "ACTIVE", tier: "HOT", startLine: 1, endLine: 1, symbolId: null, reason: "verified-read" });
    store.recordTestEvidence({ evidenceId: "evidence-before-agent-write", sessionId: "attribution-session", snapshotDigest: "before", status: "passed", payload: {} });
    const event = store.recordSourceChange({ sessionId: "attribution-session", path: "src\\auth.ts", oldSha256: "a".repeat(64), newSha256: "b".repeat(64), attribution: "agent", reason: "approved-write-file" });
    assert.equal(event.path, "src/auth.ts");
    assert.equal(store.listSourceChanges("attribution-session", "src/auth.ts")[0]?.newSha256, "b".repeat(64));
    assert.equal(store.listWorkingSet("attribution-session")[0]?.status, "STALE");
    assert.equal(store.listTestEvidence("attribution-session")[0]?.status, "stale");
    assert.throws(() => store.recordSourceChange({ sessionId: "attribution-session", path: "../outside.ts", oldSha256: null, newSha256: null, attribution: "external_or_unknown", reason: "detected" }), /invalid|protected/i);
    store.close();
  });

  it("reconciles unrecorded workspace edits as unknown, stales fragments, and invalidates passing evidence once", async () => {
    const root = await temporaryDirectory();
    const store = openStateStore(join(root, "state.db"));
    store.createSession({ sessionId: "reconcile-session", worktreeRoot: root, gitDirectory: null }, [
      { path: "src/app.ts", sha256: "a".repeat(64) },
    ]);
    store.recordWorkingSetEntry({
      sessionId: "reconcile-session", path: "src/app.ts", sourceSha256: "a".repeat(64), status: "ACTIVE", tier: "HOT",
      startLine: 1, endLine: 1, symbolId: null, reason: "verified-read",
    });
    store.recordTestEvidence({ evidenceId: "passed-before-edit", sessionId: "reconcile-session", snapshotDigest: "before", status: "passed", payload: {} });
    const changed = [{ path: "src/app.ts", sha256: "b".repeat(64) }];
    assert.deepEqual(store.reconcileWorkingTree("reconcile-session", changed), ["src/app.ts"]);
    assert.deepEqual(store.reconcileWorkingTree("reconcile-session", changed), []);
    assert.equal(store.listSourceChanges("reconcile-session", "src/app.ts").at(-1)?.attribution, "external_or_unknown");
    assert.equal(store.listSourceChanges("reconcile-session", "src/app.ts").at(-1)?.oldSha256, "a".repeat(64));
    assert.equal(store.listWorkingSet("reconcile-session")[0]?.status, "STALE");
    assert.equal(store.listTestEvidence("reconcile-session")[0]?.status, "stale");
    assert.equal(store.listLedgerRevisions("reconcile-session").filter((item) => (item.payload as { kind?: string }).kind === "test-evidence-invalidated").length, 1);
    store.close();
  });

  it("atomically captures dirty files as pre-existing when creating a session", async () => {
    const root = await temporaryDirectory();
    const store = openStateStore(join(root, "state.db"));
    const sha256 = "a".repeat(64);
    store.createSession({ sessionId: "baseline-session", worktreeRoot: root, gitDirectory: null }, [
      { path: "src/dirty.ts", sha256 },
      { path: "deleted.ts", sha256: null },
    ]);
    assert.deepEqual(store.listSourceChanges("baseline-session").map(({ path, oldSha256, newSha256, attribution, reason }) => ({ path, oldSha256, newSha256, attribution, reason })), [
      { path: "src/dirty.ts", oldSha256: null, newSha256: sha256, attribution: "pre_existing", reason: "session-start-worktree-state" },
      { path: "deleted.ts", oldSha256: null, newSha256: null, attribution: "pre_existing", reason: "session-start-worktree-state" },
    ]);
    assert.equal(store.listLedgerRevisions("baseline-session").length, 2);
    store.close();
  });

  it("writes a durable state-only checkpoint file before registering it", async () => {
    const root = await temporaryDirectory();
    const store = openStateStore(join(root, ".macus", "state", "state.db"));
    store.createSession({ sessionId: "checkpoint-file-session", worktreeRoot: root, gitDirectory: null });
    store.createTask({ sessionId: "checkpoint-file-session", title: "Preserve intent" });
    const changedSource = join(root, "working.ts");
    await writeFile(changedSource, "export const value = 1;\n");
    const sourceHash = createHash("sha256").update(await readFile(changedSource)).digest("hex");
    store.recordWorkflowNote("checkpoint-file-session", "decision", "Never restore source bytes.");
    store.recordWorkflowNote("checkpoint-file-session", "next-action", "Re-run focused tests.");
    store.recordWorkflowNote("checkpoint-file-session", "blocker", "Configured provider is unavailable.");
    store.recordTestEvidence({ evidenceId: "evidence-for-checkpoint", sessionId: "checkpoint-file-session", snapshotDigest: "snapshot", status: "unknown", payload: { reason: "offline" } });
    store.prepareExecution({ executionId: "unresolved-at-checkpoint", sessionId: "checkpoint-file-session", redactedInput: { command: "side-effect" }, effectClass: "external" });
    store.recordExecutionEvent("unresolved-at-checkpoint", "started", { pid: 123 });
    const checkpoint = await createDurableCheckpoint({ root, sessionId: "checkpoint-file-session", stateStore: store, transcriptEntryId: "pi-leaf-1", goal: "Protect state", changedFiles: [{ path: "working.ts", sha256: sourceHash }] });
    const sessionKey = createHash("sha256").update("checkpoint-file-session").digest("hex").slice(0, 32);
    const file = join(root, ".macus", "checkpoints", sessionKey, `${checkpoint.checkpointId}.json`);
    const payload = JSON.parse(await readFile(file, "utf8")) as { goal: string; tasks: unknown[]; transcriptEntryId: string; decisions: Array<{ text: string }>; blockers: Array<{ text?: string }>; currentEvidence: Array<{ evidenceId: string }>; unresolvedExecutions: Array<{ executionId: string; status: string }>; nextAction: string };
    assert.equal(payload.goal, "Protect state");
    assert.equal(payload.tasks.length, 1);
    assert.equal(payload.transcriptEntryId, "pi-leaf-1");
    assert.equal(payload.decisions[0]?.text, "Never restore source bytes.");
    assert.equal(payload.blockers[0]?.text, "Configured provider is unavailable.");
    assert.equal(payload.currentEvidence[0]?.evidenceId, "evidence-for-checkpoint");
    assert.deepEqual(payload.unresolvedExecutions, [{ executionId: "unresolved-at-checkpoint", status: "started" }]);
    assert.equal(payload.nextAction, "Re-run focused tests.");
    const reduced = await createDurableCheckpoint({ root, sessionId: "checkpoint-file-session", stateStore: store, includeContextLedger: false, transcriptEntryId: "pi-leaf-1", changedFiles: [{ path: "working.ts", sha256: sourceHash }] });
    assert.equal(reduced.payload.goal, null);
    assert.deepEqual(reduced.payload.ledger, []);
    assert.deepEqual(reduced.payload.decisions, []);
    assert.equal((reduced.payload.tasks as unknown[]).length, 1);
    assert.equal((reduced.payload.currentEvidence as unknown[]).length, 1);
    const originalTaskId = (payload.tasks[0] as { id: string }).id;
    store.transitionTask("checkpoint-file-session", originalTaskId, "in_progress");
    const laterTask = store.createTask({ sessionId: "checkpoint-file-session", title: "Later task" });
    store.restoreTaskSnapshot("checkpoint-file-session", payload.tasks);
    const restoredTasks = store.listTasks("checkpoint-file-session");
    assert.equal(restoredTasks.find((task) => task.id === originalTaskId)?.status, "pending");
    assert.equal(restoredTasks.find((task) => task.id === laterTask.id)?.status, "pending");
    assert.match(restoredTasks.find((task) => task.id === laterTask.id)!.notes.join(" "), /Retained from after/);
    assert.deepEqual(await verifyCheckpointSources(root, [{ path: "working.ts", sha256: sourceHash }]), { stalePaths: [], unverifiedPaths: [] });
    await writeFile(changedSource, "export const value = 2;\n");
    assert.deepEqual(await verifyCheckpointSources(root, [{ path: "working.ts", sha256: sourceHash }]), { stalePaths: ["working.ts"], unverifiedPaths: [] });
    assert.equal(store.getCheckpoint("checkpoint-file-session", checkpoint.checkpointId, root).checkpointId, checkpoint.checkpointId);
    const checkpointDirectory = join(root, ".macus", "checkpoints", sessionKey);
    await writeFile(join(checkpointDirectory, ".interrupted.tmp"), "partial");
    await writeFile(join(checkpointDirectory, "orphan-file.json"), JSON.stringify({ schemaVersion: 1, checkpointId: "orphan-file", sessionId: "checkpoint-file-session", worktreeRoot: await realpath(root) }));
    const reconciled = await reconcileDurableCheckpoints({ root, sessionId: "checkpoint-file-session", stateStore: store });
    assert.deepEqual(reconciled.removedTemporaryFiles, [".interrupted.tmp"]);
    assert.deepEqual(reconciled.removedOrphanFiles, ["orphan-file"]);
    assert.deepEqual(reconciled.missingRegisteredFiles, []);
    await unlink(file);
    const missing = await reconcileDurableCheckpoints({ root, sessionId: "checkpoint-file-session", stateStore: store });
    assert.deepEqual(missing.missingRegisteredFiles, [checkpoint.checkpointId]);
    store.close();
  });

  it("builds bounded compaction instructions that preserve current state and unknown side effects", () => {
    const instructions = buildCompactionInstructions({
      goal: "Finish the feature without changing public API",
      tasks: [{ id: "task-1", status: "in_progress", title: "Implement the boundary" }],
      decisions: [{ text: "Keep backwards compatibility" }],
      blockers: [{ text: "Provider outcome is unknown" }],
      currentEvidence: [{ status: "stale", evidenceId: "test-1" }],
      unresolvedExecutions: [{ status: "unknown", executionId: "exec-1" }],
      nextAction: "Inspect the process outcome",
    });
    assert.match(instructions, /user's goal or constraints/);
    assert.match(instructions, /provider outcome is unknown/i);
    assert.match(instructions, /exec-1/);
    assert.match(instructions, /Inspect the process outcome/);
    assert.ok(Buffer.byteLength(instructions, "utf8") < 7000);
    assert.ok(Buffer.byteLength(buildCompactionInstructions({ tasks: [{ title: "large".repeat(10_000) }] }), "utf8") < 7000);
  });

  it("migrates a v2 state database to schema v5 without losing sessions", async () => {
    const root = await temporaryDirectory();
    const databasePath = join(root, "state.db");
    const initial = openStateStore(databasePath);
    initial.createSession({ sessionId: "migration-session", worktreeRoot: root, gitDirectory: null });
    initial.close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("DROP TABLE working_set; UPDATE schema_metadata SET version = 2");
    legacy.close();

    const migrated = openStateStore(databasePath);
    assert.equal(migrated.getSession("migration-session")?.sessionId, "migration-session");
    const entry = migrated.recordWorkingSetEntry({ sessionId: "migration-session", path: "src/file.ts", sourceSha256: null, status: "DISCOVERED", tier: "COLD", startLine: 1, endLine: 1, symbolId: null, reason: "search-result" });
    assert.equal(entry.status, "DISCOVERED");
    assert.equal(migrated.recordSourceChange({ sessionId: "migration-session", path: "src/file.ts", oldSha256: null, newSha256: "c".repeat(64), attribution: "agent", reason: "migration-test" }).newSha256, "c".repeat(64));
    migrated.close();
  });

  it("migrates an existing v3 working-set database to v5 transactionally", async () => {
    const root = await temporaryDirectory();
    const databasePath = join(root, "state.db");
    const initial = openStateStore(databasePath);
    initial.createSession({ sessionId: "v3-session", worktreeRoot: root, gitDirectory: null });
    initial.close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("DROP TABLE source_changes; UPDATE schema_metadata SET version = 3");
    legacy.close();
    const migrated = openStateStore(databasePath);
    assert.equal(migrated.getSession("v3-session")?.sessionId, "v3-session");
    assert.equal(migrated.recordSourceChange({ sessionId: "v3-session", path: "src/file.ts", oldSha256: null, newSha256: null, attribution: "external_or_unknown", reason: "v3 migration" }).attribution, "external_or_unknown");
    migrated.close();
  });

  it("migrates a v4 session schema with no repository identity columns to v5", async () => {
    const root = await temporaryDirectory();
    const databasePath = join(root, "v4.db");
    const initial = openStateStore(databasePath);
    initial.createSession({ sessionId: "v4-session", worktreeRoot: root, gitDirectory: null });
    initial.close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec("ALTER TABLE sessions DROP COLUMN repository_identity_captured; ALTER TABLE sessions DROP COLUMN repository_head; ALTER TABLE sessions DROP COLUMN repository_branch; UPDATE schema_metadata SET version = 4");
    legacy.close();
    const migrated = openStateStore(databasePath);
    assert.equal(migrated.getSession("v4-session")?.sessionId, "v4-session");
    assert.equal(migrated.getSession("v4-session")?.gitIdentityCaptured, undefined);
    migrated.close();
  });

  it("rolls back the entire schema migration when the version commit fails", async () => {
    const root = await temporaryDirectory();
    const databasePath = join(root, "migration-rollback.db");
    const initial = openStateStore(databasePath);
    initial.createSession({ sessionId: "rollback-session", worktreeRoot: root, gitDirectory: null });
    initial.close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      ALTER TABLE sessions DROP COLUMN repository_identity_captured;
      ALTER TABLE sessions DROP COLUMN repository_head;
      ALTER TABLE sessions DROP COLUMN repository_branch;
      UPDATE schema_metadata SET version = 4;
      CREATE TRIGGER reject_schema_version BEFORE UPDATE ON schema_metadata
      BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;
    `);
    legacy.close();

    assert.throws(() => openStateStore(databasePath), /injected migration failure/);
    const afterFailure = new DatabaseSync(databasePath);
    assert.equal((afterFailure.prepare("SELECT version FROM schema_metadata").get() as { version: number }).version, 4);
    const columns = (afterFailure.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((column) => column.name);
    assert.equal(columns.includes("repository_branch"), false);
    assert.equal(columns.includes("repository_head"), false);
    assert.equal(columns.includes("repository_identity_captured"), false);
    afterFailure.exec("DROP TRIGGER reject_schema_version");
    afterFailure.close();

    const retried = openStateStore(databasePath);
    assert.equal(retried.getSession("rollback-session")?.sessionId, "rollback-session");
    assert.equal(retried.getSession("rollback-session")?.gitIdentityCaptured, undefined);
    retried.close();
  });

  it("migrates a legacy journal layout by adding nullable run links without losing evidence", async () => {
    const root = await temporaryDirectory();
    const databasePath = join(root, "legacy.db");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE schema_metadata(version INTEGER NOT NULL) STRICT;
      INSERT INTO schema_metadata VALUES (1);
      CREATE TABLE sessions(session_id TEXT PRIMARY KEY, worktree_root TEXT NOT NULL, git_directory TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      INSERT INTO sessions VALUES ('legacy-session','${root}',NULL,'2026-01-01','2026-01-01');
      CREATE TABLE executions(execution_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id), status TEXT NOT NULL, redacted_input_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
      INSERT INTO executions VALUES ('legacy-execution','legacy-session','unknown','{}','2026-01-01','2026-01-01');
      CREATE TABLE test_evidence(evidence_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(session_id), snapshot_digest TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
      INSERT INTO test_evidence VALUES ('legacy-evidence','legacy-session','snapshot','unknown','{}','2026-01-01');
    `);
    legacy.close();

    const migrated = openStateStore(databasePath);
    assert.equal(migrated.getSession("legacy-session")?.sessionId, "legacy-session");
    assert.equal(migrated.getExecutionStatus("legacy-execution"), "unknown");
    assert.equal(migrated.listTestEvidence("legacy-session")[0]?.evidenceId, "legacy-evidence");
    migrated.prepareExecution({ executionId: "new-execution", sessionId: "legacy-session", toolCallId: "tool-call", redactedInput: {}, effectClass: "read" });
    assert.equal(migrated.getExecutionStatus("new-execution"), "prepared");
    migrated.close();
  });

  it("refuses a second mutating lock and releases it for a later run", async () => {
    const root = await temporaryDirectory();
    const lockPath = join(root, "locks", "worktree.lock.db");
    const release = acquireWorktreeMutationLock(lockPath);

    assert.throws(
      () => acquireWorktreeMutationLock(lockPath),
      /already mutating this worktree/,
    );

    release();
    const releaseNext = acquireWorktreeMutationLock(lockPath);
    releaseNext();
  });
});
