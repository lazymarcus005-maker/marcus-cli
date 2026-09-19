import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { generateBenchmarkFixture, REFERENCE_BENCHMARK_FILE_COUNT, REFERENCE_BENCHMARK_TARGET_BYTES } from "../src/workflow/benchmark-fixture.js";
import { buildSymbolIndex, listRepositoryFiles } from "../src/retrieval/symbol-index.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "macus-benchmark-fixture-"));
  roots.push(root);
  return root;
}

describe("reference benchmark fixture generator", () => {
  it("creates a deterministic mixed-language corpus with the requested exact source bytes", async () => {
    assert.equal(REFERENCE_BENCHMARK_FILE_COUNT, 10_000);
    assert.equal(REFERENCE_BENCHMARK_TARGET_BYTES, 104_857_600);

    const firstRoot = await createRoot();
    const secondRoot = await createRoot();
    const options = { fileCount: 10, targetBytes: 2_000 };
    const first = await generateBenchmarkFixture({ root: firstRoot, ...options });
    const second = await generateBenchmarkFixture({ root: secondRoot, ...options });

    assert.deepEqual(first.languages, { typescript: 4, javascript: 3, csharp: 3 });
    assert.equal(first.files.length, 10);
    assert.equal(first.sourceBytes, 2_000);
    assert.equal(first.files.reduce((total, file) => total + file.bytes, 0), 2_000);
    assert.deepEqual(first.files, second.files);
    assert.equal(first.fixtureSha256, second.fixtureSha256);
    assert.deepEqual(await listRepositoryFiles(firstRoot), first.files.map((file) => file.path));
    assert.deepEqual(await listRepositoryFiles(secondRoot), second.files.map((file) => file.path));
    assert.equal(first.excludedPaths[0], ".macus/**");
    const storedManifest = JSON.parse(await readFile(join(firstRoot, ".macus/benchmark/fixture-v1.json"), "utf8")) as typeof first;
    assert.deepEqual(storedManifest, first);
    for (const file of first.files) {
      const bytes = await readFile(join(firstRoot, file.path));
      assert.equal(bytes.byteLength, file.bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    }

    const typescript = await readFile(join(firstRoot, "src/typescript/fixture-00001.ts"), "utf8");
    const javascript = await readFile(join(firstRoot, "src/javascript/fixture-00005.js"), "utf8");
    const csharp = await readFile(join(firstRoot, "src/csharp/fixture-00008.cs"), "utf8");
    assert.match(typescript, /export const fixtureItem00001/);
    assert.match(javascript, /export const fixtureItem00005/);
    assert.match(csharp, /public static class FixtureItem00008/);

    const index = await buildSymbolIndex(firstRoot);
    assert.equal(index.coverage.length, 10);
    assert.ok(index.coverage.every((entry) => entry.status === "complete"));
  });

  it("refuses to populate a non-empty directory and preserves existing bytes", async () => {
    const root = await createRoot();
    const sentinelPath = join(root, "keep.txt");
    await writeFile(sentinelPath, "user data\n");

    await assert.rejects(generateBenchmarkFixture({ root, fileCount: 10, targetBytes: 2_000 }), /must be empty/);
    assert.equal(await readFile(sentinelPath, "utf8"), "user data\n");
  });
});
