/**
 * Records the controlled paired Macus-vs-unmodified-Pi benchmark against a
 * REAL authorized OpenAI-compatible endpoint (OpenCode Go gateway).
 *
 * Required environment:
 *   MACUS_LIVE_BASE_URL   e.g. https://opencode.ai/zen/go/v1
 *   MACUS_LIVE_API_KEY    the gateway key
 *   MACUS_LIVE_MODEL      e.g. deepseek-v4-flash
 *
 * Usage: npx tsx scripts/run-live-benchmark.ts <output-report.json>
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { TrustedModelSelection } from "../src/config/trusted-model.js";
import { openStateStore } from "../src/state/state-store.js";
import { runPairedBenchmark, type BenchmarkCondition, type BenchmarkScenario } from "../src/workflow/benchmark.js";
import { runMacusBaseline } from "../src/workflow/macus-baseline.js";
import { runUnmodifiedPiBaseline } from "../src/workflow/pi-baseline.js";

const outputArgument = process.argv[2];
if (!outputArgument || !process.env.MACUS_LIVE_BASE_URL || !process.env.MACUS_LIVE_API_KEY || !process.env.MACUS_LIVE_MODEL) {
  console.error("Usage: MACUS_LIVE_BASE_URL=… MACUS_LIVE_API_KEY=… MACUS_LIVE_MODEL=… npx tsx scripts/run-live-benchmark.ts <output-report.json>");
  process.exit(2);
}
const outputPath = join(process.cwd(), outputArgument);
const REPETITIONS = 3;
const CONDITIONS: BenchmarkCondition[] = [{ repositoryCache: "cold", providerCache: "unknown" }];
const DANGEROUS = /rm\s+-rf|sudo\b|curl\b|wget\b|git\s+push|git\s+reset(--hard)?\b|shutdown\b|mkfs\b/;

const temporaryRoots: string[] = [];

function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; maxBuffer?: number }): string {
  return execFileSync(command, args, { ...options, encoding: "utf8", maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024 });
}

function fixedIdentityEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "Macus Benchmark",
    GIT_AUTHOR_EMAIL: "benchmark@example.invalid",
    GIT_COMMITTER_NAME: "Macus Benchmark",
    GIT_COMMITTER_EMAIL: "benchmark@example.invalid",
    GIT_AUTHOR_DATE: "@1758000000 +0000",
    GIT_COMMITTER_DATE: "@1758000000 +0000",
  };
}

/** Fresh committed workspace per run; fixed identity/dates pin one starting revision per task. */
async function prepareCommittedWorkspace(taskId: string): Promise<{ cwd: string; revision: string }> {
  const cwd = await mkdtemp(join(tmpdir(), `macus-live-${taskId}-`));
  temporaryRoots.push(cwd);
  await writeFile(join(cwd, ".gitignore"), ".macus/\nnode_modules/\n");
  if (taskId === "append-edit") {
    await writeFile(join(cwd, "app.ts"), "export const value = 1;\n");
  } else if (taskId === "discover-edit") {
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(join(cwd, "src", "config.ts"), "export const MAX_RETRIES = 3;\nexport const TIMEOUT_MS = 1500;\n");
    await writeFile(join(cwd, "src", "worker.ts"), "import { TIMEOUT_MS } from './config.js';\nexport function work(): number { return TIMEOUT_MS / 2; }\n");
    await writeFile(join(cwd, "README.md"), "# Fixture\n\nThe worker honors the configured retry limit indirectly through config values.\n");
  } else if (taskId === "test-fix") {
    await mkdir(join(cwd, "src"), { recursive: true });
    await mkdir(join(cwd, "test"), { recursive: true });
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "fixture", private: true, scripts: { test: "node --test test/" } }, null, 2) + "\n");
    await writeFile(join(cwd, "src", "math.ts"), "export function add(a: number, b: number): number {\n  return a + b - 1;\n}\n");
    await writeFile(join(cwd, "test", "math.test.ts"), `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add } from "../src/math.ts";\n\ntest("adds two numbers", () => {\n  assert.equal(add(2, 3), 5);\n  assert.equal(add(0, 0), 0);\n});\n`);
  } else {
    throw new Error(`Unknown benchmark task ${taskId}`);
  }
  run("git", ["init", "-q", cwd], { cwd });
  run("git", ["-C", cwd, "add", "."], { cwd, env: fixedIdentityEnvironment() });
  run("git", ["-C", cwd, "commit", "-qm", "benchmark baseline"], { cwd, env: fixedIdentityEnvironment() });
  return { cwd, revision: run("git", ["-C", cwd, "rev-parse", "HEAD"], { cwd }).trim() };
}

function worktreeChanges(cwd: string): string[] {
  // porcelain lines are "XY <path>": strip the two status columns and the space first, then trim.
  return run("git", ["-C", cwd, "status", "--porcelain"], { cwd }).split("\n").filter((line) => line.trim()).map((line) => line.slice(3).trim());
}

async function evaluateTask(taskId: string, cwd: string): Promise<"passed" | "failed"> {
  const changed = worktreeChanges(cwd);
  if (taskId === "append-edit") {
    const content = await readFile(join(cwd, "app.ts"), "utf8");
    const ok = content.includes("// benchmark-edit-marker") && changed.length === 1 && changed[0] === "app.ts";
    return ok ? "passed" : "failed";
  }
  if (taskId === "discover-edit") {
    const config = await readFile(join(cwd, "src", "config.ts"), "utf8");
    const worker = await readFile(join(cwd, "src", "worker.ts"), "utf8");
    const rightFile = config.startsWith("// BENCHMARK_FOUND_MAX_RETRIES");
    const untouchedElsewhere = !worker.includes("BENCHMARK_FOUND_MAX_RETRIES");
    const onlyConfig = changed.length === 1 && changed[0] === join("src", "config.ts");
    return rightFile && untouchedElsewhere && onlyConfig ? "passed" : "failed";
  }
  // test-fix: the suite must pass, and only src/math.ts may change (editing tests would be cheating).
  try {
    run("npm", ["test", "--silent"], { cwd, env: { ...process.env } });
  } catch {
    return "failed";
  }
  const cleanChanges = changed.every((path) => path === join("src", "math.ts"));
  return cleanChanges && changed.length === 1 ? "passed" : "failed";
}

function liveSelection(): TrustedModelSelection {
  return {
    alias: "opencode_go",
    aliasSource: "runtime",
    providerId: "opencode_go",
    protocol: "openai-compatible",
    baseUrl: process.env.MACUS_LIVE_BASE_URL!,
    apiKey: process.env.MACUS_LIVE_API_KEY!,
    protectedCredentialEnvironmentNames: [],
    credentialEnvironmentNames: [],
    profile: "standard",
    model: process.env.MACUS_LIVE_MODEL!,
    contextWindow: 131072,
    maxOutputTokens: 8192,
    reservedOutputTokens: 8192,
    safetyMarginTokens: 2048,
    runLimits: { maxModelTurns: 40, maxNoProgressAttempts: 3, maxDurationSeconds: 1800 },
    execution: {
      commandTimeoutMs: 120_000,
      testBuildTimeoutMs: 600_000,
      terminationGraceMs: 2_000,
      maxOutputMemoryBytes: 8 * 1024 * 1024,
      maxLogBytes: 100 * 1024 * 1024,
      environmentAllowlist: ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"],
    },
    logs: { retentionDays: 7, maxTotalBytes: 1024 * 1024 * 1024 },
    features: { repoMap: false, codeGraph: false, contextLedger: false, checkpoint: false, gitContext: false, taskEngine: false },
  };
}

const TASK_PROMPTS: Record<string, string> = {
  "append-edit": "Append the comment line '// benchmark-edit-marker' at the very end of app.ts using the shell. Do not change anything else.",
  "discover-edit": "Somewhere under src/ a constant named MAX_RETRIES is defined. Find the file that defines it and add the comment '// BENCHMARK_FOUND_MAX_RETRIES' as the first line of that exact file. Do not touch any other file.",
  "test-fix": "Run the test suite with `npm test`, find and fix the bug under src/ so the suite passes, then run the suite again to confirm. Do not modify the tests.",
};

async function main(): Promise<void> {
  const selection = liveSelection();
  const scenarios: BenchmarkScenario[] = Object.keys(TASK_PROMPTS).map((taskId) => {
    return {
      taskId,
      prompt: TASK_PROMPTS[taskId]!,
      startingRevision: "RESOLVED-PER-RUN",
      testOracle: "task-specific worktree and test-suite oracle (see docs/benchmark-report.md)",
      endpointModel: `${selection.providerId}/${selection.model}`,
      generationSettings: { temperature: 0 },
      contextLimitTokens: selection.contextWindow,
      outputLimitTokens: selection.maxOutputTokens,
    };
  });

  // Pin one deterministic starting revision per task up front.
  const revisions = new Map<string, string>();
  for (const scenario of scenarios) {
    const { cwd, revision } = await prepareCommittedWorkspace(scenario.taskId);
    revisions.set(scenario.taskId, revision);
    scenario.startingRevision = revision;
    await rm(cwd, { recursive: true, force: true });
    temporaryRoots.pop();
  }

  const report = await runPairedBenchmark({
    scenarios,
    conditions: CONDITIONS,
    repetitions: REPETITIONS,
    runtime: `paired-live/${process.version}/${process.env.MACUS_LIVE_MODEL}`,
    prepareWorkspace: async () => undefined,
    run: async ({ scenario, system }) => {
      // Gentle pacing reduces gateway transient failures without affecting observations.
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      const { cwd } = await prepareCommittedWorkspace(scenario.taskId);
      const observedRevision = run("git", ["-C", cwd, "rev-parse", "HEAD"], { cwd }).trim();
      if (observedRevision !== revisions.get(scenario.taskId)) throw new Error("Workspace starting revision diverged from the scenario revision");
      const testOracle = async () => evaluateTask(scenario.taskId, cwd);
      const recoveryOracle = async (): Promise<boolean> => {
        // The worktree must contain only the task's intended change; nothing destroyed.
        const changed = worktreeChanges(cwd);
        return changed.length >= 1 && changed.length <= 2;
      };
      const authorizeCommand = async (command: string) => command.length <= 500 && !DANGEROUS.test(command);
      if (system === "unmodified_pi") {
        return runUnmodifiedPiBaseline({
          cwd,
          scenario,
          selection,
          tools: ["read", "bash", "edit"],
          testOracle,
          recoveryOracle,
        });
      }
      const stateStore = openStateStore(join(cwd, ".macus", "state", "state.db"));
      try {
        return await runMacusBaseline({
          cwd,
          scenario,
          selection,
          stateStore,
          authorizeCommand,
          testOracle,
          recoveryOracle,
        });
      } finally {
        stateStore.close();
      }
    },
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({ ...report, endpointBaseUrlHost: new URL(selection.baseUrl).host }, null, 2)}\n`, "utf8");
  const passed = report.rawRuns.filter((run) => run.observation.testStatus === "passed").length;
  console.log(`Runs: ${report.rawRuns.length} (${passed} passed, ${report.rawRuns.length - passed} not passed)`);
  console.log(`Correctness-first status: ${report.correctnessFirst.status}`);
  if (report.correctnessFirst.regressions.length) console.log("Regressions:", report.correctnessFirst.regressions);
  console.log(`Report written to ${outputPath}`);
}

try {
  await main();
} finally {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
}
