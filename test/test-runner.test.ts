import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { openStateStore } from "../src/state/state-store.js";
import { runTestCommand } from "../src/workflow/test-runner.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

describe("bounded test execution and durable evidence", () => {
  it("runs an approved command and persists evidence tied to the unchanged worktree snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-test-runner-"));
    roots.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "macus@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Macus test"], { cwd: root });
    await writeFile(join(root, ".gitignore"), ".macus/\n");
    await writeFile(join(root, "source.ts"), "export const stable = true;\n");
    execFileSync("git", ["add", ".gitignore", "source.ts"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const store = openStateStore(join(root, ".macus", "state", "state.db"));
    store.createSession({ sessionId: "test-session", worktreeRoot: root, gitDirectory: join(root, ".git") });
    const task = store.createTask({ sessionId: "test-session", title: "Run baseline tests" });
    store.transitionTask("test-session", task.id, "in_progress");
    const result = await runTestCommand({
      root,
      sessionId: "test-session",
      command: "MACUS_API_TOKEN=fake-secret node -e 'process.stdout.write(JSON.stringify({summary:{counts:{tests:2,passed:2,failed:0}}}))'",
      format: "node-json",
      stateStore: store,
      authorize: async () => true,
    });
    assert.equal(result.evidence.status, "passed");
    assert.equal(result.evidence.tests, 2);
    const persisted = store.listTestEvidence("test-session")[0]!;
    assert.equal(persisted.evidenceId, result.evidenceId);
    assert.equal(JSON.stringify(persisted.payload).includes("fake-secret"), false);
    assert.deepEqual(store.listTasks("test-session")[0]?.evidenceIds, [result.evidenceId]);
    store.transitionTask("test-session", task.id, "completed");
    assert.equal(store.listTestEvidence("test-session")[0]?.status, "passed");
    store.close();
  });

  it("records unknown-runner execution without reporting a test pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-unknown-runner-"));
    roots.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, "source.ts"), "export const stable = true;\n");
    execFileSync("git", ["add", "source.ts"], { cwd: root });
    execFileSync("git", ["-c", "user.email=macus@example.invalid", "-c", "user.name=Macus test", "commit", "-qm", "fixture"], { cwd: root });
    const store = openStateStore(join(root, ".macus", "state", "state.db"));
    store.createSession({ sessionId: "unknown-runner", worktreeRoot: root, gitDirectory: join(root, ".git") });
    const result = await runTestCommand({ root, sessionId: "unknown-runner", command: "true", format: "unknown", stateStore: store, authorize: async () => true });
    assert.equal(result.evidence.status, "unknown");
    assert.match(result.evidence.reason ?? "", /unsupported/);
    store.close();
  });

  it("applies trusted timeout, output, log, and environment bounds to test commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-test-settings-"));
    roots.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "macus@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Macus test"], { cwd: root });
    await writeFile(join(root, "source.ts"), "export const stable = true;\n");
    execFileSync("git", ["add", "source.ts"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const store = openStateStore(join(root, ".macus", "state", "state.db"));
    store.createSession({ sessionId: "configured-runner", worktreeRoot: root, gitDirectory: join(root, ".git") });
    const previous = process.env.MACUS_CONFIG_TEST_SECRET;
    process.env.MACUS_CONFIG_TEST_SECRET = "not-forwarded";
    try {
      const execution = {
        commandTimeoutMs: 500,
        testBuildTimeoutMs: 30,
        terminationGraceMs: 20,
        maxOutputMemoryBytes: 1024,
        maxLogBytes: 4096,
        environmentAllowlist: ["PATH"],
      };
      const filtered = await runTestCommand({
        root,
        sessionId: "configured-runner",
        command: "node -e 'process.stdout.write(process.env.MACUS_CONFIG_TEST_SECRET ?? \"missing\")'",
        format: "unknown",
        stateStore: store,
        authorize: async () => true,
        execution,
        protectedCredentialEnvironmentNames: ["MACUS_CONFIG_TEST_SECRET"],
      });
      assert.equal(filtered.result.stdout, "missing");

      const bounded = await runTestCommand({
        root,
        sessionId: "configured-runner",
        command: "node -e 'process.stdout.write(\"x\".repeat(10000))'",
        format: "unknown",
        stateStore: store,
        authorize: async () => true,
        execution,
      });
      assert.equal(Buffer.byteLength(bounded.result.stdout, "utf8"), execution.maxOutputMemoryBytes);
      assert.equal(bounded.result.outputComplete, false);
      assert.equal(bounded.result.logTruncated, true);

      const timedOut = await runTestCommand({
        root,
        sessionId: "configured-runner",
        command: "node -e 'setTimeout(() => {}, 1000)'",
        format: "unknown",
        stateStore: store,
        authorize: async () => true,
        execution,
      });
      assert.equal(timedOut.result.timedOut, true);
    } finally {
      if (previous === undefined) delete process.env.MACUS_CONFIG_TEST_SECRET;
      else process.env.MACUS_CONFIG_TEST_SECRET = previous;
      store.close();
    }
  });

  it("rejects an unchanged pre-existing report even when its timestamp is in the future", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-stale-report-"));
    roots.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "macus@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Macus test"], { cwd: root });
    await writeFile(join(root, ".gitignore"), ".macus/\nresults.xml\n");
    await writeFile(join(root, "source.ts"), "export const stable = true;\n");
    await writeFile(join(root, "results.xml"), "<testsuite tests=\"1\" failures=\"0\" errors=\"0\"/>\n");
    execFileSync("git", ["add", ".gitignore", "source.ts"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    const future = new Date(Date.now() + 60_000);
    await utimes(join(root, "results.xml"), future, future);
    const store = openStateStore(join(root, ".macus", "state", "state.db"));
    store.createSession({ sessionId: "stale-report", worktreeRoot: root, gitDirectory: join(root, ".git") });
    const result = await runTestCommand({
      root,
      sessionId: "stale-report",
      command: "true",
      reportPath: "results.xml",
      format: "junit",
      stateStore: store,
      authorize: async () => true,
    });
    assert.equal(result.evidence.status, "unknown");
    assert.match(result.evidence.reason ?? "", /unchanged/);
    const persisted = store.listTestEvidence("stale-report")[0]!;
    assert.equal((persisted.payload as { reportFresh: boolean }).reportFresh, false);
    store.close();
  });
});
