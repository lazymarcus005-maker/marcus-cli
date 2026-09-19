import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const REFERENCE_BENCHMARK_FILE_COUNT = 10_000;
export const REFERENCE_BENCHMARK_TARGET_BYTES = 100 * 1024 * 1024;

const MAX_FIXTURE_FILE_COUNT = 50_000;
const MAX_FIXTURE_BYTES = 512 * 1024 * 1024;
const FIXTURE_MANIFEST_PATH = ".macus/benchmark/fixture-v1.json";

export interface BenchmarkFixtureFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BenchmarkFixtureManifest {
  schemaVersion: 1;
  fixtureVersion: "benchmark-v1";
  fileCount: number;
  targetBytes: number;
  sourceBytes: number;
  languages: { typescript: number; javascript: number; csharp: number };
  excludedPaths: string[];
  files: BenchmarkFixtureFile[];
  fixtureSha256: string;
}

export interface GenerateBenchmarkFixtureInput {
  root: string;
  fileCount?: number;
  targetBytes?: number;
}

type FixtureLanguage = keyof BenchmarkFixtureManifest["languages"];
type FixtureLanguageDefinition = {
  extension: "ts" | "js" | "cs";
  createBaseSource: (id: string, fileNumber: number) => string;
};

const FIXTURE_LANGUAGE_DEFINITIONS: Record<FixtureLanguage, FixtureLanguageDefinition> = {
  typescript: { extension: "ts", createBaseSource: createExportedObjectSource },
  javascript: { extension: "js", createBaseSource: createExportedObjectSource },
  csharp: { extension: "cs", createBaseSource: createCSharpTypeSource },
};

/** Create a deterministic 10,000-file, 100 MiB TS/JS/C# source corpus in an empty directory. */
export async function generateBenchmarkFixture(input: GenerateBenchmarkFixtureInput): Promise<BenchmarkFixtureManifest> {
  if (!input.root.trim()) throw new Error("Benchmark fixture root must not be empty");
  const fileCount = input.fileCount ?? REFERENCE_BENCHMARK_FILE_COUNT;
  const targetBytes = input.targetBytes ?? REFERENCE_BENCHMARK_TARGET_BYTES;
  if (!Number.isSafeInteger(fileCount) || fileCount < 10 || fileCount > MAX_FIXTURE_FILE_COUNT) {
    throw new Error(`Benchmark fixture file count must be between 10 and ${MAX_FIXTURE_FILE_COUNT}`);
  }
  if (!Number.isSafeInteger(targetBytes) || targetBytes < 1 || targetBytes > MAX_FIXTURE_BYTES) {
    throw new Error(`Benchmark fixture target bytes must be between 1 and ${MAX_FIXTURE_BYTES}`);
  }

  const root = resolve(input.root);
  await assertEmptyDirectory(root);

  const typescriptCount = Math.floor(fileCount * 0.4);
  const javascriptCount = Math.floor(fileCount * 0.3);
  const languages = {
    typescript: typescriptCount,
    javascript: javascriptCount,
    csharp: fileCount - typescriptCount - javascriptCount,
  };
  const plans = Array.from({ length: fileCount }, (_, index) => {
    const fileNumber = index + 1;
    const language: FixtureLanguage = fileNumber <= languages.typescript
      ? "typescript"
      : fileNumber <= languages.typescript + languages.javascript ? "javascript" : "csharp";
    const definition = FIXTURE_LANGUAGE_DEFINITIONS[language];
    const id = String(fileNumber).padStart(5, "0");
    const path = `src/${language}/fixture-${id}.${definition.extension}`;
    const source = definition.createBaseSource(id, fileNumber);
    return { language, path, id, source, baseBytes: Buffer.byteLength(source, "utf8") };
  });
  const baseBytes = plans.reduce((total, plan) => total + plan.baseBytes, 0);
  if (targetBytes < baseBytes) throw new Error(`Benchmark fixture target bytes must be at least ${baseBytes} for generated source declarations`);
  const paddingBytes = targetBytes - baseBytes;
  const paddingPerFile = Math.floor(paddingBytes / fileCount);
  const paddingRemainder = paddingBytes % fileCount;

  await mkdir(join(root, ".macus", "benchmark"), { recursive: true });
  for (const language of Object.keys(languages) as FixtureLanguage[]) {
    if (languages[language] > 0) await mkdir(join(root, "src", language), { recursive: true });
  }

  const files: BenchmarkFixtureFile[] = [];
  for (const [index, plan] of plans.entries()) {
    const paddingLength = paddingPerFile + (index < paddingRemainder ? 1 : 0);
    const source = plan.source + createPadding(plan.id, paddingLength);
    const digest = createHash("sha256").update(source, "utf8").digest("hex");
    await writeFile(join(root, plan.path), source, { encoding: "utf8", flag: "wx" });
    files.push({ path: plan.path, bytes: Buffer.byteLength(source, "utf8"), sha256: digest });
  }
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  const fixtureDigest = createHash("sha256");
  for (const file of files) fixtureDigest.update(file.path).update("\0").update(String(file.bytes)).update("\0").update(file.sha256).update("\n");
  const manifest: BenchmarkFixtureManifest = {
    schemaVersion: 1,
    fixtureVersion: "benchmark-v1",
    fileCount,
    targetBytes,
    sourceBytes: files.reduce((total, file) => total + file.bytes, 0),
    languages,
    excludedPaths: [".macus/**"],
    files,
    fixtureSha256: fixtureDigest.digest("hex"),
  };
  await writeFile(join(root, FIXTURE_MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return manifest;
}

async function assertEmptyDirectory(root: string): Promise<void> {
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Benchmark fixture root must be a real directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(root, { recursive: true });
  }
  if ((await readdir(root)).length > 0) throw new Error("Benchmark fixture root must be empty; existing files were preserved");
}

function createExportedObjectSource(id: string, fileNumber: number): string {
  return `export const fixtureItem${id} = { id: ${fileNumber}, value: "fixture-${id}" };\n`;
}

function createCSharpTypeSource(id: string, fileNumber: number): string {
  return `namespace MacusBenchmark.Generated;\npublic static class FixtureItem${id} { public const int Id = ${fileNumber}; }\n`;
}

function createPadding(id: string, bytes: number): string {
  if (!bytes) return "";
  const pattern = `// deterministic fixture padding ${id}\n`;
  return pattern.repeat(Math.ceil(bytes / pattern.length)).slice(0, bytes);
}
