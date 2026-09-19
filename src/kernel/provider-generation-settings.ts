import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const numericSettings: Record<string, { minimum: number; maximum: number; integer?: boolean }> = {
  temperature: { minimum: 0, maximum: 2 },
  top_p: { minimum: 0, maximum: 1 },
  presence_penalty: { minimum: -2, maximum: 2 },
  frequency_penalty: { minimum: -2, maximum: 2 },
  seed: { minimum: 0, maximum: Number.MAX_SAFE_INTEGER, integer: true },
};
const allowedSettings = new Set([...Object.keys(numericSettings), "max_tokens", "max_completion_tokens", "stop"]);

/** Validate only portable OpenAI-compatible generation controls; fail closed on unknown endpoint-specific fields. */
export function validateProviderGenerationSettings(
  value: Record<string, unknown>,
  outputLimitTokens: number,
): Record<string, unknown> {
  if (!Number.isSafeInteger(outputLimitTokens) || outputLimitTokens < 1) {
    throw new Error("Benchmark output limit must be a positive integer");
  }
  const settings = structuredClone(value);
  for (const key of Object.keys(settings)) {
    if (!allowedSettings.has(key)) throw new Error(`Unsupported OpenAI-compatible generation setting: ${key}`);
  }
  if (settings.max_tokens !== undefined && settings.max_completion_tokens !== undefined) {
    throw new Error("Generation settings cannot specify both max_tokens and max_completion_tokens");
  }
  for (const [key, bounds] of Object.entries(numericSettings)) {
    const setting = settings[key];
    if (setting === undefined) continue;
    if (typeof setting !== "number" || !Number.isFinite(setting) || setting < bounds.minimum || setting > bounds.maximum || (bounds.integer && !Number.isSafeInteger(setting))) {
      throw new Error(`Generation setting ${key} is outside its supported range`);
    }
  }
  const requestedOutput = settings.max_tokens ?? settings.max_completion_tokens;
  if (requestedOutput !== undefined && (!Number.isSafeInteger(requestedOutput) || (requestedOutput as number) < 1 || (requestedOutput as number) > outputLimitTokens)) {
    throw new Error(`Generation output limit must be a positive integer no greater than ${outputLimitTokens}`);
  }
  const stop = settings.stop;
  if (stop !== undefined && !(typeof stop === "string" || (Array.isArray(stop) && stop.length <= 4 && stop.every((item) => typeof item === "string")))) {
    throw new Error("Generation setting stop must be a string or an array of at most four strings");
  }
  return settings;
}

/** Apply a prevalidated settings object without permitting changes to model, messages, or transport controls. */
export function applyProviderGenerationSettings(payload: unknown, settings: Record<string, unknown>): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Cannot apply generation settings: provider request payload is not an object");
  }
  const updated = { ...(payload as Record<string, unknown>), ...settings };
  if (settings.max_tokens !== undefined) delete updated.max_completion_tokens;
  if (settings.max_completion_tokens !== undefined) delete updated.max_tokens;
  return updated;
}

export function createProviderGenerationSettingsExtension(settings: Record<string, unknown>): ExtensionFactory {
  return (pi) => {
    pi.on("before_provider_request", (event) => applyProviderGenerationSettings(event.payload, settings));
  };
}
