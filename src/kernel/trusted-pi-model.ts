import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { TrustedModelSelection } from "../config/trusted-model.js";

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
