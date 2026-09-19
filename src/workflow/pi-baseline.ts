import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { TrustedModelSelection } from "../config/trusted-model.js";
import { createTrustedPiModel } from "../kernel/trusted-pi-model.js";
import type { BenchmarkObservation, BenchmarkScenario, BenchmarkTestStatus } from "./benchmark.js";

const piBuiltInTools = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export async function runUnmodifiedPiBaseline(input: {
  cwd: string;
  scenario: BenchmarkScenario;
  selection: TrustedModelSelection;
  /** Explicit tool selection prevents a benchmark from silently enabling Pi's shell tools. */
  tools: readonly string[];
  testOracle: (cwd: string) => Promise<BenchmarkTestStatus>;
  recoveryOracle?: (cwd: string) => Promise<boolean | null>;
}): Promise<BenchmarkObservation> {
  if (input.scenario.endpointModel !== `${input.selection.providerId}/${input.selection.model}`) {
    throw new Error("Benchmark scenario endpoint/model does not match the trusted Pi model selection");
  }
  if (input.scenario.contextLimitTokens !== input.selection.contextWindow || input.scenario.outputLimitTokens !== input.selection.maxOutputTokens) {
    throw new Error("Benchmark scenario token limits must match the trusted Pi model selection");
  }
  if (input.tools.some((tool) => !piBuiltInTools.has(tool))) throw new Error("Pi baseline tool selection contains an unsupported built-in tool");

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let peakContextTokens = 0;
  let observedUsage = false;
  let incompleteUsage = false;
  let toolCalls = 0;
  let promptSucceeded = false;
  let promptFailed = false;
  let assistantResponseEnded = false;
  let promptStartedAt: number | null = null;
  let promptFinishedAt: number | null = null;
  const agentDir = await mkdtemp(join(tmpdir(), "macus-pi-baseline-agent-"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

  try {
    const { modelRuntime, model } = await createTrustedPiModel(input.selection);
    const settingsManager = SettingsManager.inMemory();
    const resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
    });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({
      cwd: input.cwd,
      agentDir,
      model,
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(input.cwd),
      tools: [...input.tools],
    }));
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") toolCalls++;
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      assistantResponseEnded = true;
      if (event.message.stopReason === "error" || event.message.stopReason === "aborted" || event.message.stopReason === "deferred" || event.message.stopReason === "pending") promptFailed = true;
      const usage = event.message.usage;
      const currentTotalInputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
      if (![currentTotalInputTokens, usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every((value) => Number.isFinite(value) && value >= 0) || currentTotalInputTokens === 0) {
        incompleteUsage = true;
        return;
      }
      observedUsage = true;
      inputTokens += currentTotalInputTokens;
      outputTokens += usage.output;
      cachedInputTokens += usage.cacheRead + usage.cacheWrite;
      peakContextTokens = Math.max(peakContextTokens, currentTotalInputTokens);
    });
    promptStartedAt = performance.now();
    await session.prompt(input.scenario.prompt, { expandPromptTemplates: false });
    promptFinishedAt = performance.now();
    promptSucceeded = assistantResponseEnded && !promptFailed;
  } catch {
    if (promptStartedAt !== null && promptFinishedAt === null) promptFinishedAt = performance.now();
    // The observation below remains conservative; exception text may contain credentials.
  } finally {
    try {
      await session?.dispose();
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  }
  let testStatus: BenchmarkTestStatus = "unknown";
  if (promptSucceeded) {
    try { testStatus = await input.testOracle(input.cwd); } catch { /* A failed oracle is unknown, never a pass. */ }
  }
  let recoveryPassed: boolean | null = null;
  if (promptSucceeded && input.recoveryOracle) {
    try { recoveryPassed = await input.recoveryOracle(input.cwd); } catch { recoveryPassed = null; }
  }

  const limitations = [
    !promptSucceeded ? "Pi baseline session or prompt failed; raw error omitted." : undefined,
    !observedUsage || incompleteUsage ? "Provider did not report usable token usage; token metrics are unknown." : undefined,
    "In-process adapter does not measure isolated CLI RSS or first useful edit time.",
    Object.keys(input.scenario.generationSettings).length ? "Scenario generation settings are recorded but not overridden by this baseline adapter." : undefined,
  ].filter((item): item is string => Boolean(item));
  const observation: BenchmarkObservation = {
    testStatus,
    inputTokens: observedUsage && !incompleteUsage ? inputTokens : null,
    outputTokens: observedUsage && !incompleteUsage ? outputTokens : null,
    cachedInputTokens: observedUsage && !incompleteUsage ? cachedInputTokens : null,
    uncachedInputTokens: observedUsage && !incompleteUsage ? inputTokens - cachedInputTokens : null,
    wallTimeMs: promptStartedAt !== null && promptFinishedAt !== null ? promptFinishedAt - promptStartedAt : null,
    firstUsefulEditMs: null,
    toolCalls,
    peakContextTokens: observedUsage && !incompleteUsage ? peakContextTokens : null,
    cliPeakRssBytes: null,
    recoveryPassed,
    limitation: limitations.join(" "),
  };
  return observation;
}
