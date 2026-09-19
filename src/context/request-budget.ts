import { createHash, randomUUID } from "node:crypto";
import { promptLimitForModel, type TrustedModelSelection } from "../config/trusted-model.js";

const OUTPUT_LIMIT_KEYS = ["max_tokens", "max_completion_tokens", "max_output_tokens"] as const;

export class RequestBudgetExceededError extends Error {
  constructor(
    readonly estimatedPromptTokens: number,
    readonly promptLimitTokens: number,
    readonly contextWindowTokens: number,
  ) {
    super(
      `Provider request is estimated at ${estimatedPromptTokens} tokens; the configured prompt cap is ${promptLimitTokens}. Reduce optional context or choose a compatible model.`,
    );
    this.name = "RequestBudgetExceededError";
  }
}

export class RequestCategoryBudgetExceededError extends Error {
  constructor(readonly category: string, readonly estimatedBytes: number, readonly limitTokens: number) {
    super(`Provider request category ${category} is estimated at ${estimatedBytes} tokens; its configured cap is ${limitTokens}. Narrow the retrieved content or choose a compatible profile.`);
    this.name = "RequestCategoryBudgetExceededError";
  }
}

export interface RequestManifest {
  requestId: string;
  payloadSha256: string;
  createdAt: string;
  sessionId: string | null;
  modelId: string;
  adapterVersion: string;
  contextWindowTokens: number;
  maxInputTokens: number | null;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  promptLimitTokens: number;
  estimatedPromptTokens: number;
  estimationMethod: "serialized UTF-8 bytes (conservative one byte per token)";
  categories: {
    system: number;
    toolSchemas: number;
    repositoryInstructions: number;
    taskLedger: number;
    workingSource: number;
    repoMap: number;
    searchResults: number;
    otherToolOutput: number;
    remainingConversation: number;
  };
  includedFragments: Array<{ fragmentId: string; path: string; sourceSha256: string; startLine: number; endLine: number; reason: string; tier: string; estimatedTokens: number; freshness: "verified" }>;
  includedInstructions: Array<{ path: string; sourceSha256: string; reason: "repository-instruction"; estimatedTokens: number }>;
  omittedFragments: Array<{ path: string; reason: string; detail: string }>;
}

export interface RequestManifestContext {
  sessionId?: string;
  modelId?: string;
  adapterVersion?: string;
  includedFragments?: RequestManifest["includedFragments"];
  includedInstructions?: RequestManifest["includedInstructions"];
  omittedFragments?: RequestManifest["omittedFragments"];
}

type RequestCategory = keyof RequestManifest["categories"];

function classifyMessage(message: unknown, serialized: string): RequestCategory {
  const role = typeof message === "object" && message !== null && "role" in message
    ? (message as { role?: unknown }).role
    : undefined;
  if (role === "system") return "system";
  if (serialized.includes("<repository-instruction ")) return "repositoryInstructions";
  if (serialized.includes("<macus-context-fragment ") || serialized.includes("<macus-source-read ")) return "workingSource";
  if (serialized.includes("<macus-task-ledger ")) return "taskLedger";
  if (serialized.includes("<macus-repo-map ")) return "repoMap";
  if (serialized.includes("<macus-search-results")) return "searchResults";
  if (role === "tool" || role === "toolResult") return "otherToolOutput";
  return "remainingConversation";
}

/**
 * Creates a fail-closed guard for Pi's provider payload hook. Counting each
 * UTF-8 byte as one token is intentionally conservative when no matching
 * provider tokenizer is available.
 */
export function createRequestBudgetGuard(
  model: Pick<
    TrustedModelSelection,
    "contextWindow" | "maxInputTokens" | "reservedOutputTokens" | "safetyMarginTokens" | "contextBudgets"
  >,
  onPrepared?: (manifest: RequestManifest) => void,
  getManifestContext: () => RequestManifestContext = () => ({}),
): (payload: unknown) => unknown {
  const promptLimit = promptLimitForModel(model);

  return (payload) => {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      throw new Error("Cannot validate provider request: payload is not an object");
    }

    const boundedPayload = { ...(payload as Record<string, unknown>) };
    for (const key of OUTPUT_LIMIT_KEYS) {
      const requested = boundedPayload[key];
      if (requested !== undefined) {
        if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested <= 0) {
          throw new Error(`Cannot validate provider request: ${key} must be a positive integer`);
        }
        if (requested > model.reservedOutputTokens) {
          boundedPayload[key] = model.reservedOutputTokens;
        }
      }
    }

    const serialized = JSON.stringify(boundedPayload);
    if (serialized === undefined) {
      throw new Error("Cannot validate provider request: payload is not serializable");
    }
    const estimate = Buffer.byteLength(serialized, "utf8");
    if (estimate > promptLimit) {
      throw new RequestBudgetExceededError(
        estimate,
        promptLimit,
        model.contextWindow,
      );
    }
    const categories = { system: 0, toolSchemas: 0, repositoryInstructions: 0, taskLedger: 0, workingSource: 0, repoMap: 0, searchResults: 0, otherToolOutput: 0, remainingConversation: 0 };
    let accountedBytes = 0;
    const messages = Array.isArray(boundedPayload.messages) ? boundedPayload.messages : [];
    let largestSingleRead = 0;
    for (const message of messages) {
      const serializedMessage = JSON.stringify(message) ?? "null";
      const bytes = Buffer.byteLength(serializedMessage, "utf8");
      accountedBytes += bytes;
      const category = classifyMessage(message, serializedMessage);
      categories[category] += bytes;
      for (const match of serializedMessage.matchAll(/<macus-source-read\b[^>]*\bcontentBytes=\\?"(\d+)\\?"/g)) largestSingleRead = Math.max(largestSingleRead, Number(match[1]));
      if (!serializedMessage.includes("contentBytes=")) for (const match of serializedMessage.matchAll(/<macus-source-read\b[^>]*\bcontentLength=\\?"(\d+)\\?"/g)) largestSingleRead = Math.max(largestSingleRead, Number(match[1]));
    }
    const toolSchemas = Array.isArray(boundedPayload.tools) ? boundedPayload.tools : [];
    for (const tool of toolSchemas) {
      const bytes = Buffer.byteLength(JSON.stringify(tool), "utf8");
      categories.toolSchemas += bytes;
      accountedBytes += bytes;
    }
    categories.remainingConversation += Math.max(0, estimate - accountedBytes);
    const limits = model.contextBudgets;
    const cappedCategories: Array<[string, number, number | undefined]> = [
      ["repoMap", categories.repoMap, limits?.repoMapTokens],
      ["searchResults", categories.searchResults, limits?.searchResultsTokens],
      ["otherToolOutput", categories.otherToolOutput, limits?.toolOutputTokens],
      ["singleFileRead", largestSingleRead, limits?.singleFileReadTokens],
    ];
    for (const [name, actual, limit] of cappedCategories) if (limit !== undefined && actual > limit) throw new RequestCategoryBudgetExceededError(name, actual, limit);
    if (onPrepared) {
      const manifestContext = getManifestContext();
      onPrepared({
        requestId: randomUUID(),
        payloadSha256: createHash("sha256").update(serialized).digest("hex"),
        createdAt: new Date().toISOString(),
        sessionId: manifestContext.sessionId ?? null,
        modelId: manifestContext.modelId ?? "unknown",
        adapterVersion: manifestContext.adapterVersion ?? "@earendil-works/pi-coding-agent@0.85.1",
        contextWindowTokens: model.contextWindow,
        maxInputTokens: model.maxInputTokens ?? null,
        reservedOutputTokens: model.reservedOutputTokens,
        safetyMarginTokens: model.safetyMarginTokens,
        promptLimitTokens: promptLimit,
        estimatedPromptTokens: estimate,
        estimationMethod: "serialized UTF-8 bytes (conservative one byte per token)",
        categories,
        includedFragments: manifestContext.includedFragments ?? [],
        includedInstructions: manifestContext.includedInstructions ?? [],
        omittedFragments: manifestContext.omittedFragments ?? [],
      });
    }
    return boundedPayload;
  };
}
