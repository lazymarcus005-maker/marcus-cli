#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { listTrustedModelAliases, loadTrustedModelSelection, promptLimitForModel } from "./config/trusted-model.js";
import {
  acquireWorktreeMutationLock,
  openStateStore,
} from "./state/state-store.js";
import { PiAgentKernel, type KernelObservation } from "./kernel/pi-agent-kernel.js";
import { SessionApprovals } from "./cli-approvals.js";
import { searchCode } from "./retrieval/search.js";
import { buildRepositoryMap } from "./retrieval/repo-map.js";
import { buildSymbolIndex, searchSymbols } from "./retrieval/symbol-index.js";
import { readGitContext } from "./workflow/git-context.js";
import { runTestCommand } from "./workflow/test-runner.js";
import { buildCompactionInstructions, createDurableCheckpoint, reconcileDurableCheckpoints, verifyCheckpointSources } from "./workflow/checkpoints.js";
import { inspectGit, type GitInspectionOperation } from "./workflow/git-inspection.js";
import { formatReviewReport } from "./workflow/review-report.js";
import { formatRecoveryReport } from "./workflow/recovery-report.js";
import { checkRepositoryResumeIdentity } from "./workflow/repository-identity.js";
import type { ExecutionAuthorization } from "./execution/policy-executor.js";

export interface CliDependencies {
  version?: string;
  write: (text: string) => void;
  startSession: (initialPrompt?: string, initialYolo?: boolean) => Promise<void>;
}

const helpText = `Macus Code — local CLI coding agent

Usage: macus [task]

Options:
  -h, --help      Show this help
  -v, --version   Show version
  --yolo          Auto-approve model-requested commands (credentials stay blocked)

Session commands:
  /help           Show this help
  /yolo           Toggle auto-approval of model-requested commands
  /status         Show selected model and request limits
  /recovery       Inspect redacted details for unresolved executions and runs
  /models         List trusted model aliases
  /model [ALIAS]  Show or switch the current session's trusted model
  /settings       Show validated, non-secret effective model settings
  /context        Inspect the last dispatched request budget
  /context files  Show selected/omitted source provenance
  /checkpoint     List durable state checkpoints; /checkpoint create writes one
  /checkpoint restore ID  Restore Pi transcript state only; never source bytes
  /compact        Checkpoint, then ask Pi to compact the current conversation
  /map            Show a bounded repository overview
  /search QUERY   Search source text literally
  /symbol QUERY   Find syntax-indexed declarations
  /diff           Show bounded Git changes and snapshot identity
  /git diff|log|show|blame  Inspect bounded Git history/context
  /test FORMAT [REPORT] -- COMMAND Run a bounded, approved test command
  /review         Summarize changes, current test evidence, risks, and unresolved issues
  /tasks          List durable session tasks
  /goal [set TEXT]  Show or persist the durable user goal
  /decision TEXT  Record a durable decision with user-command provenance
  /next-action TEXT  Record the next intended action for recovery
  /blocker TEXT  Pause coding prompts on a durable blocker
  /blocker clear REVISION  Resolve a recorded blocker
  /task add TEXT  Add a durable task
  /task STATUS ID Set task status: start, complete, block, reopen, skip
  /exit           Quit the session
`;

export async function runCli(
  args: string[],
  dependencies: CliDependencies,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    dependencies.write(helpText);
    return 0;
  }

  if (args.includes("--version") || args.includes("-v")) {
    dependencies.write(`${dependencies.version ?? "0.1.0"}\n`);
    return 0;
  }

  const yolo = args.includes("--yolo");
  const promptArgs = args.filter((argument) => argument !== "--yolo");
  const prompt = promptArgs.length > 0 ? promptArgs.join(" ") : undefined;
  await dependencies.startSession(prompt, yolo);
  return 0;
}

async function startInteractiveSession(initialPrompt?: string, initialYolo = false): Promise<void> {
  const cwd = await realpath(process.cwd());
  const globalConfigPath =
    process.env.MACUS_CONFIG ?? join(homedir(), ".macus", "config.yaml");
  let selection = await loadTrustedModelSelection({
    globalPath: globalConfigPath,
    projectPath: join(cwd, ".macus", "config.yaml"),
  });
  const gitDirectory = (() => {
    try {
      const path = execFileSync(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      return path ? resolve(path) : null;
    } catch {
      return null;
    }
  })();
  const stateStore = openStateStore(join(cwd, ".macus", "state", "state.db"));
  let releaseMutationLock: (() => void) | undefined;
  let kernel: PiAgentKernel | undefined;
  let input: ReturnType<typeof createInterface> | undefined;
  const onInterrupt = (): void => {
    void kernel?.cancel();
  };
  const approvals = new SessionApprovals();
  approvals.setYolo(initialYolo);
  const authorizeCommand = async (command: string, credentialEnvironmentNames: readonly string[], signal?: AbortSignal): Promise<ExecutionAuthorization> => {
    const decision = await approvals.authorize({ command, credentialEnvironmentNames }, async () => {
      console.error("\nApproval required for a model-requested operation.");
      console.error("Shell commands run locally with your account's permissions; Macus does not OS-sandbox them.");
      console.error("Review the exact operation and repository scripts before approving:");
      console.error(command);
      try {
        const question = "Type 'yes' to approve this command (anything else denies): ";
        const answer = signal
          ? await input!.question(question, { signal })
          : await input!.question(question);
        if (answer.trim() !== "yes") return { approved: false, authorizedEnvironmentNames: [] };
        if (credentialEnvironmentNames.length === 0) return { approved: true, authorizedEnvironmentNames: [] };
        console.error(`Trusted provider credentials are blocked by default. Effective non-secret environment allowlist: ${selection.execution.environmentAllowlist.join(", ") || "(empty)"}.`);
        console.error(`Credential variable names (values are never displayed): ${credentialEnvironmentNames.join(", ")}`);
        const credentialQuestion = "For this command only, enter exact credential variable names to pass, comma-separated (Enter keeps all blocked): ";
        const credentialAnswer = signal
          ? await input!.question(credentialQuestion, { signal })
          : await input!.question(credentialQuestion);
        const requested = credentialAnswer.split(",").map((name) => name.trim()).filter(Boolean);
        if (requested.some((name) => !credentialEnvironmentNames.includes(name))) {
          console.error("Unknown credential variable name; command denied.");
          return { approved: false, authorizedEnvironmentNames: [] };
        }
        return { approved: true, authorizedEnvironmentNames: [...new Set(requested)] };
      } catch {
        return { approved: false, authorizedEnvironmentNames: [] };
      }
    });
    if (!decision.approved) return false;
    if (decision.auto) dimLine(`⟡ auto-approved (${decision.reason}): ${command.length > 120 ? `${command.slice(0, 120)}…` : command}`);
    return decision.authorizedEnvironmentNames.length ? { approved: true, authorizedEnvironmentNames: decision.authorizedEnvironmentNames } : true;
  };
  const newKernel = (): PiAgentKernel => new PiAgentKernel(cwd, selection, {
    onObservation: observeRunStats,
    onTextDelta: (delta) => {
      if (!delta) return;
      lastStreamEndedWithNewline = delta.endsWith("\n");
      stdout.write(delta);
    },
  }, stateStore, authorizeCommand);
  const runPrompt = async (promptText: string): Promise<void> => {
    runStats = { toolCalls: 0, inTokens: 0, outTokens: 0 };
    const startedAt = performance.now();
    let stopped = false;
    try {
      await kernel!.prompt(promptText);
    } catch (error) {
      stopped = true;
      stdout.write(`Run failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    }
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    dimLine(`⟡ ${seconds}s · ${runStats.inTokens.toLocaleString("en-US")} tok in · ${runStats.outTokens.toLocaleString("en-US")} tok out · ${runStats.toolCalls} tool call${runStats.toolCalls === 1 ? "" : "s"}${stopped ? " · stopped" : ""}`);
  };
  let recoveryBlocked = false;
  let repositoryIdentityIssue: string | undefined;
  const interactive = Boolean(stdout.isTTY) && !process.env.NO_COLOR;
  const dim = (text: string): string => (interactive ? `\x1b[2m${text}\x1b[0m` : text);
  const startupNotices: string[] = [];
  const deferNotice = (text: string): void => { startupNotices.push(text); };
  const flushStartupNotices = (): void => {
    while (startupNotices.length) console.error(startupNotices.shift());
  };
  let runStats = { toolCalls: 0, inTokens: 0, outTokens: 0 };
  let lastStreamEndedWithNewline = true;
  const dimLine = (text: string): void => {
    stdout.write(dim(`${lastStreamEndedWithNewline ? "" : "\n"}${text}\n`));
    lastStreamEndedWithNewline = true;
  };
  const observeRunStats = (observation: KernelObservation): void => {
    if (observation.type === "tool_call") runStats.toolCalls += 1;
    else {
      runStats.inTokens += observation.usage.input + observation.usage.cacheRead + observation.usage.cacheWrite;
      runStats.outTokens += observation.usage.output;
    }
  };

  const registerSessionIdentity = async (verifyRepositoryIdentity = false): Promise<void> => {
    if (!kernel?.sessionId) throw new Error("Pi did not create a session identity");
    const existing = stateStore.getSession(kernel.sessionId);
    repositoryIdentityIssue = undefined;
    if (existing) {
      if (existing.worktreeRoot !== cwd || existing.gitDirectory !== gitDirectory) {
        throw new Error("Saved Macus session belongs to a different worktree or Git directory");
      }
      if (verifyRepositoryIdentity) {
        const current = await readGitContext(cwd);
        const check = checkRepositoryResumeIdentity(existing, current);
        if (check.status !== "verified") repositoryIdentityIssue = check.reason;
      }
    } else {
      const initialContext = await readGitContext(cwd);
      const currentHashes = new Map(initialContext.fileHashes.map(({ path, sha256 }) => [path, sha256]));
      const initialChanges = initialContext.changedFiles.slice(0, 5000).map(({ path }) => ({ path, sha256: currentHashes.get(path) ?? null }));
      stateStore.createSession({ sessionId: kernel.sessionId, worktreeRoot: cwd, gitDirectory, gitBranch: initialContext.branch, gitHead: initialContext.head, gitIdentityCaptured: true }, initialChanges);
      if (initialContext.changedFiles.length > initialChanges.length) {
        deferNotice(`Initial source attribution is partial: ${initialChanges.length} of ${initialContext.changedFiles.length} changed paths were recorded.`);
      }
    }
    stateStore.markInterruptedRunsUnknown(kernel.sessionId);
    stateStore.markInterruptedExecutionsUnknown(kernel.sessionId);
    stateStore.markCompletedExecutionsMissingTranscriptResults(kernel.sessionId, new Set(kernel.transcriptToolResultCallIds));
    const unknownRuns = stateStore.listRuns(kernel.sessionId).filter((run) => run.status === "unknown");
    const unresolved = stateStore.listUnresolvedExecutionDetails(kernel.sessionId);
    recoveryBlocked = unresolved.length > 0 || unknownRuns.length > 0 || repositoryIdentityIssue !== undefined;
    if (recoveryBlocked) deferNotice(formatRecoveryReport({ executions: unresolved, unknownRunIds: unknownRuns.map((run) => run.runId), ...(repositoryIdentityIssue ? { repositoryIdentityIssue } : {}) }));
    const checkpoints = await reconcileDurableCheckpoints({ root: cwd, sessionId: kernel.sessionId, stateStore });
    if (checkpoints.removedTemporaryFiles.length || checkpoints.removedOrphanFiles.length || checkpoints.missingRegisteredFiles.length || checkpoints.invalidFiles.length) {
      deferNotice(`Checkpoint reconciliation: removed ${checkpoints.removedTemporaryFiles.length} temp and ${checkpoints.removedOrphanFiles.length} orphan file(s); ${checkpoints.missingRegisteredFiles.length} registered file(s) missing; ${checkpoints.invalidFiles.length} invalid file(s). No source files were changed.`);
    }
  };

  try {
    input = createInterface({ input: stdin, output: stdout });
    releaseMutationLock = acquireWorktreeMutationLock(
      join(cwd, ".macus", "locks", "worktree.lock.db"),
    );
    kernel = newKernel();
    await kernel.start({ resumeRecent: true });
    const priorSession = Boolean(stateStore.getSession(kernel.sessionId!));
    await registerSessionIdentity(true);

    process.on("SIGINT", onInterrupt);
    const bannerGit = await readGitContext(cwd);
    const sessionState = priorSession ? "resumed" : "fresh";
    stdout.write(dim(`◆ Macus Code v0.1.0 · local coding agent\n`));
    stdout.write(dim(`  model    ${selection.alias} · ${selection.providerId}/${selection.model} (prompt cap ${promptLimitForModel(selection).toLocaleString("en-US")} tok)\n`));
    stdout.write(dim(`  worktree ${bannerGit.isRepository ? `${bannerGit.branch ?? "detached"} @ ${(bannerGit.head ?? "unborn").slice(0, 7)} · ${bannerGit.changedFiles.length ? `${bannerGit.changedFiles.length} changed` : "clean"}` : "not a git repository"}\n`));
    stdout.write(dim(`  session  ${sessionState}${recoveryBlocked ? " · RECOVERY PAUSED (no replay)" : ""}\n`));
    stdout.write(dim(`  keys     /help · Ctrl-C cancel · /yolo auto-approve · /exit quit\n`));
    if (approvals.yolo) stdout.write(dim(`  mode     ⚠ YOLO auto-approve (credentials stay blocked)\n`));
    flushStartupNotices();
    const initialBlockers = stateStore.listActiveBlockers(kernel.sessionId!);
    const initialBlockedTasks = stateStore.listTasks(kernel.sessionId!).filter((task) => task.status === "blocked");
    if (initialPrompt && recoveryBlocked) {
      console.error("Initial task was not sent: this resumed session has an unresolved execution outcome. Type /clear to start a fresh session, or /recovery to inspect details.");
    } else if (initialPrompt && (initialBlockers.length || (initialBlockedTasks.length && !stateStore.listTasks(kernel.sessionId!).some((task) => task.status === "in_progress")))) {
      console.error(`Initial task was not sent: the session has unresolved blocker(s). Type /blocker clear REVISION or /task start ID to resolve, then ask again.`);
    } else if (initialPrompt) {
      await runPrompt(initialPrompt);
    }

    while (true) {
      const line = await input.question("\n> ");
      const command = line.trim();
      if (command === "/exit") break;
      if (command === "/help") {
        stdout.write(helpText);
      } else if (command === "/status") {
        stdout.write(`session ${kernel.sessionId ?? "unknown"}${recoveryBlocked ? " (paused for recovery)" : ""}\n`);
        stdout.write(`model ${selection.alias} (${selection.providerId}/${selection.model})\n`);
        stdout.write(`context ${selection.contextWindow}; input cap ${selection.maxInputTokens ?? "not separately capped"}; reserved output ${selection.reservedOutputTokens}; safety margin ${selection.safetyMarginTokens}; prompt cap ${promptLimitForModel(selection)}\n`);
      } else if (command === "/recovery") {
        const unknownRuns = stateStore.listRuns(kernel.sessionId!).filter((run) => run.status === "unknown");
        stdout.write(formatRecoveryReport({
          executions: stateStore.listUnresolvedExecutionDetails(kernel.sessionId!),
          unknownRunIds: unknownRuns.map((run) => run.runId),
          ...(repositoryIdentityIssue ? { repositoryIdentityIssue } : {}),
        }));
      } else if (command === "/models") {
        const aliases = await listTrustedModelAliases(globalConfigPath);
        stdout.write(`Trusted models${selection.alias ? ` (current: ${selection.alias})` : ""}: ${aliases.join(", ") || "none"}\n`);
      } else if (command === "/model") {
        stdout.write(`${selection.alias}: ${selection.providerId}/${selection.model} (${selection.contextWindow} context, ${selection.maxOutputTokens} max output)\n`);
      } else if (command === "/settings") {
        stdout.write(`Global config: ${globalConfigPath}\nProject config: ${join(cwd, ".macus", "config.yaml")}\n`);
        stdout.write(`Model: ${selection.alias} (${selection.providerId}/${selection.model}); aliasSource=${selection.aliasSource}; profile=${selection.profile}; endpoint/credential=global trusted config\n`);
        stdout.write(`Limits: context=${selection.contextWindow}; maxInput=${selection.maxInputTokens ?? "unset"}; maxOutput=${selection.maxOutputTokens}; reservedOutput=${selection.reservedOutputTokens}; safetyMargin=${selection.safetyMarginTokens}; promptCap=${promptLimitForModel(selection)}\n`);
        stdout.write(`Execution: commandTimeoutMs=${selection.execution.commandTimeoutMs}; testBuildTimeoutMs=${selection.execution.testBuildTimeoutMs}; terminationGraceMs=${selection.execution.terminationGraceMs}; maxOutputMemoryBytes=${selection.execution.maxOutputMemoryBytes}; maxLogBytes=${selection.execution.maxLogBytes}; environmentAllowlist=${selection.execution.environmentAllowlist.join(",")}\n`);
        stdout.write(`Logs: retentionDays=${selection.logs.retentionDays}; maxTotalBytes=${selection.logs.maxTotalBytes}\n`);
        stdout.write(`Features: repo_map=${selection.features.repoMap}; code_graph=${selection.features.codeGraph}; context_ledger=${selection.features.contextLedger}; checkpoint=${selection.features.checkpoint}; git_context=${selection.features.gitContext}; task_engine=${selection.features.taskEngine}; auto_compaction=false\n`);
        stdout.write("Credentials and provider URLs are intentionally not displayed. Settings editing is not available; edit the user-owned YAML files directly.\n");
      } else if (command.startsWith("/model ")) {
        const alias = command.slice("/model ".length).trim();
        if (!alias || recoveryBlocked) {
          stdout.write(recoveryBlocked ? "Model switching is disabled while execution recovery is unresolved.\n" : "Usage: /model ALIAS\n");
        } else {
          try {
            const nextSelection = await loadTrustedModelSelection({ globalPath: globalConfigPath, projectPath: join(cwd, ".macus", "config.yaml"), modelAlias: alias });
            const previousSelection = selection;
            const resumeSessionId = kernel.sessionId;
            const previousManifest = kernel.lastRequestManifest;
            await kernel.dispose();
            selection = nextSelection;
            kernel = newKernel();
            try {
              await kernel.start(resumeSessionId ? { sessionId: resumeSessionId } : {});
              kernel.inheritLastRequestManifest(previousManifest);
              await registerSessionIdentity();
              stdout.write(`Switched this session to ${selection.alias} (${selection.providerId}/${selection.model}); trusted configuration was not modified.\n`);
            } catch (error) {
              await kernel.dispose();
              selection = previousSelection;
              kernel = newKernel();
              await kernel.start(resumeSessionId ? { sessionId: resumeSessionId } : {});
              kernel.inheritLastRequestManifest(previousManifest);
              await registerSessionIdentity();
              throw error;
            }
          } catch (error) {
            stdout.write(`Model switch failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
          }
        }
      } else if (command === "/context files") {
        const manifest = kernel.lastRequestManifest;
        if (!manifest) stdout.write("No provider request has been dispatched yet.\n");
        else {
          stdout.write(`Request ${manifest.requestId} — ${manifest.modelId} — ${manifest.sessionId ?? "unknown session"}\n`);
          stdout.write(`Effective payload SHA-256: ${manifest.payloadSha256}\n`);
          stdout.write("Included repository instructions:\n");
          if (!manifest.includedInstructions.length) stdout.write("  none\n");
          for (const instruction of manifest.includedInstructions) stdout.write(`  ${instruction.path} ${instruction.reason} sha256=${instruction.sourceSha256} ~${instruction.estimatedTokens} tokens\n`);
          stdout.write("Included fragments:\n");
          if (!manifest.includedFragments.length) stdout.write("  none\n");
          for (const fragment of manifest.includedFragments) stdout.write(`  ${fragment.path}:${fragment.startLine}-${fragment.endLine} ${fragment.tier} ${fragment.reason} ${fragment.freshness} sha256=${fragment.sourceSha256} ~${fragment.estimatedTokens} tokens\n`);
          stdout.write("Omitted fragments:\n");
          if (!manifest.omittedFragments.length) stdout.write("  none\n");
          for (const fragment of manifest.omittedFragments) stdout.write(`  ${fragment.path} ${fragment.reason}: ${fragment.detail}\n`);
        }
      } else if (command === "/context") {
        const manifest = kernel.lastRequestManifest;
        if (!manifest) {
          stdout.write("No provider request has been dispatched yet.\n");
        } else {
          stdout.write(`Last request ${manifest.requestId} at ${manifest.createdAt} — ${manifest.modelId} — session ${manifest.sessionId ?? "unknown"}\n`);
          stdout.write(`Estimated prompt ${manifest.estimatedPromptTokens}/${manifest.promptLimitTokens}; model context ${manifest.contextWindowTokens}; max input ${manifest.maxInputTokens ?? "not separately capped"}; reserved output ${manifest.reservedOutputTokens}; safety margin ${manifest.safetyMarginTokens}\n`);
          stdout.write(`Estimate: ${manifest.estimationMethod}\n`);
          stdout.write(`Effective payload SHA-256: ${manifest.payloadSha256}\n`);
          stdout.write(`Included repository instructions: ${manifest.includedInstructions.length}\n`);
          stdout.write(`Categories (estimated tokens): ${Object.entries(manifest.categories).map(([key, value]) => `${key}=${value}`).join(" ")}\n`);
          stdout.write("Provider-reported usage: unavailable\n");
        }
        stdout.write(`Next-request limit: ${promptLimitForModel(selection)} tokens (prospective cap; not an exact estimate).\n`);
      } else if (command === "/compact" && recoveryBlocked) {
        stdout.write("Compaction is disabled while this session has unresolved execution outcomes. Use /clear or resume a different session.\n");
      } else if (command === "/compact") {
        try {
          const checkpoint = selection.features.checkpoint
            ? await createDurableCheckpoint({ root: cwd, sessionId: kernel.sessionId!, stateStore, includeContextLedger: selection.features.contextLedger, ...(kernel.transcriptEntryId ? { transcriptEntryId: kernel.transcriptEntryId } : {}) })
            : undefined;
          const compactionState = checkpoint?.payload ?? {
            goal: stateStore.listLedgerRevisions(kernel.sessionId!).reverse().find((revision) => (revision.payload as { kind?: unknown })?.kind === "goal")?.payload,
            tasks: stateStore.listTasks(kernel.sessionId!),
            blockers: stateStore.listActiveBlockers(kernel.sessionId!),
            currentEvidence: stateStore.listTestEvidence(kernel.sessionId!).slice(-16),
            unresolvedExecutions: stateStore.listUnresolvedExecutions(kernel.sessionId!),
            nextAction: stateStore.listLedgerRevisions(kernel.sessionId!).reverse().find((revision) => (revision.payload as { kind?: unknown })?.kind === "next-action")?.payload,
          };
          const result = await kernel.compact(buildCompactionInstructions(compactionState));
          stdout.write(`${checkpoint ? `Checkpoint ${checkpoint.checkpointId} saved. ` : "Checkpoint feature disabled; core execution recovery remains active. "}Compaction complete: estimated ${result.tokensBefore} tokens before, ${result.estimatedTokensAfter ?? "unknown"} after.\n`);
        } catch (error) {
          stdout.write(`Compaction stopped because a durable checkpoint could not be completed: ${error instanceof Error ? error.message : "unknown error"}\n`);
        }
      } else if (command.startsWith("/checkpoint") && !selection.features.checkpoint) {
        stdout.write("Checkpoint feature is disabled by trusted configuration; core session and execution recovery remain active.\n");
      } else if (command === "/checkpoint") {
        const checkpoints = stateStore.listCheckpoints(kernel.sessionId!);
        if (!checkpoints.length) stdout.write("No checkpoints in this session. Create one with /checkpoint create.\n");
        for (const checkpoint of checkpoints) stdout.write(`${checkpoint.checkpointId} revision=${checkpoint.stateRevision} created=${checkpoint.createdAt}\n`);
      } else if (command === "/checkpoint create") {
        try {
          const checkpoint = await createDurableCheckpoint({ root: cwd, sessionId: kernel.sessionId!, stateStore, includeContextLedger: selection.features.contextLedger, ...(kernel.transcriptEntryId ? { transcriptEntryId: kernel.transcriptEntryId } : {}) });
          stdout.write(`Checkpoint ${checkpoint.checkpointId} saved at state revision ${checkpoint.stateRevision}. Checkpoints restore agent state only; source files and shell side effects are not rolled back.\n`);
        } catch (error) {
          stdout.write(`Checkpoint failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
        }
      } else if (command.startsWith("/checkpoint restore ")) {
        const checkpointId = command.slice("/checkpoint restore ".length).trim();
        if (!checkpointId || recoveryBlocked) {
          stdout.write(recoveryBlocked ? "Checkpoint restore is disabled while execution recovery is unresolved.\n" : "Usage: /checkpoint restore CHECKPOINT_ID\n");
        } else {
          try {
            const checkpoint = stateStore.getCheckpoint(kernel.sessionId!, checkpointId, cwd);
            if (checkpoint.payload.gitDirectory !== gitDirectory) throw new Error("Checkpoint Git directory identity does not match the current worktree");
            const reconciliation = await reconcileDurableCheckpoints({ root: cwd, sessionId: kernel.sessionId!, stateStore });
            if (reconciliation.missingRegisteredFiles.includes(checkpointId)) throw new Error("Checkpoint file is missing or invalid; it was not restored");
            const checkpointFiles = Array.isArray(checkpoint.payload.changedFiles)
              ? checkpoint.payload.changedFiles.filter((item): item is { path: string; sha256: string | null } => typeof item === "object" && item !== null && "path" in item && typeof item.path === "string" && "sha256" in item && (typeof item.sha256 === "string" || item.sha256 === null))
              : [];
            const verification = await verifyCheckpointSources(cwd, checkpointFiles);
            const currentSnapshot = await readGitContext(cwd);
            const snapshotChanged = typeof checkpoint.payload.snapshotDigest !== "string" || checkpoint.payload.snapshotDigest !== currentSnapshot.snapshotDigest;
            const transcriptEntryId = checkpoint.payload.transcriptEntryId;
            if (typeof transcriptEntryId !== "string" || !transcriptEntryId) throw new Error("Checkpoint has no Pi transcript entry; agent state cannot be restored");
            if (!Array.isArray(checkpoint.payload.tasks)) throw new Error("Checkpoint has no valid task snapshot; it was not restored");
            await kernel.restoreTranscriptEntry(transcriptEntryId);
            stateStore.restoreTaskSnapshot(kernel.sessionId!, checkpoint.payload.tasks);
            const stalePaths = [...new Set([
              ...verification.stalePaths,
              ...verification.unverifiedPaths,
              ...(snapshotChanged ? stateStore.listWorkingSet(kernel.sessionId!).map((entry) => entry.path) : []),
            ])];
            for (const path of stalePaths) stateStore.markWorkingSetStale(kernel.sessionId!, path);
            if (stalePaths.length || snapshotChanged) stateStore.invalidateTestEvidence(kernel.sessionId!, `Checkpoint restore found snapshot mismatch or changed/unverified files: ${stalePaths.slice(0, 20).join(", ")}`);
            stateStore.appendLedgerRevision(kernel.sessionId!, { kind: "checkpoint-restored", checkpointId, snapshotChanged, stalePaths, sourceBytesRestored: false });
            stdout.write(`Restored agent transcript and checkpoint task state to ${checkpointId}. Snapshot changed=${snapshotChanged}; ${stalePaths.length} file(s) marked stale; later tasks were retained; source files and shell side effects were not rolled back.\n`);
          } catch (error) {
            stdout.write(`Checkpoint restore failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
          }
        }
      } else if (command === "/map") {
        if (!selection.features.repoMap) stdout.write("Repository map is disabled by trusted configuration.\n");
        else if (selection.contextBudgets?.repoMapTokens === 0) stdout.write("Repository map budget is set to zero by trusted configuration.\n");
        else {
          const map = await buildRepositoryMap({ root: cwd, ...(selection.contextBudgets?.repoMapTokens !== undefined ? { tokenBudget: selection.contextBudgets.repoMapTokens } : {}) });
          stdout.write(`${map.text}\n`);
        }
      } else if (command.startsWith("/search ")) {
        const result = await searchCode({ root: cwd, query: command.slice("/search ".length), limit: 25 });
        stdout.write(`Search ${result.status}${result.truncated ? " (truncated; more results available)" : ""}\n`);
        for (const match of result.matches) stdout.write(`${match.path}:${match.line}: ${match.text}\n`);
        if (result.error) stdout.write(`${result.error}\n`);
      } else if (command.startsWith("/symbol ")) {
        const index = await buildSymbolIndex(cwd);
        const result = searchSymbols(index, { query: command.slice("/symbol ".length), limit: 50 });
        stdout.write(`Index cache: ${index.cacheStatus}; partial files: ${index.coverage.filter((entry) => entry.status === "partial").length}; unsupported files: ${index.coverage.filter((entry) => entry.status === "unsupported").length}\n`);
        stdout.write(`${result.matches.length ? (result.ambiguous ? "Ambiguous symbol candidates" : "Symbol match") : "No symbols found"}\n`);
        for (const symbol of result.matches) stdout.write(`${symbol.id} ${symbol.path}:${symbol.startLine}-${symbol.endLine} ${symbol.signature}\n`);
      } else if (command === "/diff") {
        const context = selection.features.gitContext ? await readGitContext(cwd) : undefined;
        if (!context) stdout.write("Git context is disabled by trusted configuration.\n");
        else if (!context.isRepository) stdout.write("This worktree is not inside a Git repository.\n");
        else {
          stdout.write(`Branch: ${context.branch ?? "detached"}; HEAD: ${context.head ?? "unborn"}\n`);
          stdout.write(`Working snapshot: ${context.snapshotDigest}\n`);
          for (const file of context.changedFiles) stdout.write(`${file.status} ${file.path}\n`);
          stdout.write(context.diff || "No tracked-file diff.\n");
          if (context.diffTruncated) stdout.write("Diff truncated at 256 KiB.\n");
        }
      } else if (command.startsWith("/git ")) {
        const [, action, ...arguments_] = command.split(/\s+/);
        const operationMap: Record<string, GitInspectionOperation> = { diff: "diff", log: "log", show: "show", blame: "blame" };
        const operation = operationMap[action ?? ""];
        if (!selection.features.gitContext) stdout.write("Git context is disabled by trusted configuration.\n");
        else if (!operation) stdout.write("Usage: /git diff [PATH] | log [PATH] | show [REVISION] | blame PATH [START [END]]\n");
        else if (recoveryBlocked) stdout.write("Git inspection is paused while this session has unresolved execution outcomes.\n");
        else {
          const path = operation === "blame" ? arguments_[0] : operation === "diff" || operation === "log" ? arguments_[0] : undefined;
          const revision = operation === "show" ? arguments_[0] : undefined;
          const startLine = operation === "blame" && arguments_[1] ? Number(arguments_[1]) : undefined;
          const endLine = operation === "blame" && arguments_[2] ? Number(arguments_[2]) : undefined;
          const executionId = randomUUID();
          stateStore.prepareExecution({ executionId, sessionId: kernel.sessionId!, toolCallId: `cli-git-${executionId}`, effectClass: "read", redactedInput: { operation: "git_inspect", gitOperation: operation, path, revision, startLine, endLine } });
          stateStore.recordExecutionEvent(executionId, "started", {});
          try {
            const result = await inspectGit({ root: cwd, operation, ...(path ? { path } : {}), ...(revision ? { revision } : {}), ...(startLine !== undefined ? { startLine } : {}), ...(endLine !== undefined ? { endLine } : {}) });
            stateStore.recordExecutionEvent(executionId, "completed", { truncated: result.truncated, outputBytes: Buffer.byteLength(result.output, "utf8") });
            stdout.write(result.output || "No Git output for this operation.\n");
            if (result.truncated) stdout.write("[Git output truncated at 32 KiB]\n");
          } catch (error) {
            stateStore.recordExecutionEvent(executionId, "failed", { reason: error instanceof Error ? error.message.slice(0, 300) : "Git inspection failed" });
            stdout.write(`${error instanceof Error ? error.message : "Git inspection failed"}\n`);
          }
        }
      } else if (command.startsWith("/test ")) {
        const match = command.slice("/test ".length).match(/^(node-json|junit|trx|unknown)(?:\s+(\S+))?\s+--\s+([\s\S]+)$/);
        if (!match || !match[3] || ((match[1] === "junit" || match[1] === "trx") && !match[2])) {
          stdout.write("Usage: /test node-json|unknown -- COMMAND  |  /test junit|trx REPORT_PATH -- COMMAND\n");
        } else if (recoveryBlocked) {
          stdout.write("Tests are disabled while this session has an unresolved execution outcome.\n");
        } else {
          const testResult = await runTestCommand({
            root: cwd,
            sessionId: kernel.sessionId!,
            ...(kernel.currentRunId ? { runId: kernel.currentRunId } : {}),
            command: match[3],
            ...(match[1] !== "node-json" && match[2] ? { reportPath: match[2] } : {}),
            format: match[1] as "node-json" | "junit" | "trx" | "unknown",
            stateStore,
            execution: selection.execution,
            logs: selection.logs,
            ...(selection.protectedCredentialEnvironmentNames.length ? { protectedCredentialEnvironmentNames: selection.protectedCredentialEnvironmentNames } : {}),
            ...(selection.credentialEnvironmentNames.length ? { credentialEnvironmentNames: selection.credentialEnvironmentNames } : {}),
            authorize: (request) => authorizeCommand(`${request.command}\nWorking directory: ${request.cwd}\nTimeout: ${request.timeoutMs} ms`, selection.credentialEnvironmentNames, request.signal),
          });
          stdout.write(`Test evidence ${testResult.evidenceId}: ${testResult.evidence.status} (${testResult.evidence.tests ?? "unknown"} tests, ${testResult.evidence.passed ?? "unknown"} passed, ${testResult.evidence.failed ?? "unknown"} failed).\n`);
          if (testResult.evidence.reason) stdout.write(`${testResult.evidence.reason}\n`);
          stdout.write(`Snapshot: ${testResult.evidence.snapshotDigest}\n`);
          if (testResult.result.logRef) stdout.write(`Execution log: ${testResult.result.logRef}${testResult.result.logTruncated ? " (per-execution cap reached)" : ""}\n`);
        }
      } else if (command === "/review") {
        const context = await readGitContext(cwd);
        const latestTestExecutionId = stateStore.getLatestTestBuildExecutionId(kernel.sessionId!);
        stdout.write(formatReviewReport({
          context,
          evidence: stateStore.listTestEvidence(kernel.sessionId!),
          ...(latestTestExecutionId ? { latestTestExecutionId } : {}),
          unresolvedExecutions: stateStore.listUnresolvedExecutions(kernel.sessionId!),
          runs: stateStore.listRuns(kernel.sessionId!),
          tasks: stateStore.listTasks(kernel.sessionId!),
          ledger: stateStore.listLedgerRevisions(kernel.sessionId!),
        }));
      } else if (command === "/search" || command === "/symbol") {
        stdout.write("Provide a non-empty query.\n");
      } else if (command === "/tasks") {
        if (!selection.features.taskEngine) stdout.write("Task engine is disabled by trusted configuration; core session recovery remains active.\n");
        else {
          const tasks = stateStore.listTasks(kernel.sessionId!);
          const evidence = new Map(stateStore.listTestEvidence(kernel.sessionId!).map((item) => [item.evidenceId, item]));
          const blockers = tasks.filter((task) => task.status === "blocked");
          const recordedBlockers = stateStore.listActiveBlockers(kernel.sessionId!);
          stdout.write(`Progress: ${tasks.filter((task) => task.status === "completed").length}/${tasks.length} completed; ${tasks.filter((task) => task.status === "in_progress").length} in progress; ${blockers.length + recordedBlockers.length} blocker(s) recorded.\n`);
          stdout.write("Blockers:\n");
          if (!blockers.length && !recordedBlockers.length) stdout.write("  none\n");
          for (const task of blockers) stdout.write(`  ${task.id} ${task.title}${task.notes.length ? ` — ${task.notes.at(-1)}` : ""}\n`);
          for (const blocker of recordedBlockers) stdout.write(`  ledger revision ${blocker.revision}: ${blocker.text} (resolve with /blocker clear ${blocker.revision})\n`);
          if (tasks.length === 0) stdout.write("No tasks in this session. Add one with /task add TEXT.\n");
          for (const task of tasks) {
            stdout.write(`[${task.status}] ${task.id} ${task.title}${task.relatedFiles.length ? ` — ${task.relatedFiles.join(", ")}` : ""}\n`);
            if (task.relatedSymbols.length) stdout.write(`  Related symbols: ${task.relatedSymbols.join(", ")}\n`);
            if (task.notes.length) stdout.write(`  Latest progress: ${task.notes.at(-1)}\n`);
            if (task.evidenceIds.length) stdout.write(`  Evidence: ${task.evidenceIds.map((id) => `${id}=${evidence.get(id)?.status ?? "unavailable"}`).join(", ")}\n`);
            else stdout.write("  Evidence: none recorded (task status does not imply tests ran or passed)\n");
          }
        }
      } else if (command === "/goal") {
        if (!selection.features.contextLedger) { stdout.write("Context ledger is disabled by trusted configuration.\n"); continue; }
        const goal = [...stateStore.listLedgerRevisions(kernel.sessionId!)].reverse().find((revision) => typeof revision.payload === "object" && revision.payload !== null && (revision.payload as { kind?: unknown }).kind === "goal");
        const value = goal && typeof goal.payload === "object" && goal.payload !== null ? (goal.payload as { text?: unknown }).text : undefined;
        stdout.write(goal && typeof value === "string" ? `Current goal (revision ${goal.revision}): ${value}\n` : "No durable goal recorded. Set one with /goal set TEXT.\n");
      } else if (command.startsWith("/goal set ")) {
        if (!selection.features.contextLedger) { stdout.write("Context ledger is disabled by trusted configuration.\n"); continue; }
        try {
          const revision = stateStore.recordWorkflowNote(kernel.sessionId!, "goal", command.slice("/goal set ".length));
          stdout.write(`Goal recorded at ledger revision ${revision.revision}.\n`);
        } catch (error) { stdout.write(`${error instanceof Error ? error.message : "Unable to record goal"}\n`); }
      } else if (command.startsWith("/decision ")) {
        if (!selection.features.contextLedger) { stdout.write("Context ledger is disabled by trusted configuration.\n"); continue; }
        try {
          const revision = stateStore.recordWorkflowNote(kernel.sessionId!, "decision", command.slice("/decision ".length));
          stdout.write(`Decision recorded at ledger revision ${revision.revision}.\n`);
        } catch (error) { stdout.write(`${error instanceof Error ? error.message : "Unable to record decision"}\n`); }
      } else if (command.startsWith("/next-action ")) {
        if (!selection.features.contextLedger) { stdout.write("Context ledger is disabled by trusted configuration.\n"); continue; }
        try {
          const revision = stateStore.recordWorkflowNote(kernel.sessionId!, "next-action", command.slice("/next-action ".length));
          stdout.write(`Next action recorded at ledger revision ${revision.revision}.\n`);
        } catch (error) { stdout.write(`${error instanceof Error ? error.message : "Unable to record next action"}\n`); }
      } else if (command.startsWith("/blocker ")) {
        if (!selection.features.contextLedger) { stdout.write("Context ledger is disabled by trusted configuration.\n"); continue; }
        try {
          const blockerCommand = command.slice("/blocker ".length).trim();
          const clear = blockerCommand.match(/^clear\s+(\d+)$/);
          if (clear) {
            const revision = stateStore.resolveWorkflowBlocker(kernel.sessionId!, Number(clear[1]));
            stdout.write(`Blocker resolved at ledger revision ${revision.revision}. New coding runs may continue.\n`);
          } else {
            const revision = stateStore.recordWorkflowNote(kernel.sessionId!, "blocker", blockerCommand);
            stdout.write(`Blocker recorded at ledger revision ${revision.revision}. New coding prompts are paused until resolved with /blocker clear ${revision.revision}.\n`);
          }
        } catch (error) { stdout.write(`${error instanceof Error ? error.message : "Unable to record blocker"}\n`); }
      } else if (command.startsWith("/task add ")) {
        if (!selection.features.taskEngine) { stdout.write("Task engine is disabled by trusted configuration.\n"); continue; }
        const title = command.slice("/task add ".length).trim();
        if (!title) stdout.write("Task title must not be empty.\n");
        else {
          const task = stateStore.createTask({ sessionId: kernel.sessionId!, title });
          stdout.write(`Added task ${task.id}: ${task.title}\n`);
        }
      } else if (command.startsWith("/task ")) {
        if (!selection.features.taskEngine) { stdout.write("Task engine is disabled by trusted configuration.\n"); continue; }
        const [, action, taskId] = command.split(/\s+/, 3);
        const statuses = { start: "in_progress", complete: "completed", block: "blocked", reopen: "pending", skip: "skipped" } as const;
        if (!action || !taskId || !(action in statuses)) {
          stdout.write("Usage: /task start|complete|block|reopen|skip TASK_ID\n");
        } else {
          try {
            const task = stateStore.transitionTask(kernel.sessionId!, taskId, statuses[action as keyof typeof statuses]);
            stdout.write(`Task ${task.id}: ${task.status} — ${task.title}\n`);
          } catch (error) {
            stdout.write(`${error instanceof Error ? error.message : "Unable to update task"}\n`);
          }
        }
      } else if (command === "/yolo") {
        approvals.setYolo(!approvals.yolo);
        stdout.write(approvals.yolo
          ? "⚠ YOLO enabled: model-requested commands run without approval (credentials stay blocked; writes still require hash matches). Type /yolo to disable.\n"
          : "YOLO disabled: commands ask for approval again.\n");
      } else if (command === "/clear") {
        approvals.reset();
        await kernel.dispose();
        kernel = newKernel();
        await kernel.start();
        await registerSessionIdentity();
        flushStartupNotices();
        stdout.write(`Started a new session ${kernel.sessionId}; previous sessions and source files were preserved.\n`);
      } else if (command === "/resume" || command.startsWith("/resume ")) {
        const sessionId = command.slice("/resume".length).trim();
        approvals.reset();
        await kernel.dispose();
        kernel = newKernel();
        await kernel.start(sessionId ? { sessionId } : { resumeRecent: true });
        await registerSessionIdentity(true);
        flushStartupNotices();
        stdout.write(`Resumed session ${kernel.sessionId}${recoveryBlocked ? " in paused recovery state" : ""}.\n`);
      } else if (/^\/(?:settings|resume|clear|context|checkpoint|map|search|symbol|test|review|goal|decision|next-action|blocker)(?:\s|$)/.test(command)) {
        stdout.write(`Command ${command.split(/\s/, 1)[0]} is not available in this preview yet.\n`);
      } else if (command) {
        if (recoveryBlocked) {
          stdout.write("⚠ Paused: a prior execution in this session has an unknown outcome; Macus will not replay it. Type /clear to start a fresh session, or /recovery to inspect details.\n");
        } else {
          const blockers = stateStore.listActiveBlockers(kernel.sessionId!);
          const tasks = stateStore.listTasks(kernel.sessionId!);
          const blockedTasks = tasks.filter((task) => task.status === "blocked");
          if (blockers.length) stdout.write(`Coding prompt paused by blocker(s): ${blockers.map((item) => `revision ${item.revision} (${item.text})`).join("; ")}. Resolve with /blocker clear REVISION.\n`);
          else if (blockedTasks.length && !tasks.some((task) => task.status === "in_progress")) stdout.write(`Coding prompt paused by blocked task(s): ${blockedTasks.map((task) => `${task.id} ${task.title}`).join("; ")}. Use /task reopen ID or /task start ID after resolving the blocker.\n`);
          else await runPrompt(command);
        }
      }
    }
  } finally {
    process.off("SIGINT", onInterrupt);
    input?.close();
    await kernel?.dispose();
    stateStore.close();
    releaseMutationLock?.();
  }
}

if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))) {
  try {
    const result = await runCli(process.argv.slice(2), {
      version: "0.1.0",
      write: (text) => stdout.write(text),
      startSession: startInteractiveSession,
    });
    process.exitCode = result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown startup error";
    process.stderr.write(`macus: ${message}\n`);
    process.exitCode = 1;
  }
}
