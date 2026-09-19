import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { ExecutionLogStore } from "../src/execution/execution-log-store.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

describe("bounded execution log storage", () => {
  it("streams redacted, sanitized output and reads it only through a bounded opaque reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-log-store-"));
    roots.push(root);
    const store = new ExecutionLogStore(root, { maxExecutionBytes: 4096, maxTotalBytes: 8192, retentionDays: 7 });
    const log = await store.create("session-one", "execution-one", ["super-secret"]);
    await log.append("stdout", Buffer.from("before super-"));
    await log.append("stdout", Buffer.from("secret\u001b[31mred\u001b[0m after"));
    await log.finish();
    const page = await store.read("session-one", "execution-one", 0, 4096);
    assert.match(page.text, /before/);
    assert.match(page.text, /\[REDACTED\]/);
    assert.doesNotMatch(page.text, /super-secret|\u001b\[/);
    assert.equal(page.truncated, false);
    await assert.rejects(store.read("other-session", "execution-one", 0, 100), /not found|expired/);
    await assert.rejects(store.read("session-one", "../execution-one", 0, 100), /invalid/i);
  });

  it("caps each log and reports dropped bytes without exceeding the configured bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-log-cap-"));
    roots.push(root);
    const store = new ExecutionLogStore(root, { maxExecutionBytes: 64, maxTotalBytes: 128, retentionDays: 7 });
    const log = await store.create("session-two", "execution-two", []);
    await log.append("stderr", Buffer.from("x".repeat(1000)));
    await log.finish();
    assert.equal(log.truncated, true);
    assert.ok(log.bytesWritten <= 64);
    const page = await store.read("session-two", "execution-two", 0, 32);
    assert.equal(page.truncated, true);
  });
});
