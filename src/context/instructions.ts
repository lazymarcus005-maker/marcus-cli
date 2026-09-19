import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export interface ResolvedInstruction {
  path: string;
  directory: string;
  precedence: number;
  sha256: string;
  content: string;
}

const ORDER = ["CLAUDE.md", "AGENTS.md", "MACUS.md"] as const;

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

/** Resolve scoped guidance without treating its contents as an authorization source. */
export async function resolveRepositoryInstructions(
  authorizedRoot: string,
  targetPath: string,
): Promise<ResolvedInstruction[]> {
  const root = await realpath(authorizedRoot);
  const resolvedTarget = await realpath(targetPath);
  const target = (await stat(resolvedTarget)).isDirectory()
    ? resolvedTarget
    : resolve(resolvedTarget, "..");
  if (!isWithin(root, target)) throw new Error("Instruction target escapes the authorized repository root");

  const directories: string[] = [];
  let current = target;
  while (isWithin(root, current)) {
    directories.push(current);
    if (current === root) break;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }

  const result: ResolvedInstruction[] = [];
  for (const directory of directories.reverse()) {
    for (const [precedence, name] of ORDER.entries()) {
      const path = resolve(directory, name);
      let bytes: Buffer;
      let actualPath: string;
      try {
        actualPath = await realpath(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        if ((error as NodeJS.ErrnoException).code === "EISDIR") continue;
        throw error;
      }
      if (!isWithin(root, actualPath)) throw new Error(`Repository instruction file escapes authorized root: ${path}`);
      try {
        bytes = await readFile(actualPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        if ((error as NodeJS.ErrnoException).code === "EISDIR") continue;
        throw error;
      }
      result.push({
        path,
        directory,
        precedence,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        content: bytes.toString("utf8"),
      });
    }
  }
  return result;
}
