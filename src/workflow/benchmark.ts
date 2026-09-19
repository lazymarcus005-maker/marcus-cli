import { createHash, randomUUID } from "node:crypto";
import type { TrustedModelSelection } from "../config/trusted-model.js";
import { validateProviderGenerationSettings } from "../kernel/provider-generation-settings.js";

export type BenchmarkSystem = "unmodified_pi" | "macus";
export type BenchmarkRepositoryCache = "cold" | "warm" | "unknown";
export type BenchmarkProviderCache = "cold" | "warm" | "unknown";
export type BenchmarkTestStatus = "passed" | "failed" | "unknown";

export function isFailedAssistantStopReason(stopReason: string): boolean {
  return stopReason === "error" || stopReason === "aborted" || stopReason === "deferred" || stopReason === "pending";
}

export interface BenchmarkScenario {
  taskId: string;
  prompt: string;
  startingRevision: string;
  testOracle: string;
  endpointModel: string;
  generationSettings: Record<string, unknown>;
  contextLimitTokens: number;
  outputLimitTokens: number;
}

export function validateBenchmarkScenario(
  scenario: BenchmarkScenario,
  selection: TrustedModelSelection,
  system: "Pi" | "Macus",
): Record<string, unknown> {
  if (scenario.endpointModel !== `${selection.providerId}/${selection.model}`) {
    throw new Error(`Benchmark scenario endpoint/model does not match the trusted ${system} model selection`);
  }
  if (scenario.contextLimitTokens !== selection.contextWindow || scenario.outputLimitTokens !== selection.maxOutputTokens) {
    throw new Error(`Benchmark scenario token limits must match the trusted ${system} model selection`);
  }
  return validateProviderGenerationSettings(scenario.generationSettings, selection.reservedOutputTokens);
}

export interface BenchmarkCondition {
  repositoryCache: BenchmarkRepositoryCache;
  providerCache: BenchmarkProviderCache;
}

export interface BenchmarkObservation {
  testStatus: BenchmarkTestStatus;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  uncachedInputTokens: number | null;
  wallTimeMs: number | null;
  firstUsefulEditMs: number | null;
  toolCalls: number | null;
  peakContextTokens: number | null;
  cliPeakRssBytes: number | null;
  recoveryPassed: boolean | null;
  limitation?: string;
}

export interface BenchmarkRawRun extends BenchmarkScenario, BenchmarkCondition {
  runId: string;
  pairId: string;
  system: BenchmarkSystem;
  runOrder: number;
  repetition: number;
  promptSha256: string;
  observation: BenchmarkObservation;
}

export interface BenchmarkReport {
  schemaVersion: 1;
  benchmarkId: string;
  createdAt: string;
  runtime: string;
  repetitions: number;
  conditions: BenchmarkCondition[];
  correctnessFirst: {
    pairedComparisons: number;
    regressions: string[];
    unknownComparisons: string[];
    status: "regression" | "no-regression-observed" | "inconclusive";
  };
  rawRuns: BenchmarkRawRun[];
  metricDistributions: Record<string, Record<string, Record<string, { count: number; median: number | null; p95: number | null }>>>;
  claims: string[];
}

export interface BenchmarkHarnessInput {
  scenarios: BenchmarkScenario[];
  conditions: BenchmarkCondition[];
  repetitions: number;
  prepareWorkspace: (input: { scenario: BenchmarkScenario; system: BenchmarkSystem; condition: BenchmarkCondition; repetition: number }) => Promise<void>;
  run: (input: { scenario: BenchmarkScenario; system: BenchmarkSystem; condition: BenchmarkCondition; repetition: number }) => Promise<BenchmarkObservation>;
  now?: () => Date;
  runtime?: string;
}

function validateObservation(observation: BenchmarkObservation): void {
  if (!(observation.testStatus === "passed" || observation.testStatus === "failed" || observation.testStatus === "unknown")) throw new Error("Benchmark test oracle status is invalid");
  for (const field of ["inputTokens", "outputTokens", "cachedInputTokens", "uncachedInputTokens", "wallTimeMs", "firstUsefulEditMs", "toolCalls", "peakContextTokens", "cliPeakRssBytes"] as const) {
    const value = observation[field];
    if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error(`Benchmark metric ${field} must be a non-negative finite number or null`);
  }
  if (observation.recoveryPassed !== null && typeof observation.recoveryPassed !== "boolean") throw new Error("Benchmark recovery status must be boolean or unknown");
}

function distribution(values: number[]): { count: number; median: number | null; p95: number | null } {
  if (!values.length) return { count: 0, median: null, p95: null };
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return { count: sorted.length, median, p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]! };
}

/** Paired, order-alternated measurement harness. Workspace reset and adapters are explicit dependencies. */
export async function runPairedBenchmark(input: BenchmarkHarnessInput): Promise<BenchmarkReport> {
  if (!input.scenarios.length || !input.conditions.length) throw new Error("Benchmark requires at least one scenario and one condition");
  if (!Number.isSafeInteger(input.repetitions) || input.repetitions < 3 || input.repetitions > 100) throw new Error("Benchmark repetitions must be between 3 and 100");
  if (input.scenarios.length > 100 || input.conditions.length > 20 || input.scenarios.length * input.conditions.length * input.repetitions * 2 > 2000) throw new Error("Benchmark plan exceeds the 2000-run safety bound");
  const stableScenarios = input.scenarios.map((scenario) => structuredClone(scenario));
  const stableConditions = input.conditions.map((condition) => structuredClone(condition));
  const conditionKeys = new Set<string>();
  for (const condition of stableConditions) {
    if (!["cold", "warm", "unknown"].includes(condition.repositoryCache) || !["cold", "warm", "unknown"].includes(condition.providerCache)) {
      throw new Error("Benchmark cache conditions must be cold, warm, or unknown");
    }
    const key = benchmarkConditionKey(condition);
    if (conditionKeys.has(key)) throw new Error(`Benchmark cache condition ${key} is duplicated`);
    conditionKeys.add(key);
  }
  const taskIds = new Set<string>();
  for (const scenario of stableScenarios) {
    if (!scenario.taskId.trim() || taskIds.has(scenario.taskId)) throw new Error("Benchmark task IDs must be non-empty and unique");
    taskIds.add(scenario.taskId);
    if (!scenario.prompt || !scenario.startingRevision || !scenario.testOracle || !scenario.endpointModel) throw new Error(`Benchmark scenario ${scenario.taskId} is missing its prompt, revision, oracle, or endpoint/model`);
    for (const limit of [scenario.contextLimitTokens, scenario.outputLimitTokens]) if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`Benchmark scenario ${scenario.taskId} has invalid token limits`);
  }
  const rawRuns: BenchmarkRawRun[] = [];
  let order = 0;
  for (const scenario of stableScenarios) {
    for (const condition of stableConditions) {
      for (let repetition = 0; repetition < input.repetitions; repetition++) {
        const pairId = randomUUID();
        const systems: BenchmarkSystem[] = repetition % 2 === 0 ? ["unmodified_pi", "macus"] : ["macus", "unmodified_pi"];
        for (const system of systems) {
          let observation: BenchmarkObservation;
          try {
            await input.prepareWorkspace({ scenario: structuredClone(scenario), system, condition: structuredClone(condition), repetition });
            observation = await input.run({ scenario: structuredClone(scenario), system, condition: structuredClone(condition), repetition });
            validateObservation(observation);
          } catch {
            observation = {
              testStatus: "unknown",
              inputTokens: null,
              outputTokens: null,
              cachedInputTokens: null,
              uncachedInputTokens: null,
              wallTimeMs: null,
              firstUsefulEditMs: null,
              toolCalls: null,
              peakContextTokens: null,
              cliPeakRssBytes: null,
              recoveryPassed: null,
              limitation: "Workspace or runner adapter failed; raw error omitted to avoid recording secrets.",
            };
          }
          rawRuns.push({
            ...scenario,
            ...condition,
            runId: randomUUID(),
            pairId,
            system,
            runOrder: order++,
            repetition,
            promptSha256: createHash("sha256").update(scenario.prompt).digest("hex"),
            observation,
          });
        }
      }
    }
  }

  const pairs = new Map<string, Partial<Record<BenchmarkSystem, BenchmarkRawRun>>>();
  for (const run of rawRuns) pairs.set(run.pairId, { ...pairs.get(run.pairId), [run.system]: run });
  const regressions: string[] = [];
  const unknownComparisons: string[] = [];
  for (const [pairId, pair] of pairs) {
    const baseline = pair.unmodified_pi;
    const macus = pair.macus;
    if (!baseline || !macus || baseline.observation.testStatus === "unknown" || macus.observation.testStatus === "unknown" || baseline.observation.recoveryPassed === null || macus.observation.recoveryPassed === null) {
      unknownComparisons.push(pairId);
      continue;
    }
    if (baseline.observation.testStatus === "passed" && macus.observation.testStatus === "failed") regressions.push(`${baseline.taskId}/${baseline.repositoryCache}/${baseline.providerCache}/rep-${baseline.repetition}: correctness regression`);
    if (baseline.observation.recoveryPassed && macus.observation.recoveryPassed === false) regressions.push(`${baseline.taskId}/${baseline.repositoryCache}/${baseline.providerCache}/rep-${baseline.repetition}: recovery regression`);
  }
  const metricNames = ["inputTokens", "outputTokens", "cachedInputTokens", "uncachedInputTokens", "wallTimeMs", "firstUsefulEditMs", "toolCalls", "peakContextTokens", "cliPeakRssBytes"] as const;
  const metricDistributions: BenchmarkReport["metricDistributions"] = {};
  for (const system of ["unmodified_pi", "macus"] as const) {
    metricDistributions[system] = {};
    for (const condition of stableConditions) {
      const conditionKey = benchmarkConditionKey(condition);
      metricDistributions[system]![conditionKey] = {};
      for (const metric of metricNames) {
        metricDistributions[system]![conditionKey]![metric] = distribution(rawRuns
          .filter((run) => run.system === system && run.repositoryCache === condition.repositoryCache && run.providerCache === condition.providerCache)
          .map((run) => run.observation[metric])
          .filter((value): value is number => value !== null));
      }
    }
  }
  const comparisonStatus = regressions.length ? "regression" : unknownComparisons.length ? "inconclusive" : "no-regression-observed";
  return {
    schemaVersion: 1,
    benchmarkId: randomUUID(),
    createdAt: (input.now?.() ?? new Date()).toISOString(),
    runtime: input.runtime ?? process.version,
    repetitions: input.repetitions,
    conditions: stableConditions,
    correctnessFirst: { pairedComparisons: pairs.size, regressions, unknownComparisons, status: comparisonStatus },
    rawRuns,
    metricDistributions,
    claims: ["No performance or equivalence claim is implied by this report.", "Cost is omitted unless an explicit pricing source and configuration are supplied."],
  };
}

function benchmarkConditionKey(condition: BenchmarkCondition): string {
  return `repositoryCache=${condition.repositoryCache};providerCache=${condition.providerCache}`;
}
