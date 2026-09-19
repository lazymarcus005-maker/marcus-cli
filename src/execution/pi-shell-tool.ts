import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PolicyExecutor } from "./policy-executor.js";
import { ExecutionLogStore } from "./execution-log-store.js";
import type { StateStore } from "../state/state-store.js";

const MODEL_RESULT_LIMIT = 32 * 1024;

/** The only enabled execution route; user approval, durable journal and output bounds are mandatory. */
export function createPolicyShellTool(options: {
  cwd: string;
  stateStore: StateStore;
  sessionId: () => string | undefined;
  runId: () => string | undefined;
  authorizeCommand: (command: string, signal?: AbortSignal) => Promise<boolean>;
}) {
  const logs = new ExecutionLogStore(options.cwd);
  const bash = defineTool({
    name: "bash",
    label: "bash (policy controlled)",
    description: "Run a shell command in the current repository. Commands are not sandboxed and require explicit approval.",
    promptSnippet: "Run a shell command after asking the user to approve it.",
    executionMode: "sequential",
    parameters: Type.Object({
      command: Type.String({ minLength: 1 }),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000 })),
    }),
    async execute(toolCallId, params, signal, _onUpdate, _ctx) {
      const approved = await options.authorizeCommand(params.command, signal);
      const sessionId = options.sessionId();
      const runId = options.runId();
      if (!sessionId) throw new Error("Cannot execute before the Macus session is durably identified");
      const executor = new PolicyExecutor({
        authorize: async () => approved,
        maxOutputBytes: 8 * 1024 * 1024,
        journal: options.stateStore,
        logStore: logs,
      });
      const result = await executor.execute({
        command: params.command,
        cwd: options.cwd,
        timeoutMs: params.timeoutMs ?? 120_000,
        terminationGraceMs: 2_000,
        allowedEnvironment: ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"],
        ...(signal ? { signal } : {}),
        identity: {
          executionId: randomUUID(),
          sessionId,
          ...(runId ? { runId } : {}),
          toolCallId,
          effectClass: "external",
        },
      });
      const combined = [result.stdout, result.stderr && `[stderr]\n${result.stderr}`].filter(Boolean).join("\n");
      const bounded = Buffer.from(combined, "utf8").subarray(0, MODEL_RESULT_LIMIT).toString("utf8");
      const text = [
        `exitCode=${result.exitCode ?? "unknown"}; timedOut=${result.timedOut}; cancelled=${result.cancelled}; outputComplete=${result.outputComplete}`,
        ...(result.logRef ? [`logRef=${result.logRef}; logTruncated=${result.logTruncated}`] : []),
        bounded || "(no output)",
        Buffer.byteLength(combined, "utf8") > MODEL_RESULT_LIMIT ? "[model-facing result truncated]" : "",
      ].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text }],
        details: { exitCode: result.exitCode, timedOut: result.timedOut, cancelled: result.cancelled, outputComplete: result.outputComplete },
      };
    },
  });
  const readLog = defineTool({
    name: "read_log",
    label: "read execution log",
    description: "Read a bounded page of this session's redacted command output log.",
    promptSnippet: "Read more output from a prior approved shell command by its logRef.",
    executionMode: "sequential",
    parameters: Type.Object({
      logRef: Type.String({ minLength: 1, maxLength: 128 }),
      startByte: Type.Optional(Type.Integer({ minimum: 0 })),
      maxBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 64 * 1024 })),
    }),
    async execute(toolCallId, params) {
      const sessionId = options.sessionId();
      if (!sessionId) throw new Error("Cannot read logs before the Macus session is durably identified");
      if (options.stateStore.getExecutionSessionId(params.logRef) !== sessionId) {
        throw new Error("Execution log reference does not belong to this session");
      }
      const runId = options.runId();
      const readExecutionId = randomUUID();
      options.stateStore.prepareExecution({
        executionId: readExecutionId,
        sessionId,
        ...(runId ? { runId } : {}),
        toolCallId,
        effectClass: "read",
        redactedInput: { operation: "read_log", logRef: params.logRef, startByte: params.startByte ?? 0, maxBytes: params.maxBytes ?? 16 * 1024 },
      });
      options.stateStore.recordExecutionEvent(readExecutionId, "started", {});
      try {
        const page = await logs.read(sessionId, params.logRef, params.startByte ?? 0, params.maxBytes ?? 16 * 1024);
        options.stateStore.recordExecutionEvent(readExecutionId, "completed", { bytesRead: Buffer.byteLength(page.text, "utf8"), nextByte: page.nextByte, truncated: page.truncated });
        return {
          content: [{ type: "text", text: `${page.text}\n[log page: nextByte=${page.nextByte ?? "end"}; truncated=${page.truncated}]` }],
          details: { nextByte: page.nextByte, truncated: page.truncated },
        };
      } catch (error) {
        options.stateStore.recordExecutionEvent(readExecutionId, "failed", { reason: error instanceof Error ? error.message.slice(0, 300) : "Log read failed" });
        throw error;
      }
    },
  });
  return [bash, readLog];
}
