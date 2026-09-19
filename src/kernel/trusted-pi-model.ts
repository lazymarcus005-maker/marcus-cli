import { randomUUID } from "node:crypto";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { TrustedModelSelection } from "../config/trusted-model.js";

/**
 * The OpenCode Go gateway refuses requests without a stable per-conversation
 * routing session and a client-identifying user agent. Keep this adapter
 * behavior endpoint-keyed so generic providers see no extra headers.
 */
export function gatewayHeadersFor(baseUrl: string, processIdentifier: () => string = randomUUID): Record<string, string> | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname !== "opencode.ai" || !url.pathname.startsWith("/zen/go/")) {
    return undefined;
  }
  return {
    "user-agent": "macus/0.1.0",
    "x-opencode-session": processIdentifier(),
  };
}

/** Register the already-trusted provider/model pair without reading Pi's ambient credentials. */
export async function createTrustedPiModel(selection: TrustedModelSelection) {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  if (modelRuntime.getProvider(selection.providerId)) {
    throw new Error(
      `Provider ID ${selection.providerId} conflicts with a built-in Pi provider; choose a distinct trusted provider ID`,
    );
  }
  const api = "openai-completions" as const;
  modelRuntime.registerProvider(selection.providerId, {
    name: selection.providerId,
    baseUrl: selection.baseUrl,
    api,
    ...(selection.apiKey ? { apiKey: selection.apiKey } : {}),
    ...(() => {
      const headers = gatewayHeadersFor(selection.baseUrl);
      return headers ? { headers } : {};
    })(),
    models: [
      {
        id: selection.model,
        name: selection.model,
        api,
        baseUrl: selection.baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: selection.contextWindow,
        maxTokens: selection.maxOutputTokens,
      },
    ],
  });
  const model = modelRuntime.getModel(selection.providerId, selection.model);
  if (!model) throw new Error("Configured model is unavailable in the Pi runtime");
  return { modelRuntime, model };
}
