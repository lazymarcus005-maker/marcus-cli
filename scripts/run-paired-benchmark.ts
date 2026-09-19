/**
 * Records one controlled paired Macus-vs-unmodified-Pi benchmark against a
 * deterministic loopback OpenAI-compatible provider. The loopback model is a
 * synthetic fixture: it proves the paired harness records real observations
 * end to end, and it is NOT a live-endpoint performance or quality result.
 *
 * Usage: npx tsx scripts/run-paired-benchmark.ts <output-report.json>
 */
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TrustedModelSelection } from "../src/config/trusted-model.js";
import { openStateStore } from "../src/state/state-store.js";
import { runPairedBenchmark, type BenchmarkCondition, type BenchmarkScenario } from "../src/workflow/benchmark.js";
import { runMacusBaseline } from "../src/workflow/macus-baseline.js";
import { runUnmodifiedPiBaseline } from "../src/workflow/pi-baseline.js";

const outputArgument = process.argv[2];
if (!outputArgument) {
  console.error("Usage: npx tsx scripts/run-paired-benchmark.ts <output-report.json>");
  process.exit(2);
}
const outputPath = join(process.cwd(), outputArgument);

const EDIT_COMMAND = "printf '%s\\n' '// benchmark-edit-marker' >> app.ts";
const EXPECTED_MARKER = "// benchmark-edit-marker";
const BASE_APP_TS = "export const value = 1;\n";
const REPETITIONS = 3;
const CONDITIONS: BenchmarkCondition[] = [
  { repositoryCache: "cold", providerCache: "unknown" },
];

const temporaryRoots: string[] = [];
const servers: Server[] = [];

process.on("exit", () => {
  for (const server of servers) server.close();
});

/** Deterministic loopback OpenAI-compatible SSE provider shared by both systems. */
async function startLoopbackProvider(): Promise<string> {
  let toolCallSequence = 0;
  const server = createServer((request, response) => {
    let rawBody = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { rawBody += chunk; });
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunks: string[] = [];
      if (rawBody.includes('"role":"tool"') || rawBody.includes('"role": "tool"')) {
        chunks.push(sseChunk({ delta: { role: "assistant", content: "The benchmark edit is complete." }, finish: null }));
        chunks.push(sseChunk({
          delta: {},
          finish: "stop",
          usage: { prompt_tokens: 24, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 }, completion_tokens: 8, total_tokens: 32 },
        }));
      } else {
        const toolCallId = `call_benchmark_${++toolCallSequence}`;
        chunks.push(sseChunk({
          delta: { role: "assistant", tool_calls: [{ index: 0, id: toolCallId, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: EDIT_COMMAND }) } }] },
          finish: null,
        }));
        chunks.push(sseChunk({
          delta: {},
          finish: "tool_calls",
          usage: { prompt_tokens: 17, prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 }, completion_tokens: 4, total_tokens: 21 },
        }));
      }
      chunks.push("data: [DONE]", "", "");
      response.end(chunks.join("\n\n"));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback provider did not bind a port");
  return `http://127.0.0.1:${address.port}/v1`;
}

function sseChunk(payload: { delta: Record<string, unknown>; finish: string | null; usage?: Record<string, unknown> }): string {
  const choice: Record<string, unknown> = { index: 0, delta: payload.delta, finish_reason: payload.finish };
  if (payload.usage) choice.usage = payload.usage;
  return `data: ${JSON.stringify({ id: "benchmark-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [choice] })}`;
}

function benchmarkSelection(baseUrl: string): TrustedModelSelection {
  return {
    alias: "benchmark-fixture",
    aliasSource: "runtime",
    providerId: "benchmark-fixture",
    protocol: "openai-compatible",
    baseUrl,
    apiKey: "benchmark-loopback-key",
    protectedCredentialEnvironmentNames: [],
    credentialEnvironmentNames: [],
    profile: "benchmark-fixture",
    model: "fixture-model",
    contextWindow: 16_384,
    maxOutputTokens: 256,
    reservedOutputTokens: 256,
    safetyMarginTokens: 32,
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

/** Fresh workspace per run; fixed identity and dates make every HEAD identical. */
async function prepareCommittedWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "macus-paired-benchmark-"));
  temporaryRoots.push(cwd);
  await writeFile(join(cwd, ".gitignore"), ".macus/\n");
  await writeFile(join(cwd, "app.ts"), BASE_APP_TS);
  const fixedEnvironment = {
    ...process.env,
    GIT_AUTHOR_NAME: "Macus Benchmark",
    GIT_AUTHOR_EMAIL: "benchmark@example.invalid",
    GIT_COMMITTER_NAME: "Macus Benchmark",
    GIT_COMMITTER_EMAIL: "benchmark@example.invalid",
    GIT_AUTHOR_DATE: "@1758000000 +0000",
    GIT_COMMITTER_DATE: "@1758000000 +0000",
  };
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "add", "."], { env: fixedEnvironment });
  execFileSync("git", ["-C", cwd, "commit", "-qm", "benchmark baseline"], { env: fixedEnvironment });
  return cwd;
}

async function evaluateWorktree(cwd: string): Promise<boolean> {
  const content = await readFile(join(cwd, "app.ts"), "utf8");
  if (!content.includes(EXPECTED_MARKER)) return false;
  const status = execFileSync("git", ["-C", cwd, "status", "--porcelain"], { encoding: "utf8" })
    .split("\n").map((line) => line.trim()).filter(Boolean);
  return status.length === 1 && status[0]!.endsWith("app.ts");
}

async function main(): Promise<void> {
  const baseUrl = await startLoopbackProvider();
  const selection = benchmarkSelection(baseUrl);

  // One committed workspace up front pins the deterministic starting revision.
  const revisionWorkspace = await prepareCommittedWorkspace();
  const startingRevision = execFileSync("git", ["-C", revisionWorkspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  const scenario: BenchmarkScenario = {
    taskId: "loopback-bash-append-edit",
    prompt: "Append the benchmark marker comment to app.ts using the shell, then confirm the edit.",
    startingRevision,
    testOracle: "git status must show only app.ts modified and app.ts must contain the benchmark marker",
    endpointModel: `${selection.providerId}/${selection.model}`,
    generationSettings: { temperature: 0 },
    contextLimitTokens: selection.contextWindow,
    outputLimitTokens: selection.maxOutputTokens,
  };

  const report = await runPairedBenchmark({
    scenarios: [scenario],
    conditions: CONDITIONS,
    repetitions: REPETITIONS,
    runtime: `paired-loopback/${process.version}`,
    prepareWorkspace: async () => {
      await prepareCommittedWorkspace();
    },
    run: async ({ system, repetition }) => {
      const cwd = await prepareCommittedWorkspace();
      const observedRevision = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      if (observedRevision !== startingRevision) throw new Error("Workspace starting revision diverged from the scenario revision");
      const testOracle = async () => (await evaluateWorktree(cwd)) ? "passed" as const : "failed" as const;
      const recoveryOracle = async (): Promise<boolean> => evaluateWorktree(cwd);
      if (system === "unmodified_pi") {
        return runUnmodifiedPiBaseline({
          cwd,
          scenario,
          selection,
          tools: ["bash"],
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
          authorizeCommand: async (command) => command === EDIT_COMMAND,
          testOracle,
          recoveryOracle,
        });
      } finally {
        stateStore.close();
      }
    },
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const passed = report.rawRuns.filter((run) => run.observation.testStatus === "passed").length;
  console.log(`Runs: ${report.rawRuns.length} (${passed} passed, ${report.rawRuns.length - passed} not passed)`);
  console.log(`Correctness-first status: ${report.correctnessFirst.status}`);
  console.log(`Report written to ${outputPath}`);

  await rm(revisionWorkspace, { recursive: true, force: true });
}

try {
  await main();
} finally {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
}
