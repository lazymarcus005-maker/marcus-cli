import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IndexedSymbol, SymbolIndex } from "./symbol-index.js";
import { listRepositoryFiles } from "./symbol-index.js";

export type RelationshipType = "imports" | "contains" | "references" | "implements" | "test_references";
export type RelationshipResolution = "confirmed" | "candidate" | "unresolved";

export interface RelationshipEdge {
  edgeType: RelationshipType;
  fromId: string;
  toId: string | null;
  targetText: string;
  resolution: RelationshipResolution;
  confidence: number;
  evidence: { path: string; startLine: number; endLine: number; sourceSha256: string; excerpt: string; extraction: string };
  resolverVersion: string;
  indexGeneration: string;
}

export interface RelationshipGraph {
  generationId: string;
  edges: RelationshipEdge[];
  coverage: "complete" | "partial";
  limitations: string[];
}

export type RelationshipOperation = "find_references" | "find_dependencies" | "find_dependents" | "impact";

const RESOLVER_VERSION = "static-candidate-resolver-v1";
const MAX_GRAPH_FILES = 5000;
const MAX_GRAPH_BYTES = 64 * 1024 * 1024;
const MAX_GRAPH_EDGES = 100_000;
const MAX_FILE_BYTES = 1024 * 1024;
const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".cs"];

function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function isTestPath(path: string): boolean {
  return /(?:^|\/)(?:__tests__|tests?)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(path);
}

function excerptAt(lines: string[], index: number): string {
  return (lines[index] ?? "").trim().slice(0, 300);
}

function appendEdge(edges: RelationshipEdge[], edge: RelationshipEdge): void {
  if (edges.length < MAX_GRAPH_EDGES) edges.push(edge);
}

function resolveLocalImport(fromPath: string, target: string, allPaths: Set<string>): string[] {
  if (!target.startsWith(".")) return [];
  const base = resolve(dirname(resolve("/root", fromPath)), target);
  const relativeBase = relative("/root", base).split(sep).join("/");
  const candidates = new Set<string>();
  if (allPaths.has(relativeBase)) candidates.add(relativeBase);
  const substitution: Record<string, string[]> = {
    ".js": [".ts", ".tsx", ".d.ts"],
    ".jsx": [".tsx", ".jsx"],
  };
  const suffix = relativeBase.slice(relativeBase.lastIndexOf(".")).toLowerCase();
  for (const extension of substitution[suffix] ?? []) {
    const candidate = `${relativeBase.slice(0, -suffix.length)}${extension}`;
    if (allPaths.has(candidate)) candidates.add(candidate);
  }
  for (const extension of EXTENSIONS) if (allPaths.has(`${relativeBase}${extension}`)) candidates.add(`${relativeBase}${extension}`);
  for (const extension of EXTENSIONS) {
    const indexPath = `${relativeBase.replace(/\/$/, "")}/index${extension}`;
    if (allPaths.has(indexPath)) candidates.add(indexPath);
  }
  return [...candidates].sort();
}

async function extractStaticImports(path: string, source: string): Promise<Array<{ target: string; line: number; extraction: string }> | undefined> {
  let grammar: unknown;
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  try {
    if (extension === ".ts" || extension === ".tsx") grammar = (await import("tree-sitter-typescript")).default[extension === ".ts" ? "typescript" : "tsx"];
    else if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) grammar = (await import("tree-sitter-javascript")).default;
    else if (extension === ".cs") grammar = (await import("tree-sitter-c-sharp")).default;
    else return undefined;
    const ParserClass = (await import("tree-sitter")).default;
    const parser = new ParserClass();
    parser.setLanguage(grammar as never);
    const tree = parser.parse(source);
    const imports: Array<{ target: string; line: number; extraction: string }> = [];
    const visit = (node: import("tree-sitter").SyntaxNode): void => {
      if (node.type === "import_statement" || node.type === "export_statement") {
        const string = node.namedChildren.find((child) => child.type === "string");
        if (string) imports.push({ target: string.text.slice(1, -1), line: node.startPosition.row + 1, extraction: "Tree-sitter static import/export declaration" });
      } else if (node.type === "call_expression" && ["require", "import"].includes(node.childForFieldName("function")?.text ?? "")) {
        const argumentsNode = node.childForFieldName("arguments");
        const string = argumentsNode?.namedChildren.find((child) => child.type === "string");
        if (string) imports.push({ target: string.text.slice(1, -1), line: node.startPosition.row + 1, extraction: "Tree-sitter literal require/import call" });
      }
      for (const child of node.namedChildren) visit(child);
    };
    visit(tree.rootNode);
    return imports;
  } catch {
    return undefined;
  }
}

function createGraphDatabase(root: string): DatabaseSync {
  const path = resolve(root, ".macus/cache/index.db");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 1000 });
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS relationship_metadata(
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      generation_id TEXT NOT NULL,
      coverage TEXT NOT NULL,
      limitations_json TEXT NOT NULL,
      resolver_version TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS relationship_edges(
      generation_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      from_id TEXT NOT NULL,
      to_id TEXT,
      target_text TEXT NOT NULL,
      resolution TEXT NOT NULL,
      confidence REAL NOT NULL,
      evidence_json TEXT NOT NULL,
      resolver_version TEXT NOT NULL,
      PRIMARY KEY(generation_id, edge_type, from_id, target_text, evidence_json)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS relationship_edges_by_target ON relationship_edges(generation_id, to_id, edge_type);
    CREATE INDEX IF NOT EXISTS relationship_edges_by_source ON relationship_edges(generation_id, from_id, edge_type);
  `);
  chmodSync(path, 0o600);
  return database;
}

async function extractGraph(root: string, index: SymbolIndex): Promise<RelationshipGraph> {
  const edges: RelationshipEdge[] = [];
  const limitations: string[] = [];
  const fileSymbols = new Map<string, IndexedSymbol[]>();
  for (const symbol of index.symbols) fileSymbols.set(symbol.path, [...(fileSymbols.get(symbol.path) ?? []), symbol]);
  const symbolNames = new Map<string, IndexedSymbol[]>();
  for (const symbol of index.symbols) symbolNames.set(symbol.name, [...(symbolNames.get(symbol.name) ?? []), symbol]);
  const allPaths = new Set(listRepositoryFiles(root));
  const scanPaths = [...allPaths].filter((path) => /\.(?:ts|tsx|js|jsx|cs)$/i.test(path)).sort();
  const fileLimitReached = scanPaths.length > MAX_GRAPH_FILES;
  let bytesScanned = 0;

  for (const coverage of index.coverage) {
    for (const symbol of fileSymbols.get(coverage.path) ?? []) {
      appendEdge(edges, {
        edgeType: "contains",
        fromId: coverage.path,
        toId: symbol.id,
        targetText: symbol.name,
        resolution: "confirmed",
        confidence: 1,
        evidence: { path: symbol.path, startLine: symbol.startLine, endLine: symbol.endLine, sourceSha256: symbol.sourceSha256, excerpt: symbol.signature, extraction: "tree-sitter declaration containment" },
        resolverVersion: RESOLVER_VERSION,
        indexGeneration: index.generationId,
      });
    }
  }

  for (const path of scanPaths.slice(0, MAX_GRAPH_FILES)) {
    const absolute = resolve(root, path);
    try {
      const info = await lstat(absolute);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES || bytesScanned + info.size > MAX_GRAPH_BYTES) {
        limitations.push(`Skipped ${path}: unsafe, oversized, or aggregate graph scan bound reached`);
        continue;
      }
      const actual = await realpath(absolute);
      if (!within(root, actual)) {
        limitations.push(`Skipped ${path}: resolved path escapes repository`);
        continue;
      }
      const bytes = await readFile(actual);
      bytesScanned += bytes.byteLength;
      const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
      const indexedFile = index.coverage.find((item) => item.path === path);
      if (indexedFile?.sourceSha256 && indexedFile.sourceSha256 !== sourceSha256) {
        limitations.push(`${path}: source changed after symbol indexing; stale relationships were omitted`);
        continue;
      }
      if (bytes.includes(0)) {
        limitations.push(`Skipped ${path}: binary content`);
        continue;
      }
      const lines = bytes.toString("utf8").split(/\r?\n/);
      const importRecords = await extractStaticImports(path, bytes.toString("utf8"));
      if (!importRecords) limitations.push(`${path}: import syntax could not be structurally analyzed`);
      for (const imported of importRecords ?? []) {
        if (edges.length >= MAX_GRAPH_EDGES) break;
        const targetText = imported.target;
        const startLine = imported.line;
        const destinations = resolveLocalImport(path, targetText, allPaths);
        const destinationCoverage = destinations.length === 1 ? index.coverage.find((item) => item.path === destinations[0]) : undefined;
        const resolved = destinations.length === 1 && destinationCoverage?.status === "complete";
        appendEdge(edges, {
          edgeType: "imports",
          fromId: path,
          toId: resolved ? destinations[0]! : null,
          targetText,
          resolution: resolved && indexedFile?.status === "complete" ? "confirmed" : "unresolved",
          confidence: resolved && indexedFile?.status === "complete" ? 1 : 0,
          evidence: { path, startLine, endLine: startLine, sourceSha256, excerpt: excerptAt(lines, startLine - 1), extraction: imported.extraction },
          resolverVersion: RESOLVER_VERSION,
          indexGeneration: index.generationId,
        });
      }

      for (const symbol of fileSymbols.get(path) ?? []) {
        if (!["class", "record", "struct"].includes(symbol.kind)) continue;
        const implemented = symbol.signature.match(/\bimplements\s+([A-Za-z_$][\w$]*(?:\s*,\s*[A-Za-z_$][\w$]*)*)/);
        if (!implemented?.[1]) continue;
        for (const targetText of implemented[1].split(",").map((name) => name.trim())) {
          const matches = (symbolNames.get(targetText) ?? []).filter((candidate) => candidate.kind === "interface");
          const resolved = matches.length === 1 && indexedFile?.status === "complete";
          appendEdge(edges, {
            edgeType: "implements",
            fromId: symbol.id,
            toId: resolved ? matches[0]!.id : null,
            targetText,
            resolution: resolved ? "confirmed" : matches.length ? "candidate" : "unresolved",
            confidence: resolved ? 1 : matches.length ? 0.5 : 0,
            evidence: { path, startLine: symbol.startLine, endLine: symbol.startLine, sourceSha256, excerpt: symbol.signature, extraction: "explicit implements clause; unique interface declaration required for confirmation" },
            resolverVersion: RESOLVER_VERSION,
            indexGeneration: index.generationId,
          });
        }
      }

      const tokens = /\b[A-Za-z_$][\w$]*\b/g;
      for (let lineIndex = 0; lineIndex < lines.length && edges.length < MAX_GRAPH_EDGES; lineIndex++) {
        let token: RegExpExecArray | null;
        tokens.lastIndex = 0;
        while ((token = tokens.exec(lines[lineIndex] ?? "")) !== null) {
          const declarations = symbolNames.get(token[0]);
          if (!declarations?.length) continue;
          for (const declaration of declarations) {
            if (declaration.path === path && declaration.startLine === lineIndex + 1) continue;
            const test = isTestPath(path);
            appendEdge(edges, {
              edgeType: test ? "test_references" : "references",
              fromId: path,
              toId: declaration.id,
              targetText: token[0],
              resolution: "candidate",
              confidence: 0.25,
              evidence: { path, startLine: lineIndex + 1, endLine: lineIndex + 1, sourceSha256, excerpt: excerptAt(lines, lineIndex), extraction: "identifier-name match only; receiver/type/alias resolution not performed" },
              resolverVersion: RESOLVER_VERSION,
              indexGeneration: index.generationId,
            });
          }
        }
      }
      if (indexedFile?.status !== "complete") limitations.push(`${path}: syntax coverage is not complete`);
    } catch {
      limitations.push(`${path}: source could not be safely read for relationship extraction`);
    }
  }

  if (fileLimitReached) limitations.push(`Graph scan truncated at ${MAX_GRAPH_FILES} files`);
  if (edges.length >= MAX_GRAPH_EDGES) limitations.push(`Graph edge bound reached (${MAX_GRAPH_EDGES})`);
  if (index.coverage.some((item) => item.status !== "complete")) limitations.push("One or more source files have partial or unsupported syntax coverage");
  limitations.push("Reference resolution is lexical; aliases, overloads, and dynamic dispatch remain unresolved");
  const uniqueLimitations = [...new Set(limitations)].slice(0, 2000);
  const uniqueEdges = [...new Map(edges.map((edge) => [
    `${edge.edgeType}\0${edge.fromId}\0${edge.toId ?? ""}\0${edge.targetText}\0${edge.evidence.path}\0${edge.evidence.startLine}`,
    edge,
  ])).values()];
  return { generationId: index.generationId, edges: uniqueEdges, coverage: uniqueLimitations.length ? "partial" : "complete", limitations: uniqueLimitations };
}

export async function buildRelationshipGraph(rootPath: string, index: SymbolIndex): Promise<RelationshipGraph> {
  const root = await realpath(rootPath);
  const database = createGraphDatabase(root);
  try {
    const cached = database.prepare("SELECT generation_id AS generationId, coverage, limitations_json AS limitations FROM relationship_metadata WHERE singleton = 1 AND generation_id = ? AND resolver_version = ?").get(index.generationId, RESOLVER_VERSION) as { generationId: string; coverage: "complete" | "partial"; limitations: string } | undefined;
    if (cached) {
      const rows = database.prepare("SELECT edge_type AS edgeType, from_id AS fromId, to_id AS toId, target_text AS targetText, resolution, confidence, evidence_json AS evidence FROM relationship_edges WHERE generation_id = ? ORDER BY edge_type, from_id, target_text").all(index.generationId) as Array<Omit<RelationshipEdge, "resolverVersion" | "indexGeneration" | "evidence"> & { evidence: string }>;
      return { generationId: cached.generationId, coverage: cached.coverage, limitations: JSON.parse(cached.limitations) as string[], edges: rows.map((row) => ({ ...row, evidence: JSON.parse(row.evidence) as RelationshipEdge["evidence"], resolverVersion: RESOLVER_VERSION, indexGeneration: index.generationId })) };
    }
    const graph = await extractGraph(root, index);
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("DELETE FROM relationship_edges").run();
      const insert = database.prepare("INSERT OR IGNORE INTO relationship_edges(generation_id,edge_type,from_id,to_id,target_text,resolution,confidence,evidence_json,resolver_version) VALUES(?,?,?,?,?,?,?,?,?)");
      for (const edge of graph.edges) insert.run(edge.indexGeneration, edge.edgeType, edge.fromId, edge.toId, edge.targetText, edge.resolution, edge.confidence, JSON.stringify(edge.evidence), edge.resolverVersion);
      database.prepare("INSERT INTO relationship_metadata(singleton,generation_id,coverage,limitations_json,resolver_version) VALUES(1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET generation_id=excluded.generation_id,coverage=excluded.coverage,limitations_json=excluded.limitations_json,resolver_version=excluded.resolver_version").run(graph.generationId, graph.coverage, JSON.stringify(graph.limitations), RESOLVER_VERSION);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return graph;
  } finally {
    database.close();
  }
}

export function queryRelationshipGraph(graph: RelationshipGraph, input: { operation: RelationshipOperation; target: string }): {
  target: string;
  operation: RelationshipOperation;
  confirmed: RelationshipEdge[];
  candidates: RelationshipEdge[];
  unresolved: RelationshipEdge[];
  possibleTests: RelationshipEdge[];
  generationId: string;
  coverage: "complete" | "partial";
  limitations: string[];
} {
  const targetMatches = graph.edges.filter((edge) => edge.toId === input.target || edge.fromId === input.target || edge.targetText === input.target);
  let selected: RelationshipEdge[];
  switch (input.operation) {
    case "find_dependencies": selected = targetMatches.filter((edge) => edge.edgeType === "imports" && edge.fromId === input.target); break;
    case "find_dependents": selected = targetMatches.filter((edge) => edge.edgeType === "imports" && edge.toId === input.target); break;
    case "find_references": selected = targetMatches.filter((edge) => ["references", "test_references", "implements"].includes(edge.edgeType)); break;
    case "impact": selected = targetMatches.filter((edge) => edge.edgeType !== "contains"); break;
  }
  const limit = selected.slice(0, 200);
  const confirmed = limit.filter((edge) => edge.resolution === "confirmed");
  const candidates = limit.filter((edge) => edge.resolution === "candidate");
  const unresolved = limit.filter((edge) => edge.resolution === "unresolved");
  const possibleTests = limit.filter((edge) => edge.edgeType === "test_references");
  const limitations = [...graph.limitations];
  if (selected.length > limit.length) limitations.push("Relationship output truncated at 200 edges");
  if (!selected.length) limitations.push("No indexed relationship was found; partial coverage means this does not establish absence of callers or dependencies");
  return { target: input.target, operation: input.operation, confirmed, candidates, unresolved, possibleTests, generationId: graph.generationId, coverage: limitations.length ? "partial" : graph.coverage, limitations: limitations.slice(0, 2000) };
}
