import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { resolveRepositoryInstructions } from "../src/context/instructions.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

describe("repository instruction resolution", () => {
  it("loads ancestors before deeper scopes and preserves source precedence and hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-instructions-"));
    roots.push(root);
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "root guidance");
    await writeFile(join(nested, "CLAUDE.md"), "local guidance");
    await writeFile(join(nested, "MACUS.md"), "local top-priority guidance");

    const instructions = await resolveRepositoryInstructions(root, nested);
    assert.deepEqual(instructions.map(({ content }) => content), [
      "root guidance",
      "local guidance",
      "local top-priority guidance",
    ]);
    assert.equal(instructions[1]?.precedence, 0);
    assert.equal(instructions[2]?.precedence, 2);
    assert.match(instructions[0]?.sha256 ?? "", /^[a-f0-9]{64}$/);
  });

  it("rejects targets outside the authorized root", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-instructions-root-"));
    const outside = await mkdtemp(join(tmpdir(), "macus-instructions-outside-"));
    roots.push(root, outside);
    await assert.rejects(resolveRepositoryInstructions(root, outside), /escapes/);
  });

  it("refuses to read repository instructions through a symlink outside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-instructions-link-root-"));
    const outside = await mkdtemp(join(tmpdir(), "macus-instructions-link-outside-"));
    roots.push(root, outside);
    await writeFile(join(outside, "AGENTS.md"), "external instructions");
    await symlink(join(outside, "AGENTS.md"), join(root, "AGENTS.md"));
    await assert.rejects(resolveRepositoryInstructions(root, root), /instruction file escapes/);
  });
});
