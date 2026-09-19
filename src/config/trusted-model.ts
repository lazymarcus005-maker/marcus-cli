import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import {
  DEFAULT_ENVIRONMENT_ALLOWLIST,
  DEFAULT_EXECUTION_SETTINGS,
  DEFAULT_LOG_SETTINGS,
  EXECUTION_LIMIT_MAXIMUMS,
  LOG_LIMIT_MAXIMUMS,
  type ExecutionSettings,
  type LogSettings,
} from "../execution/execution-settings.js";

type RecordValue = Record<string, unknown>;

export type TrustedExecutionSettings = ExecutionSettings;
export type TrustedLogSettings = LogSettings;

export interface TrustedModelSelection {
  alias: string;
  aliasSource: "global" | "project" | "runtime";
  providerId: string;
  protocol: "openai-compatible" | "openrouter" | "litellm" | "local";
  baseUrl: string;
  apiKey: string | undefined;
  protectedCredentialEnvironmentNames: string[];
  credentialEnvironmentNames: string[];
  profile: string;
  model: string;
  contextWindow: number;
  maxInputTokens?: number;
  maxOutputTokens: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  contextBudgets?: { repoMapTokens?: number; searchResultsTokens?: number; toolOutputTokens?: number; singleFileReadTokens?: number };
  runLimits: { maxModelTurns: number; maxNoProgressAttempts: number; maxDurationSeconds: number };
  execution: TrustedExecutionSettings;
  logs: TrustedLogSettings;
  features: { repoMap: boolean; codeGraph: boolean; contextLedger: boolean; checkpoint: boolean; gitContext: boolean; taskEngine: boolean };
}

export class ModelConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigurationError";
  }
}

function record(value: unknown, location: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelConfigurationError(`${location} must be a mapping`);
  }
  return value as RecordValue;
}

function assertOnlyKeys(
  value: RecordValue,
  allowed: readonly string[],
  location: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) {
    throw new ModelConfigurationError(`${location} contains unsupported field ${unknown}`);
  }
}

function readDocument(text: string, location: string): RecordValue {
  let value: unknown;
  try {
    value = parse(text, { uniqueKeys: true });
  } catch {
    // YAML parser diagnostics can quote input values; avoid echoing credentials.
    throw new ModelConfigurationError(`${location} is not valid YAML`);
  }
  return record(value, location);
}

function interpolateTrustedUrl(value: unknown, env: NodeJS.ProcessEnv): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ModelConfigurationError("Trusted provider base_url must be a non-empty string");
  }
  const expanded = value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = env[name];
    if (!resolved) {
      throw new ModelConfigurationError(`Required environment variable ${name} is missing`);
    }
    return resolved;
  });
  if (expanded.includes("${")) {
    throw new ModelConfigurationError("base_url contains an invalid environment reference");
  }

  let url: URL;
  try {
    url = new URL(expanded);
  } catch {
    throw new ModelConfigurationError("Trusted provider base_url must be an absolute URL");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && localHosts.has(url.hostname)))
  ) {
    throw new ModelConfigurationError(
      "Provider URLs must use HTTPS; HTTP is allowed only for loopback endpoints and URL credentials are forbidden",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function positiveInteger(value: unknown, location: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ModelConfigurationError(`${location} must be a positive integer`);
  }
  return value;
}

function boundedConfiguredInteger(config: RecordValue, section: string, key: string, fallback: number, maximum: number): number {
  const configured = config[key];
  const value = configured === undefined ? fallback : positiveInteger(configured, `${section}.${key}`);
  if (value > maximum) throw new ModelConfigurationError(`${section}.${key} must not exceed ${maximum}`);
  return value;
}

function nonNegativeInteger(value: unknown, location: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ModelConfigurationError(`${location} must be a non-negative integer`);
}

function validateOptionalSections(config: RecordValue, location: string, project = false): void {
  if (config.context !== undefined) {
    const context = record(config.context, `${location}.context`);
    assertOnlyKeys(context, ["reserved_output_tokens", "safety_margin_tokens", "target_prompt_ratio", "compact_prompt_ratio", "emergency_prompt_ratio", "budget"], `${location}.context`);
    for (const key of ["reserved_output_tokens", "safety_margin_tokens"] as const) if (context[key] !== undefined) positiveInteger(context[key], `${location}.context.${key}`);
    const ratios = ["target_prompt_ratio", "compact_prompt_ratio", "emergency_prompt_ratio"] as const;
    for (const key of ratios) if (context[key] !== undefined && (typeof context[key] !== "number" || !Number.isFinite(context[key]) || context[key] <= 0 || context[key] >= 1)) throw new ModelConfigurationError(`${location}.context.${key} must be between 0 and 1`);
    if (ratios.every((key) => context[key] !== undefined)) {
      const values = ratios.map((key) => context[key] as number);
      if (!(values[0]! < values[1]! && values[1]! < values[2]!)) throw new ModelConfigurationError(`${location}.context prompt ratios must be strictly increasing`);
    }
    if (context.budget !== undefined) {
      const budget = record(context.budget, `${location}.context.budget`);
      assertOnlyKeys(budget, ["repo_map_tokens", "search_results_tokens", "tool_output_tokens", "single_file_read_tokens"], `${location}.context.budget`);
      for (const [key, value] of Object.entries(budget)) nonNegativeInteger(value, `${location}.context.budget.${key}`);
    }
  }
  if (config.retrieval !== undefined) {
    const retrieval = record(config.retrieval, `${location}.retrieval`);
    assertOnlyKeys(retrieval, ["search_max_results", "search_timeout_seconds", "max_parse_file_bytes"], `${location}.retrieval`);
    for (const [key, value] of Object.entries(retrieval)) positiveInteger(value, `${location}.retrieval.${key}`);
  }
  if (project) {
    if (config.features !== undefined) {
      const features = record(config.features, `${location}.features`);
      assertOnlyKeys(features, ["repo_map", "code_graph", "context_ledger", "checkpoint", "auto_compaction", "git_context", "task_engine", "prompt_cache_optimization", "semantic_search", "telemetry"], `${location}.features`);
      for (const [name, enabled] of Object.entries(features)) if (typeof enabled !== "boolean") throw new ModelConfigurationError(`${location}.features.${name} must be boolean`);
      if (features.semantic_search === true || features.telemetry === true || features.auto_compaction === true || features.prompt_cache_optimization === true) throw new ModelConfigurationError("Project config cannot enable features unavailable in this preview");
    }
    return;
  }
  if (config.run !== undefined) {
    const run = record(config.run, `${location}.run`);
    assertOnlyKeys(run, ["max_model_turns", "max_no_progress_attempts", "max_duration_seconds"], `${location}.run`);
    for (const [key, value] of Object.entries(run)) positiveInteger(value, `${location}.run.${key}`);
  }
  if (config.execution !== undefined) {
    const execution = record(config.execution, `${location}.execution`);
    assertOnlyKeys(execution, ["command_timeout_seconds", "test_build_timeout_seconds", "termination_grace_seconds", "max_output_memory_bytes", "max_log_bytes", "environment_allowlist"], `${location}.execution`);
    for (const [key, value] of Object.entries(execution)) {
      if (key === "environment_allowlist") {
        if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new ModelConfigurationError(`${location}.execution.environment_allowlist must contain environment variable names`);
      } else positiveInteger(value, `${location}.execution.${key}`);
    }
  }
  if (config.logs !== undefined) {
    const logs = record(config.logs, `${location}.logs`);
    assertOnlyKeys(logs, ["retention_days", "max_total_bytes"], `${location}.logs`);
    for (const [key, value] of Object.entries(logs)) positiveInteger(value, `${location}.logs.${key}`);
  }
  if (config.features !== undefined) {
    const features = record(config.features, `${location}.features`);
    assertOnlyKeys(features, ["repo_map", "code_graph", "context_ledger", "checkpoint", "auto_compaction", "git_context", "task_engine", "prompt_cache_optimization", "semantic_search", "telemetry"], `${location}.features`);
    for (const [name, enabled] of Object.entries(features)) if (typeof enabled !== "boolean") throw new ModelConfigurationError(`${location}.features.${name} must be boolean`);
    for (const name of ["auto_compaction", "prompt_cache_optimization", "semantic_search", "telemetry"]) if (features[name] === true) throw new ModelConfigurationError(`Feature ${name} is not available in this preview`);
  }
}

export function resolveTrustedModelSelection(
  globalText: string,
  projectText: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  aliasOverride?: string,
): TrustedModelSelection {
  const globalConfig = readDocument(globalText, "Global config");
  assertOnlyKeys(
    globalConfig,
    ["schema_version", "models", "model_profiles", "context", "run", "execution", "retrieval", "logs", "features"],
    "Global config",
  );

  const schemaVersion = globalConfig.schema_version;
  if (schemaVersion !== 1) {
    throw new ModelConfigurationError("Global config requires schema_version: 1");
  }
  validateOptionalSections(globalConfig, "Global config");
  let projectConfig: RecordValue | undefined;

  const models = record(globalConfig.models, "models");
  assertOnlyKeys(models, ["default", "providers", "aliases"], "models");
  if (typeof models.default !== "string" || !models.default) {
    throw new ModelConfigurationError("models.default must name a trusted alias");
  }
  const providers = record(models.providers, "models.providers");
  const aliases = record(models.aliases, "models.aliases");
  for (const [providerId, value] of Object.entries(providers)) {
    const providerConfig = record(value, `Trusted provider ${providerId}`);
    assertOnlyKeys(providerConfig, ["protocol", "base_url", "api_key_env", "profile", "model"], `Trusted provider ${providerId}`);
    if (typeof providerConfig.protocol !== "string" || !["openai-compatible", "openrouter", "litellm", "local"].includes(providerConfig.protocol)) throw new ModelConfigurationError(`Trusted provider ${providerId} has an unsupported protocol`);
    for (const field of ["base_url", "profile", "model"] as const) if (typeof providerConfig[field] !== "string" || !providerConfig[field]) throw new ModelConfigurationError(`Trusted provider ${providerId} requires ${field}`);
    if (providerConfig.api_key_env !== undefined && (typeof providerConfig.api_key_env !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(providerConfig.api_key_env))) throw new ModelConfigurationError(`Trusted provider ${providerId} has an invalid api_key_env name`);
  }
  for (const [aliasName, target] of Object.entries(aliases)) if (typeof target !== "string" || !providers[target]) throw new ModelConfigurationError(`Model alias ${aliasName} references an unknown trusted provider`);

  let alias = aliasOverride ?? models.default;
  let aliasSource: TrustedModelSelection["aliasSource"] = aliasOverride ? "runtime" : "global";
  if (projectText !== undefined) {
    const project = readDocument(projectText, "Project config");
    projectConfig = project;
    assertOnlyKeys(
      project,
      ["models", "context", "retrieval", "features"],
      "Project config",
    );
    validateOptionalSections(project, "Project config", true);
    if (project.features !== undefined) {
      const projectFeatures = record(project.features, "Project config.features");
      const globalFeatures = globalConfig.features === undefined ? {} : record(globalConfig.features, "Global config.features");
      const defaults: Record<string, boolean> = { repo_map: true, code_graph: false, context_ledger: true, checkpoint: true, git_context: true, task_engine: true };
      for (const [name, enabled] of Object.entries(projectFeatures)) if (enabled === true && (globalFeatures[name] ?? defaults[name]) === false) throw new ModelConfigurationError(`Project config cannot enable globally disabled feature ${name}`);
    }
    if (!aliasOverride && project.models !== undefined) {
      const projectModels = record(project.models, "Project models");
      assertOnlyKeys(projectModels, ["default"], "Project models");
      if (typeof projectModels.default !== "string" || !projectModels.default) {
        throw new ModelConfigurationError("Project models.default must name a trusted alias");
      }
      alias = projectModels.default;
      aliasSource = "project";
    }
  }

  const providerId = aliases[alias];
  if (typeof providerId !== "string" || !providerId) {
    throw new ModelConfigurationError(`Model alias ${alias} is not trusted in global config`);
  }
  const provider = record(providers[providerId], `Trusted provider ${providerId}`);
  assertOnlyKeys(
    provider,
    ["protocol", "base_url", "api_key_env", "profile", "model"],
    `Trusted provider ${providerId}`,
  );
  const protocol = provider.protocol;
  if (
    protocol !== "openai-compatible" &&
    protocol !== "openrouter" &&
    protocol !== "litellm" &&
    protocol !== "local"
  ) {
    throw new ModelConfigurationError(`Trusted provider ${providerId} has an unsupported protocol`);
  }
  const profile = provider.profile;
  const model = provider.model;
  const protectedCredentialEnvironmentNames = [...new Set(Object.values(providers).flatMap((value) => {
    const configuredProvider = record(value, "Trusted provider");
    return typeof configuredProvider.api_key_env === "string" ? [configuredProvider.api_key_env] : [];
  }))];
  const credentialEnvironmentNames = typeof provider.api_key_env === "string" ? [provider.api_key_env] : [];
  if (typeof profile !== "string" || !profile || typeof model !== "string" || !model) {
    throw new ModelConfigurationError(`Trusted provider ${providerId} requires profile and model`);
  }

  let apiKey: string | undefined;
  if (provider.api_key_env !== undefined) {
    if (
      typeof provider.api_key_env !== "string" ||
      !/^[A-Z_][A-Z0-9_]*$/.test(provider.api_key_env)
    ) {
      throw new ModelConfigurationError(`Trusted provider ${providerId} has an invalid api_key_env name`);
    }
    apiKey = env[provider.api_key_env];
    if (!apiKey) {
      throw new ModelConfigurationError(
        `Required environment variable ${provider.api_key_env} is missing`,
      );
    }
  }

  const profiles = record(globalConfig.model_profiles, "model_profiles");
  for (const [profileName, value] of Object.entries(profiles)) {
    const profileConfig = record(value, `Model profile ${profileName}`);
    assertOnlyKeys(profileConfig, ["context_window", "max_output_tokens", "max_input_tokens", "tokenizer", "context", "capabilities"], `Model profile ${profileName}`);
    const profileWindow = positiveInteger(profileConfig.context_window, `${profileName}.context_window`);
    const profileOutput = positiveInteger(profileConfig.max_output_tokens, `${profileName}.max_output_tokens`);
    if (profileOutput > profileWindow || (profileConfig.max_input_tokens !== undefined && positiveInteger(profileConfig.max_input_tokens, `${profileName}.max_input_tokens`) > profileWindow)) throw new ModelConfigurationError(`${profileName} input/output limits exceed its context window`);
    if (profileConfig.tokenizer !== undefined && (typeof profileConfig.tokenizer !== "string" || !profileConfig.tokenizer)) throw new ModelConfigurationError(`${profileName}.tokenizer must be a non-empty string`);
    if (profileConfig.context !== undefined) validateOptionalSections({ context: profileConfig.context }, `Model profile ${profileName}`);
    if (profileConfig.capabilities !== undefined) {
      const capabilities = record(profileConfig.capabilities, `${profileName}.capabilities`);
      assertOnlyKeys(capabilities, ["streaming", "tool_calls", "reasoning"], `${profileName}.capabilities`);
      for (const [name, capability] of Object.entries(capabilities)) if (typeof capability !== "boolean") throw new ModelConfigurationError(`${profileName}.capabilities.${name} must be boolean`);
      if (capabilities.streaming === false || capabilities.tool_calls === false) throw new ModelConfigurationError("Configured agent model must support streaming and tool calls");
    }
  }
  const selectedProfile = record(profiles[profile], `Model profile ${profile}`);
  assertOnlyKeys(selectedProfile, ["context_window", "max_output_tokens", "max_input_tokens", "tokenizer", "context", "capabilities"], `Model profile ${profile}`);
  if (selectedProfile.context !== undefined) validateOptionalSections({ context: selectedProfile.context }, `Model profile ${profile}`);
  const contextWindow = positiveInteger(selectedProfile.context_window, `${profile}.context_window`);
  const maxInputTokens = selectedProfile.max_input_tokens === undefined ? undefined : positiveInteger(selectedProfile.max_input_tokens, `${profile}.max_input_tokens`);
  if (maxInputTokens !== undefined && maxInputTokens > contextWindow) throw new ModelConfigurationError(`${profile}.max_input_tokens exceeds its context window`);
  const maxOutputTokens = positiveInteger(
    selectedProfile.max_output_tokens,
    `${profile}.max_output_tokens`,
  );
  if (maxOutputTokens > contextWindow) {
    throw new ModelConfigurationError(`${profile}.max_output_tokens exceeds its context window`);
  }
  if (selectedProfile.tokenizer !== undefined && (typeof selectedProfile.tokenizer !== "string" || !selectedProfile.tokenizer)) throw new ModelConfigurationError(`${profile}.tokenizer must be a non-empty string`);
  if (selectedProfile.capabilities !== undefined) {
    const capabilities = record(selectedProfile.capabilities, `${profile}.capabilities`);
    assertOnlyKeys(capabilities, ["streaming", "tool_calls", "reasoning"], `${profile}.capabilities`);
    for (const [name, capability] of Object.entries(capabilities)) if (typeof capability !== "boolean") throw new ModelConfigurationError(`${profile}.capabilities.${name} must be boolean`);
    if (capabilities.streaming === false || capabilities.tool_calls === false) throw new ModelConfigurationError("Configured agent model must support streaming and tool calls");
  }
  const context = record(globalConfig.context, "context");
  assertOnlyKeys(context, ["reserved_output_tokens", "safety_margin_tokens", "target_prompt_ratio", "compact_prompt_ratio", "emergency_prompt_ratio", "budget"], "context");
  const profileContext = selectedProfile.context === undefined
    ? {}
    : record(selectedProfile.context, `${profile}.context`);
  assertOnlyKeys(profileContext, ["reserved_output_tokens", "safety_margin_tokens", "target_prompt_ratio", "compact_prompt_ratio", "emergency_prompt_ratio", "budget"], `${profile}.context`);
  const globalBudget = context.budget === undefined ? {} : record(context.budget, "context.budget");
  const profileBudget = profileContext.budget === undefined ? {} : record(profileContext.budget, `${profile}.context.budget`);
  const configuredBudget = { ...globalBudget, ...profileBudget };
  const projectContext = projectConfig?.context === undefined ? {} : record(projectConfig.context, "Project config.context");
  const projectBudget = projectContext.budget === undefined ? {} : record(projectContext.budget, "Project config.context.budget");
  for (const [name, value] of Object.entries(projectBudget)) {
    if (configuredBudget[name] !== undefined && (typeof value !== "number" || value > (configuredBudget[name] as number))) throw new ModelConfigurationError(`Project context budget ${name} exceeds the trusted profile limit`);
  }
  Object.assign(configuredBudget, projectBudget);
  const contextBudgets = {
    ...(configuredBudget.repo_map_tokens !== undefined ? { repoMapTokens: nonNegativeBudget(configuredBudget.repo_map_tokens, "repo_map_tokens", 20_000) } : {}),
    ...(configuredBudget.search_results_tokens !== undefined ? { searchResultsTokens: nonNegativeBudget(configuredBudget.search_results_tokens, "search_results_tokens") } : {}),
    ...(configuredBudget.tool_output_tokens !== undefined ? { toolOutputTokens: nonNegativeBudget(configuredBudget.tool_output_tokens, "tool_output_tokens") } : {}),
    ...(configuredBudget.single_file_read_tokens !== undefined ? { singleFileReadTokens: nonNegativeBudget(configuredBudget.single_file_read_tokens, "single_file_read_tokens") } : {}),
  };
  const runConfig = globalConfig.run === undefined ? {} : record(globalConfig.run, "run");
  const runLimits = {
    maxModelTurns: runConfig.max_model_turns === undefined ? 40 : positiveInteger(runConfig.max_model_turns, "run.max_model_turns"),
    maxNoProgressAttempts: runConfig.max_no_progress_attempts === undefined ? 3 : positiveInteger(runConfig.max_no_progress_attempts, "run.max_no_progress_attempts"),
    maxDurationSeconds: runConfig.max_duration_seconds === undefined ? 1800 : positiveInteger(runConfig.max_duration_seconds, "run.max_duration_seconds"),
  };
  const executionConfig = globalConfig.execution === undefined ? {} : record(globalConfig.execution, "execution");
  const configuredEnvironmentAllowlist = executionConfig.environment_allowlist === undefined
    ? [...DEFAULT_ENVIRONMENT_ALLOWLIST]
    : [...new Set(executionConfig.environment_allowlist as string[])];
  const credentialEnvironmentNameSet = new Set(protectedCredentialEnvironmentNames);
  const environmentAllowlist = configuredEnvironmentAllowlist.filter((name) => !credentialEnvironmentNameSet.has(name));
  const execution = {
    commandTimeoutMs: boundedConfiguredInteger(executionConfig, "execution", "command_timeout_seconds", DEFAULT_EXECUTION_SETTINGS.commandTimeoutMs / 1000, EXECUTION_LIMIT_MAXIMUMS.commandTimeoutSeconds) * 1000,
    testBuildTimeoutMs: boundedConfiguredInteger(executionConfig, "execution", "test_build_timeout_seconds", DEFAULT_EXECUTION_SETTINGS.testBuildTimeoutMs / 1000, EXECUTION_LIMIT_MAXIMUMS.testBuildTimeoutSeconds) * 1000,
    terminationGraceMs: boundedConfiguredInteger(executionConfig, "execution", "termination_grace_seconds", DEFAULT_EXECUTION_SETTINGS.terminationGraceMs / 1000, EXECUTION_LIMIT_MAXIMUMS.terminationGraceSeconds) * 1000,
    maxOutputMemoryBytes: boundedConfiguredInteger(executionConfig, "execution", "max_output_memory_bytes", DEFAULT_EXECUTION_SETTINGS.maxOutputMemoryBytes, EXECUTION_LIMIT_MAXIMUMS.maxOutputMemoryBytes),
    maxLogBytes: boundedConfiguredInteger(executionConfig, "execution", "max_log_bytes", DEFAULT_EXECUTION_SETTINGS.maxLogBytes, EXECUTION_LIMIT_MAXIMUMS.maxLogBytes),
    environmentAllowlist,
  };
  const logsConfig = globalConfig.logs === undefined ? {} : record(globalConfig.logs, "logs");
  const logs = {
    retentionDays: boundedConfiguredInteger(logsConfig, "logs", "retention_days", DEFAULT_LOG_SETTINGS.retentionDays, LOG_LIMIT_MAXIMUMS.retentionDays),
    maxTotalBytes: boundedConfiguredInteger(logsConfig, "logs", "max_total_bytes", DEFAULT_LOG_SETTINGS.maxTotalBytes, LOG_LIMIT_MAXIMUMS.maxTotalBytes),
  };
  const featureDefaults = { repo_map: true, code_graph: false, context_ledger: true, checkpoint: true, git_context: true, task_engine: true };
  const globalFeatures = globalConfig.features === undefined ? {} : record(globalConfig.features, "Global config.features");
  const projectFeatures = projectConfig?.features === undefined ? {} : record(projectConfig.features, "Project config.features");
  const features = {
    repoMap: (projectFeatures.repo_map ?? globalFeatures.repo_map ?? featureDefaults.repo_map) as boolean,
    codeGraph: (projectFeatures.code_graph ?? globalFeatures.code_graph ?? featureDefaults.code_graph) as boolean,
    contextLedger: (projectFeatures.context_ledger ?? globalFeatures.context_ledger ?? featureDefaults.context_ledger) as boolean,
    checkpoint: (projectFeatures.checkpoint ?? globalFeatures.checkpoint ?? featureDefaults.checkpoint) as boolean,
    gitContext: (projectFeatures.git_context ?? globalFeatures.git_context ?? featureDefaults.git_context) as boolean,
    taskEngine: (projectFeatures.task_engine ?? globalFeatures.task_engine ?? featureDefaults.task_engine) as boolean,
  };
  const baseReservedOutputTokens = positiveInteger(
    profileContext.reserved_output_tokens ?? context.reserved_output_tokens,
    `${profile}.context.reserved_output_tokens`,
  );
  const baseSafetyMarginTokens = positiveInteger(
    profileContext.safety_margin_tokens ?? context.safety_margin_tokens,
    `${profile}.context.safety_margin_tokens`,
  );
  const projectReservedOutput = projectContext.reserved_output_tokens === undefined ? baseReservedOutputTokens : positiveInteger(projectContext.reserved_output_tokens, "Project config.context.reserved_output_tokens");
  const projectSafetyMargin = projectContext.safety_margin_tokens === undefined ? baseSafetyMarginTokens : positiveInteger(projectContext.safety_margin_tokens, "Project config.context.safety_margin_tokens");
  if (projectReservedOutput < baseReservedOutputTokens || projectSafetyMargin < baseSafetyMarginTokens) throw new ModelConfigurationError("Project context overrides cannot reduce trusted output reservation or safety margin");
  const reservedOutputTokens = projectReservedOutput;
  const safetyMarginTokens = projectSafetyMargin;
  if (
    reservedOutputTokens > maxOutputTokens ||
    reservedOutputTokens + safetyMarginTokens >= Math.min(contextWindow, maxInputTokens ?? contextWindow)
  ) {
    throw new ModelConfigurationError("Configured output reservation and safety margin exceed model limits");
  }

  return {
    alias,
    aliasSource,
    providerId,
    protocol,
    baseUrl: interpolateTrustedUrl(provider.base_url, env),
    apiKey,
    protectedCredentialEnvironmentNames,
    credentialEnvironmentNames,
    profile,
    model,
    contextWindow,
    ...(maxInputTokens !== undefined ? { maxInputTokens } : {}),
    maxOutputTokens,
    reservedOutputTokens,
    safetyMarginTokens,
    runLimits,
    execution,
    logs,
    features,
    ...(Object.keys(contextBudgets).length ? { contextBudgets } : {}),
  };
}

function nonNegativeBudget(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  nonNegativeInteger(value, `context.budget.${field}`);
  if ((value as number) > maximum) throw new ModelConfigurationError(`context.budget.${field} must not exceed ${maximum}`);
  return value as number;
}

export function promptLimitForModel(selection: Pick<TrustedModelSelection, "contextWindow" | "maxInputTokens" | "reservedOutputTokens" | "safetyMarginTokens">): number {
  return Math.min(selection.contextWindow, selection.maxInputTokens ?? selection.contextWindow) - selection.reservedOutputTokens - selection.safetyMarginTokens;
}

export async function loadTrustedModelSelection(options: {
  globalPath: string;
  projectPath?: string;
  env?: NodeJS.ProcessEnv;
  modelAlias?: string;
}): Promise<TrustedModelSelection> {
  let globalText: string;
  try {
    globalText = await readFile(options.globalPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ModelConfigurationError(
        `Trusted model config not found at ${options.globalPath}; create it before starting a session`,
      );
    }
    throw error;
  }
  let projectText: string | undefined;
  if (options.projectPath) {
    try {
      projectText = await readFile(options.projectPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return resolveTrustedModelSelection(globalText, projectText, options.env, options.modelAlias);
}

export async function listTrustedModelAliases(globalPath: string): Promise<string[]> {
  let text: string;
  try { text = await readFile(globalPath, "utf8"); }
  catch { throw new ModelConfigurationError(`Trusted model config not found at ${globalPath}`); }
  const config = readDocument(text, "Global config");
  const models = record(config.models, "models");
  const aliases = record(models.aliases, "models.aliases");
  return Object.keys(aliases).sort();
}
