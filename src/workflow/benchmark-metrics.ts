import type { KernelUsage } from "../kernel/pi-agent-kernel.js";

export interface BenchmarkMetricSnapshot {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  uncachedInputTokens: number | null;
  peakContextTokens: number | null;
  toolCalls: number;
  usageUnavailable: boolean;
}

export function createBenchmarkMetricAccumulator() {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let peakContextTokens = 0;
  let observedUsage = false;
  let incompleteUsage = false;
  let toolCalls = 0;

  return {
    recordToolCall(): void {
      toolCalls++;
    },
    recordAssistantUsage(usage: KernelUsage): void {
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
    },
    snapshot(): BenchmarkMetricSnapshot {
      const usable = observedUsage && !incompleteUsage;
      return {
        inputTokens: usable ? inputTokens : null,
        outputTokens: usable ? outputTokens : null,
        cachedInputTokens: usable ? cachedInputTokens : null,
        uncachedInputTokens: usable ? inputTokens - cachedInputTokens : null,
        peakContextTokens: usable ? peakContextTokens : null,
        toolCalls,
        usageUnavailable: !usable,
      };
    },
  };
}
