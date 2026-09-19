import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
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
    const store = openStateStore(join(cwd, ".macus", "state", "state.db"));
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
