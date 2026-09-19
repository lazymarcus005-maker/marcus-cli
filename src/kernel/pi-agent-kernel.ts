import { join } from "node:path";
import {
  DefaultResourceLoader,
  createAgentSession,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { promptLimitForModel, type TrustedModelSelection } from "../config/trusted-model.js";
import { createRequestBudgetGuard, type RequestManifest, type RequestManifestContext } from "../context/request-budget.js";
import { resolveRepositoryInstructions } from "../context/instructions.js";
import { prepareWorkingSetRequest } from "../context/working-set-runtime.js";
import { createPolicyShellTool } from "../execution/pi-shell-tool.js";
import type { ExecutionAuthorization } from "../execution/policy-executor.js";
import { createRepositoryTools } from "../execution/repository-tools.js";
import type { StateStore } from "../state/state-store.js";
import { readGitContext } from "../workflow/git-context.js";
import { RunController } from "../workflow/run-controller.js";
import { createTrustedPiModel } from "./trusted-pi-model.js";
import { applyProviderGenerationSettings, validateProviderGenerationSettings } from "./provider-generation-settings.js";

export interface KernelHooks {
  prepareProviderRequest?: (payload: unknown) => unknown;
  prepareContext?: (messages: unknown[]) => Promise<unknown[]>;
  onProviderRequestRejected?: (error: unknown) => void;
  onContextPreparationError?: (error: unknown) => void;
  onObservation?: (observation: KernelObservation) => void;
  onTextDelta?: (text: string) => void;
  providerGenerationSettings?: Record<string, unknown>;
}

export interface KernelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type KernelObservation =
  | { type: "assistant_message"; usage: KernelUsage; stopReason: string }
  | { type: "tool_call"; toolName: string };

type RequestPreparationHooks = Omit<KernelHooks, "prepareProviderRequest" | "onObservation"> & {
  prepareProviderRequest: (payload: unknown) => unknown;
};

export interface KernelSessionOptions {
  resumeRecent?: boolean;
  sessionId?: string;
}

/** Fail closed with a useful message if the pinned Pi session API drifts. */
export function assertPiSessionCapabilities(session: AgentSession): void {
  const requiredMethods = [
    "prompt",
    "subscribe",
    "abort",
    "abortCompaction",
    "compact",
    "dispose",
    "setAutoCompactionEnabled",
  ] as const;
  for (const method of requiredMethods) {
    if (typeof (session as unknown as Record<string, unknown>)[method] !== "function") {
      throw new Error(`Incompatible Pi SDK: required public session capability "${method}" is unavailable; expected @earendil-works/pi-coding-agent@0.85.1`);
    }
  }
  const sessionManager = session.sessionManager as unknown as Record<string, unknown>;
  for (const method of ["getLeafId", "getEntry"] as const) {
    if (typeof sessionManager?.[method] !== "function") {
      throw new Error(`Incompatible Pi SDK: required public session manager capability "${method}" is unavailable; expected @earendil-works/pi-coding-agent@0.85.1`);
    }
  }
}

export function createRequestPreparationExtension(
  hooks: RequestPreparationHooks,
  instructionText?: string,
): ExtensionFactory {
  return (pi) => {
    if (instructionText || hooks.prepareContext) {
      pi.on("context", async (event) => {
        const messages = instructionText
          ? [{ role: "user" as const, content: instructionText, timestamp: Date.now() }, ...event.messages]
          : event.messages;
        if (!hooks.prepareContext) return { messages };
        try {
          return { messages: await hooks.prepareContext(messages) as typeof messages };
        } catch (error) {
          hooks.onContextPreparationError?.(error);
          return { messages };
        }
      });
    }
    pi.on("before_provider_request", (event) => {
      try {
        return hooks.prepareProviderRequest(event.payload);
      } catch (error) {
        // Pi 0.85.1 reports extension errors and continues with the original payload.
        // Abort the in-flight Agent request before the provider transport resumes.
        hooks.onProviderRequestRejected?.(error);
        return event.payload;
      }
    });
  };
}

/** Stable Macus-facing wrapper around the pinned public Pi SDK. */
export class PiAgentKernel {
  private session: AgentSession | undefined;
  private readonly prepareRequest: (payload: unknown) => unknown;
  private lastManifest: RequestManifest | undefined;
  private requestManifestContext: RequestManifestContext = {};
  private activeRun: RunController | undefined;
  private runTimer: NodeJS.Timeout | undefined;
  private sessionOperation: "start" | "prompt" | "compact" | "restore" | undefined;
  private readonly observe: KernelHooks["onObservation"];
  private readonly onTextDelta: KernelHooks["onTextDelta"];

  constructor(
    private readonly cwd: string,
    private readonly selection: TrustedModelSelection,
    hooks?: KernelHooks,
    private readonly stateStore?: StateStore,
    private readonly authorizeCommand: (command: string, credentialEnvironmentNames: readonly string[], signal?: AbortSignal) => Promise<ExecutionAuthorization> = async () => false,
  ) {
    this.observe = hooks?.onObservation;
    this.onTextDelta = hooks?.onTextDelta;
    const providerGenerationSettings = hooks?.providerGenerationSettings === undefined
      ? undefined
      : validateProviderGenerationSettings(hooks.providerGenerationSettings, selection.reservedOutputTokens);
    const prepareBudgetedRequest = hooks?.prepareProviderRequest ?? createRequestBudgetGuard(
      selection,
      (manifest) => { this.lastManifest = manifest; },
      () => ({
        ...(this.session?.sessionId ? { sessionId: this.session.sessionId } : {}),
        modelId: `${selection.providerId}/${selection.model}`,
        adapterVersion: "@earendil-works/pi-coding-agent@0.85.1",
        ...this.requestManifestContext,
      }),
    );
    this.prepareRequest = (payload) => {
      if (this.activeRun && !this.activeRun.beforeModelRequest()) {
        throw new Error(this.activeRun.stopReason ?? "Run stopped at a safe model boundary");
      }
      const configuredPayload = providerGenerationSettings
        ? applyProviderGenerationSettings(payload, providerGenerationSettings)
        : payload;
      return prepareBudgetedRequest(configuredPayload);
    };
  }

  get sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  get currentRunId(): string | undefined {
    return this.activeRun?.runId;
  }

  get lastRequestManifest(): RequestManifest | undefined {
    return this.lastManifest;
  }

  inheritLastRequestManifest(manifest: RequestManifest | undefined): void {
    if (!manifest) return;
    if (this.session?.sessionId && manifest.sessionId && this.session.sessionId !== manifest.sessionId) {
      throw new Error("Cannot inherit a request manifest from a different session");
    }
    if (!this.lastManifest) this.lastManifest = manifest;
  }

  get transcriptEntryId(): string | null {
    return this.session?.sessionManager.getLeafId() ?? null;
  }

  get autoCompactionEnabled(): boolean {
    return this.session?.autoCompactionEnabled ?? false;
  }

  async start(options: KernelSessionOptions = {}): Promise<void> {
    if (this.session) return;
    if (this.sessionOperation) throw new Error(`Cannot start a session while ${this.sessionOperation} is in progress`);
    this.sessionOperation = "start";
    try {

    const { modelRuntime, model } = await createTrustedPiModel(this.selection);
    const settingsManager = SettingsManager.inMemory();
    const instructions = await resolveRepositoryInstructions(this.cwd, this.cwd);
    const instructionText = instructions.map((instruction) =>
      `<repository-instruction path="${instruction.path}" sha256="${instruction.sha256}">\n${instruction.content}\n</repository-instruction>`,
    ).join("\n\n");
    const instructionManifest = instructions.map((instruction) => ({
      path: instruction.path,
      sourceSha256: instruction.sha256,
      reason: "repository-instruction" as const,
      estimatedTokens: Buffer.byteLength(`<repository-instruction path="${instruction.path}" sha256="${instruction.sha256}">\n${instruction.content}\n</repository-instruction>`, "utf8"),
    }));
    const requestExtension = createRequestPreparationExtension({
      prepareProviderRequest: this.prepareRequest,
      prepareContext: async (messages) => {
        const sessionId = this.session?.sessionId;
        this.requestManifestContext = {
          ...(sessionId ? { sessionId } : {}),
          modelId: `${this.selection.providerId}/${this.selection.model}`,
          adapterVersion: "@earendil-works/pi-coding-agent@0.85.1",
          includedInstructions: instructionManifest,
          includedFragments: [],
          omittedFragments: [],
        };
        if (!this.stateStore || !sessionId) return messages;
        const tasks = this.stateStore.listTasks(sessionId);
        const activeTask = tasks.find((task) => task.status === "in_progress");
        const latestEvidence = this.stateStore.listTestEvidence(sessionId).at(-1);
        const view = await prepareWorkingSetRequest({
          root: this.cwd,
          sessionId,
          stateStore: this.stateStore,
          messages,
          promptLimitTokens: promptLimitForModel(this.selection),
          stage: latestEvidence?.status === "failed" ? "failure" : activeTask ? "implementation" : "discovery",
          relatedPaths: activeTask?.relatedFiles ?? [],
        });
        this.requestManifestContext = {
          sessionId,
          modelId: `${this.selection.providerId}/${this.selection.model}`,
          adapterVersion: "@earendil-works/pi-coding-agent@0.85.1",
          includedInstructions: instructionManifest,
          includedFragments: view.includedFragments.map(({ fragmentId, path, sourceSha256, startLine, endLine, reason, tier, estimatedTokens }) => ({ fragmentId, path, sourceSha256: sourceSha256!, startLine, endLine, reason, tier, estimatedTokens, freshness: "verified" as const })),
          omittedFragments: view.omittedFragments,
        };
        return view.messages;
      },
      onProviderRequestRejected: (error) => {
        const message = error instanceof Error ? error.message : "provider request rejected by Macus policy";
        process.stderr.write(`Macus paused the provider request: ${message}\n`);
        void this.session?.abort();
      },
      onContextPreparationError: (error) => {
        const message = error instanceof Error ? error.message : "working-set context preparation failed";
        this.requestManifestContext = {
          ...(this.session?.sessionId ? { sessionId: this.session.sessionId } : {}),
          modelId: `${this.selection.providerId}/${this.selection.model}`,
          adapterVersion: "@earendil-works/pi-coding-agent@0.85.1",
          includedInstructions: instructionManifest,
          includedFragments: [],
          omittedFragments: [{ path: "<working-set>", reason: "invalid-source", detail: message.slice(0, 200) }],
        };
        process.stderr.write(`Macus omitted optional working-set context: ${message}\n`);
      },
    }, instructionText);
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: getAgentDir(),
      settingsManager,
      // Macus owns instruction and executable-extension discovery. Do not run
      // repository-provided extensions before their trust policy exists.
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [requestExtension],
    });
    await resourceLoader.reload();

    const customTools = this.stateStore
      ? [
          ...createPolicyShellTool({
          cwd: this.cwd,
          stateStore: this.stateStore,
          sessionId: () => this.session?.sessionId,
          runId: () => this.activeRun?.runId,
          authorizeCommand: this.authorizeCommand,
          execution: this.selection.execution,
          logs: this.selection.logs,
          ...(this.selection.protectedCredentialEnvironmentNames.length ? { protectedCredentialEnvironmentNames: this.selection.protectedCredentialEnvironmentNames } : {}),
          ...(this.selection.credentialEnvironmentNames.length ? { credentialEnvironmentNames: this.selection.credentialEnvironmentNames } : {}),
          }),
          ...createRepositoryTools({
            cwd: this.cwd,
            stateStore: this.stateStore,
            sessionId: () => this.session?.sessionId,
            runId: () => this.activeRun?.runId,
            codeGraph: this.selection.features.codeGraph,
            gitContext: this.selection.features.gitContext,
            authorizeWrite: async (summary, signal) => {
              const authorization = await this.authorizeCommand(summary, [], signal);
              return typeof authorization === "boolean" ? authorization : authorization.approved;
            },
          }),
        ]
      : [];

    const sessionDirectory = join(this.cwd, ".macus", "sessions");
    let sessionManager: SessionManager;
    if (options.sessionId) {
      const sessions = await SessionManager.list(this.cwd, sessionDirectory);
      const selected = sessions.find((candidate) => candidate.id === options.sessionId);
      if (!selected) throw new Error(`No Macus session found with ID ${options.sessionId}`);
      sessionManager = SessionManager.open(selected.path, sessionDirectory, this.cwd);
    } else if (options.resumeRecent) {
      sessionManager = SessionManager.continueRecent(this.cwd, sessionDirectory);
    } else {
      sessionManager = SessionManager.create(this.cwd, sessionDirectory);
    }

    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: this.cwd,
      agentDir: join(this.cwd, ".macus", "pi-agent"),
      model,
      modelRuntime,
      settingsManager,
      sessionManager,
      resourceLoader,
      // Pi built-ins remain disabled; the sole execution tool is Macus policy-controlled.
      noTools: "builtin",
      customTools,
    });
    assertPiSessionCapabilities(session);

    // Macus is the only compaction authority; callers must checkpoint and pass
    // the serialized request-budget gate before the next provider dispatch.
    session.setAutoCompactionEnabled(false);
    this.session = session;
    session.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        this.emitObservation({ type: "tool_call", toolName: event.toolName });
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        this.emitObservation({
          type: "assistant_message",
          usage: {
            input: event.message.usage.input,
            output: event.message.usage.output,
            cacheRead: event.message.usage.cacheRead,
            cacheWrite: event.message.usage.cacheWrite,
          },
          stopReason: event.message.stopReason,
        });
      }
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        if (this.onTextDelta) {
          try { this.onTextDelta(event.assistantMessageEvent.delta); } catch { /* Optional output hooks must not alter session behavior. */ }
        } else process.stdout.write(event.assistantMessageEvent.delta);
      }
      const observed = event as unknown as Record<string, unknown>;
      if (observed.type === "message_end" && typeof observed.message === "object" && observed.message !== null && (observed.message as { role?: unknown }).role === "assistant") {
        this.activeRun?.assistantTurnEnded();
      }
      if (observed.type === "tool_execution_end") {
        const name = typeof observed.toolName === "string" ? observed.toolName : "unknown-tool";
        this.activeRun?.toolCompleted({ name, isError: observed.isError === true, result: observed.result });
        if (this.activeRun?.stopReason) void this.session?.abort();
      }
    });

    if (modelFallbackMessage) {
      process.stderr.write(`Model note: ${modelFallbackMessage}\n`);
    }
    } finally {
      if (this.sessionOperation === "start") this.sessionOperation = undefined;
    }
  }

  async prompt(text: string): Promise<void> {
    if (!this.session) throw new Error("Pi session has not been started");
    const blockers = this.stateStore?.listActiveBlockers(this.session.sessionId) ?? [];
    if (blockers.length) throw new Error(`Coding run is paused by blocker(s) at ledger revision ${blockers.map((item) => item.revision).join(", ")}; resolve them explicitly before continuing`);
    if (this.stateStore) {
      const unknownRuns = this.stateStore.listRuns(this.session.sessionId).filter((run) => run.status === "unknown");
      if (unknownRuns.length) {
        throw new Error(`Coding run is paused by unknown prior run(s) ${unknownRuns.map((run) => run.runId).join(", ")}; review state and start a new session before continuing`);
      }
      const tasks = this.stateStore.listTasks(this.session.sessionId);
      const blockedTasks = tasks.filter((task) => task.status === "blocked");
      if (blockedTasks.length && !tasks.some((task) => task.status === "in_progress")) {
        throw new Error(`Coding run is paused by blocked task(s) ${blockedTasks.map((task) => task.id).join(", ")}; explicitly reopen a task or start another task before continuing`);
      }
      if (this.stateStore.getSession(this.session.sessionId)) {
        const savedIdentity = this.stateStore.getSession(this.session.sessionId)!;
        const context = await readGitContext(this.cwd);
        if (context.isRepository) {
          if (savedIdentity.gitIdentityCaptured && (savedIdentity.gitBranch !== context.branch || savedIdentity.gitHead !== context.head)) {
            const reason = `Repository branch/HEAD changed (saved ${savedIdentity.gitBranch ?? "detached"}/${savedIdentity.gitHead ?? "unborn"}, current ${context.branch ?? "detached"}/${context.head ?? "unborn"}); start a new session after reviewing workspace state`;
            this.stateStore.invalidateWorkspaceState(this.session.sessionId, reason);
            throw new Error(reason);
          }
          this.stateStore.reconcileWorkingTree(this.session.sessionId, context.fileHashes);
        }
      }
    }
    this.assertNoUnresolvedExecutions("send a prompt");
    if (this.sessionOperation) throw new Error(`Cannot send a prompt while ${this.sessionOperation} is in progress`);
    const run = new RunController(this.selection.runLimits);
    this.sessionOperation = "prompt";
    this.activeRun = run;
    const sessionId = this.session.sessionId;
    let durableRunStarted = false;
    try {
      if (this.stateStore) {
        this.stateStore.startRun({ runId: run.runId, sessionId, prompt: text });
        durableRunStarted = true;
      }
      this.runTimer = setTimeout(() => {
        run.timedOut();
        void this.session?.abort();
      }, Math.min(this.selection.runLimits.maxDurationSeconds * 1000, 2_147_000_000));
      await this.session.prompt(text);
    } catch (error) {
      run.fail();
      throw error;
    } finally {
      if (this.runTimer) clearTimeout(this.runTimer);
      this.runTimer = undefined;
      try {
        if (this.stateStore && durableRunStarted) this.stateStore.finishRun(run.runId, run.status, { modelTurns: run.turns, ...(run.stopReason ? { stopReason: run.stopReason } : {}) });
        if (run.stopReason) process.stderr.write(`Macus paused this run: ${run.stopReason}; review state before continuing.\n`);
      } finally {
        this.activeRun = undefined;
        this.sessionOperation = undefined;
      }
    }
  }

  async cancel(): Promise<void> {
    this.activeRun?.cancel();
    if (this.sessionOperation === "compact") {
      this.session?.abortCompaction();
      return;
    }
    await this.session?.abort();
  }

  async compact(instructions?: string): Promise<Awaited<ReturnType<AgentSession["compact"]>>> {
    if (!this.session) throw new Error("Pi session has not been started");
    if (this.sessionOperation) throw new Error(`Cannot compact while ${this.sessionOperation} is in progress`);
    this.assertNoUnresolvedExecutions("compact the conversation");
    this.sessionOperation = "compact";
    try {
      return await this.session.compact(instructions);
    } finally {
      this.sessionOperation = undefined;
    }
  }

  async restoreTranscriptEntry(entryId: string): Promise<void> {
    if (!this.session) throw new Error("Pi session has not been started");
    if (this.sessionOperation) throw new Error(`Cannot restore a checkpoint while ${this.sessionOperation} is in progress`);
    this.assertNoUnresolvedExecutions("restore a checkpoint");
    this.sessionOperation = "restore";
    try {
      if (!this.session.sessionManager.getEntry(entryId)) throw new Error("Checkpoint transcript entry is not present in this session");
      const result = await this.session.navigateTree(entryId, { summarize: false });
      if (result.cancelled) throw new Error("Checkpoint restore was cancelled");
    } finally {
      this.sessionOperation = undefined;
    }
  }

  private assertNoUnresolvedExecutions(action: string): void {
    const sessionId = this.session?.sessionId;
    if (!sessionId || !this.stateStore) return;
    const unresolved = this.stateStore.listUnresolvedExecutions(sessionId);
    if (unresolved.length) {
      throw new Error(`Cannot ${action}: ${unresolved.length} execution outcome(s) require recovery review`);
    }
  }

  private emitObservation(observation: KernelObservation): void {
    try {
      this.observe?.(observation);
    } catch {
      // Optional measurement observers must not alter coding-session behavior.
    }
  }

  async dispose(): Promise<void> {
    if (this.sessionOperation) throw new Error(`Cannot dispose a session while ${this.sessionOperation} is in progress`);
    if (this.runTimer) clearTimeout(this.runTimer);
    this.runTimer = undefined;
    this.activeRun = undefined;
    await this.session?.dispose();
    this.session = undefined;
  }
}
