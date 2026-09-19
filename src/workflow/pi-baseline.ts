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
import { createProviderGenerationSettingsExtension } from "../kernel/provider-generation-settings.js";
import { createTrustedPiModel } from "../kernel/trusted-pi-model.js";
import { isFailedAssistantStopReason, type BenchmarkObservation, type BenchmarkScenario, type BenchmarkTestStatus, validateBenchmarkScenario } from "./benchmark.js";
import { createBenchmarkMetricAccumulator } from "./benchmark-metrics.js";

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
  const generationSettings = validateBenchmarkScenario(input.scenario, input.selection, "Pi");
  if (input.tools.some((tool) => !piBuiltInTools.has(tool))) throw new Error("Pi baseline tool selection contains an unsupported built-in tool");

  const metrics = createBenchmarkMetricAccumulator();
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
      extensionFactories: [createProviderGenerationSettingsExtension(generationSettings)],
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
      if (event.type === "tool_execution_start") metrics.recordToolCall();
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      assistantResponseEnded = true;
      if (isFailedAssistantStopReason(event.message.stopReason)) promptFailed = true;
      metrics.recordAssistantUsage(event.message.usage);
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

  const metricSnapshot = metrics.snapshot();
  const limitations = [
    !promptSucceeded ? "Pi baseline session or prompt failed; raw error omitted." : undefined,
    metricSnapshot.usageUnavailable ? "Provider did not report usable token usage; token metrics are unknown." : undefined,
    "In-process adapter does not measure isolated CLI RSS or first useful edit time.",
  ].filter((item): item is string => Boolean(item));
  const observation: BenchmarkObservation = {
    testStatus,
    inputTokens: metricSnapshot.inputTokens,
    outputTokens: metricSnapshot.outputTokens,
    cachedInputTokens: metricSnapshot.cachedInputTokens,
    uncachedInputTokens: metricSnapshot.uncachedInputTokens,
    wallTimeMs: promptStartedAt !== null && promptFinishedAt !== null ? promptFinishedAt - promptStartedAt : null,
    firstUsefulEditMs: null,
    toolCalls: metricSnapshot.toolCalls,
    peakContextTokens: metricSnapshot.peakContextTokens,
    cliPeakRssBytes: null,
    recoveryPassed,
    limitation: limitations.join(" "),
  };
  return observation;
}
