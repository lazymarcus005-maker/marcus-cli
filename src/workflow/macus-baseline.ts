import { realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { TrustedModelSelection } from "../config/trusted-model.js";
import type { ExecutionAuthorization } from "../execution/policy-executor.js";
import { PiAgentKernel, type KernelObservation } from "../kernel/pi-agent-kernel.js";
import { acquireWorktreeMutationLock, type StateStore } from "../state/state-store.js";
import { readGitContext } from "./git-context.js";
import { isFailedAssistantStopReason, type BenchmarkObservation, type BenchmarkScenario, type BenchmarkTestStatus, validateBenchmarkScenario } from "./benchmark.js";
import { createBenchmarkMetricAccumulator } from "./benchmark-metrics.js";

function assertPreparedWorkspace(
  context: Awaited<ReturnType<typeof readGitContext>>,
  scenario: BenchmarkScenario,
): void {
  if (!context.isRepository || !context.head) throw new Error("Macus benchmark requires a Git workspace with a committed starting revision");
  if (context.head !== scenario.startingRevision) throw new Error("Macus benchmark workspace HEAD does not match the scenario starting revision");
  if (context.changedFiles.length) throw new Error("Macus benchmark workspace must be clean before the run");
}

export async function runMacusBaseline(input: {
  cwd: string;
  scenario: BenchmarkScenario;
  selection: TrustedModelSelection;
  stateStore: StateStore;
  /** Explicit policy decision for each model-requested command; this adapter never auto-approves. */
  authorizeCommand: (command: string, credentialEnvironmentNames: readonly string[], signal?: AbortSignal) => Promise<ExecutionAuthorization>;
  testOracle: (cwd: string) => Promise<BenchmarkTestStatus>;
  recoveryOracle?: (cwd: string) => Promise<boolean | null>;
}): Promise<BenchmarkObservation> {
  const generationSettings = validateBenchmarkScenario(input.scenario, input.selection, "Macus");

  const cwd = await realpath(input.cwd);
  assertPreparedWorkspace(await readGitContext(cwd), input.scenario);
  const releaseMutationLock = acquireWorktreeMutationLock(join(cwd, ".macus", "locks", "worktree.lock.db"));
  try {
    const metrics = createBenchmarkMetricAccumulator();
    let assistantResponseEnded = false;
    let promptFailed = false;
    let promptStartedAt: number | null = null;
    let promptFinishedAt: number | null = null;
    let promptSucceeded = false;
    let cleanupFailed = false;
    const observe = (observation: KernelObservation): void => {
      if (observation.type === "tool_call") {
        metrics.recordToolCall();
        return;
      }
      assistantResponseEnded = true;
      if (isFailedAssistantStopReason(observation.stopReason)) promptFailed = true;
      metrics.recordAssistantUsage(observation.usage);
    };
    const kernel = new PiAgentKernel(
      cwd,
      input.selection,
      { onObservation: observe, onTextDelta: () => {}, providerGenerationSettings: generationSettings },
      input.stateStore,
      input.authorizeCommand,
    );

    try {
      const initialContext = await readGitContext(cwd);
      assertPreparedWorkspace(initialContext, input.scenario);
      const gitDirectory = await realpath(execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8" }).trim());
      await kernel.start();
      const sessionId = kernel.sessionId;
      if (!sessionId) throw new Error("Macus did not create a session identity");
      input.stateStore.createSession({
        sessionId,
        worktreeRoot: cwd,
        gitDirectory,
        gitBranch: initialContext.branch,
        gitHead: initialContext.head,
        gitIdentityCaptured: true,
      }, initialContext.fileHashes);

      promptStartedAt = performance.now();
      try {
        await kernel.prompt(input.scenario.prompt);
        promptFinishedAt = performance.now();
        promptSucceeded = assistantResponseEnded && !promptFailed;
      } catch {
        promptFinishedAt = performance.now();
      }
    } catch {
      // Keep the observation conservative; errors may contain credentials or local paths.
    } finally {
      try {
        await kernel.dispose();
      } catch {
        cleanupFailed = true;
      }
    }

    if (cleanupFailed) promptSucceeded = false;
    let testStatus: BenchmarkTestStatus = "unknown";
    if (promptSucceeded) {
      try { testStatus = await input.testOracle(cwd); } catch { /* A failed oracle is unknown, never a pass. */ }
    }
    let recoveryPassed: boolean | null = null;
    if (promptSucceeded && input.recoveryOracle) {
      try { recoveryPassed = await input.recoveryOracle(cwd); } catch { recoveryPassed = null; }
    }

    const metricSnapshot = metrics.snapshot();
    const limitations = [
      !promptSucceeded ? "Macus session or prompt failed; raw error omitted." : undefined,
      cleanupFailed ? "Macus session cleanup failed; correctness and recovery are unknown." : undefined,
      metricSnapshot.usageUnavailable ? "Provider did not report usable token usage; token metrics are unknown." : undefined,
      "In-process adapter does not measure isolated CLI RSS or first useful edit time.",
    ].filter((item): item is string => Boolean(item));
    return {
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
  } finally {
    releaseMutationLock();
  }
}
