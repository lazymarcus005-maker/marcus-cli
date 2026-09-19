import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ignore from "ignore";
import type Parser from "tree-sitter";

export type SymbolKind = "class" | "interface" | "function" | "method" | "type" | "enum" | "variable" | "namespace" | "property" | "constructor" | "struct" | "record";
export interface IndexedSymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  path: string;
  signature: string;
  startLine: number;
  endLine: number;
  sourceSha256: string;
}
export interface FileCoverage {
  path: string;
  status: "complete" | "partial" | "unsupported";
  sourceSha256?: string;
  reason?: string;
  errorCount?: number;
}
export interface SymbolIndex {
  root: string;
  generationId: string;
  symbols: IndexedSymbol[];
  coverage: FileCoverage[];
  cacheStatus: "ready" | "rebuilt" | "unavailable";
  cacheWarning?: string;
  stats: { filesSeen: number; filesParsed: number; cacheHits: number; bytesHashed: number };
}

const MAX_SOURCE_FILE_BYTES = 1024 * 1024;
const MAX_SYMBOL_FILES = 20_000;
const MAX_FILE_LIST_BYTES = 16 * 1024 * 1024;
const GRAMMAR_VERSION = "ts-0.23.2_js-csharp-0.23.1";
const RECOGNIZED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".cs"]);

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

async function grammarFor(path: string): Promise<unknown | undefined> {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (extension === ".ts" || extension === ".tsx") {
    const grammar = await import("tree-sitter-typescript");
    return extension === ".ts" ? grammar.default.typescript : grammar.default.tsx;
  }
  if (extension === ".js" || extension === ".jsx") return (await import("tree-sitter-javascript")).default;
  if (extension === ".cs") return (await import("tree-sitter-c-sharp")).default;
  return undefined;
}

function symbolKind(nodeType: string): SymbolKind | undefined {
  const kinds: Record<string, SymbolKind> = {
    class_declaration: "class",
    interface_declaration: "interface",
    function_declaration: "function",
    method_definition: "method",
    method_declaration: "method",
    abstract_method_declaration: "method",
    property_signature: "property",
    type_alias_declaration: "type",
    enum_declaration: "enum",
    internal_module: "namespace",
    namespace_declaration: "namespace",
    file_scoped_namespace_declaration: "namespace",
    struct_declaration: "struct",
    record_declaration: "record",
    constructor_declaration: "constructor",
    property_declaration: "property",
  };
  return kinds[nodeType];
}

function byteOffsetToStringOffset(text: string, byteOffset: number): number {
  return Buffer.from(text, "utf8").subarray(0, byteOffset).toString("utf8").length;
}

function declarationSignature(node: Parser.SyntaxNode): string {
  const text = node.text;
  const body = node.childForFieldName("body");
  const prefix = body
    ? text.slice(0, byteOffsetToStringOffset(text, body.startIndex - node.startIndex))
    : text.split(/\r?\n/, 1)[0] ?? text;
  return prefix.replace(/\s+/g, " ").trim().slice(0, 500);
}

function isFunctionValuedVariable(node: Parser.SyntaxNode): boolean {
  const value = node.childForFieldName("value");
  return value !== null && ["arrow_function", "function_expression", "class"].includes(value.type);
}

async function parseSource(path: string, content: string, sourceSha256: string): Promise<{ symbols: IndexedSymbol[]; status: "complete" | "partial"; errorCount: number }> {
  const grammar = await grammarFor(path);
  if (!grammar) return { symbols: [], status: "partial", errorCount: 1 };
  const ParserModule = await import("tree-sitter");
  const ParserClass = ParserModule.default;
  const parser = new ParserClass();
  parser.setLanguage(grammar as never);
  const tree = parser.parse(content);
  const symbols: IndexedSymbol[] = [];
  let errorCount = 0;
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === "ERROR" || node.isMissing) errorCount++;
    const kind = symbolKind(node.type);
    let nameNode = node.childForFieldName("name");
    let effectiveKind = kind;
    if (node.type === "variable_declarator" && isFunctionValuedVariable(node)) {
      nameNode = node.childForFieldName("name");
      effectiveKind = "variable";
    }
    if (effectiveKind && nameNode && nameNode.type !== "missing") {
      const name = nameNode.text;
      if (name) {
        const startLine = node.startPosition.row + 1;
        const endLine = node.endPosition.row + 1;
        const id = sha256(`${path}\0${node.startIndex}\0${effectiveKind}\0${name}`);
        symbols.push({
          id,
          name,
          kind: effectiveKind,
          path,
          signature: declarationSignature(node),
          startLine,
          endLine,
          sourceSha256,
        });
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(tree.rootNode);
  return { symbols, status: tree.rootNode.hasError ? "partial" : "complete", errorCount };
}

export function listRepositoryFiles(root: string): string[] {
  const args = [
    "--files", "--hidden", "--null", "--no-ignore",
    "--glob", "!.git/**", "--glob", "!.macus/**",
    "--glob", "!node_modules/**", "--glob", "!vendor/**", "--glob", "!Packages/**",
    "--glob", "!dist/**", "--glob", "!build/**", "--glob", "!out/**",
    "--glob", "!coverage/**", "--glob", "!target/**", "--glob", "!obj/**",
    "--glob", "!bin/**", "--glob", "!generated/**", "--glob", "!.next/**",
    "--glob", "!**/.env", "--glob", "!**/.env.*", "--glob", "!**/*.pem",
    "--glob", "!**/*.key", "--glob", "!**/id_rsa*", "--glob", "!*credential*",
    "--glob", "!*secret*",
  ];
  const output = execFileSync("rg", args, { cwd: root, encoding: "buffer", maxBuffer: MAX_FILE_LIST_BYTES });
  const files = output.toString("utf8").split("\0").filter(Boolean).sort();
  if (files.length > MAX_SYMBOL_FILES) throw new Error(`Symbol index file limit exceeded (${MAX_SYMBOL_FILES})`);
  const managers = new Map<string, ReturnType<typeof ignore>>();
  for (const ignorePath of files.filter((path) => [".gitignore", ".macusignore"].includes(basename(path)))) {
    const rules = awaitReadIgnore(resolve(root, ignorePath));
    if (rules !== undefined) {
      const directory = dirname(ignorePath) === "." ? "" : dirname(ignorePath);
      const manager = managers.get(directory) ?? ignore();
      manager.add(rules);
      managers.set(directory, manager);
    }
  }
  return files.filter((path) => {
    const directories = [""];
    let directory = dirname(path);
    while (directory !== "." && directory !== "") {
      directories.push(directory);
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    let ignored = false;
    for (const scope of directories.reverse()) {
      const manager = managers.get(scope);
      if (!manager) continue;
      const relativePath = scope ? relative(scope, path) : path;
      const result = manager.test(relativePath.split(sep).join("/"));
      if (result.ignored) ignored = true;
      if (result.unignored) ignored = false;
    }
    return !ignored;
  });
}

function awaitReadIgnore(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

interface CachedFile {
  content_hash: string;
  grammar_version: string;
  parse_status: "complete" | "partial";
  error_count: number;
  symbols_json: string;
}

function validCachedSymbols(value: unknown, path: string, sourceSha256: string): value is IndexedSymbol[] {
  if (!Array.isArray(value)) return false;
  const kinds = new Set<SymbolKind>(["class", "interface", "function", "method", "type", "enum", "variable", "namespace", "property", "constructor", "struct", "record"]);
  return value.every((symbol) => typeof symbol === "object" && symbol !== null &&
    typeof (symbol as IndexedSymbol).id === "string" && typeof (symbol as IndexedSymbol).name === "string" &&
    kinds.has((symbol as IndexedSymbol).kind) && typeof (symbol as IndexedSymbol).signature === "string" &&
    (symbol as IndexedSymbol).path === path && (symbol as IndexedSymbol).sourceSha256 === sourceSha256 &&
    Number.isSafeInteger((symbol as IndexedSymbol).startLine) && (symbol as IndexedSymbol).startLine > 0 &&
    Number.isSafeInteger((symbol as IndexedSymbol).endLine) && (symbol as IndexedSymbol).endLine >= (symbol as IndexedSymbol).startLine);
}

function initializeIndexCache(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 0 });
  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    database.exec("CREATE TABLE IF NOT EXISTS index_metadata(version INTEGER NOT NULL) STRICT;");
    const metadata = database.prepare("SELECT version FROM index_metadata LIMIT 1").get() as { version: number } | undefined;
    if (metadata && metadata.version > 1) throw new Error(`Index cache schema ${metadata.version} is newer than supported schema 1; cache was preserved`);
    database.exec(`
      CREATE TABLE IF NOT EXISTS indexed_files(
        path TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        mtime_ns TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        grammar_version TEXT NOT NULL,
        parse_status TEXT NOT NULL,
        error_count INTEGER NOT NULL,
        symbols_json TEXT NOT NULL
      ) STRICT;
    `);
    const cacheColumns = database.prepare("PRAGMA table_info(indexed_files)").all() as Array<{ name: string }>;
    const requiredColumns = ["path", "size", "mtime_ns", "content_hash", "grammar_version", "parse_status", "error_count", "symbols_json"];
    if (requiredColumns.some((column) => !cacheColumns.some((entry) => entry.name === column))) throw new Error("Index cache schema is incomplete");
    if (!metadata) database.prepare("INSERT INTO index_metadata(version) VALUES (1)").run();
    chmodSync(path, 0o600);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function openIndexCache(path: string): { database?: DatabaseSync; status: SymbolIndex["cacheStatus"]; warning?: string } {
  try { return { database: initializeIndexCache(path), status: "ready" }; }
  catch (error) {
    const warning = error instanceof Error ? error.message : "Index cache could not be opened";
    if (/newer than supported schema/.test(warning)) return { status: "unavailable", warning };
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const quarantine = `${path}.corrupt-${Date.now()}-${randomUUID()}`;
      for (const candidate of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(candidate)) renameSync(candidate, `${quarantine}${candidate.slice(path.length)}`);
      return { database: initializeIndexCache(path), status: "rebuilt", warning: `Corrupt index cache was quarantined and rebuilt: ${warning}` };
    } catch (rebuildError) {
      return { status: "unavailable", warning: `Index cache unavailable; using uncached structural reads: ${rebuildError instanceof Error ? rebuildError.message : "cache rebuild failed"}` };
    }
  }
}

function persistCachedFile(database: DatabaseSync, input: {
  path: string;
  size: number;
  mtimeNs: string;
  contentHash: string;
  status: "complete" | "partial";
  errorCount: number;
  symbols: IndexedSymbol[];
}): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`INSERT INTO indexed_files(path,size,mtime_ns,content_hash,grammar_version,parse_status,error_count,symbols_json)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET size=excluded.size,mtime_ns=excluded.mtime_ns,
      content_hash=excluded.content_hash,grammar_version=excluded.grammar_version,parse_status=excluded.parse_status,
      error_count=excluded.error_count,symbols_json=excluded.symbols_json`).run(
      input.path,
      input.size,
      input.mtimeNs,
      input.contentHash,
      GRAMMAR_VERSION,
      input.status,
      input.errorCount,
      JSON.stringify(input.symbols),
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export async function buildSymbolIndex(rootPath: string, options: { maxFileBytes?: number; cachePath?: string } = {}): Promise<SymbolIndex> {
  const root = await realpath(rootPath);
  const maxFileBytes = options.maxFileBytes ?? MAX_SOURCE_FILE_BYTES;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_SOURCE_FILE_BYTES) {
    throw new Error(`maxFileBytes must be between 1 and ${MAX_SOURCE_FILE_BYTES}`);
  }
  const symbols: IndexedSymbol[] = [];
  const coverage: FileCoverage[] = [];
  const files = listRepositoryFiles(root);
  const currentPaths = new Set(files);
  const cachePath = options.cachePath ?? resolve(root, ".macus/cache/index.db");
  const cache = openIndexCache(cachePath);
  let database = cache.database;
  let filesParsed = 0;
  let cacheHits = 0;
  let bytesHashed = 0;
  try {
    for (const listedPath of files) {
      const path = relative(root, resolve(root, listedPath));
      if (!RECOGNIZED_EXTENSIONS.has(path.slice(path.lastIndexOf(".")).toLowerCase())) {
        if (/\.(?:py|go|rs|java|rb|php|swift|kt|c|cc|cpp|h|hpp)$/i.test(path)) {
          coverage.push({ path, status: "unsupported", reason: "No pinned structural grammar is configured for this language" });
        }
        continue;
      }
      const absolute = resolve(root, listedPath);
      const link = await lstat(absolute);
      if (link.isSymbolicLink()) {
        coverage.push({ path, status: "partial", reason: "symbolic links are not indexed" });
        continue;
      }
      const resolvedFile = await realpath(absolute);
      const relativeResolved = relative(root, resolvedFile);
      if (relativeResolved === ".." || relativeResolved.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
        coverage.push({ path, status: "partial", reason: "resolved source path escapes the worktree" });
        continue;
      }
      const fileHandle = await open(resolvedFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let bytes: Buffer;
      let mtimeNs: string;
      let changedDuringRead = false;
      try {
        const beforeRead = await fileHandle.stat({ bigint: true });
        if (!beforeRead.isFile()) {
          coverage.push({ path, status: "partial", reason: "source is not a regular file" });
          continue;
        }
        if (beforeRead.size > BigInt(maxFileBytes)) {
          coverage.push({ path, status: "partial", reason: "file exceeds configured parser size limit" });
          continue;
        }
        const buffer = Buffer.alloc(Math.min(maxFileBytes + 1, Number(beforeRead.size) + 1));
        let length = 0;
        while (length < buffer.byteLength) {
          const read = await fileHandle.read(buffer, length, buffer.byteLength - length, length);
          if (read.bytesRead === 0) break;
          length += read.bytesRead;
        }
        const afterRead = await fileHandle.stat({ bigint: true });
        changedDuringRead = beforeRead.dev !== afterRead.dev || beforeRead.ino !== afterRead.ino || beforeRead.size !== afterRead.size || beforeRead.mtimeNs !== afterRead.mtimeNs || beforeRead.ctimeNs !== afterRead.ctimeNs;
        if (length > maxFileBytes || changedDuringRead) {
          coverage.push({ path, status: "partial", reason: length > maxFileBytes ? "file exceeds configured parser size limit" : "file changed while being indexed" });
          continue;
        }
        bytes = buffer.subarray(0, length);
        mtimeNs = afterRead.mtimeNs.toString();
      } finally {
        await fileHandle.close();
      }
      bytesHashed += bytes.byteLength;
      const sourceSha256 = sha256(bytes);
      if (bytes.includes(0)) {
        coverage.push({ path, status: "partial", sourceSha256, reason: "binary content is not structurally indexed" });
        continue;
      }
      if (bytes.byteLength > maxFileBytes) {
        coverage.push({ path, status: "partial", sourceSha256, reason: "file exceeds configured parser size limit" });
        continue;
      }
      let cached: CachedFile | undefined;
      if (database) {
        try {
          cached = database.prepare("SELECT content_hash, grammar_version, parse_status, error_count, symbols_json FROM indexed_files WHERE path = ?").get(path) as CachedFile | undefined;
        } catch (error) {
          database.close();
          database = undefined;
          cache.status = "unavailable";
          cache.warning = `Index cache read failed; continuing uncached: ${error instanceof Error ? error.message : "cache read failed"}`;
        }
      }
      let fileSymbols: IndexedSymbol[];
      let parseStatus: "complete" | "partial";
      let errorCount: number;
      let cachedSymbols: IndexedSymbol[] | undefined;
      if (cached?.content_hash === sourceSha256 && cached.grammar_version === GRAMMAR_VERSION && (cached.parse_status === "complete" || cached.parse_status === "partial") && Number.isSafeInteger(cached.error_count) && cached.error_count >= 0) {
        try {
          const decoded: unknown = JSON.parse(cached.symbols_json);
          if (validCachedSymbols(decoded, path, sourceSha256)) cachedSymbols = decoded;
        } catch { /* invalid cache entry is reparsed and replaced below */ }
      }
      if (cached && cachedSymbols) {
        fileSymbols = cachedSymbols;
        parseStatus = cached.parse_status;
        errorCount = cached.error_count;
        cacheHits++;
      } else {
        const parsed = await parseSource(path, bytes.toString("utf8"), sourceSha256);
        fileSymbols = parsed.symbols;
        parseStatus = parsed.status;
        errorCount = parsed.errorCount;
        filesParsed++;
        if (database) {
          try {
            persistCachedFile(database, {
              path,
              size: bytes.byteLength,
              mtimeNs,
              contentHash: sourceSha256,
              status: parseStatus,
              errorCount,
              symbols: fileSymbols,
            });
          } catch (error) {
            database.close();
            database = undefined;
            cache.status = "unavailable";
            cache.warning = `Index cache write failed; continuing uncached: ${error instanceof Error ? error.message : "cache write failed"}`;
          }
        }
      }
      symbols.push(...fileSymbols);
      coverage.push({ path, status: parseStatus, sourceSha256, ...(parseStatus === "partial" ? { reason: "syntax tree contains parse errors", errorCount } : {}) });
    }
    if (database) {
      try {
        const previousPaths = database.prepare("SELECT path FROM indexed_files").all() as Array<{ path: string }>;
        for (const previous of previousPaths) {
          if (!currentPaths.has(previous.path)) database.prepare("DELETE FROM indexed_files WHERE path = ?").run(previous.path);
        }
      } catch (error) {
        database.close();
        database = undefined;
        cache.status = "unavailable";
        cache.warning = `Index cache cleanup failed; continuing uncached: ${error instanceof Error ? error.message : "cache cleanup failed"}`;
      }
    }
  } finally {
    database?.close();
  }
  if (cache.status !== "ready" && cache.warning) coverage.push({ path: "<index-cache>", status: "partial", reason: cache.warning });
  const generationId = sha256(coverage.map((item) => `${item.path}\0${item.sourceSha256 ?? item.status}`).join("\n"));
  return { root, generationId, symbols, coverage, cacheStatus: cache.status, ...(cache.warning ? { cacheWarning: cache.warning } : {}), stats: { filesSeen: files.length, filesParsed, cacheHits, bytesHashed } };
}

export function searchSymbols(index: SymbolIndex, options: {
  query: string;
  path?: string;
  kind?: SymbolKind;
  limit?: number;
  cursor?: string;
}): { matches: IndexedSymbol[]; ambiguous: boolean; truncated: boolean; nextCursor: string | null; generationId: string } {
  if (!options.query.trim()) throw new Error("Symbol query must not be empty");
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Symbol limit must be between 1 and 500");
  let offset = 0;
  if (options.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
      if (cursor.generationId !== index.generationId || cursor.query !== options.query || cursor.path !== options.path || cursor.kind !== options.kind || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error();
      offset = cursor.offset;
    } catch {
      throw new Error("Symbol cursor is invalid or stale; restart the search");
    }
  }
  const query = options.query.toLocaleLowerCase();
  const all = index.symbols.filter((symbol) =>
    symbol.name.toLocaleLowerCase().includes(query) &&
    (!options.path || symbol.path.startsWith(options.path)) &&
    (!options.kind || symbol.kind === options.kind),
  );
  const matches = all.slice(offset, offset + limit);
  const truncated = offset + matches.length < all.length;
  const nextCursor = truncated ? Buffer.from(JSON.stringify({ generationId: index.generationId, query: options.query, path: options.path, kind: options.kind, offset: offset + matches.length })).toString("base64url") : null;
  return { matches, ambiguous: all.length > 1, truncated, nextCursor, generationId: index.generationId };
}
