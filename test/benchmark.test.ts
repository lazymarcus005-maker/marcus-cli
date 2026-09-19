import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runPairedBenchmark, type BenchmarkCondition, type BenchmarkObservation, type BenchmarkScenario } from "../src/workflow/benchmark.js";

const scenario: BenchmarkScenario = {
  taskId: "bounded-search",
  prompt: "Find and explain the requested symbol.",
  startingRevision: "a".repeat(40),
  testOracle: "node test/oracle.test.js",
  endpointModel: "fixture/model-v1",
  generationSettings: { temperature: 0, maxTokens: 256 },
  contextLimitTokens: 8192,
  outputLimitTokens: 256,
};
const condition: BenchmarkCondition = { repositoryCache: "cold", providerCache: "unknown" };
const observation = (testStatus: BenchmarkObservation["testStatus"] = "passed", recoveryPassed: boolean | null = true, wallTimeMs = 1000): BenchmarkObservation => ({
  testStatus,
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: null,
  uncachedInputTokens: null,
  wallTimeMs,
  firstUsefulEditMs: 250,
  toolCalls: 2,
  peakContextTokens: 400,
  cliPeakRssBytes: 40_000_000,
  recoveryPassed,
});

describe("paired benchmark harness", () => {
  it("runs three matched repetitions with alternating order and reports raw data plus distributions", async () => {
    const prepared: string[] = [];
    const report = await runPairedBenchmark({
      scenarios: [scenario],
      conditions: [condition],
      repetitions: 3,
      now: () => new Date("2026-09-19T00:00:00.000Z"),
      prepareWorkspace: async ({ system, repetition }) => { prepared.push(`${repetition}:${system}`); },
      run: async ({ system }) => observation(system === "macus" ? "passed" : "passed"),
    });
    assert.deepEqual(prepared, ["0:unmodified_pi", "0:macus", "1:macus", "1:unmodified_pi", "2:unmodified_pi", "2:macus"]);
    assert.equal(report.rawRuns.length, 6);
    assert.equal(report.correctnessFirst.pairedComparisons, 3);
    assert.equal(report.correctnessFirst.status, "no-regression-observed");
    assert.ok(Object.keys(report).indexOf("correctnessFirst") < Object.keys(report).indexOf("rawRuns"));
    assert.ok(Object.keys(report).indexOf("correctnessFirst") < Object.keys(report).indexOf("metricDistributions"));
    assert.equal(report.metricDistributions.macus?.["bounded-search"]?.["repositoryCache=cold;providerCache=unknown"]?.wallTimeMs?.median, 1000);
    assert.equal(report.rawRuns[0]?.promptSha256, report.rawRuns[1]?.promptSha256);
    assert.equal(report.rawRuns[0]?.repositoryCache, "cold");
    assert.equal(report.rawRuns[0]?.providerCache, "unknown");
  });

  it("keeps metric distributions separate for repository and provider cache states", async () => {
    const conditions: BenchmarkCondition[] = [
      { repositoryCache: "cold", providerCache: "cold" },
      { repositoryCache: "cold", providerCache: "warm" },
      { repositoryCache: "warm", providerCache: "unknown" },
      { repositoryCache: "unknown", providerCache: "unknown" },
    ];
    const report = await runPairedBenchmark({
      scenarios: [scenario],
      conditions,
      repetitions: 3,
      prepareWorkspace: async () => undefined,
      run: async ({ condition: current }) => observation("passed", true,
        current.repositoryCache === "cold" && current.providerCache === "cold" ? 100
          : current.repositoryCache === "cold" && current.providerCache === "warm" ? 200
            : current.repositoryCache === "warm" ? 300 : 400),
    });

    assert.equal(report.metricDistributions.macus?.["bounded-search"]?.["repositoryCache=cold;providerCache=cold"]?.wallTimeMs?.median, 100);
    assert.equal(report.metricDistributions.unmodified_pi?.["bounded-search"]?.["repositoryCache=cold;providerCache=warm"]?.wallTimeMs?.median, 200);
    assert.equal(report.metricDistributions.macus?.["bounded-search"]?.["repositoryCache=warm;providerCache=unknown"]?.wallTimeMs?.median, 300);
    assert.equal(report.metricDistributions.macus?.["bounded-search"]?.["repositoryCache=unknown;providerCache=unknown"]?.wallTimeMs?.median, 400);
    assert.equal(report.metricDistributions.macus?.["bounded-search"]?.["repositoryCache=cold;providerCache=cold"]?.wallTimeMs?.count, 3);
  });

  it("keeps distributions separate by task as well as system and cache condition", async () => {
    const slowScenario: BenchmarkScenario = { ...scenario, taskId: "large-output" };
    const report = await runPairedBenchmark({
      scenarios: [scenario, slowScenario],
      conditions: [condition],
      repetitions: 3,
      prepareWorkspace: async () => undefined,
      run: async ({ scenario: current, system }) => observation("passed", true,
        current.taskId === "bounded-search" ? (system === "macus" ? 100 : 110) : (system === "macus" ? 900 : 910)),
    });

    const conditionKey = "repositoryCache=cold;providerCache=unknown";
    assert.equal(report.metricDistributions.macus?.["bounded-search"]?.[conditionKey]?.wallTimeMs?.median, 100);
    assert.equal(report.metricDistributions.macus?.["large-output"]?.[conditionKey]?.wallTimeMs?.median, 900);
    assert.equal(report.metricDistributions.unmodified_pi?.["bounded-search"]?.[conditionKey]?.wallTimeMs?.median, 110);
    assert.equal(report.metricDistributions.unmodified_pi?.["large-output"]?.[conditionKey]?.wallTimeMs?.median, 910);
  });

  it("preserves special task IDs as own properties in serialized reports", async () => {
    const specialScenario: BenchmarkScenario = { ...scenario, taskId: "__proto__" };
    const report = await runPairedBenchmark({
      scenarios: [specialScenario],
      conditions: [condition],
      repetitions: 3,
      prepareWorkspace: async () => undefined,
      run: async () => observation(),
    });

    const serialized = JSON.parse(JSON.stringify(report)) as typeof report;
    assert.ok(Object.hasOwn(serialized.metricDistributions.macus, "__proto__"));
    assert.equal(serialized.metricDistributions.macus["__proto__"]?.["repositoryCache=cold;providerCache=unknown"]?.wallTimeMs?.median, 1000);
  });

  it("surfaces correctness/recovery regressions before performance and marks unknown comparisons inconclusive", async () => {
    let currentPairRun = 0;
    const report = await runPairedBenchmark({
      scenarios: [scenario],
      conditions: [condition],
      repetitions: 3,
      prepareWorkspace: async () => undefined,
      run: async ({ system }) => {
        currentPairRun++;
        if (currentPairRun > 2) return observation("unknown", null);
        return observation(system === "macus" ? "failed" : "passed", system === "macus" ? false : true);
      },
    });
    assert.equal(report.correctnessFirst.status, "regression");
    assert.equal(report.correctnessFirst.regressions.length, 2);
    assert.equal(report.correctnessFirst.unknownComparisons.length, 2);
  });

  it("requires at least three repetitions and never converts adapter failures into passes", async () => {
    await assert.rejects(runPairedBenchmark({ scenarios: [scenario], conditions: [condition], repetitions: 2, prepareWorkspace: async () => undefined, run: async () => observation() }), /between 3 and 100/);
    await assert.rejects(runPairedBenchmark({ scenarios: [scenario], conditions: [condition, condition], repetitions: 3, prepareWorkspace: async () => undefined, run: async () => observation() }), /condition .* is duplicated/);
    const report = await runPairedBenchmark({
      scenarios: [scenario],
      conditions: [condition],
      repetitions: 3,
      prepareWorkspace: async () => undefined,
      run: async ({ system }) => { if (system === "macus") throw new Error("fixture offline"); return observation(); },
    });
    assert.equal(report.correctnessFirst.status, "inconclusive");
    assert.ok(report.rawRuns.filter((run) => run.system === "macus").every((run) => run.observation.testStatus === "unknown"));
    const limitation = report.rawRuns.find((run) => run.system === "macus")?.observation.limitation ?? "";
    assert.match(limitation, /raw error omitted/);
    assert.doesNotMatch(limitation, /fixture offline/);
  });
});
