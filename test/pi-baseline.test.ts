import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { TrustedModelSelection } from "../src/config/trusted-model.js";
import { acquireWorktreeMutationLock, openStateStore } from "../src/state/state-store.js";
import type { BenchmarkScenario } from "../src/workflow/benchmark.js";
import { runMacusBaseline } from "../src/workflow/macus-baseline.js";
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

async function usageProvider(options: { includeUsage?: boolean; fail?: boolean } = {}): Promise<{ baseUrl: string; requests: () => number; payloads: () => Array<Record<string, unknown>> }> {
  let requests = 0;
  const requestPayloads: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    requests++;
    let rawBody = "";
    request.on("data", (chunk: Buffer) => { rawBody += chunk.toString("utf8"); });
    request.on("end", () => {
      try {
        const payload: unknown = JSON.parse(rawBody);
        if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) requestPayloads.push(payload as Record<string, unknown>);
      } catch { /* A malformed request remains visible through the missing-payload assertion. */ }
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
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests: () => requests, payloads: () => requestPayloads };
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

async function committedMacusWorkspace(prefix: string): Promise<{ cwd: string; startingRevision: string }> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  roots.push(cwd);
  await writeFile(join(cwd, ".gitignore"), ".macus/\n");
  await writeFile(join(cwd, "app.ts"), "export const value = 1;\n");
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "-c", "user.name=Macus Test", "-c", "user.email=macus-test@example.invalid", "commit", "-qm", "baseline"]);
  const startingRevision = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { cwd, startingRevision };
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
    await assert.rejects(runUnmodifiedPiBaseline({
      cwd,
      scenario: { ...scenario, generationSettings: { unsupported_vendor_option: true } },
      selection: model,
      tools: ["read"],
      testOracle: async () => "passed",
    }), /Unsupported OpenAI-compatible generation setting/);
    assert.equal(provider.requests(), 0, "invalid settings must be rejected before contacting the endpoint");

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
    assert.equal(provider.payloads()[0]?.temperature, 0.2);
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
    assert.doesNotMatch(observation.limitation ?? "", /generation settings/);
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

describe("Macus benchmark baseline adapter", () => {
  it("runs the actual Macus kernel with durable state and reports observed usage", async () => {
    const { cwd, startingRevision } = await committedMacusWorkspace("macus-benchmark-kernel-");
    const provider = await usageProvider();
    const model = { ...selection(provider.baseUrl), contextWindow: 16_384, maxOutputTokens: 256, reservedOutputTokens: 256 };
    const stateStore = openStateStore(join(cwd, ".macus", "state", "state.db"));
    let worktreeLockHeldDuringOracle = false;
    try {
      await assert.rejects(runMacusBaseline({
        cwd,
        scenario: { ...scenarioFor(model), startingRevision: "b".repeat(40) },
        selection: model,
        stateStore,
        authorizeCommand: async () => false,
        testOracle: async () => "passed",
      }), /HEAD does not match the scenario starting revision/);
      const observation = await runMacusBaseline({
        cwd,
        scenario: { ...scenarioFor(model), startingRevision },
        selection: model,
        stateStore,
        authorizeCommand: async () => false,
        testOracle: async () => {
          try {
            const release = acquireWorktreeMutationLock(join(cwd, ".macus", "locks", "worktree.lock.db"));
            release();
          } catch {
            worktreeLockHeldDuringOracle = true;
          }
          return "passed";
        },
        recoveryOracle: async () => true,
      });
      assert.equal(provider.requests(), 1);
      assert.equal(provider.payloads()[0]?.temperature, 0.2);
      assert.equal(observation.testStatus, "passed");
      assert.equal(observation.inputTokens, 17);
      assert.equal(observation.outputTokens, 4);
      assert.equal(observation.cachedInputTokens, 5);
      assert.equal(observation.uncachedInputTokens, 12);
      assert.equal(observation.peakContextTokens, 17);
      assert.equal(observation.toolCalls, 0);
      assert.equal(observation.recoveryPassed, true);
      assert.equal(observation.cliPeakRssBytes, null);
      assert.doesNotMatch(observation.limitation ?? "", /generation settings/);
      assert.equal(worktreeLockHeldDuringOracle, true);
    } finally {
      stateStore.close();
    }
  });

  it("leaves correctness and recovery unknown after a failed Macus provider response", async () => {
    const { cwd, startingRevision } = await committedMacusWorkspace("macus-benchmark-failed-");
    const provider = await usageProvider({ fail: true });
    const model = { ...selection(provider.baseUrl), contextWindow: 16_384, maxOutputTokens: 256, reservedOutputTokens: 256 };
    const stateStore = openStateStore(join(cwd, ".macus", "state", "state.db"));
    let testOracleCalled = false;
    let recoveryOracleCalled = false;
    try {
      const observation = await runMacusBaseline({
        cwd,
        scenario: { ...scenarioFor(model), startingRevision },
        selection: model,
        stateStore,
        authorizeCommand: async () => false,
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
      assert.equal(testOracleCalled, false);
      assert.equal(recoveryOracleCalled, false);
    } finally {
      stateStore.close();
    }
  });
});
