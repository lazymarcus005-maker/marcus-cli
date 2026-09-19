import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { listRepositoryFiles } from "./symbol-index.js";

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

export class StaleEditError extends Error {
  constructor(readonly currentSha256: string) {
    super("File changed since it was read; refresh and recalculate the edit");
    this.name = "StaleEditError";
  }
}

/** Hash-checked, atomic workspace replacement; callers must journal and authorize before invoking. */
export async function replaceFileSafely(options: {
  root: string;
  path: string;
  expectedSha256: string;
  content: string | Uint8Array;
}): Promise<{ path: string; sha256: string }> {
  const root = await realpath(options.root);
  const candidate = resolve(root, options.path);
  if (!isWithin(root, candidate) || candidate === root || relative(root, candidate).split(sep)[0] === ".macus") {
    throw new Error("Edit path is outside the authorized source area");
  }
  const parent = await realpath(dirname(candidate));
  const target = resolve(parent, basename(candidate));
  if (!isWithin(root, parent) || !isWithin(root, target)) throw new Error("Edit path escapes the authorized root");
  const repoRelativePath = relative(root, target);
  if (!listRepositoryFiles(root).includes(repoRelativePath)) {
    throw new Error("Edit path is excluded by repository retrieval policy");
  }
  const link = await lstat(target);
  if (!link.isFile() || link.isSymbolicLink()) throw new Error("Only regular files can be edited");
  const before = await readFile(target);
  const currentSha256 = createHash("sha256").update(before).digest("hex");
  if (currentSha256 !== options.expectedSha256) throw new StaleEditError(currentSha256);
  const mode = (await stat(target)).mode & 0o777;
  const tempPath = resolve(parent, `.${basename(target)}.macus-${randomUUID()}.tmp`);
  const bytes = typeof options.content === "string" ? Buffer.from(options.content) : Buffer.from(options.content);
  try {
    await writeFile(tempPath, bytes, { flag: "wx", mode });
    await chmod(tempPath, mode);
    // Recheck immediately before atomic replacement to detect ordinary editor races.
    const latest = await readFile(target);
    if (createHash("sha256").update(latest).digest("hex") !== options.expectedSha256) {
      throw new StaleEditError(createHash("sha256").update(latest).digest("hex"));
    }
    await rename(tempPath, target);
  } finally {
    await unlink(tempPath).catch(() => undefined);
  }
  return { path: repoRelativePath, sha256: createHash("sha256").update(bytes).digest("hex") };
}
