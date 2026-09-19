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
const observation = (testStatus: BenchmarkObservation["testStatus"] = "passed", recoveryPassed: boolean | null = true): BenchmarkObservation => ({
  testStatus,
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: null,
  uncachedInputTokens: null,
  wallTimeMs: 1000,
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
    assert.equal(report.metricDistributions.macus?.wallTimeMs?.median, 1000);
    assert.equal(report.rawRuns[0]?.promptSha256, report.rawRuns[1]?.promptSha256);
    assert.equal(report.rawRuns[0]?.repositoryCache, "cold");
    assert.equal(report.rawRuns[0]?.providerCache, "unknown");
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
