import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isReadOnlyCommand, SessionApprovals } from "../src/cli-approvals.js";

describe("read-only command classification", () => {
  it("accepts plain read-only pipelines and git inspection", () => {
    for (const command of [
      "ls -la",
      "cat src/app.ts | grep value",
      "rg MARKER src/",
      "find . -name '*.ts'",
      "git status --short",
      "git log --oneline -5",
      "git branch -a",
      "git remote",
      "ls && git log",
      "pwd; git rev-parse HEAD",
    ]) {
      assert.equal(isReadOnlyCommand(command), true, command);
    }
  });

  it("rejects writes, executions, substitutions, and mutating git forms", () => {
    for (const command of [
      "echo hi > notes.txt",
      "printf '%s' x >> app.ts",
      "rm -rf build",
      "sudo ls",
      "npm test",
      "find . -delete",
      "find . -name '*.ts' -exec rm {} \\;",
      "git branch new-branch",
      "git remote add origin https://example.invalid",
      "git push origin main",
      "git commit -m x",
      "echo `rm file`",
      "ls $(rm file)",
      "",
    ]) {
      assert.equal(isReadOnlyCommand(command), false, command);
    }
  });
});

describe("session approval policy", () => {
  it("auto-approves read-only commands once the class is approved", async () => {
    const approvals = new SessionApprovals();
    let asks = 0;
    const decide = await approvals.authorize({ command: "git status --short", credentialEnvironmentNames: [] }, async () => {
      asks += 1;
      return { approved: true, authorizedEnvironmentNames: [] };
    });
    assert.equal(decide.approved, true);
    assert.equal(decide.auto, false);
    const repeat = await approvals.authorize({ command: "git diff", credentialEnvironmentNames: [] }, async () => {
      asks += 1;
      return { approved: true, authorizedEnvironmentNames: [] };
    });
    assert.equal(repeat.auto, true);
    assert.equal(repeat.reason, "read-only");
    assert.equal(asks, 1);
    const writes = await approvals.authorize({ command: "rm -rf build", credentialEnvironmentNames: [] }, async () => {
      asks += 1;
      return { approved: true, authorizedEnvironmentNames: [] };
    });
    assert.equal(writes.auto, false);
    assert.equal(asks, 2);
  });

  it("remembers exact commands even when they are not read-only", async () => {
    const approvals = new SessionApprovals();
    let asks = 0;
    await approvals.authorize({ command: "npm test --silent", credentialEnvironmentNames: [] }, async () => {
      asks += 1;
      return { approved: true, authorizedEnvironmentNames: [] };
    });
    const again = await approvals.authorize({ command: "npm test --silent", credentialEnvironmentNames: [] }, async () => {
      asks += 1;
      return { approved: true, authorizedEnvironmentNames: [] };
    });
    assert.equal(again.approved, true);
    assert.equal(again.auto, true);
    assert.equal(again.reason, "exact-match");
    assert.equal(asks, 1);
  });

  it("auto-approves commands carrying credential names but never grants the credentials", async () => {
    const approvals = new SessionApprovals();
    approvals.setYolo(true);
    const granted = await approvals.authorize({ command: "ls -la", credentialEnvironmentNames: ["MACUS_MODEL_API_KEY"] }, async () => {
      throw new Error("ask must not run in yolo mode");
    });
    assert.equal(granted.approved, true);
    assert.equal(granted.auto, true);
    assert.deepEqual(granted.authorizedEnvironmentNames, [], "auto paths must never grant credential variables");

    const manual = new SessionApprovals();
    const asked = await manual.authorize({ command: "deploy", credentialEnvironmentNames: ["MACUS_MODEL_API_KEY"] }, async () => ({
      approved: true,
      authorizedEnvironmentNames: ["MACUS_MODEL_API_KEY"],
    }));
    assert.deepEqual(asked.authorizedEnvironmentNames, ["MACUS_MODEL_API_KEY"], "explicit user approval can grant credentials");
  });

  it("keeps yolo from granting credentials and resets cleanly", async () => {
    const approvals = new SessionApprovals();
    approvals.setYolo(true);
    const yolo = await approvals.authorize({ command: "ls -la", credentialEnvironmentNames: [] }, async () => {
      throw new Error("ask must not run in yolo mode");
    });
    assert.equal(yolo.auto, true);
    assert.equal(yolo.reason, "yolo");
    approvals.reset();
    approvals.setYolo(false);
    await assert.rejects(
      approvals.authorize({ command: "ls -la", credentialEnvironmentNames: [] }, async () => {
        throw new Error("ask must run again after reset");
      }),
      /ask must run again/,
    );
  });
});
