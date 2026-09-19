import { chmodSync, mkdirSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, posix } from "node:path";
import { DatabaseSync } from "node:sqlite";

const STATE_SCHEMA_VERSION = 5;

export interface SessionIdentity {
  sessionId: string;
  worktreeRoot: string;
  gitDirectory: string | null;
  gitBranch?: string | null;
  gitHead?: string | null;
  gitIdentityCaptured?: boolean;
}

export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked" | "skipped";
export interface DurableTask {
  sessionId: string;
  id: string;
  title: string;
  status: TaskStatus;
  relatedFiles: string[];
  relatedSymbols: string[];
  notes: string[];
  createdAt: string;
  updatedAt: string;
  evidenceIds: string[];
}

export interface WorkingSetEntry {
  sessionId: string;
  path: string;
  sourceSha256: string | null;
  status: "ACTIVE" | "RELATED" | "DISCOVERED" | "STALE";
  tier: "HOT" | "WARM" | "COLD";
  startLine: number;
  endLine: number;
  symbolId: string | null;
  reason: string;
  lastAccessedAt: string;
}

export interface LedgerRevision {
  sessionId: string;
  revision: number;
  createdAt: string;
  payload: unknown;
}

export interface StateCheckpoint {
  checkpointId: string;
  sessionId: string;
  stateRevision: number;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface SourceChange {
  sessionId: string;
  path: string;
  oldSha256: string | null;
  newSha256: string | null;
  attribution: "agent" | "pre_existing" | "external_or_unknown";
  reason: string;
  createdAt: string;
}

export interface DurableRun {
  runId: string;
  sessionId: string;
  status: "running" | "completed" | "failed" | "cancelled" | "paused" | "unknown";
  createdAt: string;
  updatedAt: string;
}

interface StateSessionRow {
  session_id: string;
  worktree_root: string;
  git_directory: string | null;
  repository_branch: string | null;
  repository_head: string | null;
  repository_identity_captured: number;
}

export class StateStore {
  constructor(private readonly database: DatabaseSync) {}

  private appendLedgerWithinTransaction(sessionId: string, payload: unknown, createdAt: string): void {
    const row = this.database.prepare("SELECT state_revision AS revision FROM sessions WHERE session_id = ?").get(sessionId) as { revision: number } | undefined;
    if (!row) throw new Error(`Unknown session ${sessionId}`);
    const revision = row.revision + 1;
    this.database.prepare("UPDATE sessions SET state_revision = ?, updated_at = ? WHERE session_id = ?").run(revision, createdAt, sessionId);
    this.database.prepare("INSERT INTO ledger_revisions(session_id, revision, payload_json, created_at) VALUES (?, ?, ?, ?)").run(sessionId, revision, JSON.stringify(payload), createdAt);
  }

  createSession(identity: SessionIdentity, initialChanges: Array<{ path: string; sha256: string | null }> = []): void {
    if (initialChanges.length > 5000) throw new Error("Initial source baseline exceeds the 5000-path bound");
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        `INSERT INTO sessions(session_id, worktree_root, git_directory, repository_branch, repository_head, repository_identity_captured, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(identity.sessionId, identity.worktreeRoot, identity.gitDirectory, identity.gitBranch ?? null, identity.gitHead ?? null, identity.gitIdentityCaptured ? 1 : 0, now, now);
      for (const change of initialChanges) {
        const path = normalizeRelativePath(change.path);
        if (!path || path === ".macus" || path.startsWith(".macus/")) continue;
        if (change.sha256 !== null && !/^[a-f0-9]{64}$/.test(change.sha256)) throw new Error(`Invalid initial source hash for ${path}`);
        this.database.prepare("INSERT INTO source_changes(session_id, path, old_sha256, new_sha256, attribution, reason, created_at) VALUES (?, ?, NULL, ?, 'pre_existing', 'session-start-worktree-state', ?)").run(identity.sessionId, path, change.sha256, now);
        this.appendLedgerWithinTransaction(identity.sessionId, { kind: "source-change", path, oldSha256: null, newSha256: change.sha256, attribution: "pre_existing", reason: "session-start-worktree-state" }, now);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getSession(sessionId: string): SessionIdentity | undefined {
    const row = this.database
      .prepare(
        `SELECT session_id, worktree_root, git_directory, repository_branch, repository_head, repository_identity_captured
         FROM sessions WHERE session_id = ?`,
      )
      .get(sessionId) as StateSessionRow | undefined;
    if (!row) return undefined;
    return {
      sessionId: row.session_id,
      worktreeRoot: row.worktree_root,
      gitDirectory: row.git_directory,
      ...(row.repository_branch !== null ? { gitBranch: row.repository_branch } : {}),
      ...(row.repository_head !== null ? { gitHead: row.repository_head } : {}),
      ...(row.repository_identity_captured === 1 ? { gitIdentityCaptured: true } : {}),
    };
  }

  createTask(input: { sessionId: string; title: string; relatedFiles?: string[]; relatedSymbols?: string[] }): DurableTask {
    const title = input.title.trim();
    if (!title) throw new Error("Task title must not be empty");
    if (!this.getSession(input.sessionId)) throw new Error(`Unknown session ${input.sessionId}`);
    const now = new Date().toISOString();
    const task: DurableTask = {
      sessionId: input.sessionId,
      id: randomUUID(),
      title,
      status: "pending",
      relatedFiles: input.relatedFiles ?? [],
      relatedSymbols: input.relatedSymbols ?? [],
      notes: [],
      createdAt: now,
      updatedAt: now,
      evidenceIds: [],
    };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(
        "INSERT INTO tasks(session_id, task_id, status, payload_json, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(task.sessionId, task.id, task.status, JSON.stringify(task), now);
      this.appendLedgerWithinTransaction(task.sessionId, { event: "task-created", taskId: task.id, title: task.title, status: task.status }, now);
      this.database.exec("COMMIT");
      return task;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  startRun(input: { runId: string; sessionId: string; prompt: string }): DurableRun {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.runId)) throw new Error("Invalid run ID");
    const now = new Date().toISOString();
    const promptDigest = createHash("sha256").update(input.prompt).digest("hex");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.getSession(input.sessionId)) throw new Error(`Unknown session ${input.sessionId}`);
      this.database.prepare("INSERT INTO runs(run_id, session_id, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)").run(input.runId, input.sessionId, now, now);
      this.appendLedgerWithinTransaction(input.sessionId, { kind: "run-started", runId: input.runId, promptSha256: promptDigest, promptBytes: Buffer.byteLength(input.prompt, "utf8") }, now);
      this.database.exec("COMMIT");
      return { runId: input.runId, sessionId: input.sessionId, status: "running", createdAt: now, updatedAt: now };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  finishRun(runId: string, status: Exclude<DurableRun["status"], "running" | "unknown">, summary: Record<string, unknown> = {}): void {
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const run = this.database.prepare("SELECT session_id AS sessionId, status FROM runs WHERE run_id = ?").get(runId) as { sessionId: string; status: string } | undefined;
      if (!run || run.status !== "running") throw new Error("Run is missing or no longer active");
      this.database.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?").run(status, now, runId);
      this.appendLedgerWithinTransaction(run.sessionId, { kind: "run-finished", runId, status, ...summary }, now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  markInterruptedRunsUnknown(sessionId: string): DurableRun[] {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.database.prepare("SELECT run_id AS runId, session_id AS sessionId, status, created_at AS createdAt, updated_at AS updatedAt FROM runs WHERE session_id = ? AND status = 'running' ORDER BY created_at").all(sessionId) as unknown as DurableRun[];
      for (const run of rows) {
        const now = new Date().toISOString();
        this.database.prepare("UPDATE runs SET status = 'unknown', updated_at = ? WHERE run_id = ? AND status = 'running'").run(now, run.runId);
        this.appendLedgerWithinTransaction(sessionId, { kind: "run-interrupted", runId: run.runId, previousStatus: "running" }, now);
      }
      this.database.exec("COMMIT");
      return rows.map((run) => ({ ...run, status: "unknown" }));
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listRuns(sessionId: string): DurableRun[] {
    return this.database.prepare("SELECT run_id AS runId, session_id AS sessionId, status, created_at AS createdAt, updated_at AS updatedAt FROM runs WHERE session_id = ? ORDER BY created_at").all(sessionId) as unknown as DurableRun[];
  }

  getExecutionRunId(executionId: string): string | undefined {
    const row = this.database.prepare("SELECT run_id AS runId FROM executions WHERE execution_id = ?").get(executionId) as { runId: string | null } | undefined;
    return row?.runId ?? undefined;
  }

  listExecutionIds(sessionId: string): string[] {
    return (this.database.prepare("SELECT execution_id AS executionId FROM executions WHERE session_id = ? ORDER BY created_at").all(sessionId) as Array<{ executionId: string }>).map(({ executionId }) => executionId);
  }

  listTasks(sessionId: string): DurableTask[] {
    const rows = this.database.prepare(
      "SELECT payload_json FROM tasks WHERE session_id = ? ORDER BY rowid",
    ).all(sessionId) as Array<{ payload_json: string }>;
    return rows.map(({ payload_json }) => JSON.parse(payload_json) as DurableTask);
  }

  restoreTaskSnapshot(sessionId: string, snapshot: unknown): void {
    if (!Array.isArray(snapshot) || snapshot.length > 512) throw new Error("Checkpoint task snapshot is invalid or exceeds 512 tasks");
    const validStatuses = new Set<TaskStatus>(["pending", "in_progress", "completed", "blocked", "skipped"]);
    const tasks = snapshot.map((value) => {
      if (typeof value !== "object" || value === null) throw new Error("Checkpoint contains an invalid task");
      const task = value as Partial<DurableTask>;
      if (task.sessionId !== sessionId || typeof task.id !== "string" || !task.id || typeof task.title !== "string" || !validStatuses.has(task.status as TaskStatus) || !Array.isArray(task.relatedFiles) || !Array.isArray(task.relatedSymbols) || !Array.isArray(task.notes) || !Array.isArray(task.evidenceIds) || typeof task.createdAt !== "string" || typeof task.updatedAt !== "string") throw new Error("Checkpoint contains an invalid task");
      return task as DurableTask;
    });
    if (new Set(tasks.map((task) => task.id)).size !== tasks.length || tasks.filter((task) => task.status === "in_progress").length > 1) throw new Error("Checkpoint task snapshot violates task identity or active-task invariants");
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.getSession(sessionId)) throw new Error(`Unknown session ${sessionId}`);
      const current = this.listTasks(sessionId);
      const snapshotIds = new Set(tasks.map((task) => task.id));
      for (const task of tasks) {
        this.database.prepare("INSERT INTO tasks(session_id, task_id, status, payload_json, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_id, task_id) DO UPDATE SET status = excluded.status, payload_json = excluded.payload_json, updated_at = excluded.updated_at")
          .run(sessionId, task.id, task.status, JSON.stringify({ ...task, updatedAt: now }), now);
      }
      for (const task of current) {
        if (snapshotIds.has(task.id)) continue;
        const restored: DurableTask = { ...task, status: task.status === "in_progress" ? "pending" : task.status, updatedAt: now, notes: [...task.notes, "Retained from after the restored checkpoint; task history was not deleted."] };
        this.database.prepare("UPDATE tasks SET status = ?, payload_json = ?, updated_at = ? WHERE session_id = ? AND task_id = ?")
          .run(restored.status, JSON.stringify(restored), now, sessionId, task.id);
      }
      this.appendLedgerWithinTransaction(sessionId, { kind: "task-snapshot-restored", restoredTaskIds: tasks.map((task) => task.id), retainedLaterTaskIds: current.filter((task) => !snapshotIds.has(task.id)).map((task) => task.id) }, now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  transitionTask(sessionId: string, taskId: string, status: TaskStatus, note?: string): DurableTask {
    const validStatuses = new Set<TaskStatus>(["pending", "in_progress", "completed", "blocked", "skipped"]);
    if (!validStatuses.has(status)) throw new Error(`Invalid task status ${status}`);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const row = this.database.prepare(
        "SELECT payload_json FROM tasks WHERE session_id = ? AND task_id = ?",
      ).get(sessionId, taskId) as { payload_json: string } | undefined;
      if (!row) throw new Error(`Unknown task ${taskId}`);
      const task = JSON.parse(row.payload_json) as DurableTask;
      const transitions: Record<TaskStatus, TaskStatus[]> = {
        pending: ["in_progress", "blocked", "skipped"],
        in_progress: ["pending", "completed", "blocked"],
        blocked: ["pending", "in_progress", "skipped"],
        completed: [],
        skipped: [],
      };
      if (task.status !== status && !transitions[task.status].includes(status)) {
        throw new Error(`Invalid task transition ${task.status} -> ${status}`);
      }
      if (status === "in_progress") {
        const active = this.database.prepare(
          "SELECT task_id FROM tasks WHERE session_id = ? AND status = 'in_progress' AND task_id <> ? LIMIT 1",
        ).get(sessionId, taskId) as { task_id: string } | undefined;
        if (active) throw new Error(`Task ${active.task_id} is already in progress`);
      }
      task.status = status;
      task.updatedAt = new Date().toISOString();
      if (note?.trim()) task.notes.push(note.trim());
      this.database.prepare(
        "UPDATE tasks SET status = ?, payload_json = ?, updated_at = ? WHERE session_id = ? AND task_id = ?",
      ).run(status, JSON.stringify(task), task.updatedAt, sessionId, taskId);
      this.appendLedgerWithinTransaction(sessionId, { event: "task-transition", taskId, status, ...(note?.trim() ? { note: note.trim() } : {}) }, task.updatedAt);
      this.database.exec("COMMIT");
      return task;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recordTestEvidence(input: { evidenceId: string; sessionId: string; runId?: string; snapshotDigest: string; status: string; payload: unknown }): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const createdAt = new Date().toISOString();
      this.database.prepare(
        "INSERT INTO test_evidence(evidence_id, session_id, run_id, snapshot_digest, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(input.evidenceId, input.sessionId, input.runId ?? null, input.snapshotDigest, input.status, JSON.stringify(input.payload), createdAt);
      const activeTask = this.database.prepare("SELECT task_id AS taskId, payload_json AS payload FROM tasks WHERE session_id = ? AND status = 'in_progress' LIMIT 1").get(input.sessionId) as { taskId: string; payload: string } | undefined;
      if (activeTask) {
        const task = JSON.parse(activeTask.payload) as DurableTask;
        task.evidenceIds = [...new Set([...task.evidenceIds, input.evidenceId])].slice(-100);
        task.updatedAt = createdAt;
        this.database.prepare("UPDATE tasks SET payload_json = ?, updated_at = ? WHERE session_id = ? AND task_id = ?").run(JSON.stringify(task), createdAt, input.sessionId, activeTask.taskId);
        this.appendLedgerWithinTransaction(input.sessionId, { event: "task-evidence-linked", taskId: activeTask.taskId, evidenceId: input.evidenceId, status: input.status }, createdAt);
      }
      this.appendLedgerWithinTransaction(input.sessionId, { event: "test-evidence-recorded", evidenceId: input.evidenceId, status: input.status, snapshotDigest: input.snapshotDigest }, createdAt);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listTestEvidence(sessionId: string): Array<{ evidenceId: string; snapshotDigest: string; status: string; payload: unknown; createdAt: string }> {
    return this.database.prepare(
      "SELECT evidence_id AS evidenceId, snapshot_digest AS snapshotDigest, status, payload_json AS payload, created_at AS createdAt FROM test_evidence WHERE session_id = ? ORDER BY created_at, evidence_id",
    ).all(sessionId).map((row) => {
      const record = row as { evidenceId: string; snapshotDigest: string; status: string; payload: string; createdAt: string };
      return { ...record, payload: JSON.parse(record.payload) as unknown };
    });
  }

  invalidateTestEvidence(sessionId: string, reason: string): void {
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("UPDATE test_evidence SET status = 'stale' WHERE session_id = ? AND status = 'passed'").run(sessionId);
      this.appendLedgerWithinTransaction(sessionId, { kind: "test-evidence-invalidated", reason: reason.slice(0, 500) }, now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recordSourceChange(input: Omit<SourceChange, "createdAt">): SourceChange {
    const path = normalizeRelativePath(input.path);
    if (!path || path === ".macus" || path.startsWith(".macus/")) throw new Error("Source-change path is invalid or protected");
    for (const hash of [input.oldSha256, input.newSha256]) if (hash !== null && !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Source-change hashes must be SHA-256 values");
    if (!input.reason.trim() || input.reason.length > 500) throw new Error("Source-change reason must contain 1 to 500 characters");
    const createdAt = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.getSession(input.sessionId)) throw new Error(`Unknown session ${input.sessionId}`);
      this.database.prepare("INSERT INTO source_changes(session_id, path, old_sha256, new_sha256, attribution, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(input.sessionId, path, input.oldSha256, input.newSha256, input.attribution, input.reason.trim(), createdAt);
      this.appendLedgerWithinTransaction(input.sessionId, { kind: "source-change", path, oldSha256: input.oldSha256, newSha256: input.newSha256, attribution: input.attribution, reason: input.reason.trim() }, createdAt);
      this.database.prepare("UPDATE working_set SET status = 'STALE' WHERE session_id = ? AND path = ?").run(input.sessionId, path);
      this.database.prepare("UPDATE test_evidence SET status = 'stale' WHERE session_id = ? AND status = 'passed'").run(input.sessionId);
      this.appendLedgerWithinTransaction(input.sessionId, { kind: "test-evidence-invalidated", reason: `Source changed (${input.attribution}): ${path}` }, createdAt);
      this.database.exec("COMMIT");
      return { ...input, path, reason: input.reason.trim(), createdAt };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listSourceChanges(sessionId: string, path?: string): SourceChange[] {
    const rows = path === undefined
      ? this.database.prepare("SELECT session_id AS sessionId, path, old_sha256 AS oldSha256, new_sha256 AS newSha256, attribution, reason, created_at AS createdAt FROM source_changes WHERE session_id = ? ORDER BY created_at, rowid").all(sessionId)
      : this.database.prepare("SELECT session_id AS sessionId, path, old_sha256 AS oldSha256, new_sha256 AS newSha256, attribution, reason, created_at AS createdAt FROM source_changes WHERE session_id = ? AND path = ? ORDER BY created_at, rowid").all(sessionId, normalizeRelativePath(path));
    return rows as unknown as SourceChange[];
  }

  reconcileWorkingTree(sessionId: string, files: Array<{ path: string; sha256: string | null }>): string[] {
    if (files.length > 5000) throw new Error("Working-tree reconciliation exceeds the 5000-path bound");
    const now = new Date().toISOString();
    const changed: string[] = [];
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.getSession(sessionId)) throw new Error(`Unknown session ${sessionId}`);
      const latest = this.database.prepare(`
        SELECT new_sha256 AS newSha256
        FROM source_changes WHERE session_id = ? AND path = ? ORDER BY rowid DESC LIMIT 1
      `);
      const insert = this.database.prepare(`
        INSERT INTO source_changes(session_id, path, old_sha256, new_sha256, attribution, reason, created_at)
        VALUES (?, ?, ?, ?, 'external_or_unknown', 'workspace-snapshot-reconciliation', ?)
      `);
      for (const file of files) {
        const path = normalizeRelativePath(file.path);
        if (!path || path === ".macus" || path.startsWith(".macus/")) continue;
        if (file.sha256 !== null && !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Invalid working-tree hash for ${path}`);
        const previous = latest.get(sessionId, path) as { newSha256: string | null } | undefined;
        if (previous && previous.newSha256 === file.sha256) continue;
        const oldSha256 = previous?.newSha256 ?? null;
        insert.run(sessionId, path, oldSha256, file.sha256, now);
        this.appendLedgerWithinTransaction(sessionId, {
          kind: "source-change", path, oldSha256, newSha256: file.sha256,
          attribution: "external_or_unknown", reason: "workspace-snapshot-reconciliation",
        }, now);
        this.database.prepare("UPDATE working_set SET status = 'STALE' WHERE session_id = ? AND path = ?").run(sessionId, path);
        changed.push(path);
      }
      if (changed.length) {
        this.database.prepare("UPDATE test_evidence SET status = 'stale' WHERE session_id = ? AND status = 'passed'").run(sessionId);
        this.appendLedgerWithinTransaction(sessionId, {
          kind: "test-evidence-invalidated", reason: `Workspace changed outside a recorded Macus write: ${changed.slice(0, 20).join(", ")}`,
        }, now);
      }
      this.database.exec("COMMIT");
      return changed;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  invalidateWorkspaceState(sessionId: string, reason: string): void {
    const cleanReason = reason.trim().slice(0, 500);
    if (!cleanReason) throw new Error("Workspace invalidation requires a reason");
    const now = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.getSession(sessionId)) throw new Error(`Unknown session ${sessionId}`);
      this.database.prepare("UPDATE working_set SET status = 'STALE' WHERE session_id = ?").run(sessionId);
      this.database.prepare("UPDATE test_evidence SET status = 'stale' WHERE session_id = ? AND status = 'passed'").run(sessionId);
      this.appendLedgerWithinTransaction(sessionId, { kind: "workspace-state-invalidated", reason: cleanReason }, now);
      this.appendLedgerWithinTransaction(sessionId, { kind: "test-evidence-invalidated", reason: cleanReason }, now);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recordWorkingSetEntry(input: Omit<WorkingSetEntry, "lastAccessedAt">): WorkingSetEntry {
    const normalizedPath = normalizeRelativePath(input.path);
    if (!normalizedPath) {
      throw new Error("Working-set path must be repository-relative");
    }
    const statuses = new Set(["ACTIVE", "RELATED", "DISCOVERED", "STALE"]);
    const tiers = new Set(["HOT", "WARM", "COLD"]);
    if (!statuses.has(input.status) || !tiers.has(input.tier)) throw new Error("Invalid working-set status or tier");
    if (!Number.isSafeInteger(input.startLine) || input.startLine < 1 || !Number.isSafeInteger(input.endLine) || input.endLine < input.startLine) {
      throw new Error("Working-set source range is invalid");
    }
    if (input.sourceSha256 !== null && !/^[a-f0-9]{64}$/i.test(input.sourceSha256)) throw new Error("Working-set source hash is invalid");
    const entry: WorkingSetEntry = { ...input, path: normalizedPath, lastAccessedAt: new Date().toISOString() };
    this.database.prepare(`
      INSERT INTO working_set(session_id, path, source_sha256, status, tier, start_line, end_line, symbol_id, reason, last_accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, path) DO UPDATE SET source_sha256=excluded.source_sha256,
        status=excluded.status, tier=excluded.tier, start_line=excluded.start_line,
        end_line=excluded.end_line, symbol_id=excluded.symbol_id, reason=excluded.reason,
        last_accessed_at=excluded.last_accessed_at
    `).run(entry.sessionId, entry.path, entry.sourceSha256, entry.status, entry.tier, entry.startLine, entry.endLine, entry.symbolId, entry.reason, entry.lastAccessedAt);
    this.database.prepare(`
      DELETE FROM working_set WHERE session_id = ? AND path IN (
        SELECT path FROM working_set WHERE session_id = ? ORDER BY last_accessed_at DESC, path LIMIT -1 OFFSET 512
      )
    `).run(entry.sessionId, entry.sessionId);
    return entry;
  }

  listWorkingSet(sessionId: string): WorkingSetEntry[] {
    return this.database.prepare(`
      SELECT session_id AS sessionId, path, source_sha256 AS sourceSha256, status, tier,
        start_line AS startLine, end_line AS endLine, symbol_id AS symbolId, reason, last_accessed_at AS lastAccessedAt
      FROM working_set WHERE session_id = ? ORDER BY last_accessed_at DESC, path
    `).all(sessionId) as unknown as WorkingSetEntry[];
  }

  markWorkingSetStale(sessionId: string, path: string): void {
    this.database.prepare("UPDATE working_set SET status = 'STALE' WHERE session_id = ? AND path = ?").run(sessionId, path);
  }

  appendLedgerRevision(sessionId: string, payload: unknown): LedgerRevision {
    const serialized = JSON.stringify(payload);
    if (!serialized || Buffer.byteLength(serialized, "utf8") > 64 * 1024) throw new Error("Ledger revision must be serializable and at most 64 KiB");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const session = this.database.prepare("SELECT state_revision AS revision FROM sessions WHERE session_id = ?").get(sessionId) as { revision: number } | undefined;
      if (!session) throw new Error(`Unknown session ${sessionId}`);
      const revision = session.revision + 1;
      const createdAt = new Date().toISOString();
      this.database.prepare("UPDATE sessions SET state_revision = ?, updated_at = ? WHERE session_id = ?").run(revision, createdAt, sessionId);
      this.database.prepare("INSERT INTO ledger_revisions(session_id, revision, payload_json, created_at) VALUES (?, ?, ?, ?)").run(sessionId, revision, serialized, createdAt);
      this.database.exec("COMMIT");
      return { sessionId, revision, createdAt, payload: JSON.parse(serialized) as unknown };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  recordWorkflowNote(sessionId: string, kind: "goal" | "decision" | "next-action" | "blocker", text: string, provenance = "user-command"): LedgerRevision {
    const normalized = text.trim();
    if (!normalized || Buffer.byteLength(normalized, "utf8") > 4000) throw new Error("Workflow note must contain 1 to 4000 UTF-8 bytes");
    return this.appendLedgerRevision(sessionId, { kind, text: normalized, provenance: provenance.slice(0, 100) });
  }

  listActiveBlockers(sessionId: string): Array<{ revision: number; text: string; createdAt: string }> {
    const revisions = this.listLedgerRevisions(sessionId);
    const resolved = new Set(revisions.flatMap((revision) => {
      const payload = revision.payload as { kind?: unknown; blockerRevision?: unknown } | null;
      return payload?.kind === "blocker-resolved" && Number.isSafeInteger(payload.blockerRevision) ? [payload.blockerRevision as number] : [];
    }));
    return revisions.flatMap((revision) => {
      const payload = revision.payload as { kind?: unknown; text?: unknown } | null;
      return payload?.kind === "blocker" && !resolved.has(revision.revision)
        ? [{ revision: revision.revision, text: typeof payload.text === "string" ? payload.text : "Recorded blocker", createdAt: revision.createdAt }]
        : [];
    });
  }

  resolveWorkflowBlocker(sessionId: string, blockerRevision: number): LedgerRevision {
    if (!Number.isSafeInteger(blockerRevision) || blockerRevision < 1) throw new Error("Blocker revision must be a positive integer");
    const blocker = this.listActiveBlockers(sessionId).find((item) => item.revision === blockerRevision);
    if (!blocker) throw new Error(`No active blocker at ledger revision ${blockerRevision} in this session`);
    return this.appendLedgerRevision(sessionId, { kind: "blocker-resolved", blockerRevision, provenance: "user-command" });
  }

  listLedgerRevisions(sessionId: string): LedgerRevision[] {
    return (this.database.prepare("SELECT session_id AS sessionId, revision, payload_json AS payload, created_at AS createdAt FROM ledger_revisions WHERE session_id = ? ORDER BY revision").all(sessionId) as Array<{ sessionId: string; revision: number; payload: string; createdAt: string }>).map((row) => ({ ...row, payload: JSON.parse(row.payload) as unknown }));
  }

  createCheckpoint(sessionId: string, payload: Record<string, unknown>, checkpointIdInput = randomUUID()): StateCheckpoint {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(checkpointIdInput)) throw new Error("Invalid checkpoint ID");
    const serialized = JSON.stringify(payload);
    if (!serialized || Buffer.byteLength(serialized, "utf8") > 256 * 1024) throw new Error("Checkpoint must be serializable and at most 256 KiB");
    const checkpointId = checkpointIdInput;
    const createdAt = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const session = this.database.prepare("SELECT state_revision AS revision, worktree_root AS worktreeRoot, git_directory AS gitDirectory FROM sessions WHERE session_id = ?").get(sessionId) as { revision: number; worktreeRoot: string; gitDirectory: string | null } | undefined;
      if (!session) throw new Error(`Unknown session ${sessionId}`);
      const revision = session.revision;
      const unresolved = this.listUnresolvedExecutions(sessionId);
      const checkpointPayload = JSON.stringify({ ...payload, schemaVersion: 1, sessionId, worktreeRoot: session.worktreeRoot, gitDirectory: session.gitDirectory, transcriptEntryId: payload.transcriptEntryId ?? null, stateRevision: revision, unresolvedExecutions: unresolved });
      if (Buffer.byteLength(checkpointPayload, "utf8") > 256 * 1024) throw new Error("Checkpoint exceeds 256 KiB after recovery metadata");
      this.database.prepare("INSERT INTO checkpoints(checkpoint_id, session_id, state_revision, payload_json, created_at) VALUES (?, ?, ?, ?, ?)").run(checkpointId, sessionId, revision, checkpointPayload, createdAt);
      this.database.exec("COMMIT");
      return { checkpointId, sessionId, stateRevision: revision, createdAt, payload: JSON.parse(checkpointPayload) as Record<string, unknown> };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listCheckpoints(sessionId: string): StateCheckpoint[] {
    return (this.database.prepare("SELECT checkpoint_id AS checkpointId, session_id AS sessionId, state_revision AS stateRevision, payload_json AS payload, created_at AS createdAt FROM checkpoints WHERE session_id = ? ORDER BY created_at, checkpoint_id").all(sessionId) as Array<{ checkpointId: string; sessionId: string; stateRevision: number; payload: string; createdAt: string }>).map((row) => ({ ...row, payload: JSON.parse(row.payload) as Record<string, unknown> }));
  }

  getCheckpoint(sessionId: string, checkpointId: string, expectedWorktreeRoot: string): StateCheckpoint {
    const session = this.getSession(sessionId);
    if (!session || session.worktreeRoot !== expectedWorktreeRoot) throw new Error("Checkpoint worktree identity does not match the active session");
    const row = this.database.prepare("SELECT checkpoint_id AS checkpointId, session_id AS sessionId, state_revision AS stateRevision, payload_json AS payload, created_at AS createdAt FROM checkpoints WHERE session_id = ? AND checkpoint_id = ?").get(sessionId, checkpointId) as { checkpointId: string; sessionId: string; stateRevision: number; payload: string; createdAt: string } | undefined;
    if (!row) throw new Error(`Unknown checkpoint ${checkpointId}`);
    return { ...row, payload: JSON.parse(row.payload) as Record<string, unknown> };
  }

  prepareExecution(input: {
    executionId: string;
    sessionId: string;
    runId?: string;
    toolCallId?: string;
    redactedInput: unknown;
    effectClass: "read" | "workspace-write" | "test-build" | "external" | "destructive";
  }): void {
    const now = new Date().toISOString();
    if (input.toolCallId) {
      const previous = this.database.prepare(
        "SELECT execution_id AS executionId, status FROM executions WHERE session_id = ? AND tool_call_id = ? ORDER BY created_at DESC LIMIT 1",
      ).get(input.sessionId, input.toolCallId) as { executionId: string; status: string } | undefined;
      if (previous) {
        throw new Error(`Tool call ${input.toolCallId} already has durable execution ${previous.executionId} (${previous.status}); automatic replay is refused. Inspect the execution and issue a new tool request only after resolving its outcome.`);
      }
    }
    this.database.prepare(
      `INSERT INTO executions(execution_id, session_id, run_id, tool_call_id, status,
        redacted_input_json, effect_class, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?, ?)`,
    ).run(
      input.executionId,
      input.sessionId,
      input.runId ?? null,
      input.toolCallId ?? null,
      JSON.stringify(input.redactedInput),
      input.effectClass,
      now,
      now,
    );
    this.recordExecutionEvent(input.executionId, "prepared", {});
  }

  recordExecutionEvent(executionId: string, status: string, payload: unknown): void {
    const allowed = new Set(["prepared", "started", "completed", "failed", "cancelled", "unknown"]);
    if (!allowed.has(status)) throw new Error(`Invalid execution status ${status}`);
    const now = new Date().toISOString();
    const eventId = randomUUID();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const found = this.database.prepare(
        "SELECT status FROM executions WHERE execution_id = ?",
      ).get(executionId) as { status: string } | undefined;
      if (!found) throw new Error(`Unknown execution ${executionId}`);
      const terminal = new Set(["completed", "failed", "cancelled", "unknown"]);
      if (terminal.has(found.status) || (status === "prepared" && found.status !== "prepared")) {
        throw new Error(`Invalid execution transition ${found.status} -> ${status}`);
      }
      this.database.prepare(
        "INSERT INTO execution_events(execution_id, event_id, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(executionId, eventId, status, JSON.stringify(payload), now);
      this.database.prepare(
        "UPDATE executions SET status = ?, updated_at = ? WHERE execution_id = ?",
      ).run(status, now, executionId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  getExecutionStatus(executionId: string): string | undefined {
    const row = this.database.prepare(
      "SELECT status FROM executions WHERE execution_id = ?",
    ).get(executionId) as { status: string } | undefined;
    return row?.status;
  }

  getExecutionSessionId(executionId: string): string | undefined {
    const row = this.database.prepare(
      "SELECT session_id AS sessionId FROM executions WHERE execution_id = ?",
    ).get(executionId) as { sessionId: string } | undefined;
    return row?.sessionId;
  }

  listUnresolvedExecutions(sessionId: string): Array<{ executionId: string; status: string }> {
    const rows = this.database.prepare(
      `SELECT execution_id AS executionId, status FROM executions
       WHERE session_id = ? AND (
         status IN ('prepared', 'started', 'unknown') OR
         (status = 'cancelled' AND effect_class IN ('workspace-write', 'test-build', 'external', 'destructive'))
       ) ORDER BY created_at`,
    ).all(sessionId) as Array<{ executionId: string; status: string }>;
    return rows.map((row) => ({ executionId: row.executionId, status: row.status }));
  }

  close(): void {
    this.database.close();
  }
}

function initializeSchema(database: DatabaseSync): void {
  const hasMetadataTable = database
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_metadata'")
    .get();
  const versionRow = hasMetadataTable
    ? (database.prepare("SELECT version FROM schema_metadata LIMIT 1").get() as
        | { version: number }
        | undefined)
    : undefined;

  if (versionRow && versionRow.version > STATE_SCHEMA_VERSION) {
    throw new Error(
      `State database schema ${versionRow.version} is newer than supported schema ${STATE_SCHEMA_VERSION}; state was preserved`,
    );
  }
  if (versionRow?.version === STATE_SCHEMA_VERSION) return;

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_metadata (
        version INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        worktree_root TEXT NOT NULL,
        git_directory TEXT,
        repository_branch TEXT,
        repository_head TEXT,
        repository_identity_captured INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        state_revision INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS tasks (
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        task_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(session_id, task_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ledger_revisions (
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(session_id, revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS executions (
        execution_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        run_id TEXT REFERENCES runs(run_id),
        tool_call_id TEXT,
        status TEXT NOT NULL,
        redacted_input_json TEXT NOT NULL,
        effect_class TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS execution_events (
        execution_id TEXT NOT NULL REFERENCES executions(execution_id),
        event_id TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(execution_id, event_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS test_evidence (
        evidence_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        run_id TEXT REFERENCES runs(run_id),
        snapshot_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS working_set (
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        path TEXT NOT NULL,
        source_sha256 TEXT,
        status TEXT NOT NULL CHECK(status IN ('ACTIVE','RELATED','DISCOVERED','STALE')),
        tier TEXT NOT NULL CHECK(tier IN ('HOT','WARM','COLD')),
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        symbol_id TEXT,
        reason TEXT NOT NULL,
        last_accessed_at TEXT NOT NULL,
        PRIMARY KEY(session_id, path)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS checkpoints (
        checkpoint_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        state_revision INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_changes (
        session_id TEXT NOT NULL REFERENCES sessions(session_id),
        path TEXT NOT NULL,
        old_sha256 TEXT,
        new_sha256 TEXT,
        attribution TEXT NOT NULL CHECK(attribution IN ('agent','pre_existing','external_or_unknown')),
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `);

    const ensureColumn = (table: string, column: string, definition: string): void => {
      const columns = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
      if (!columns.some((item) => item.name === column)) database.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
    };
    // Older durable-state layouts predate workflow/run linkage. Nullable
    // additions preserve existing rows and make recovery uncertainty explicit.
    ensureColumn("sessions", "state_revision", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("sessions", "repository_branch", "TEXT");
    ensureColumn("sessions", "repository_head", "TEXT");
    ensureColumn("sessions", "repository_identity_captured", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn("executions", "run_id", "TEXT REFERENCES runs(run_id)");
    ensureColumn("executions", "tool_call_id", "TEXT");
    ensureColumn("executions", "effect_class", "TEXT NOT NULL DEFAULT 'external'");
    ensureColumn("test_evidence", "run_id", "TEXT REFERENCES runs(run_id)");

    if (!versionRow) {
      database
        .prepare("INSERT INTO schema_metadata(version) VALUES (?)")
        .run(STATE_SCHEMA_VERSION);
    } else {
      database
        .prepare("UPDATE schema_metadata SET version = ?")
        .run(STATE_SCHEMA_VERSION);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function normalizeRelativePath(path: string): string {
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) return "";
  return normalized;
}

export function openStateStore(databasePath: string): StateStore {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    timeout: 0,
  });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = FULL");
    initializeSchema(database);
    chmodSync(databasePath, 0o600);
    return new StateStore(database);
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * Hold a SQLite exclusive file lock for the duration of one mutating run.
 * SQLite releases the OS-backed lock automatically if the process exits.
 */
export function acquireWorktreeMutationLock(lockDatabasePath: string): () => void {
  mkdirSync(dirname(lockDatabasePath), { recursive: true, mode: 0o700 });
  const lockDatabase = new DatabaseSync(lockDatabasePath, { timeout: 0 });
  try {
    lockDatabase.exec("PRAGMA locking_mode = EXCLUSIVE");
    lockDatabase.exec("BEGIN EXCLUSIVE");
    chmodSync(lockDatabasePath, 0o600);
  } catch (error) {
    lockDatabase.close();
    if (error instanceof Error && /locked|busy/i.test(error.message)) {
      throw new Error("Another Macus process is already mutating this worktree");
    }
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      lockDatabase.exec("ROLLBACK");
    } finally {
      lockDatabase.close();
    }
  };
}
