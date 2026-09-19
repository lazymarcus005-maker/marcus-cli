import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ModelConfigurationError,
  promptLimitForModel,
  resolveTrustedModelSelection,
} from "../src/config/trusted-model.js";

const globalConfig = `
schema_version: 1
models:
  default: primary
  providers:
    private_gateway:
      protocol: openai-compatible
      base_url: ${"${"}MACUS_MODEL_BASE_URL}
      api_key_env: MACUS_MODEL_API_KEY
      profile: standard
      model: model-a
  aliases:
    primary: private_gateway
model_profiles:
  standard:
    context_window: 32768
    max_output_tokens: 4096
    max_input_tokens: 12000
context:
  reserved_output_tokens: 2048
  safety_margin_tokens: 512
`;

describe("trusted model configuration", () => {
  it("resolves only a user-trusted alias and binds its key to its endpoint", () => {
    const selected = resolveTrustedModelSelection(
      globalConfig,
      "models:\n  default: primary\n",
      {
        MACUS_MODEL_BASE_URL: "https://gateway.example/v1",
        MACUS_MODEL_API_KEY: "secret-test-value",
      },
    );

    assert.equal(selected.alias, "primary");
    assert.equal(selected.providerId, "private_gateway");
    assert.equal(selected.baseUrl, "https://gateway.example/v1");
    assert.equal(selected.apiKey, "secret-test-value");
    assert.equal(selected.contextWindow, 32768);
    assert.equal(selected.maxInputTokens, 12000);
    assert.equal(promptLimitForModel(selected), 9440);
    assert.equal(selected.reservedOutputTokens, 2048);
    assert.equal(selected.safetyMarginTokens, 512);
  });

  it("rejects project attempts to introduce a provider or endpoint", () => {
    assert.throws(
      () =>
        resolveTrustedModelSelection(
          globalConfig,
          "models:\n  default: primary\n  providers:\n    attacker:\n      base_url: https://attacker.invalid\n",
          {
            MACUS_MODEL_BASE_URL: "https://gateway.example/v1",
            MACUS_MODEL_API_KEY: "secret-test-value",
          },
        ),
      ModelConfigurationError,
    );
  });

  it("rejects non-loopback HTTP endpoints", () => {
    assert.throws(
      () =>
        resolveTrustedModelSelection(
          globalConfig,
          undefined,
          {
            MACUS_MODEL_BASE_URL: "http://gateway.example/v1",
            MACUS_MODEL_API_KEY: "secret-test-value",
          },
        ),
      /HTTPS/,
    );
  });

  it("does not expose a missing credential value in its error", () => {
    assert.throws(
      () => resolveTrustedModelSelection(globalConfig, undefined, {
        MACUS_MODEL_BASE_URL: "https://gateway.example/v1",
      }),
      /MACUS_MODEL_API_KEY is missing/,
    );
  });

  it("keeps runtime alias overrides inside the trusted global alias map", () => {
    assert.throws(
      () => resolveTrustedModelSelection(globalConfig, "models:\n  default: primary\n", {
        MACUS_MODEL_BASE_URL: "https://gateway.example/v1",
        MACUS_MODEL_API_KEY: "secret-test-value",
      }, "untrusted"),
      /not trusted in global config/,
    );
  });

  it("rejects unknown schema fields and unsupported feature enables while resolving code graph", () => {
    const extraProfileField = globalConfig.replace("    max_output_tokens: 4096", "    max_output_tokens: 4096\n    surprise: true");
    assert.throws(() => resolveTrustedModelSelection(extraProfileField, undefined, {
      MACUS_MODEL_BASE_URL: "https://gateway.example/v1", MACUS_MODEL_API_KEY: "secret-test-value",
    }), /unsupported field surprise/);
    const enabledGraph = globalConfig.replace("context:\n", "features:\n  code_graph: true\ncontext:\n");
    const graphSelection = resolveTrustedModelSelection(enabledGraph, undefined, {
      MACUS_MODEL_BASE_URL: "https://gateway.example/v1", MACUS_MODEL_API_KEY: "secret-test-value",
    });
    assert.equal(graphSelection.features.codeGraph, true);
    const unsupported = globalConfig.replace("context:\n", "features:\n  auto_compaction: true\ncontext:\n");
    assert.throws(() => resolveTrustedModelSelection(unsupported, undefined, {
      MACUS_MODEL_BASE_URL: "https://gateway.example/v1", MACUS_MODEL_API_KEY: "secret-test-value",
    }), /Feature auto_compaction is not available/);
  });

  it("prevents project config from enabling a globally disabled feature", () => {
    const global = globalConfig.replace("context:\n", "features:\n  repo_map: false\ncontext:\n");
    assert.throws(() => resolveTrustedModelSelection(global, "features:\n  repo_map: true\n", {
      MACUS_MODEL_BASE_URL: "https://gateway.example/v1", MACUS_MODEL_API_KEY: "secret-test-value",
    }), /cannot enable globally disabled feature repo_map/);
  });

  it("lets project config narrow supported global feature settings", () => {
    const global = globalConfig.replace("context:\n", "features:\n  repo_map: true\n  code_graph: true\n  checkpoint: true\ncontext:\n");
    const selected = resolveTrustedModelSelection(global, "features:\n  repo_map: false\n  code_graph: false\n  checkpoint: false\n", {
      MACUS_MODEL_BASE_URL: "https://gateway.example/v1", MACUS_MODEL_API_KEY: "secret-test-value",
    });
    assert.deepEqual(selected.features, { repoMap: false, codeGraph: false, contextLedger: true, checkpoint: false, gitContext: true, taskEngine: true });
  });

  it("applies profile category caps and prevents project budgets from expanding them", () => {
    const global = globalConfig.replace("safety_margin_tokens: 512", "safety_margin_tokens: 512\n  budget:\n    search_results_tokens: 400\n    single_file_read_tokens: 800");
    const env = { MACUS_MODEL_BASE_URL: "https://gateway.example/v1", MACUS_MODEL_API_KEY: "secret-test-value" };
    const narrowed = resolveTrustedModelSelection(global, "context:\n  budget:\n    search_results_tokens: 200\n", env);
    assert.equal(narrowed.contextBudgets?.searchResultsTokens, 200);
    assert.equal(narrowed.contextBudgets?.singleFileReadTokens, 800);
    assert.throws(() => resolveTrustedModelSelection(global, "context:\n  budget:\n    search_results_tokens: 401\n", env), /exceeds the trusted profile limit/);
  });

  it("accepts a configurable bounded repository-map budget", () => {
    const env = { MACUS_MODEL_BASE_URL: "https://gateway.example/v1", MACUS_MODEL_API_KEY: "secret-test-value" };
    const configured = globalConfig.replace("  safety_margin_tokens: 512", "  safety_margin_tokens: 512\n  budget:\n    repo_map_tokens: 256");
    assert.equal(resolveTrustedModelSelection(configured, undefined, env).contextBudgets?.repoMapTokens, 256);
    const zeroBudget = configured.replace("repo_map_tokens: 256", "repo_map_tokens: 0");
    assert.equal(resolveTrustedModelSelection(zeroBudget, undefined, env).contextBudgets?.repoMapTokens, 0);
    const excessive = configured.replace("repo_map_tokens: 256", "repo_map_tokens: 20001");
    assert.throws(() => resolveTrustedModelSelection(excessive, undefined, env), /must not exceed 20000/);
  });

  it("resolves bounded execution settings from trusted global config", () => {
    const configured = globalConfig.replace(
      "context:\n",
      "execution:\n  command_timeout_seconds: 7\n  test_build_timeout_seconds: 11\n  termination_grace_seconds: 3\n  max_output_memory_bytes: 4096\n  max_log_bytes: 8192\n  environment_allowlist: [PATH, LANG, MACUS_MODEL_API_KEY, SECONDARY_MODEL_KEY]\nlogs:\n  retention_days: 5\n  max_total_bytes: 16384\ncontext:\n",
    ).replace(
      "  aliases:\n    primary: private_gateway",
      "    secondary_gateway:\n      protocol: openai-compatible\n      base_url: https://secondary.example/v1\n      api_key_env: SECONDARY_MODEL_KEY\n      profile: standard\n      model: model-b\n  aliases:\n    primary: private_gateway\n    secondary: secondary_gateway",
    );
    const selected = resolveTrustedModelSelection(configured, undefined, {
      MACUS_MODEL_BASE_URL: "https://gateway.example/v1",
      MACUS_MODEL_API_KEY: "secret-test-value",
    });
    assert.deepEqual(selected.execution, {
      commandTimeoutMs: 7000,
      testBuildTimeoutMs: 11000,
      terminationGraceMs: 3000,
      maxOutputMemoryBytes: 4096,
      maxLogBytes: 8192,
      environmentAllowlist: ["PATH", "LANG"],
    });
    assert.deepEqual(selected.protectedCredentialEnvironmentNames, ["MACUS_MODEL_API_KEY", "SECONDARY_MODEL_KEY"]);
    assert.deepEqual(selected.credentialEnvironmentNames, ["MACUS_MODEL_API_KEY"]);
    assert.deepEqual(selected.logs, { retentionDays: 5, maxTotalBytes: 16384 });
    assert.throws(() => resolveTrustedModelSelection(configured, "execution:\n  command_timeout_seconds: 1\n", {
      MACUS_MODEL_BASE_URL: "https://gateway.example/v1",
      MACUS_MODEL_API_KEY: "secret-test-value",
    }), /unsupported field execution/);
  });
});
