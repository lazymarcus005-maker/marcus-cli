import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { TrustedModelSelection } from "../src/config/trusted-model.js";
import type { BenchmarkScenario } from "../src/workflow/benchmark.js";
import { runUnmodifiedPiBaseline } from "../src/workflow/pi-baseline.js";

const roots: string[] = [];
const servers: Server[] = [];

after(async () => {
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function selection(baseUrl: string): TrustedModelSelection {
  return {
    alias: "benchmark-fixture",
    aliasSource: "runtime",
    providerId: "benchmark-fixture",
    protocol: "openai-compatible",
    baseUrl,
    apiKey: "fixture-key",
    protectedCredentialEnvironmentNames: [],
    credentialEnvironmentNames: [],
    profile: "benchmark-fixture",
    model: "fixture-model",
    contextWindow: 4096,
    maxOutputTokens: 128,
    reservedOutputTokens: 128,
    safetyMarginTokens: 32,
    runLimits: { maxModelTurns: 40, maxNoProgressAttempts: 3, maxDurationSeconds: 1800 },
    execution: {
      commandTimeoutMs: 120_000,
      testBuildTimeoutMs: 600_000,
      terminationGraceMs: 2_000,
      maxOutputMemoryBytes: 8 * 1024 * 1024,
      maxLogBytes: 100 * 1024 * 1024,
      environmentAllowlist: ["PATH"],
    },
    logs: { retentionDays: 7, maxTotalBytes: 1024 * 1024 * 1024 },
    features: { repoMap: false, codeGraph: false, contextLedger: false, checkpoint: false, gitContext: false, taskEngine: false },
  };
}

async function usageProvider(options: { includeUsage?: boolean; fail?: boolean } = {}): Promise<{ baseUrl: string; requests: () => number }> {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    request.resume();
    request.on("end", () => {
      if (options.fail) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "fixture failure" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const chunks = [
        `data: ${JSON.stringify({ id: "baseline-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: "ready" }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ id: "baseline-fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(options.includeUsage === false ? {} : { usage: { prompt_tokens: 17, prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 }, completion_tokens: 4, total_tokens: 21 } }) })}`,
        "data: [DONE]",
        "",
        "",
      ];
      response.end(chunks.join("\n\n"));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests: () => requests };
}

function scenarioFor(model: TrustedModelSelection): BenchmarkScenario {
  return {
    taskId: "baseline-smoke",
    prompt: "Reply with one short word.",
    startingRevision: "a".repeat(40),
    testOracle: "fixture oracle",
    endpointModel: `${model.providerId}/${model.model}`,
    generationSettings: { temperature: 0.2 },
    contextLimitTokens: model.contextWindow,
    outputLimitTokens: model.maxOutputTokens,
  };
}

describe("unmodified Pi benchmark baseline adapter", () => {
  it("runs the pinned Pi session against a trusted endpoint and reports observed usage only", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "macus-pi-baseline-"));
    roots.push(cwd);
    const provider = await usageProvider();
    const model = selection(provider.baseUrl);
    const scenario = scenarioFor(model);
    await assert.rejects(runUnmodifiedPiBaseline({
      cwd,
      scenario: { ...scenario, contextLimitTokens: 8192 },
      selection: model,
      tools: ["read"],
      testOracle: async () => "passed",
    }), /token limits must match/);

    const taskStartedAt = performance.now();
    const observation = await runUnmodifiedPiBaseline({
      cwd,
      scenario,
      selection: model,
      tools: ["read"],
      testOracle: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return "passed";
      },
      recoveryOracle: async () => true,
    });
    const elapsedMs = performance.now() - taskStartedAt;
    assert.ok(provider.requests() > 0);
    assert.equal(observation.testStatus, "passed");
    assert.equal(observation.inputTokens, 17);
    assert.equal(observation.outputTokens, 4);
    assert.equal(observation.cachedInputTokens, 5);
    assert.equal(observation.uncachedInputTokens, 12);
    assert.equal(observation.peakContextTokens, 17);
    assert.equal(observation.toolCalls, 0);
    assert.equal(observation.recoveryPassed, true);
    assert.equal(observation.cliPeakRssBytes, null);
    assert.equal(observation.firstUsefulEditMs, null);
    assert.match(observation.limitation ?? "", /isolated CLI RSS/);
    assert.match(observation.limitation ?? "", /generation settings are recorded/);
    assert.ok(observation.wallTimeMs !== null);
    assert.ok(elapsedMs - observation.wallTimeMs >= 80, "wall time must exclude test/recovery oracle work");
  });

  it("keeps token metrics unknown when the provider omits usage", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "macus-pi-baseline-no-usage-"));
    roots.push(cwd);
    const provider = await usageProvider({ includeUsage: false });
    const model = selection(provider.baseUrl);
    const observation = await runUnmodifiedPiBaseline({
      cwd,
      scenario: scenarioFor(model),
      selection: model,
      tools: ["read"],
      testOracle: async () => "passed",
    });

    assert.equal(observation.testStatus, "passed");
    assert.equal(observation.inputTokens, null);
    assert.equal(observation.outputTokens, null);
    assert.equal(observation.cachedInputTokens, null);
    assert.equal(observation.uncachedInputTokens, null);
    assert.match(observation.limitation ?? "", /token metrics are unknown/);
  });

  it("does not run correctness or recovery oracles after a failed Pi prompt", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "macus-pi-baseline-failed-"));
    roots.push(cwd);
    const provider = await usageProvider({ fail: true });
    const model = selection(provider.baseUrl);
    let testOracleCalled = false;
    let recoveryOracleCalled = false;
    const observation = await runUnmodifiedPiBaseline({
      cwd,
      scenario: scenarioFor(model),
      selection: model,
      tools: ["read"],
      testOracle: async () => {
        testOracleCalled = true;
        return "passed";
      },
      recoveryOracle: async () => {
        recoveryOracleCalled = true;
        return true;
      },
    });

    assert.equal(provider.requests(), 1);
    assert.equal(observation.testStatus, "unknown");
    assert.equal(observation.recoveryPassed, null);
    assert.equal(observation.inputTokens, null);
    assert.equal(testOracleCalled, false);
    assert.equal(recoveryOracleCalled, false);
    assert.match(observation.limitation ?? "", /session or prompt failed/);
  });
});
