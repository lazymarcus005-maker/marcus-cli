import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { PolicyExecutor } from "../src/execution/policy-executor.js";
import { ExecutionLogStore } from "../src/execution/execution-log-store.js";
import { openStateStore } from "../src/state/state-store.js";

const directories: string[] = [];
after(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

async function fixtureDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "macus-execution-test-"));
  directories.push(path);
  return path;
}

describe("policy-controlled command execution", () => {
  it("runs an explicitly authorized command and returns bounded output", async () => {
    const cwd = await fixtureDirectory();
    const executor = new PolicyExecutor({
      authorize: async () => true,
      maxOutputBytes: 128,
    });
    const result = await executor.execute({
      command: `${process.execPath} -e "process.stdout.write('safe output')"`,
      cwd,
      timeoutMs: 5000,
      allowedEnvironment: ["PATH"],
    });

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "safe output");
    assert.equal(result.outputComplete, true);
    assert.equal(result.cancelled, false);
  });

  it("does not start a command when authorization is denied", async () => {
    const cwd = await fixtureDirectory();
    const executor = new PolicyExecutor({ authorize: async () => false });

    await assert.rejects(
      executor.execute({
        command: "touch should-not-exist",
        cwd,
        timeoutMs: 1000,
        allowedEnvironment: [],
      }),
      /denied by policy/,
    );
  });

  it("does not authorize, journal, or launch a command when cancelled before launch", async () => {
    const cwd = await fixtureDirectory();
    const controller = new AbortController();
    controller.abort();
    let authorized = false;
    let prepared = false;
    let recorded = false;
    const executor = new PolicyExecutor({
      authorize: async () => { authorized = true; return true; },
      journal: {
        prepareExecution: () => { prepared = true; },
        recordExecutionEvent: () => { recorded = true; },
      },
    });
    await assert.rejects(executor.execute({
      command: `${process.execPath} -e "require('fs').writeFileSync('launched', 'yes')"`,
      cwd,
      timeoutMs: 1000,
      allowedEnvironment: ["PATH"],
      signal: controller.signal,
      identity: { executionId: "cancel-before-launch", sessionId: "session", effectClass: "workspace-write" },
    }), /cancelled before authorization/);
    assert.equal(authorized, false);
    assert.equal(prepared, false);
    assert.equal(recorded, false);
    await assert.rejects(readFile(join(cwd, "launched")), { code: "ENOENT" });
  });

  it("does not launch when cancellation arrives while authorization is pending", async () => {
    const cwd = await fixtureDirectory();
    const controller = new AbortController();
    let markAuthorizationStarted!: () => void;
    const authorizationStarted = new Promise<void>((resolve) => { markAuthorizationStarted = resolve; });
    let finishAuthorization!: () => void;
    const authorizationGate = new Promise<void>((resolve) => { finishAuthorization = resolve; });
    let prepared = false;
    let recorded = false;
    const executor = new PolicyExecutor({
      authorize: async () => {
        markAuthorizationStarted();
        await authorizationGate;
        return true;
      },
      journal: {
        prepareExecution: () => { prepared = true; },
        recordExecutionEvent: () => { recorded = true; },
      },
    });
    const execution = executor.execute({
      command: `${process.execPath} -e "require('fs').writeFileSync('launched-after-cancel', 'yes')"`,
      cwd,
      timeoutMs: 1000,
      allowedEnvironment: ["PATH"],
      signal: controller.signal,
      identity: { executionId: "cancel-during-authorization", sessionId: "session", effectClass: "workspace-write" },
    });
    await authorizationStarted;
    controller.abort();
    finishAuthorization();
    await assert.rejects(execution, /cancelled before launch/);
    assert.equal(prepared, false);
    assert.equal(recorded, false);
    await assert.rejects(readFile(join(cwd, "launched-after-cancel")), { code: "ENOENT" });
  });

  it("does not spawn after cancellation while allocating the execution log", async () => {
    const cwd = await fixtureDirectory();
    const controller = new AbortController();
    const store = openStateStore(join(cwd, ".macus", "state", "state.db"));
    store.createSession({ sessionId: "cancel-during-prepare", worktreeRoot: cwd, gitDirectory: null });
    class AbortDuringLogCreation extends ExecutionLogStore {
      override async create(sessionId: string, executionId: string, secrets: string[] = []) {
        controller.abort();
        return super.create(sessionId, executionId, secrets);
      }
    }
    const statuses: string[] = [];
    const executor = new PolicyExecutor({
      authorize: async () => true,
      journal: {
        prepareExecution: (input) => store.prepareExecution(input),
        recordExecutionEvent: (executionId, status, payload) => {
          statuses.push(status);
          store.recordExecutionEvent(executionId, status, payload);
        },
      },
      logStore: new AbortDuringLogCreation(cwd),
    });
    try {
      await assert.rejects(executor.execute({
        command: `${process.execPath} -e "require('fs').writeFileSync('should-not-launch', 'bad')"`,
        cwd,
        timeoutMs: 5000,
        allowedEnvironment: ["PATH"],
        signal: controller.signal,
        identity: { executionId: "cancel-before-spawn", sessionId: "cancel-during-prepare", effectClass: "external" },
      }), /cancelled before launch/);
      assert.deepEqual(statuses, ["failed"]);
      assert.equal(store.getExecutionStatus("cancel-before-spawn"), "failed");
      assert.deepEqual(store.listUnresolvedExecutions("cancel-during-prepare"), []);
      await assert.rejects(readFile(join(cwd, "should-not-launch")), { code: "ENOENT" });
    } finally {
      store.close();
    }
  });

  it("passes trusted credentials only after exact per-command authorization", async () => {
    const cwd = await fixtureDirectory();
    const prior = process.env.MACUS_EXPLICIT_TEST_KEY;
    process.env.MACUS_EXPLICIT_TEST_KEY = "credential-value";
    try {
      const executor = new PolicyExecutor({
        authorize: async () => ({ approved: true, authorizedEnvironmentNames: ["MACUS_EXPLICIT_TEST_KEY"] }),
        deniedEnvironmentNames: ["MACUS_EXPLICIT_TEST_KEY"],
        authorizableEnvironmentNames: ["MACUS_EXPLICIT_TEST_KEY"],
      });
      const result = await executor.execute({
        command: `${process.execPath} -e "process.stdout.write(process.env.MACUS_EXPLICIT_TEST_KEY || 'blocked')"`,
        cwd,
        timeoutMs: 5000,
        allowedEnvironment: ["PATH"],
      });
      assert.equal(result.stdout, "[REDACTED]");
    } finally {
      if (prior === undefined) delete process.env.MACUS_EXPLICIT_TEST_KEY;
      else process.env.MACUS_EXPLICIT_TEST_KEY = prior;
    }
  });

  it("rejects authorization for an environment name outside the trusted credential set", async () => {
    const cwd = await fixtureDirectory();
    const executor = new PolicyExecutor({
      authorize: async () => ({ approved: true, authorizedEnvironmentNames: ["PATH"] }),
      deniedEnvironmentNames: ["TRUSTED_KEY"],
      authorizableEnvironmentNames: ["TRUSTED_KEY"],
    });
    await assert.rejects(executor.execute({
      command: "true",
      cwd,
      timeoutMs: 1000,
      allowedEnvironment: [],
    }), /outside the trusted credential set/);
  });

  it("bounds captured output and identifies incomplete capture", async () => {
    const cwd = await fixtureDirectory();
    const executor = new PolicyExecutor({
      authorize: async () => true,
      maxOutputBytes: 32,
    });
    const result = await executor.execute({
      command: `${process.execPath} -e "process.stdout.write('x'.repeat(100000))"`,
      cwd,
      timeoutMs: 5000,
      allowedEnvironment: ["PATH"],
    });

    assert.equal(Buffer.byteLength(result.stdout, "utf8"), 32);
    assert.equal(result.outputComplete, false);
  });

  it("terminates a timed-out process and reports the timeout", async () => {
    const cwd = await fixtureDirectory();
    const executor = new PolicyExecutor({ authorize: async () => true });
    const result = await executor.execute({
      command: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
      cwd,
      timeoutMs: 50,
      allowedEnvironment: ["PATH"],
      terminationGraceMs: 50,
    });

    assert.equal(result.timedOut, true);
    assert.equal(result.outputComplete, false);
  });

  it("terminates an aborted process group and reports cancellation", async () => {
    const cwd = await fixtureDirectory();
    const controller = new AbortController();
    const executor = new PolicyExecutor({ authorize: async () => true });
    const pending = executor.execute({
      command: `${process.execPath} -e "setTimeout(() => {}, 5000)"`,
      cwd,
      timeoutMs: 5000,
      allowedEnvironment: ["PATH"],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    assert.equal(result.cancelled, true);
    assert.equal(result.outputComplete, false);
  });

  it("removes terminal control sequences and redacts allowed credential values", async () => {
    const cwd = await fixtureDirectory();
    const prior = process.env.MACUS_TEST_SECRET;
    process.env.MACUS_TEST_SECRET = "secret-value";
    try {
      const executor = new PolicyExecutor({ authorize: async () => true });
      const result = await executor.execute({
        command: `${process.execPath} -e "process.stdout.write('\\u001b[31msecret-value\\u001b[0m')"`,
        cwd,
        timeoutMs: 5000,
        allowedEnvironment: ["PATH", "MACUS_TEST_SECRET"],
      });
      assert.equal(result.stdout, "[REDACTED]");
    } finally {
      if (prior === undefined) delete process.env.MACUS_TEST_SECRET;
      else process.env.MACUS_TEST_SECRET = prior;
    }
  });

  it("journals redacted intent before launch and observed completion", async () => {
    const cwd = await fixtureDirectory();
    const events: Array<{ status: string; payload: unknown }> = [];
    let prepared: unknown;
    const executor = new PolicyExecutor({
      authorize: async () => true,
      journal: {
        prepareExecution: (input) => { prepared = input; },
        recordExecutionEvent: (_id, status, payload) => { events.push({ status, payload }); },
      },
    });
    await executor.execute({
      command: "printf '%s' --token=private-value",
      cwd,
      timeoutMs: 5000,
      allowedEnvironment: ["PATH"],
      identity: { executionId: "journaled", sessionId: "session", effectClass: "external" },
    });
    assert.equal((prepared as { redactedInput: { command: string } }).redactedInput.command.includes("private-value"), false);
    assert.deepEqual(events.map((event) => event.status), ["started", "completed"]);
  });

  it("kills and observes the process group when the started journal acknowledgement fails", async () => {
    const cwd = await fixtureDirectory();
    const events: string[] = [];
    const executor = new PolicyExecutor({
      authorize: async () => true,
      journal: {
        prepareExecution: () => undefined,
        recordExecutionEvent: (_id, status) => {
          events.push(status);
          if (status === "started") throw new Error("journal unavailable");
        },
      },
    });
    const command = `${process.execPath} -e "setTimeout(() => require('fs').writeFileSync('orphan-side-effect', 'bad'), 800)"`;
    await assert.rejects(executor.execute({
      command,
      cwd,
      timeoutMs: 5000,
      allowedEnvironment: ["PATH"],
      identity: { executionId: "journal-start-failure", sessionId: "session", effectClass: "external" },
    }), /journal unavailable/);
    await new Promise((resolve) => setTimeout(resolve, 900));
    await assert.rejects(readFile(join(cwd, "orphan-side-effect")), { code: "ENOENT" });
    assert.deepEqual(events, ["started", "unknown"]);
  });

  it("preserves an unknown recovery gate when a side effect succeeds but result persistence fails", async () => {
    const cwd = await fixtureDirectory();
    const databasePath = join(cwd, ".macus", "state", "state.db");
    let store = openStateStore(databasePath);
    store.createSession({ sessionId: "result-persist-failure", worktreeRoot: cwd, gitDirectory: null });
    const journal = {
      prepareExecution: (input: Parameters<typeof store.prepareExecution>[0]) => store.prepareExecution(input),
      recordExecutionEvent: (id: string, status: string, payload: unknown) => {
        if (status === "completed") throw new Error("result persistence failed");
        store.recordExecutionEvent(id, status, payload);
      },
    };
    try {
      const executor = new PolicyExecutor({ authorize: async () => true, journal });
      await assert.rejects(executor.execute({
        command: `${process.execPath} -e "require('fs').writeFileSync('side-effect', 'done')"`,
        cwd,
        timeoutMs: 5000,
        allowedEnvironment: ["PATH"],
        identity: { executionId: "persist-result", sessionId: "result-persist-failure", effectClass: "workspace-write" },
      }), /result persistence failed/);
      assert.equal(await readFile(join(cwd, "side-effect"), "utf8"), "done");
      assert.deepEqual(store.listUnresolvedExecutions("result-persist-failure"), [
        { executionId: "persist-result", status: "unknown" },
      ]);
      store.close();
      store = openStateStore(databasePath);
      assert.equal(store.getExecutionStatus("persist-result"), "unknown");
      assert.deepEqual(store.listUnresolvedExecutions("result-persist-failure"), [
        { executionId: "persist-result", status: "unknown" },
      ]);
    } finally {
      store.close();
    }
  });

  it("marks a side effect unknown after the agent process crashes before completion persistence", async () => {
    const cwd = await fixtureDirectory();
    const databasePath = join(cwd, "state.db");
    const sideEffectPath = join(cwd, "side-effect");
    const stateStoreUrl = new URL("../src/state/state-store.ts", import.meta.url).href;
    const executorUrl = new URL("../src/execution/policy-executor.ts", import.meta.url).href;
    const script = `
      import { openStateStore } from ${JSON.stringify(stateStoreUrl)};
      import { PolicyExecutor } from ${JSON.stringify(executorUrl)};
      const store = openStateStore(${JSON.stringify(databasePath)});
      store.createSession({ sessionId: "process-crash", worktreeRoot: ${JSON.stringify(cwd)}, gitDirectory: null });
      const journal = {
        prepareExecution: (input) => store.prepareExecution(input),
        recordExecutionEvent: (id, status, payload) => {
          if (status === "completed") process.exit(73);
          store.recordExecutionEvent(id, status, payload);
        },
      };
      const command = ${JSON.stringify(`${JSON.stringify(process.execPath)} -e 'require("node:fs").writeFileSync(${JSON.stringify(sideEffectPath)}, "completed")'`)};
      await new PolicyExecutor({ authorize: async () => true, journal }).execute({
        command, cwd: ${JSON.stringify(cwd)}, timeoutMs: 5000, allowedEnvironment: ["PATH"],
        identity: { executionId: "crash-after-write", sessionId: "process-crash", effectClass: "workspace-write" },
      });
      process.exit(74);
    `;
    const crashed = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.equal(crashed.error, undefined, crashed.error?.message);
    assert.equal(crashed.status, 73, crashed.stderr);
    assert.equal(await readFile(sideEffectPath, "utf8"), "completed");

    const store = openStateStore(databasePath);
    try {
      assert.equal(store.getExecutionStatus("crash-after-write"), "started");
      assert.equal(store.markInterruptedExecutionsUnknown("process-crash"), 1);
      assert.equal(store.getExecutionStatus("crash-after-write"), "unknown");
      assert.equal(store.markInterruptedExecutionsUnknown("process-crash"), 0);
      assert.deepEqual(store.listUnresolvedExecutions("process-crash"), [
        { executionId: "crash-after-write", status: "unknown" },
      ]);
    } finally {
      store.close();
    }
  });

  it("spools the full redacted stream and returns an opaque log reference", async () => {
    const cwd = await fixtureDirectory();
    const executor = new PolicyExecutor({ authorize: async () => true, maxOutputBytes: 16, logStore: new ExecutionLogStore(cwd) });
    const result = await executor.execute({
      command: `${process.execPath} -e "process.stdout.write('full-output-'.repeat(100))"`,
      cwd,
      timeoutMs: 5000,
      allowedEnvironment: ["PATH"],
      identity: { executionId: "log-ref-test", sessionId: "log-session", effectClass: "external" },
    });
    assert.equal(result.outputComplete, false);
    assert.equal(result.logRef, "log-ref-test");
    const page = await new ExecutionLogStore(cwd).read("log-session", result.logRef!, 0, 64 * 1024);
    assert.ok(page.text.length > result.stdout.length);
    assert.match(page.text, /full-output/);
  });

  it("attributes shell-created worktree changes as external or unknown", async () => {
    const cwd = await fixtureDirectory();
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    await writeFile(join(cwd, "tracked.ts"), "before\n");
    execFileSync("git", ["add", "tracked.ts"], { cwd });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd });
    const store = openStateStore(join(cwd, ".macus", "state", "state.db"));
    store.createSession({ sessionId: "shell-attribution", worktreeRoot: cwd, gitDirectory: join(cwd, ".git") });
    const result = await new PolicyExecutor({ authorize: async () => true, journal: store }).execute({
      command: `${process.execPath} -e "require('fs').writeFileSync('tracked.ts', 'after\\n')"`,
      cwd,
      timeoutMs: 5000,
      allowedEnvironment: ["PATH"],
      identity: { executionId: "shell-attribution-run", sessionId: "shell-attribution", effectClass: "external" },
    });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(store.listSourceChanges("shell-attribution").map((change) => ({ path: change.path, attribution: change.attribution, reason: change.reason })), [{ path: "tracked.ts", attribution: "external_or_unknown", reason: "shell-command-worktree-change" }]);
    store.close();
  });
});
