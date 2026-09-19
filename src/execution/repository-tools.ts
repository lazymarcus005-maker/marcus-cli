import { createHash, randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { searchCode, smartRead } from "../retrieval/search.js";
import { buildSymbolIndex, searchSymbols, type SymbolKind } from "../retrieval/symbol-index.js";
import { replaceFileSafely } from "../retrieval/safe-edit.js";
import { inspectGit, type GitInspectionOperation } from "../workflow/git-inspection.js";
import type { StateStore } from "../state/state-store.js";
import { buildRelationshipGraph, queryRelationshipGraph, type RelationshipOperation } from "../retrieval/relationship-graph.js";

const TOOL_RESULT_LIMIT = 16 * 1024;

function sanitize(text: string): string {
  return text
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, "")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/((?:api[-_]?key|access[_-]?token|token|secret|password)\s*[=:]\s*)([^\s,;"']+)/gi, "$1[REDACTED]");
}

function xmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function toolText(text: string, details?: unknown) {
  const safe = sanitize(text);
  const bytes = Buffer.from(safe, "utf8");
  const truncated = bytes.byteLength > TOOL_RESULT_LIMIT;
  const bounded = bytes.subarray(0, TOOL_RESULT_LIMIT).toString("utf8");
  return {
    content: [{ type: "text" as const, text: `${bounded}${truncated ? "\n[tool output truncated; request a narrower range]" : ""}` }],
    details: { ...(typeof details === "object" && details !== null ? details : {}), outputTruncated: truncated },
  };
}

async function journaled<T>(options: {
  stateStore: StateStore;
  sessionId: string;
  runId?: string;
  toolCallId: string;
  effectClass: "read" | "workspace-write";
  redactedInput: unknown;
  execute: () => Promise<T>;
}): Promise<T> {
  const executionId = randomUUID();
  options.stateStore.prepareExecution({
    executionId,
    sessionId: options.sessionId,
    ...(options.runId ? { runId: options.runId } : {}),
    toolCallId: options.toolCallId,
    redactedInput: options.redactedInput,
    effectClass: options.effectClass,
  });
  options.stateStore.recordExecutionEvent(executionId, "started", {});
  try {
    const result = await options.execute();
    options.stateStore.recordExecutionEvent(executionId, "completed", {});
    return result;
  } catch (error) {
    options.stateStore.recordExecutionEvent(executionId, "failed", { error: error instanceof Error ? sanitize(error.message) : "operation failed" });
    throw error;
  }
}

/** Structured source operations use the same session journal and worktree scope as shell execution. */
export function createRepositoryTools(options: {
  cwd: string;
  stateStore: StateStore;
  sessionId: () => string | undefined;
  runId: () => string | undefined;
  codeGraph: boolean;
  gitContext: boolean;
  authorizeWrite: (summary: string, signal?: AbortSignal) => Promise<boolean>;
}) {
  const identity = (toolCallId: string) => {
    const sessionId = options.sessionId();
    if (!sessionId) throw new Error("Cannot access repository before the Macus session is durably identified");
    const runId = options.runId();
    return { sessionId, toolCallId, ...(runId ? { runId } : {}) };
  };

  const searchCodeTool = defineTool({
    name: "search_code",
    label: "search code",
    description: "Search included repository files deterministically. Literal matching is default; regex is opt-in.",
    promptSnippet: "Search source text before reading or changing files.",
    executionMode: "parallel",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 1000 }),
      path: Type.Optional(Type.String({ maxLength: 1000 })),
      regex: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(toolCallId, params, signal) {
      const who = identity(toolCallId);
      const result = await journaled({
        ...who,
        stateStore: options.stateStore,
        effectClass: "read",
        redactedInput: { operation: "search_code", query: params.query, path: params.path, regex: params.regex },
        execute: () => searchCode({ root: options.cwd, query: params.query, ...(params.path ? { path: params.path } : {}), ...(params.regex !== undefined ? { regex: params.regex } : {}), limit: params.limit ?? 25, ...(signal ? { signal } : {}) }),
      });
      for (const match of result.matches) {
        const prior = options.stateStore.listWorkingSet(who.sessionId).find((entry) => entry.path === match.path);
        if (prior?.status === "ACTIVE" || prior?.status === "RELATED") continue;
        options.stateStore.recordWorkingSetEntry({
          sessionId: who.sessionId,
          path: match.path,
          sourceSha256: null,
          status: "DISCOVERED",
          tier: "COLD",
          startLine: match.line,
          endLine: match.line,
          symbolId: null,
          reason: "search-result",
        });
      }
      return toolText(`<macus-search-results>\n${result.matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n") || `Search status: ${result.status}`}\n</macus-search-results>`, result);
    },
  });

  const readRangeTool = defineTool({
    name: "read_range",
    label: "read source range",
    description: "Read a numbered, bounded range from an included repository file and return its current SHA-256 hash.",
    promptSnippet: "Read only the needed source range; verify the returned hash before editing.",
    executionMode: "parallel",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 1000 }),
      startLine: Type.Optional(Type.Integer({ minimum: 1 })),
      endLine: Type.Optional(Type.Integer({ minimum: 1 })),
      expectedSha256: Type.Optional(Type.String({ minLength: 64, maxLength: 64 })),
    }),
    async execute(toolCallId, params) {
      const who = identity(toolCallId);
      const result = await journaled({
        ...who,
        stateStore: options.stateStore,
        effectClass: "read",
        redactedInput: { operation: "read_range", path: params.path, startLine: params.startLine, endLine: params.endLine },
        execute: () => smartRead({ root: options.cwd, path: params.path, ...(params.startLine ? { startLine: params.startLine } : {}), ...(params.endLine ? { endLine: params.endLine } : {}), ...(params.expectedSha256 ? { expectedSha256: params.expectedSha256 } : {}) }),
      });
      options.stateStore.recordWorkingSetEntry({
        sessionId: who.sessionId,
        path: result.path,
        sourceSha256: result.sha256,
        status: "ACTIVE",
        tier: "HOT",
        startLine: result.startLine,
        endLine: result.endLine,
        symbolId: null,
        reason: "verified-read",
      });
      return toolText(`<macus-source-read path="${xmlAttribute(result.path)}" sha256="${result.sha256}" start="${result.startLine}" end="${result.endLine}" contentBytes="${Buffer.byteLength(result.text, "utf8")}" stale="${result.stale}" contentLength="${result.text.length}">${result.text}</macus-source-read>`, result);
    },
  });

  const searchSymbolTool = defineTool({
    name: "search_symbol",
    label: "search symbols",
    description: "Find syntax-indexed declarations with disambiguated IDs and source hashes. Unsupported files are reported as such.",
    promptSnippet: "Use symbol search to locate declarations; choose by path and range when names are ambiguous.",
    executionMode: "parallel",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      path: Type.Optional(Type.String({ maxLength: 1000 })),
      kind: Type.Optional(Type.String({ maxLength: 32 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    async execute(toolCallId, params) {
      const who = identity(toolCallId);
      const result = await journaled({
        ...who,
        stateStore: options.stateStore,
        effectClass: "read",
        redactedInput: { operation: "search_symbol", query: params.query, path: params.path, kind: params.kind },
        execute: async () => {
          const index = await buildSymbolIndex(options.cwd);
          return searchSymbols(index, {
            query: params.query,
            ...(params.path ? { path: params.path } : {}),
            ...(params.kind ? { kind: params.kind as SymbolKind } : {}),
            limit: params.limit ?? 25,
          });
        },
      });
      const text = result.matches.map((symbol) => `${symbol.id} ${symbol.path}:${symbol.startLine}-${symbol.endLine} ${symbol.signature} sha256=${symbol.sourceSha256}`).join("\n");
      for (const symbol of result.matches) {
        options.stateStore.recordWorkingSetEntry({
          sessionId: who.sessionId,
          path: symbol.path,
          sourceSha256: symbol.sourceSha256,
          status: "RELATED",
          tier: "WARM",
          startLine: symbol.startLine,
          endLine: symbol.endLine,
          symbolId: symbol.id,
          reason: "symbol-search",
        });
      }
      return toolText(`${result.ambiguous ? "Ambiguous candidates (select explicitly):\n" : ""}${text || "No symbols found"}`, result);
    },
  });

  const gitInspectTool = defineTool({
    name: "git_inspect",
    label: "inspect Git history",
    description: "Read bounded Git diff, history, commit summary, or blame data. Paths remain inside the authorized repository.",
    promptSnippet: "Use Git inspection for targeted diff, log, show, and blame context; results may be truncated.",
    executionMode: "parallel",
    parameters: Type.Object({
      operation: Type.String({ minLength: 1, maxLength: 16 }),
      path: Type.Optional(Type.String({ maxLength: 1000 })),
      revision: Type.Optional(Type.String({ maxLength: 64 })),
      startLine: Type.Optional(Type.Integer({ minimum: 1 })),
      endLine: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(toolCallId, params, signal) {
      const operations = new Set<GitInspectionOperation>(["diff", "log", "show", "blame"]);
      if (!operations.has(params.operation as GitInspectionOperation)) throw new Error("Unsupported Git inspection operation");
      const who = identity(toolCallId);
      const result = await journaled({
        ...who,
        stateStore: options.stateStore,
        effectClass: "read",
        redactedInput: { operation: "git_inspect", gitOperation: params.operation, path: params.path, revision: params.revision, startLine: params.startLine, endLine: params.endLine },
        execute: () => inspectGit({ root: options.cwd, operation: params.operation as GitInspectionOperation, ...(params.path ? { path: params.path } : {}), ...(params.revision ? { revision: params.revision } : {}), ...(params.startLine ? { startLine: params.startLine } : {}), ...(params.endLine ? { endLine: params.endLine } : {}), ...(signal ? { signal } : {}) }),
      });
      return toolText(result.output || "No Git output for this operation.", { truncated: result.truncated, coverage: "bounded-read" });
    },
  });

  const writeFileTool = defineTool({
    name: "write_file",
    label: "write source file",
    description: "Replace a repository file only if its current content still matches the SHA-256 hash from read_range. Requires user approval.",
    promptSnippet: "Use read_range then write_file with the observed SHA-256. Changes are atomic and refuse stale files.",
    executionMode: "sequential",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, maxLength: 1000 }),
      expectedSha256: Type.String({ minLength: 64, maxLength: 64 }),
      content: Type.String({ maxLength: 1_048_576 }),
    }),
    async execute(toolCallId, params, signal) {
      const approved = await options.authorizeWrite(`Replace ${params.path} with ${Buffer.byteLength(params.content, "utf8")} bytes. This write is atomic and will fail if the source hash changed.`, signal);
      if (!approved) throw new Error("File write denied by user");
      const who = identity(toolCallId);
      const contentHash = createHash("sha256").update(params.content).digest("hex");
      const result = await journaled({
        ...who,
        stateStore: options.stateStore,
        effectClass: "workspace-write",
        redactedInput: { operation: "write_file", path: params.path, expectedSha256: params.expectedSha256, contentSha256: contentHash, contentBytes: Buffer.byteLength(params.content, "utf8") },
        execute: () => replaceFileSafely({ root: options.cwd, path: params.path, expectedSha256: params.expectedSha256, content: params.content }),
      });
      options.stateStore.recordSourceChange({
        sessionId: who.sessionId,
        path: result.path,
        oldSha256: params.expectedSha256,
        newSha256: result.sha256,
        attribution: "agent",
        reason: "approved-write-file",
      });
      options.stateStore.recordWorkingSetEntry({
        sessionId: who.sessionId,
        path: result.path,
        sourceSha256: result.sha256,
        status: "ACTIVE",
        tier: "HOT",
        startLine: 1,
        endLine: params.content.split(/\r?\n/).length,
        symbolId: null,
        reason: "verified-agent-edit",
      });
      return toolText(`Updated ${result.path}; sha256=${result.sha256}`);
    },
  });

  const makeRelationshipTool = (operation: RelationshipOperation, description: string) => defineTool({
    name: operation,
    label: operation.replaceAll("_", " "),
    description,
    promptSnippet: "Use graph results as bounded evidence; candidate name matches are not confirmed callers and partial coverage never means no callers.",
    executionMode: "parallel",
    parameters: Type.Object({ target: Type.String({ minLength: 1, maxLength: 1200 }) }),
    async execute(toolCallId, params) {
      const who = identity(toolCallId);
      const result = await journaled({
        ...who,
        stateStore: options.stateStore,
        effectClass: "read",
        redactedInput: { operation, target: params.target },
        execute: async () => {
          const index = await buildSymbolIndex(options.cwd);
          const graph = await buildRelationshipGraph(options.cwd, index);
          return queryRelationshipGraph(graph, { operation, target: params.target });
        },
      });
      return toolText(JSON.stringify(result), {
        operation,
        coverage: result.coverage,
        generationId: result.generationId,
        confirmedCount: result.confirmed.length,
        candidateCount: result.candidates.length,
        unresolvedCount: result.unresolved.length,
        possibleTestCount: result.possibleTests.length,
        limitationCount: result.limitations.length,
      });
    },
  });

  return [
    searchCodeTool,
    readRangeTool,
    searchSymbolTool,
    ...(options.gitContext ? [gitInspectTool] : []),
    writeFileTool,
    ...(options.codeGraph ? [
      makeRelationshipTool("find_references", "Find candidate/confirmed references to a disambiguated symbol ID. Use the exact ID from search_symbol."),
      makeRelationshipTool("find_dependencies", "Find imports from a repository-relative source file path."),
      makeRelationshipTool("find_dependents", "Find files with imports resolving to a repository-relative source file path."),
      makeRelationshipTool("impact", "Return bounded reference and possible-test hints for a symbol ID or file path; incomplete coverage requires broader search/tests."),
    ] : []),
  ];
}
