import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export interface ChangedFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";
}
export interface GitContext {
  isRepository: boolean;
  branch: string | null;
  head: string | null;
  changedFiles: ChangedFile[];
  fileHashes: Array<{ path: string; sha256: string | null }>;
  diff: string;
  diffTruncated: boolean;
  snapshotDigest: string;
}

const MAX_DIFF_BYTES = 256 * 1024;

function git(root: string, args: string[], maxBuffer = 2 * 1024 * 1024): Buffer {
  return execFileSync("git", ["-C", root, ...args], { encoding: "buffer", maxBuffer, stdio: ["ignore", "pipe", "ignore"] });
}

function statusKind(code: string): ChangedFile["status"] {
  if (code === "??") return "untracked";
  if (code.includes("U") || code === "AA" || code === "DD") return "conflicted";
  if (code.includes("R")) return "renamed";
  if (code.includes("A")) return "added";
  if (code.includes("D")) return "deleted";
  return "modified";
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

export async function readGitContext(directory: string): Promise<GitContext> {
  const requestedDirectory = await realpath(directory);
  let root: string;
  try {
    root = await realpath(git(requestedDirectory, ["rev-parse", "--show-toplevel"], 64 * 1024).toString("utf8").trim());
  } catch {
    const digest = createHash("sha256").update(`non-git:${requestedDirectory}`).digest("hex");
    return { isRepository: false, branch: null, head: null, changedFiles: [], fileHashes: [], diff: "", diffTruncated: false, snapshotDigest: digest };
  }
  let head: string | null;
  let branch: string | null;
  let statusBytes: Buffer;
  try { head = git(root, ["rev-parse", "HEAD"], 64 * 1024).toString("utf8").trim() || null; }
  catch { head = null; }
  try {
    branch = git(root, ["branch", "--show-current"], 64 * 1024).toString("utf8").trim() || null;
    statusBytes = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  } catch (error) {
    throw new Error(`Unable to read Git working-tree state: ${error instanceof Error ? error.message : "git command failed"}`);
  }

  const entries = statusBytes.toString("utf8").split("\0").filter(Boolean);
  const changedFiles: ChangedFile[] = [];
  for (let index = 0; index < entries.length; index++) {
    const record = entries[index]!;
    const code = record.slice(0, 2);
    let path = record.slice(3);
    if (code.includes("R") || code.includes("C")) path = entries[++index] ?? path;
    const status = statusKind(code);
    changedFiles.push({ path, status });
  }

  let diffBuffer: Buffer;
  try {
    const diffArgs = head
      ? ["diff", "HEAD", "--no-ext-diff", "--no-color", "--unified=3"]
      : ["diff", "--cached", "--no-ext-diff", "--no-color", "--unified=3"];
    diffBuffer = git(root, diffArgs, 16 * 1024 * 1024);
  }
  catch { diffBuffer = Buffer.from("Git diff unavailable\n"); }
  const diffTruncated = diffBuffer.byteLength > MAX_DIFF_BYTES;
  const diff = diffBuffer.subarray(0, MAX_DIFF_BYTES).toString("utf8");

  const hash = createHash("sha256").update(head ?? "no-head").update(statusBytes);
  const fileHashes: Array<{ path: string; sha256: string | null }> = [];
  for (const file of [...changedFiles].sort((a, b) => a.path.localeCompare(b.path))) {
    const target = resolve(root, file.path);
    if (!isWithin(root, target)) continue;
    hash.update(file.path).update(file.status);
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) {
        hash.update("symlink");
        fileHashes.push({ path: file.path, sha256: null });
        continue;
      }
      if (!info.isFile()) { fileHashes.push({ path: file.path, sha256: null }); continue; }
      const actual = await realpath(target);
      if (isWithin(root, actual)) {
        const bytes = await readFile(actual);
        hash.update(bytes);
        fileHashes.push({ path: file.path, sha256: createHash("sha256").update(bytes).digest("hex") });
      } else fileHashes.push({ path: file.path, sha256: null });
    } catch {
      hash.update("missing");
      fileHashes.push({ path: file.path, sha256: null });
    }
  }
  return { isRepository: true, branch, head, changedFiles, fileHashes, diff, diffTruncated, snapshotDigest: hash.digest("hex") };
}
