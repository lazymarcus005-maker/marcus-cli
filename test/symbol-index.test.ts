import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildSymbolIndex, searchSymbols } from "../src/retrieval/symbol-index.js";
import { listRepositoryFiles } from "../src/retrieval/symbol-index.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

describe("syntax-aware symbol index", () => {
  it("indexes TS/TSX, JavaScript, and C# declarations with disambiguated source identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-symbols-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await mkdir(join(root, "dotnet"));
    await writeFile(join(root, "src", "catalog.ts"), [
      "export interface CatalogEntry { id: string }",
      "export class CatalogService {",
      "  load(id: string): CatalogEntry { return { id }; }",
      "}",
      "export function createCatalog(): CatalogService { return new CatalogService(); }",
    ].join("\n"));
    await writeFile(join(root, "src", "view.tsx"), "export const CatalogView = () => <main />;\n");
    await writeFile(join(root, "src", "legacy.js"), "export function load(id) { return id; }\n");
    await writeFile(join(root, "dotnet", "Catalog.cs"), [
      "namespace Demo;",
      "public interface ICatalog { string Load(int id); }",
      "public class Catalog : ICatalog { public string Load(int id) { return id.ToString(); } }",
    ].join("\n"));

    const index = await buildSymbolIndex(root);
    const loads = searchSymbols(index, { query: "load" });
    assert.equal(loads.matches.length, 4);
    assert.equal(new Set(loads.matches.map((symbol) => symbol.id)).size, 4);
    assert.ok(loads.matches.every((symbol) => /^[a-f0-9]{64}$/.test(symbol.sourceSha256)));
    assert.ok(index.symbols.some((symbol) => symbol.name === "CatalogEntry" && symbol.kind === "interface"));
    assert.ok(index.symbols.some((symbol) => symbol.name === "CatalogView" && symbol.kind === "variable"));
    assert.ok(index.coverage.every((entry) => entry.status === "complete"));
    const unchanged = await buildSymbolIndex(root);
    assert.equal(unchanged.stats.filesParsed, 0);
    assert.equal(unchanged.stats.cacheHits, 4);
  });

  it("reports unsupported files and parser errors as partial coverage, not invented symbols", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-symbols-partial-"));
    roots.push(root);
    await writeFile(join(root, "broken.ts"), "export function valid() {}\nexport function broken( {\n");
    await writeFile(join(root, "script.py"), "def not_indexed(): pass\n");
    const index = await buildSymbolIndex(root);
    assert.ok(index.symbols.some((symbol) => symbol.name === "valid"));
    assert.ok(!index.symbols.some((symbol) => symbol.name === "not_indexed"));
    assert.equal(index.coverage.find((entry) => entry.path === "broken.ts")?.status, "partial");
    assert.equal(index.coverage.find((entry) => entry.path === "script.py")?.status, "unsupported");
  });

  it("marks oversized source partial without reading or hashing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-symbols-oversized-"));
    roots.push(root);
    const oversized = join(root, "large.ts");
    await writeFile(oversized, "");
    await truncate(oversized, 32 * 1024 * 1024);
    const index = await buildSymbolIndex(root);
    const coverage = index.coverage.find((entry) => entry.path === "large.ts");
    assert.equal(coverage?.status, "partial");
    assert.match(coverage?.reason ?? "", /size limit/);
    assert.equal(coverage?.sourceSha256, undefined);
    assert.equal(index.stats.bytesHashed, 0);
    assert.equal(index.stats.filesParsed, 0);
  });

  it("quarantines a corrupt rebuildable index cache and continues without touching session state", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-symbols-corrupt-cache-"));
    roots.push(root);
    await mkdir(join(root, ".macus", "cache"), { recursive: true });
    await mkdir(join(root, ".macus", "state"), { recursive: true });
    await writeFile(join(root, "app.ts"), "export function fresh() { return true; }\n");
    await writeFile(join(root, ".macus", "cache", "index.db"), "not a sqlite database");
    await writeFile(join(root, ".macus", "state", "state.db"), "durable session sentinel");
    const statePath = join(root, ".macus", "state", "state.db");
    const beforeState = await readFile(statePath);

    const rebuilt = await buildSymbolIndex(root);
    assert.equal(rebuilt.cacheStatus, "rebuilt");
    assert.match(rebuilt.cacheWarning ?? "", /quarantined and rebuilt/);
    assert.equal(searchSymbols(rebuilt, { query: "fresh" }).matches.length, 1);
    assert.deepEqual(await readFile(statePath), beforeState);

    const next = await buildSymbolIndex(root);
    assert.equal(next.cacheStatus, "ready");
    assert.equal(next.stats.cacheHits, 1);
    assert.equal(next.stats.filesParsed, 0);
  });

  it("rehashes before cache reuse and removes renamed or deleted file symbols", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-symbols-freshness-"));
    roots.push(root);
    const sourcePath = join(root, "same.ts");
    await writeFile(sourcePath, "export function alpha() {}\n");
    const first = await buildSymbolIndex(root);
    await writeFile(sourcePath, "export function bravo() {}\n");
    const changed = await buildSymbolIndex(root);
    assert.equal(changed.stats.filesParsed, 1);
    assert.equal(searchSymbols(changed, { query: "alpha" }).matches.length, 0);
    assert.equal(searchSymbols(changed, { query: "bravo" }).matches.length, 1);
    assert.notEqual(changed.generationId, first.generationId);
    const { rename } = await import("node:fs/promises");
    await rename(sourcePath, join(root, "renamed.ts"));
    const renamed = await buildSymbolIndex(root);
    assert.ok(!renamed.coverage.some((entry) => entry.path === "same.ts"));
    assert.equal(searchSymbols(renamed, { query: "bravo" }).matches[0]?.path, "renamed.ts");
  });

  it("respects gitignore, macusignore, generated output, and credential-file exclusions", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-symbols-excludes-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    await mkdir(join(root, "dist"));
    await writeFile(join(root, ".gitignore"), "src/git-ignored.ts\n");
    await writeFile(join(root, ".macusignore"), "src/macus-ignored.ts\n");
    await writeFile(join(root, "src", "included.ts"), "export function included() {}\n");
    await writeFile(join(root, "src", "git-ignored.ts"), "export function ignoredByGit() {}\n");
    await writeFile(join(root, "src", "macus-ignored.ts"), "export function ignoredByMacus() {}\n");
    await writeFile(join(root, "dist", "generated.ts"), "export function generated() {}\n");
    await writeFile(join(root, ".env.secret"), "TOKEN=do-not-index\n");
    const files = listRepositoryFiles(root);
    assert.deepEqual(files, [".gitignore", ".macusignore", "src/included.ts"]);
  });
});
