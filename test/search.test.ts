import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { searchCode, smartRead } from "../src/retrieval/search.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "macus-search-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "one.ts"), "alpha\nneedle here\nomega\nneedle twice\n");
  await writeFile(join(root, "src", "two.ts"), "needle elsewhere\n");
  return root;
}

describe("deterministic search and smart reads", () => {
  it("defaults to literal matching, enforces a global result cap, and continues", async () => {
    const root = await fixture();
    const first = await searchCode({ root, query: "needle", limit: 2 });
    assert.equal(first.status, "matches");
    assert.equal(first.matches.length, 2);
    assert.equal(first.truncated, true);
    assert.ok(first.continuation);
    const next = await searchCode({ root, query: "needle", limit: 2, continuation: first.continuation! });
    assert.equal(next.matches.length, 1);
    assert.equal(next.truncated, false);
  });

  it("continues without repeating results when excluded files match first", async () => {
    const root = await fixture();
    await writeFile(join(root, ".macusignore"), "src/one.ts\n");
    await writeFile(join(root, "src", "three.ts"), "needle final\n");
    const first = await searchCode({ root, query: "needle", limit: 1 });
    const next = await searchCode({ root, query: "needle", limit: 1, continuation: first.continuation! });
    assert.notEqual(first.matches[0]?.path, next.matches[0]?.path, JSON.stringify({ first, next }));
  });

  it("rejects a continuation cursor after the indexed source snapshot changes", async () => {
    const root = await fixture();
    const first = await searchCode({ root, query: "needle", limit: 1 });
    assert.ok(first.continuation);
    await writeFile(join(root, "src", "two.ts"), "changed source with needle\n");
    const next = await searchCode({ root, query: "needle", limit: 1, continuation: first.continuation! });
    assert.equal(next.status, "invalid-query");
    assert.match(next.error ?? "", /Repository changed/);
  });

  it("reports invalid regex and no-match distinctly", async () => {
    const root = await fixture();
    assert.equal((await searchCode({ root, query: "absent" })).status, "no-match");
    assert.equal((await searchCode({ root, query: "[", regex: true })).status, "invalid-query");
  });

  it("returns numbered bounded source with a current hash and staleness signal", async () => {
    const root = await fixture();
    const first = await smartRead({ root, path: "src/one.ts", startLine: 2, endLine: 3 });
    assert.equal(first.text, "2: needle here\n3: omega");
    const stale = await smartRead({ root, path: "src/one.ts", expectedSha256: "0".repeat(64) });
    assert.equal(stale.stale, true);
    await assert.rejects(smartRead({ root, path: "../outside" }), /ENOENT|escapes/);
  });

  it("applies retrieval exclusions to reads and refuses symlinks outside the root", async () => {
    const root = await fixture();
    await writeFile(join(root, ".macusignore"), "private.ts\n");
    await writeFile(join(root, "private.ts"), "do not expose\n");
    const outside = join(tmpdir(), `macus-outside-${Date.now()}.ts`);
    await writeFile(outside, "outside\n");
    try {
      await symlink(outside, join(root, "outside-link.ts"));
      await assert.rejects(smartRead({ root, path: "private.ts" }), /excluded by repository retrieval policy/);
      await assert.rejects(smartRead({ root, path: "outside-link.ts" }), /escapes/);
    } finally {
      await rm(outside, { force: true });
    }
  });
});
