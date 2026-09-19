import { spawn } from "node:child_process";
import { ExecutionLogStore } from "./execution-log-store.js";
import { readGitContext } from "../workflow/git-context.js";

export interface CommandRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  allowedEnvironment: string[];
  signal?: AbortSignal;
  terminationGraceMs?: number;
  identity?: {
    executionId: string;
    sessionId: string;
    runId?: string;
    toolCallId?: string;
    effectClass: "read" | "workspace-write" | "test-build" | "external" | "destructive";
  };
}

export interface ExecutionJournal {
  prepareExecution(input: {
    executionId: string;
    sessionId: string;
    runId?: string;
    toolCallId?: string;
    redactedInput: unknown;
    effectClass: "read" | "workspace-write" | "test-build" | "external" | "destructive";
  }): void;
  recordExecutionEvent(executionId: string, status: string, payload: unknown): void;
  recordSourceChange?(input: {
    sessionId: string;
    path: string;
    oldSha256: string | null;
    newSha256: string | null;
    attribution: "external_or_unknown";
    reason: string;
  }): unknown;
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  outputComplete: boolean;
  cancelled: boolean;
  timedOut: boolean;
  logRef?: string;
  logTruncated?: boolean;
}

export interface ExecutionAuthorizationDecision {
  approved: boolean;
  authorizedEnvironmentNames?: readonly string[];
}

export type ExecutionAuthorization = boolean | ExecutionAuthorizationDecision;

export interface PolicyExecutorOptions {
  authorize: (request: Readonly<CommandRequest>) => ExecutionAuthorization | Promise<ExecutionAuthorization>;
  maxOutputBytes?: number;
  deniedEnvironmentNames?: readonly string[];
  authorizableEnvironmentNames?: readonly string[];
  journal?: ExecutionJournal;
  logStore?: ExecutionLogStore;
}

const MAX_RETAINED_OUTPUT_BYTES = 8 * 1024 * 1024;

export function redactExecutionText(value: string): string {
  return value
    .replace(/(--?(?:api[-_]?key|token|secret|password)(?:=|\s+))[^\s]+/gi, "$1[REDACTED]")
    .replace(/\b([A-Z_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))=([^\s]+)/gi, "$1=[REDACTED]");
}

/** Executes shell commands only after explicit policy approval. This is not an OS sandbox. */
export class PolicyExecutor {
  private readonly maxOutputBytes: number;

  constructor(private readonly options: PolicyExecutorOptions) {
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_RETAINED_OUTPUT_BYTES;
    if (!Number.isSafeInteger(this.maxOutputBytes) || this.maxOutputBytes < 1 || this.maxOutputBytes > MAX_RETAINED_OUTPUT_BYTES) {
      throw new Error(`maxOutputBytes must be between 1 and ${MAX_RETAINED_OUTPUT_BYTES}`);
    }
  }

  async execute(request: CommandRequest): Promise<CommandResult> {
    if (!request.command.trim()) throw new Error("command must not be empty");
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 600_000) {
      throw new Error("timeoutMs must be between 1 and 600000 milliseconds");
    }
    if (request.signal?.aborted) throw new Error("command cancelled before authorization");
    const decision = await this.options.authorize(Object.freeze({ ...request }));
    const approved = typeof decision === "boolean" ? decision : decision.approved;
    const explicitlyAuthorizedEnvironmentNames = typeof decision === "boolean" ? [] : [...new Set(decision.authorizedEnvironmentNames ?? [])];
    const authorizableEnvironmentNames = new Set(this.options.authorizableEnvironmentNames ?? []);
    if (explicitlyAuthorizedEnvironmentNames.some((name) => !authorizableEnvironmentNames.has(name))) {
      throw new Error("Authorization requested an environment variable outside the trusted credential set");
    }
    if (!approved) {
      throw new Error("command denied by policy");
    }
    if (request.signal?.aborted) throw new Error("command cancelled before launch");

    if (this.options.journal && !request.identity) {
      throw new Error("Execution identity is required when journaling is enabled");
    }
    const identity = request.identity;
    const redactedCommand = redactExecutionText(request.command);
    const effectiveEnvironmentAllowlist = [...new Set([...request.allowedEnvironment, ...explicitlyAuthorizedEnvironmentNames])];
    const commandSecrets = [
      ...Array.from(request.command.matchAll(/--?(?:api[-_]?key|token|secret|password)(?:=|\s+)["']?([^\s"']+)/gi), (match) => match[1]!),
      ...Array.from(request.command.matchAll(/\b[A-Z_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)=([^\s]+)/gi), (match) => match[1]!),
    ];
    if (this.options.journal && identity) {
      this.options.journal.prepareExecution({
        ...identity,
        redactedInput: { command: redactedCommand, cwd: request.cwd, allowedEnvironment: effectiveEnvironmentAllowlist },
      });
    }

    const env: NodeJS.ProcessEnv = {};
    const secrets: string[] = [];
    const deniedEnvironmentNames = new Set(this.options.deniedEnvironmentNames ?? []);
    const authorizedNames = new Set(explicitlyAuthorizedEnvironmentNames);
    for (const key of effectiveEnvironmentAllowlist) {
      if (deniedEnvironmentNames.has(key) && !authorizedNames.has(key)) continue;
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && process.env[key] !== undefined) {
        env[key] = process.env[key];
        if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key) && process.env[key]) {
          secrets.push(process.env[key]!);
        }
      }
    }
    const log = identity && this.options.logStore
      ? await this.options.logStore.create(identity.sessionId, identity.executionId, [...secrets, ...commandSecrets])
      : undefined;
    const beforeGit = identity && this.options.journal?.recordSourceChange
      ? await readGitContext(request.cwd)
      : undefined;
    if (request.signal?.aborted) {
      await log?.abort();
      if (identity) this.options.journal?.recordExecutionEvent(identity.executionId, "failed", { reason: "cancelled before process launch" });
      throw new Error("command cancelled before launch");
    }
    const child = spawn(request.command, {
      cwd: request.cwd,
      env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const childOutcome = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; error?: Error }>((resolveOutcome) => {
      child.once("error", (error) => resolveOutcome({ exitCode: null, signal: null, error }));
      child.once("close", (exitCode, signal) => resolveOutcome({ exitCode, signal }));
    });
    const signalChild = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* process may have exited */ }
    };
    try {
      if (identity) this.options.journal?.recordExecutionEvent(identity.executionId, "started", { pid: child.pid ?? null });
    } catch (error) {
      signalChild("SIGKILL");
      await childOutcome;
      if (identity) {
        try { this.options.journal?.recordExecutionEvent(identity.executionId, "unknown", { reason: "journal acknowledgement failed after process launch" }); }
        catch { /* the original journal failure remains authoritative to the caller */ }
      }
      throw error;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let retainedBytes = 0;
    let outputComplete = true;
    const capture = (target: Buffer[], chunk: Buffer) => {
      const remaining = this.maxOutputBytes - retainedBytes;
      if (remaining <= 0) {
        outputComplete = false;
        return;
      }
      const kept = chunk.subarray(0, remaining);
      target.push(kept);
      retainedBytes += kept.length;
      if (kept.length < chunk.length) outputComplete = false;
    };
    let logWrites = Promise.resolve();
    let logFailure: unknown;
    const captureStream = (stream: "stdout" | "stderr", target: Buffer[]) => (chunk: Buffer) => {
      capture(target, chunk);
      if (!log) return;
      logWrites = log.append(stream, chunk).catch((error: unknown) => {
        logFailure = error;
        outputComplete = false;
        try { child.kill("SIGTERM"); } catch { /* process may have exited */ }
      });
      if (log.pendingBytes > 1024 * 1024) { child.stdout.pause(); child.stderr.pause(); }
      void logWrites.then(() => {
        if (log.pendingBytes < 256 * 1024) { child.stdout.resume(); child.stderr.resume(); }
      });
    };
    child.stdout.on("data", captureStream("stdout", stdout));
    child.stderr.on("data", captureStream("stderr", stderr));

    let timedOut = false;
    let cancelled = false;
    let terminationTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      outputComplete = false;
      signalChild("SIGTERM");
      terminationTimer = setTimeout(() => {
        signalChild("SIGKILL");
      }, request.terminationGraceMs ?? 250);
      terminationTimer.unref();
    };
    const timeout = setTimeout(() => { timedOut = true; terminate(); }, request.timeoutMs);
    const onAbort = () => { cancelled = true; terminate(); };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) onAbort();

    try {
      const observed = await childOutcome;
      if (observed.error) throw observed.error;
      await logWrites;
      if (log) await log.finish();
      if (logFailure) throw logFailure;
      if (beforeGit?.isRepository && identity && this.options.journal?.recordSourceChange) {
        const afterGit = await readGitContext(request.cwd);
        const beforeHashes = new Map(beforeGit.fileHashes.map((file) => [file.path, file.sha256]));
        const afterHashes = new Map(afterGit.fileHashes.map((file) => [file.path, file.sha256]));
        for (const path of new Set([...beforeHashes.keys(), ...afterHashes.keys()])) {
          const oldSha256 = beforeHashes.get(path) ?? null;
          const newSha256 = afterHashes.get(path) ?? null;
          if (oldSha256 === newSha256 || path === ".macus" || path.startsWith(".macus/")) continue;
          this.options.journal.recordSourceChange({ sessionId: identity.sessionId, path, oldSha256, newSha256, attribution: "external_or_unknown", reason: "shell-command-worktree-change" });
        }
      }
      const { exitCode, signal } = observed;
      const sanitize = (buffers: Buffer[]) => {
        let text = Buffer.concat(buffers).toString("utf8");
        text = text.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, "");
        for (const secret of [...secrets, ...commandSecrets]) text = text.split(secret).join("[REDACTED]");
        return text;
      };
      const result = {
        exitCode,
        signal,
        stdout: sanitize(stdout),
        stderr: sanitize(stderr),
        outputComplete,
        cancelled,
        timedOut,
        ...(log ? { logRef: log.logRef, logTruncated: log.truncated } : {}),
      };
      if (identity) {
        const status = cancelled ? "cancelled" : exitCode === 0 && !timedOut ? "completed" : "failed";
        this.options.journal?.recordExecutionEvent(identity.executionId, status, {
          exitCode,
          signal,
          timedOut,
          cancelled,
          outputComplete,
          stdoutBytes: Buffer.concat(stdout).byteLength,
          stderrBytes: Buffer.concat(stderr).byteLength,
          ...(log ? { logRef: log.logRef, logTruncated: log.truncated } : {}),
        });
      }
      return result;
    } catch (error) {
      await log?.abort();
      if (identity) this.options.journal?.recordExecutionEvent(identity.executionId, "unknown", { reason: "process outcome could not be observed" });
      throw error;
    } finally {
      clearTimeout(timeout);
      if (terminationTimer) clearTimeout(terminationTimer);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }
}
