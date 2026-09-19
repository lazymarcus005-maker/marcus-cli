import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { inspectGit } from "../src/workflow/git-inspection.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

describe("bounded Git inspection", () => {
  it("returns targeted diff, log, show, and blame through fixed argument forms", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-git-inspect-"));
    roots.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: root });
    await writeFile(join(root, "src.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "src.ts"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture commit"], { cwd: root });
    await writeFile(join(root, "src.ts"), "export const value = 2;\n");

    const diff = await inspectGit({ root, operation: "diff", path: "src.ts" });
    assert.match(diff.output, /value = 2/);
    assert.match((await inspectGit({ root, operation: "log" })).output, /fixture commit/);
    assert.match((await inspectGit({ root, operation: "show", revision: "HEAD" })).output, /fixture commit/);
    assert.match((await inspectGit({ root, operation: "blame", path: "src.ts", startLine: 1, endLine: 1 })).output, /export const value = 2/);
    await assert.rejects(inspectGit({ root, operation: "blame", path: "../../../../etc/passwd" }), /escapes/);
    await assert.rejects(inspectGit({ root, operation: "show", revision: "--output=bad" }), /accepts HEAD/);
  });

  it("propagates cancellation before launching a Git operation", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-git-cancel-"));
    roots.push(root);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(inspectGit({ root, operation: "log", signal: controller.signal }), /cancelled/);
  });
});
