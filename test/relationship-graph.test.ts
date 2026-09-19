import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { buildRelationshipGraph, queryRelationshipGraph } from "../src/retrieval/relationship-graph.js";
import { buildSymbolIndex } from "../src/retrieval/symbol-index.js";

const roots: string[] = [];
after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

describe("bounded relationship graph", () => {
  it("confirms syntax containment and uniquely resolved local imports while keeping name references as candidates", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-graph-"));
    roots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(join(root, "src", "target.ts"), "export interface Contract {}\nexport function target() { return 42; }\nexport class Concrete implements Contract {}\n");
    await writeFile(join(root, "src", "caller.ts"), 'import { target } from "./target.js";\nexport function caller() { return target(); }\n');
    await writeFile(join(root, "tests", "target.test.ts"), 'import { target } from "../src/target";\ntest("target", () => target());\n');
    const index = await buildSymbolIndex(root);
    const graph = await buildRelationshipGraph(root, index);
    const targetSymbol = index.symbols.find((symbol) => symbol.name === "target");
    assert.ok(targetSymbol);
    assert.ok(graph.edges.some((edge) => edge.edgeType === "contains" && edge.toId === targetSymbol.id && edge.resolution === "confirmed"));
    const contract = index.symbols.find((symbol) => symbol.name === "Contract");
    assert.ok(contract);
    assert.ok(graph.edges.some((edge) => edge.edgeType === "implements" && edge.toId === contract.id && edge.resolution === "confirmed"));
    const dependencies = queryRelationshipGraph(graph, { operation: "find_dependencies", target: "src/caller.ts" });
    assert.equal(dependencies.confirmed[0]?.toId, "src/target.ts");
    const references = queryRelationshipGraph(graph, { operation: "find_references", target: targetSymbol.id });
    assert.ok(references.candidates.some((edge) => edge.fromId === "src/caller.ts"));
    assert.ok(references.possibleTests.some((edge) => edge.fromId === "tests/target.test.ts"));
    assert.ok(references.candidates.every((edge) => edge.resolution === "candidate"));
    const dependents = queryRelationshipGraph(graph, { operation: "find_dependents", target: "src/target.ts" });
    assert.ok(dependents.confirmed.some((edge) => edge.fromId === "src/caller.ts"));
    const cachedGraph = await buildRelationshipGraph(root, index);
    assert.equal(cachedGraph.edges.length, graph.edges.length);
    assert.equal(cachedGraph.generationId, graph.generationId);
  });

  it("reports partial coverage and never interprets zero candidates as proof of no callers", () => {
    const graph = { generationId: "g", coverage: "partial" as const, edges: [], limitations: ["unsupported language present"] };
    const result = queryRelationshipGraph(graph, { operation: "impact", target: "missing" });
    assert.equal(result.coverage, "partial");
    assert.equal(result.confirmed.length, 0);
    assert.ok(result.limitations.some((item) => /does not establish absence/.test(item)));
  });

  it("keeps ambiguous imports and duplicate-name calls from becoming confirmed relationships", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-graph-ambiguous-"));
    roots.push(root);
    await mkdir(join(root, "src", "pkg"), { recursive: true });
    await writeFile(join(root, "src", "pkg.ts"), "export function refresh() { return 'file'; }\n");
    await writeFile(join(root, "src", "pkg", "index.ts"), "export function refresh() { return 'index'; }\n");
    await writeFile(join(root, "src", "caller.ts"), 'import { refresh } from "./pkg";\nexport function call(service: any) { return service.refresh() + refresh(); }\n');
    const index = await buildSymbolIndex(root);
    const graph = await buildRelationshipGraph(root, index);
    const ambiguousImport = graph.edges.find((edge) => edge.edgeType === "imports" && edge.fromId === "src/caller.ts");
    assert.equal(ambiguousImport?.resolution, "unresolved");
    assert.equal(ambiguousImport?.toId, null);
    const refreshIds = new Set(index.symbols.filter((symbol) => symbol.name === "refresh").map((symbol) => symbol.id));
    const references = graph.edges.filter((edge) => edge.edgeType === "references" && edge.fromId === "src/caller.ts" && edge.evidence.startLine === 2 && refreshIds.has(edge.toId ?? ""));
    assert.equal(references.length, 2);
    assert.ok(references.every((edge) => edge.resolution === "candidate" && edge.confidence < 1));
    assert.ok(references.every((edge) => edge.evidence.sourceSha256 && edge.indexGeneration === graph.generationId && edge.resolverVersion));
  });
});
