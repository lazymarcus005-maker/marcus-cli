import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildSymbolIndex, listRepositoryFiles, type IndexedSymbol, type SymbolIndex } from "./symbol-index.js";

const DEFAULT_MAP_BUDGET = 1200;
const MAX_MAP_BUDGET = 20_000;

export interface RepositoryMap {
  text: string;
  estimatedTokens: number;
  budgetTokens: number;
  includedFiles: string[];
  omittedItems: number;
  indexGeneration: string;
  coverage: SymbolIndex["coverage"];
  cacheStatus: SymbolIndex["cacheStatus"];
}

function priority(path: string): number {
  const lower = path.toLowerCase();
  if (/^(package\.json|readme(?:\.md)?|pyproject\.toml|cargo\.toml|go\.mod|.*\.sln|.*\.csproj)$/.test(lower)) return 0;
  if (/^(src\/)?(index|main|cli)\.(ts|tsx|js|jsx)$/.test(lower)) return 1;
  if (/^(tsconfig\.json|vite\.config\.[^/]+|webpack\.config\.[^/]+|\.github\/workflows\/[^/]+)$/.test(lower)) return 2;
  return 3;
}

function symbolLine(symbol: IndexedSymbol): string {
  return `  ${symbol.kind} ${symbol.name} — ${symbol.signature} [${symbol.startLine}-${symbol.endLine}]`;
}

export async function buildRepositoryMap(options: {
  root: string;
  tokenBudget?: number;
  index?: SymbolIndex;
}): Promise<RepositoryMap> {
  const budgetTokens = options.tokenBudget ?? DEFAULT_MAP_BUDGET;
  if (!Number.isSafeInteger(budgetTokens) || budgetTokens < 1 || budgetTokens > MAX_MAP_BUDGET) {
    throw new Error(`Repository map token budget must be between 1 and ${MAX_MAP_BUDGET}`);
  }
  const root = resolve(options.root);
  const index = options.index ?? await buildSymbolIndex(root);
  const files = listRepositoryFiles(root);
  const candidates: Array<{ section: string; line: string; path?: string; priority: number }> = [];
  for (const path of files) candidates.push({ section: "files", line: `- ${path}`, path, priority: priority(path) });
  let dependencies: string[] = [];
  try {
    const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as Record<string, unknown>;
    for (const area of ["dependencies", "devDependencies", "peerDependencies"]) {
      const value = pkg[area];
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        dependencies.push(...Object.keys(value as Record<string, unknown>));
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  dependencies = [...new Set(dependencies)].sort();
  for (const dependency of dependencies) candidates.push({ section: "dependencies", line: `- ${dependency}`, priority: 2 });
  for (const symbol of index.symbols) {
    candidates.push({ section: "symbols", line: symbolLine(symbol), path: symbol.path, priority: 3 });
  }
  candidates.sort((a, b) => a.priority - b.priority || a.section.localeCompare(b.section) || (a.path ?? "").localeCompare(b.path ?? "") || a.line.localeCompare(b.line));

  const partialFiles = index.coverage.filter((entry) => entry.status === "partial").length;
  const unsupportedFiles = index.coverage.filter((entry) => entry.status === "unsupported").length;
  const heading = `Repository map (index cache: ${index.cacheStatus}; partial files: ${partialFiles}; unsupported files: ${unsupportedFiles})\n`;
  let text = Buffer.byteLength(heading, "utf8") <= budgetTokens ? heading : "";
  let previousSection = "";
  const includedFiles: string[] = [];
  let omittedItems = 0;
  for (const candidate of candidates) {
    const sectionHeader = candidate.section === previousSection ? "" : `\n${candidate.section === "files" ? "Files" : candidate.section === "dependencies" ? "Important dependencies" : "Declarations"}\n`;
    const next = `${sectionHeader}${candidate.line}\n`;
    if (Buffer.byteLength(text + next, "utf8") > budgetTokens) {
      omittedItems++;
      continue;
    }
    text += next;
    previousSection = candidate.section;
    if (candidate.path) includedFiles.push(candidate.path);
  }
  if (omittedItems > 0) {
    const note = `\n[${omittedItems} map items omitted by the ${budgetTokens}-token conservative byte budget]\n`;
    if (Buffer.byteLength(text + note, "utf8") <= budgetTokens) text += note;
  }
  return {
    text,
    estimatedTokens: Buffer.byteLength(text, "utf8"),
    budgetTokens,
    includedFiles: [...new Set(includedFiles)],
    omittedItems,
    indexGeneration: index.generationId,
    coverage: index.coverage,
    cacheStatus: index.cacheStatus,
  };
}
