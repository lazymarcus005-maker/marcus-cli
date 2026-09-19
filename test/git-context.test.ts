import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { after, describe, it } from "node:test";
import { readGitContext } from "../src/workflow/git-context.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

describe("Git context and source snapshot", () => {
  it("reports dirty and untracked files and changes the digest when workspace bytes change", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-git-context-"));
    roots.push(root);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "macus@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Macus test"], { cwd: root });
    await writeFile(join(root, "tracked.ts"), "export const value = 1;\n");
    execFileSync("git", ["add", "tracked.ts"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    await writeFile(join(root, "tracked.ts"), "export const value = 2;\n");
    await writeFile(join(root, "new.ts"), "export const added = true;\n");

    const before = await readGitContext(root);
    assert.deepEqual(before.changedFiles.map((file) => file.path).sort(), ["new.ts", "tracked.ts"]);
    assert.equal(before.changedFiles.find((file) => file.path === "new.ts")?.status, "untracked");
    assert.ok(before.diff.includes("value = 2"));
    await writeFile(join(root, "new.ts"), "export const added = false;\n");
    const afterChange = await readGitContext(root);
    assert.notEqual(before.snapshotDigest, afterChange.snapshotDigest);
  });
});
