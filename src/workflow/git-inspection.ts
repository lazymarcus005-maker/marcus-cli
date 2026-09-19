import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { listRepositoryFiles } from "../retrieval/symbol-index.js";

export type GitInspectionOperation = "diff" | "log" | "show" | "blame";
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const MAX_RETURN_BYTES = 32 * 1024;

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function git(root: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolveOutput, reject) => {
    if (signal?.aborted) { reject(new Error("Git inspection cancelled")); return; }
    const child = spawn("git", ["-C", root, ...args], { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let exceeded = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 10_000);
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_GIT_OUTPUT_BYTES) { exceeded = true; child.kill("SIGTERM"); }
      else chunks.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code, childSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) reject(new Error("Git inspection cancelled"));
      else if (timedOut) reject(new Error("Git inspection timed out after 10 seconds"));
      else if (exceeded) reject(new Error("Git inspection output exceeded 1 MiB"));
      else if (code !== 0) reject(new Error(`git exited ${code ?? childSignal ?? "unknown"}`));
      else resolveOutput(Buffer.concat(chunks));
    });
  });
}

export async function inspectGit(input: {
  root: string;
  operation: GitInspectionOperation;
  path?: string;
  revision?: string;
  startLine?: number;
  endLine?: number;
  signal?: AbortSignal;
}): Promise<{ output: string; truncated: boolean }> {
  const root = await realpath(input.root);
  try { await git(root, ["rev-parse", "--show-toplevel"], input.signal); }
  catch (error) {
    if (input.signal?.aborted || (error instanceof Error && /timed out/.test(error.message))) throw error;
    throw new Error("This worktree is not a Git repository");
  }
  let path: string | undefined;
  if (input.path !== undefined) {
    const candidate = resolve(root, input.path);
    if (!inside(root, candidate)) throw new Error("Git inspection path escapes the authorized worktree");
    const actual = await realpath(candidate);
    if (!inside(root, actual)) throw new Error("Git inspection path escapes the authorized worktree");
    const info = await lstat(actual);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Git inspection requires a regular repository file");
    path = relative(root, actual).split(sep).join("/");
    if (!listRepositoryFiles(root).includes(path)) throw new Error("Git inspection path is excluded by repository retrieval policy");
  }
  let args: string[];
  switch (input.operation) {
    case "diff":
      args = ["diff", "HEAD", "--no-ext-diff", "--no-color", "--unified=3", ...(path ? ["--", path] : [])];
      break;
    case "log":
      args = ["log", "-n", "20", "--oneline", "--decorate", ...(path ? ["--", path] : [])];
      break;
    case "show": {
      const revision = input.revision ?? "HEAD";
      if (!/^(?:HEAD|HEAD~[0-9]{1,4}|[a-f0-9]{7,40})$/i.test(revision)) throw new Error("Git show accepts HEAD, bounded HEAD~N, or a hexadecimal commit ID");
      args = ["show", "--format=fuller", "--stat", "--no-ext-diff", "--no-color", revision, ...(path ? ["--", path] : [])];
      break;
    }
    case "blame": {
      if (!path) throw new Error("Git blame requires an authorized file path");
      const start = input.startLine ?? 1;
      const end = input.endLine ?? Math.min(start + 99, 100);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start >= 100) throw new Error("Git blame range must be between 1 and 100 lines");
      args = ["blame", "--line-porcelain", "-L", `${start},${end}`, "--", path];
      break;
    }
  }
  let bytes: Buffer;
  try { bytes = await git(root, args, input.signal); }
  catch { throw new Error(`Git ${input.operation} could not produce a result for the requested revision or range`); }
  const truncated = bytes.byteLength > MAX_RETURN_BYTES;
  return { output: bytes.subarray(0, MAX_RETURN_BYTES).toString("utf8"), truncated };
}
