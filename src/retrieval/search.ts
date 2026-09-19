import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { listRepositoryFiles } from "./symbol-index.js";

const MAX_SMART_READ_BYTES = 1024 * 1024;

export type SearchStatus = "matches" | "no-match" | "invalid-query" | "timeout" | "cancelled" | "failed";
export interface SearchMatch { path: string; line: number; text: string }
export interface SearchResult {
  status: SearchStatus;
  matches: SearchMatch[];
  truncated: boolean;
  continuation: string | null;
  error?: string;
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

async function searchGeneration(root: string, files: Set<string>): Promise<string> {
  const hash = createHash("sha256").update(root);
  for (const path of [...files].sort()) {
    hash.update(path).update("\0");
    try {
      const info = await stat(resolve(root, path), { bigint: true });
      hash.update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}\0`);
    } catch { hash.update("missing\0"); }
  }
  return hash.digest("hex");
}

export async function searchCode(options: {
  root: string;
  query: string;
  path?: string;
  fileType?: string;
  caseSensitive?: boolean;
  regex?: boolean;
  limit?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  continuation?: string;
}): Promise<SearchResult> {
  if (!options.query) return { status: "invalid-query", matches: [], truncated: false, continuation: null, error: "Query must not be empty" };
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    return { status: "invalid-query", matches: [], truncated: false, continuation: null, error: "Limit must be between 1 and 10000" };
  }
  let start = 0;
  let cursorGeneration: unknown;
  if (options.continuation) {
    try {
      const cursor = JSON.parse(Buffer.from(options.continuation, "base64url").toString("utf8"));
      if (cursor.query !== options.query || cursor.regex !== !!options.regex || cursor.path !== (options.path ?? ".") || cursor.fileType !== (options.fileType ?? null) || cursor.caseSensitive !== !!options.caseSensitive || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error();
      start = cursor.offset;
      cursorGeneration = cursor.generation;
    } catch { return { status: "invalid-query", matches: [], truncated: false, continuation: null, error: "Invalid continuation token" }; }
  }
  const root = await realpath(options.root);
  let includedFiles: Set<string>;
  try {
    includedFiles = new Set(listRepositoryFiles(root));
  } catch (error) {
    return { status: "failed", matches: [], truncated: false, continuation: null, error: error instanceof Error ? error.message : "Unable to enumerate authorized source files" };
  }
  const generation = await searchGeneration(root, includedFiles);
  if (options.continuation && cursorGeneration !== generation) return { status: "invalid-query", matches: [], truncated: false, continuation: null, error: "Repository changed since this search cursor was issued; restart the search" };
  let searchPath = ".";
  if (options.path) {
    const candidate = resolve(root, options.path);
    let checked: string;
    try { checked = await realpath(candidate); }
    catch { return { status: "invalid-query", matches: [], truncated: false, continuation: null, error: "Search path does not exist" }; }
    if (!inside(root, checked)) return { status: "invalid-query", matches: [], truncated: false, continuation: null, error: "Search path escapes the authorized repository root" };
    searchPath = relative(root, checked) || ".";
    if (!(await stat(checked).then((info) => info.isDirectory()).catch(() => false)) && !includedFiles.has(searchPath)) {
      return { status: "invalid-query", matches: [], truncated: false, continuation: null, error: "Search path is excluded by repository retrieval policy" };
    }
  }
  if (options.signal?.aborted) return { status: "cancelled", matches: [], truncated: false, continuation: null };

  const args = ["--json", "--line-number", "--hidden", "--sort", "path", "--max-columns", "2000", "--max-columns-preview", "--glob", "!.git/**", "--glob", "!.macus/**", "--glob", "!node_modules/**"];
  if (options.caseSensitive) args.push("--case-sensitive");
  if (options.fileType) {
    if (!/^[A-Za-z0-9_-]+$/.test(options.fileType)) return { status: "invalid-query", matches: [], truncated: false, continuation: null, error: "Invalid file type filter" };
    args.push("--type", options.fileType);
  }
  if (options.regex) args.push(`--regexp=${options.query}`, searchPath);
  else args.push("--fixed-strings", "--", options.query, searchPath);
  const child = spawn("rg", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const matches: SearchMatch[] = [];
  let stderr = "";
  let pending = "";
  let seen = 0;
  let truncated = false;
  let timedOut = false;
  let cancelled = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeoutMs ?? 10_000);
  const abort = () => { cancelled = true; child.kill("SIGTERM"); };
  options.signal?.addEventListener("abort", abort, { once: true });

  const consume = (line: string) => {
    if (!line) return;
    let item: any;
    try { item = JSON.parse(line); } catch { return; }
    if (item.type !== "match") return;
    const data = item.data;
    const rawPath = data.path.text ?? Buffer.from(data.path.bytes ?? "", "base64").toString("utf8");
    const rawText = (data.lines.text ?? Buffer.from(data.lines.bytes ?? "", "base64").toString("utf8")).replace(/[\r\n]+$/, "");
    const absolute = resolve(root, rawPath);
    if (!inside(root, absolute)) return;
    if (!includedFiles.has(relative(root, absolute))) return;
    seen++;
    if (seen <= start) return;
    if (matches.length === limit) { truncated = true; child.kill("SIGTERM"); return; }
    matches.push({ path: relative(root, absolute), line: data.line_number, text: rawText });
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      consume(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length); });
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolveOutcome) => {
    child.once("error", (error) => resolveOutcome({ code: null, signal: null, error }));
    child.once("close", (code, signal) => resolveOutcome({ code, signal }));
  });
  clearTimeout(timeout);
  options.signal?.removeEventListener("abort", abort);
  if (pending) consume(pending);
  const cursor = truncated ? Buffer.from(JSON.stringify({ query: options.query, regex: !!options.regex, path: options.path ?? ".", fileType: options.fileType ?? null, caseSensitive: !!options.caseSensitive, generation, offset: start + matches.length })).toString("base64url") : null;
  if (cancelled) return { status: "cancelled", matches, truncated, continuation: cursor };
  if (timedOut) return { status: "timeout", matches, truncated, continuation: cursor };
  if (truncated && matches.length > 0) return { status: "matches", matches, truncated, continuation: cursor };
  if (outcome.error || (outcome.code !== 0 && outcome.code !== 1)) {
    const invalid = options.regex && /regex parse error|PCRE2:/.test(stderr);
    return { status: invalid ? "invalid-query" : "failed", matches, truncated, continuation: cursor, error: invalid ? "Invalid regular expression" : stderr.trim() || outcome.error?.message || `rg exited ${outcome.code}` };
  }
  return { status: matches.length ? "matches" : "no-match", matches, truncated, continuation: cursor };
}

export async function smartRead(options: {
  root: string;
  path: string;
  startLine?: number;
  endLine?: number;
  expectedSha256?: string;
  maxBytes?: number;
}): Promise<{ path: string; sha256: string; stale: boolean; startLine: number; endLine: number; text: string }> {
  const root = await realpath(options.root);
  const candidate = resolve(root, options.path);
  const actual = await realpath(candidate);
  if (!inside(root, actual)) throw new Error("Read path escapes the authorized repository root");
  const relativePath = relative(root, actual);
  if (!listRepositoryFiles(root).includes(relativePath)) {
    throw new Error("Read path is excluded by repository retrieval policy");
  }
  const maxBytes = options.maxBytes ?? 256 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SMART_READ_BYTES) {
    throw new Error(`Smart-read limit must be between 1 and ${MAX_SMART_READ_BYTES} bytes`);
  }
  const file = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer;
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Smart read only supports regular source files");
    if (info.size > maxBytes) throw new Error(`File exceeds smart-read limit (${maxBytes} bytes)`);
    const bounded = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < bounded.byteLength) {
      const result = await file.read(bounded, bytesRead, bounded.byteLength - bytesRead, null);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maxBytes) throw new Error(`File exceeds smart-read limit (${maxBytes} bytes)`);
    bytes = bounded.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const lines = bytes.toString("utf8").split(/\r?\n/);
  const startLine = Math.max(1, options.startLine ?? 1);
  const endLine = Math.min(lines.length, options.endLine ?? Math.min(lines.length, startLine + 199));
  if (endLine < startLine) throw new Error("Invalid line range");
  const text = lines.slice(startLine - 1, endLine).map((line, i) => `${startLine + i}: ${line}`).join("\n");
  return { path: relativePath, sha256, stale: options.expectedSha256 !== undefined && options.expectedSha256 !== sha256, startLine, endLine, text };
}
