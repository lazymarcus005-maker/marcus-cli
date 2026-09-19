import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildRepositoryMap } from "../src/retrieval/repo-map.js";
import { buildSymbolIndex } from "../src/retrieval/symbol-index.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

describe("bounded repository map", () => {
  it("prioritizes entry files, dependencies, and syntax declarations within its byte-token budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-repo-map-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { zod: "1.0.0" } }));
    await writeFile(join(root, "src", "main.ts"), "export class Widget { render(): string { return 'ok'; } }\n");
    const index = await buildSymbolIndex(root);
    const map = await buildRepositoryMap({ root, index, tokenBudget: 500 });
    assert.ok(map.text.includes("package.json"));
    assert.match(map.text, /index cache: ready/);
    assert.ok(map.text.includes("zod"));
    assert.ok(map.text.includes("Widget"));
    assert.ok(map.estimatedTokens <= 500);
    assert.equal(map.indexGeneration, index.generationId);
  });

  it("keeps very small budgets bounded and reports omitted entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-repo-map-small-"));
    roots.push(root);
    await writeFile(join(root, "a.ts"), "export function alpha() {}\n");
    await writeFile(join(root, "b.ts"), "export function bravo() {}\n");
    const map = await buildRepositoryMap({ root, tokenBudget: 32 });
    assert.ok(map.estimatedTokens <= 32);
    assert.ok(map.omittedItems > 0);
    const tiny = await buildRepositoryMap({ root, tokenBudget: 1 });
    assert.ok(tiny.estimatedTokens <= 1);
  });
});
