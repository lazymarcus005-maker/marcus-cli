import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { TrustedModelSelection } from "../src/config/trusted-model.js";
import { createRequestBudgetGuard } from "../src/context/request-budget.js";
import { assertPiSessionCapabilities, PiAgentKernel } from "../src/kernel/pi-agent-kernel.js";
import { openStateStore } from "../src/state/state-store.js";

const roots: string[] = [];
const servers: Server[] = [];
let toolCallSequence = 0;
after(async () => {
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function completion(text: string): string {
  return [
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    "data: [DONE]",
    "",
    "",
  ].join("\n\n");
}

function toolCallCompletion(command: string): string {
  return functionToolCompletion("bash", { command, timeoutMs: 5_000 });
}

function functionToolCompletion(name: string, args: unknown): string {
  const toolCallId = `call_fixture_${++toolCallSequence}`;
  return [
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: toolCallId, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}`,
    "data: [DONE]",
    "",
    "",
  ].join("\n\n");
}

async function localProvider(responses: string[] = [completion("ok")]): Promise<{ baseUrl: string; requests: () => number; bodies: () => string[] }> {
  let requestCount = 0;
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    requestCount++;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      bodies.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(responses[Math.min(requestCount - 1, responses.length - 1)]);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests: () => requestCount, bodies: () => bodies };
}

async function hangingProvider(): Promise<{ baseUrl: string; waitForRequest: () => Promise<void>; waitForClose: () => Promise<void>; wasClosed: () => boolean }> {
  let requested!: () => void;
  let markClosed!: () => void;
  let closed = false;
  const requestSeen = new Promise<void>((resolve) => { requested = resolve; });
  const connectionClosed = new Promise<void>((resolve) => { markClosed = resolve; });
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      requested();
      response.on("close", () => { closed = true; markClosed(); });
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, waitForRequest: () => requestSeen, waitForClose: () => connectionClosed, wasClosed: () => closed };
}

async function providerHangingOnCompaction(): Promise<{ baseUrl: string; waitForCompaction: () => Promise<void>; waitForCompactionClose: () => Promise<void>; wasCompactionClosed: () => boolean; requests: () => number; bodies: () => string[] }> {
  let requestCount = 0;
  const bodies: string[] = [];
  let requested!: () => void;
  let markClosed!: () => void;
  let closed = false;
  const compactionSeen = new Promise<void>((resolve) => { requested = resolve; });
  const compactionClosed = new Promise<void>((resolve) => { markClosed = resolve; });
  const server = createServer((request, response) => {
    requestCount++;
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      bodies.push(body);
      if (requestCount === 3) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.on("close", () => { closed = true; markClosed(); });
        requested();
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(completion("The prior conversation remains usable."));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, waitForCompaction: () => compactionSeen, waitForCompactionClose: () => compactionClosed, wasCompactionClosed: () => closed, requests: () => requestCount, bodies: () => bodies };
}

function selection(baseUrl: string, budgets: Pick<TrustedModelSelection, "contextWindow" | "reservedOutputTokens" | "safetyMarginTokens">): TrustedModelSelection {
  return {
    alias: "fixture",
    aliasSource: "global",
    providerId: "macus-fixture",
    protocol: "openai-compatible",
    baseUrl,
    apiKey: "fixture-key",
    profile: "fixture",
    model: "fixture-model",
    maxOutputTokens: budgets.reservedOutputTokens,
    runLimits: { maxModelTurns: 40, maxNoProgressAttempts: 3, maxDurationSeconds: 1800 },
    features: { repoMap: true, codeGraph: true, contextLedger: true, checkpoint: true, gitContext: true, taskEngine: true },
    ...budgets,
  };
}

describe("Pi adapter with a deterministic local provider", () => {
  it("fails with an actionable compatibility error when a required public Pi capability is absent", () => {
    assert.throws(
      () => assertPiSessionCapabilities({ prompt: () => undefined } as never),
      /Incompatible Pi SDK: required public session capability "subscribe" is unavailable/,
    );
  });

  it("reconciles an external edit before dispatching the next coding prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-pi-external-edit-"));
    roots.push(root);
    const sourcePath = join(root, "app.ts");
    const before = "export const value = 'before';\n";
    const after = "export const value = 'external';\n";
    await writeFile(sourcePath, before);
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "-c", "user.name=Macus Test", "-c", "user.email=macus-test@example.invalid", "add", "app.ts"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Macus Test", "-c", "user.email=macus-test@example.invalid", "commit", "-qm", "baseline"]);
    const provider = await localProvider();
    const store = openStateStore(join(root, ".macus", "state", "state.db"));
    const kernel = new PiAgentKernel(root, selection(provider.baseUrl, { contextWindow: 16_384, reservedOutputTokens: 256, safetyMarginTokens: 256 }), undefined, store);
    try {
      await kernel.start();
      const sessionId = kernel.sessionId!;
      store.createSession({ sessionId, worktreeRoot: root, gitDirectory: join(root, ".git") }, [
        { path: "app.ts", sha256: createHash("sha256").update(before).digest("hex") },
      ]);
      store.recordTestEvidence({ evidenceId: "external-edit-evidence", sessionId, snapshotDigest: "before", status: "passed", payload: {} });
      await writeFile(sourcePath, after);
      await kernel.prompt("Continue working with the current source.");
      assert.equal(store.listTestEvidence(sessionId)[0]?.status, "stale");
      const lastChange = store.listSourceChanges(sessionId, "app.ts").at(-1);
      assert.equal(lastChange?.attribution, "external_or_unknown");
      assert.equal(lastChange?.oldSha256, createHash("sha256").update(before).digest("hex"));
      assert.equal(lastChange?.newSha256, createHash("sha256").update(after).digest("hex"));
      assert.equal(provider.requests(), 1);
    } finally {
      await kernel.dispose();
      store.close();
    }
  });

  it("invalidates workspace evidence and blocks prompts after a branch/HEAD change", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-pi-checkout-change-"));
    roots.push(root);
    const sourcePath = join(root, "app.ts");
    await writeFile(sourcePath, "export const value = 'before';\n");
    execFileSync("git", ["init", "-q", root]);
    execFileSync("git", ["-C", root, "-c", "user.name=Macus Test", "-c", "user.email=macus-test@example.invalid", "add", "app.ts"]);
    execFileSync("git", ["-C", root, "-c", "user.name=Macus Test", "-c", "user.email=macus-test@example.invalid", "commit", "-qm", "baseline"]);
    const branch = execFileSync("git", ["-C", root, "branch", "--show-current"], { encoding: "utf8" }).trim();
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const provider = await localProvider();
    const store = openStateStore(join(root, ".macus", "state", "state.db"));
    const kernel = new PiAgentKernel(root, selection(provider.baseUrl, { contextWindow: 16_384, reservedOutputTokens: 256, safetyMarginTokens: 256 }), undefined, store);
    try {
      await kernel.start();
      const sessionId = kernel.sessionId!;
      const sourceHash = createHash("sha256").update("export const value = 'before';\n").digest("hex");
      store.createSession({ sessionId, worktreeRoot: root, gitDirectory: join(root, ".git"), gitBranch: branch, gitHead: head, gitIdentityCaptured: true }, [
        { path: "app.ts", sha256: sourceHash },
      ]);
      store.recordWorkingSetEntry({ sessionId, path: "app.ts", sourceSha256: sourceHash, status: "ACTIVE", tier: "HOT", startLine: 1, endLine: 1, symbolId: null, reason: "verified-read" });
      store.recordTestEvidence({ evidenceId: "checkout-evidence", sessionId, snapshotDigest: "before", status: "passed", payload: {} });
      await writeFile(sourcePath, "export const value = 'after checkout';\n");
      execFileSync("git", ["-C", root, "-c", "user.name=Macus Test", "-c", "user.email=macus-test@example.invalid", "add", "app.ts"]);
      execFileSync("git", ["-C", root, "-c", "user.name=Macus Test", "-c", "user.email=macus-test@example.invalid", "commit", "-qm", "advance"]);
      await assert.rejects(kernel.prompt("Do not run on a changed repository identity."), /branch\/HEAD changed/);
      assert.equal(store.listWorkingSet(sessionId)[0]?.status, "STALE");
      assert.equal(store.listTestEvidence(sessionId)[0]?.status, "stale");
      assert.equal(provider.requests(), 0);
    } finally {
      await kernel.dispose();
      store.close();
    }
  });

  it("streams a provider response through the public session adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-pi-runtime-"));
    roots.push(root);
    await writeFile(join(root, "AGENTS.md"), "MACUS_INSTRUCTION_MARKER_73");
    const provider = await localProvider();
    const kernel = new PiAgentKernel(root, selection(provider.baseUrl, {
      contextWindow: 16_384,
      reservedOutputTokens: 256,
      safetyMarginTokens: 256,
    }));
    try {
      await kernel.start();
      assert.ok(kernel.sessionId);
      await kernel.prompt("Reply briefly.");
      assert.equal(provider.requests(), 1);
      const messages = JSON.stringify(JSON.parse(provider.bodies()[0] ?? "{}").messages);
      assert.equal(messages.split("MACUS_INSTRUCTION_MARKER_73").length - 1, 1);
      const manifest = kernel.lastRequestManifest;
      assert.ok(manifest);
      assert.equal(Object.values(manifest.categories).reduce((sum, value) => sum + value, 0), manifest.estimatedPromptTokens);
      assert.match(manifest.payloadSha256, /^[a-f0-9]{64}$/);
      assert.equal(manifest.payloadSha256, createHash("sha256").update(JSON.stringify(JSON.parse(provider.bodies()[0] ?? "{}"))).digest("hex"));
      assert.match(manifest.includedInstructions[0]?.path ?? "", /(?:^|\/)AGENTS\.md$/);
      assert.equal(manifest.includedInstructions[0]?.sourceSha256, createHash("sha256").update("MACUS_INSTRUCTION_MARKER_73").digest("hex"));
      const replacementKernel = new PiAgentKernel(root, selection(provider.baseUrl, {
        contextWindow: 16_384,
        reservedOutputTokens: 256,
        safetyMarginTokens: 256,
      }));
      replacementKernel.inheritLastRequestManifest(manifest);
      assert.equal(replacementKernel.lastRequestManifest?.requestId, manifest.requestId);
    } finally {
      await kernel.dispose();
    }
  });

  it("disposes a session cleanly and can create a replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-pi-session-replacement-"));
    roots.push(root);
    const provider = await localProvider();
    const kernel = new PiAgentKernel(root, selection(provider.baseUrl, {
      contextWindow: 16_384,
      reservedOutputTokens: 256,
      safetyMarginTokens: 256,
    }));
    try {
      await kernel.start();
      const originalSessionId = kernel.sessionId;
      assert.ok(originalSessionId);

      await kernel.dispose();
      assert.equal(kernel.sessionId, undefined);

      await kernel.start();
      assert.ok(kernel.sessionId);
      assert.notEqual(kernel.sessionId, originalSessionId);
      await kernel.prompt("Confirm the replacement session is usable.");
      assert.equal(provider.requests(), 1);
    } finally {
      await kernel.dispose();
    }
  });

  it("injects only fresh working-set fragments and records their request provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-pi-working-set-"));
    roots.push(root);
    await mkdir(join(root, "src"));
    const currentContent = "export const current = 'selected';\n";
    await writeFile(join(root, "src", "current.ts"), currentContent);
    await writeFile(join(root, "src", "changed.ts"), "export const source = 'new version';\n");
    const provider = await localProvider();
    const store = openStateStore(join(root, ".macus", "state", "state.db"));
    const kernel = new PiAgentKernel(root, selection(provider.baseUrl, {
      contextWindow: 16_384,
      reservedOutputTokens: 256,
      safetyMarginTokens: 256,
    }), undefined, store);
    try {
      await kernel.start();
      store.createSession({ sessionId: kernel.sessionId!, worktreeRoot: root, gitDirectory: null });
      store.recordWorkingSetEntry({ sessionId: kernel.sessionId!, path: "src/current.ts", sourceSha256: createHash("sha256").update(currentContent).digest("hex"), status: "ACTIVE", tier: "HOT", startLine: 1, endLine: 1, symbolId: null, reason: "verified-read" });
      store.recordWorkingSetEntry({ sessionId: kernel.sessionId!, path: "src/changed.ts", sourceSha256: "0".repeat(64), status: "ACTIVE", tier: "HOT", startLine: 1, endLine: 1, symbolId: null, reason: "old-read" });
      await kernel.prompt("Use src/current.ts for this task.");
      const request = JSON.stringify(JSON.parse(provider.bodies()[0] ?? "{}").messages);
      assert.match(request, /<macus-context-fragment/);
      assert.match(request, /export const current/);
      assert.doesNotMatch(request, /new version/);
      assert.equal(kernel.lastRequestManifest?.includedFragments[0]?.path, "src/current.ts");
      assert.ok(kernel.lastRequestManifest?.omittedFragments.some((item) => item.path === "src/changed.ts" && item.reason === "stale"));
      assert.equal(store.listWorkingSet(kernel.sessionId!).find((entry) => entry.path === "src/changed.ts")?.status, "STALE");
    } finally {
      await kernel.dispose();
      store.close();
    }
  });

  it("does not dispatch a provider request when the serialized request exceeds budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-pi-budget-"));
    roots.push(root);
    const provider = await localProvider();
    const kernel = new PiAgentKernel(root, selection(provider.baseUrl, {
      contextWindow: 32,
      reservedOutputTokens: 8,
      safetyMarginTokens: 8,
    }));
    try {
      await kernel.start();
      await kernel.prompt("This request cannot possibly fit.");
      assert.equal(provider.requests(), 0);
    } finally {
      await kernel.dispose();
    }
  });

  it("completes an inner custom-tool turn through the policy and journal path", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-pi-tool-turn-"));
    roots.push(root);
    const provider = await localProvider([toolCallCompletion("printf policy-tool-ok"), completion("done")]);
    const store = openStateStore(join(root, ".macus", "state", "state.db"));
    const model = selection(provider.baseUrl, { contextWindow: 16_384, reservedOutputTokens: 256, safetyMarginTokens: 256 });
    const guard = createRequestBudgetGuard(model);
    let preparedRequests = 0;
    const kernel = new PiAgentKernel(
      root,
      model,
      { prepareProviderRequest: (payload) => { preparedRequests++; return guard(payload); } },
      store,
      async () => true,
    );
    try {
      await kernel.start();
      assert.ok(kernel.sessionId);
      store.createSession({ sessionId: kernel.sessionId, worktreeRoot: root, gitDirectory: null });
      await kernel.prompt("Run the approved command.");
      assert.equal(provider.requests(), 2);
      assert.equal(preparedRequests, 2);
      assert.match(provider.bodies()[1] ?? "", /policy-tool-ok/);
      const followUpMessages = JSON.parse(provider.bodies()[1] ?? "{}").messages as Array<{
        role?: string;
        tool_call_id?: string;
        tool_calls?: Array<{ id?: string }>;
      }>;
      const toolCallMessage = followUpMessages.find((message) => message.role === "assistant" && message.tool_calls?.length);
      assert.ok(toolCallMessage?.tool_calls);
      const callIds = toolCallMessage.tool_calls.map((call) => call.id);
      assert.ok(callIds.every((id): id is string => typeof id === "string" && id.length > 0));
      const callGroupStart = followUpMessages.indexOf(toolCallMessage);
      const toolResults = followUpMessages.slice(callGroupStart + 1).filter((message) => message.role === "tool");
      assert.deepEqual(toolResults.map((message) => message.tool_call_id), callIds);
      assert.ok(toolResults.every((message) => followUpMessages.indexOf(message) > callGroupStart));
      assert.equal(store.listUnresolvedExecutions(kernel.sessionId).length, 0);
      const [run] = store.listRuns(kernel.sessionId);
      assert.equal(run?.status, "completed");
      const [executionId] = store.listExecutionIds(kernel.sessionId);
      assert.ok(executionId);
      assert.equal(store.getExecutionRunId(executionId), run?.runId);
    } finally {
      await kernel.dispose();
      store.close();
    }
  });

  it("enforces the configured model-turn ceiling inside a Pi tool cycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-pi-run-limit-"));
    roots.push(root);
    const provider = await localProvider([toolCallCompletion("printf once"), completion("should not dispatch")]);
    const model = { ...selection(provider.baseUrl, { contextWindow: 16_384, reservedOutputTokens: 256, safetyMarginTokens: 256 }), runLimits: { maxModelTurns: 1, maxNoProgressAttempts: 3, maxDurationSeconds: 30 } };
    const store = openStateStore(join(root, ".macus", "state", "state.db"));
    const kernel = new PiAgentKernel(root, model, undefined, store, async () => true);
    try {
      await kernel.start();
      store.createSession({ sessionId: kernel.sessionId!, worktreeRoot: root, gitDirectory: null });
      await kernel.prompt("Run once only.");
      assert.equal(provider.requests(), 1);
      assert.equal(store.listRuns(kernel.sessionId!)[0]?.status, "paused");
    } finally {
      await kernel.dispose();
      store.close();
    }
  });

  it("does not dispatch a coding prompt while a durable blocker is unresolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-pi-blocker-"));
    roots.push(root);
    const provider = await localProvider();
    const store = openStateStore(join(root, ".macus", "state", "state.db"));
    const kernel = new PiAgentKernel(root, selection(provider.baseUrl, {
      contextWindow: 16_384,
      reservedOutputTokens: 256,
      safetyMarginTokens: 256,
    }), undefined, store);
    try {
      await kernel.start();
      store.createSession({ sessionId: kernel.sessionId!, worktreeRoot: root, gitDirectory: null });
      const blocker = store.recordWorkflowNote(kernel.sessionId!, "blocker", "Need explicit approval");
      await assert.rejects(kernel.prompt("Change the protected setting"), /paused by blocker/);
      assert.equal(provider.requests(), 0);
      store.resolveWorkflowBlocker(kernel.sessionId!, blocker.revision);
      const blockedTask = store.createTask({ sessionId: kernel.sessionId!, title: "Blocked protected-setting change" });
      store.transitionTask(kernel.sessionId!, blockedTask.id, "blocked");
      await assert.rejects(kernel.prompt("Continue with the blocked task"), /blocked task/);
      assert.equal(provider.requests(), 0);
      const nextTask = store.createTask({ sessionId: kernel.sessionId!, title: "Continue independent work" });
      store.transitionTask(kernel.sessionId!, nextTask.id, "in_progress");
      await kernel.prompt("Continue after starting an independent task");
      assert.equal(provider.requests(), 1);
    } finally {
      await kernel.dispose();
      store.close();
    }
  });

  it("executes deterministic source search as a journaled custom Pi tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-pi-search-tool-"));
    roots.push(root);
    await writeFile(join(root, "source.ts"), "export const answer = 'SEARCH_MARKER_9';\n");
    const provider = await localProvider([
      functionToolCompletion("search_code", { query: "SEARCH_MARKER_9", limit: 10 }),
      completion("I found the marker.")
    ]);
    const store = openStateStore(join(root, ".macus", "state", "state.db"));
    const kernel = new PiAgentKernel(root, selection(provider.baseUrl, { contextWindow: 16_384, reservedOutputTokens: 256, safetyMarginTokens: 256 }), undefined, store);
    try {
      await kernel.start();
      store.createSession({ sessionId: kernel.sessionId!, worktreeRoot: root, gitDirectory: null });
      await kernel.prompt("Find the search marker.");
      assert.equal(provider.requests(), 2);
      assert.match(provider.bodies()[1] ?? "", /SEARCH_MARKER_9/);
      assert.deepEqual(store.listUnresolvedExecutions(kernel.sessionId!), []);
    } finally {
      await kernel.dispose();
      store.close();
    }
  });

  it("executes graph dependency inspection through a journaled custom Pi tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-pi-graph-tool-"));
    roots.push(root);
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "target.ts"), "export function target() { return 1; }\n");
    await writeFile(join(root, "src", "caller.ts"), 'import { target } from "./target.js";\nexport function caller() { return target(); }\n');
    const provider = await localProvider([
      functionToolCompletion("find_dependencies", { target: "src/caller.ts" }),
      completion("The caller imports target.")
    ]);
    const store = openStateStore(join(root, ".macus", "state", "state.db"));
    const kernel = new PiAgentKernel(root, selection(provider.baseUrl, { contextWindow: 16_384, reservedOutputTokens: 256, safetyMarginTokens: 256 }), undefined, store);
    try {
      await kernel.start();
      store.createSession({ sessionId: kernel.sessionId!, worktreeRoot: root, gitDirectory: null });
      await kernel.prompt("Inspect dependencies of src/caller.ts.");
      assert.equal(provider.requests(), 2);
      assert.match(provider.bodies()[1] ?? "", /src\/target\.ts/);
      assert.match(provider.bodies()[1] ?? "", /confirmed/);
      assert.equal(store.listUnresolvedExecutions(kernel.sessionId!).length, 0);
    } finally {
      await kernel.dispose();
      store.close();
    }
  });

  it("requires approval and hash-checks a journaled source write tool call", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-pi-write-tool-"));
    roots.push(root);
    const original = "export const value = 'before';\n";
    const sourcePath = join(root, "source.ts");
    await writeFile(sourcePath, original);
    const expectedSha256 = createHash("sha256").update(original).digest("hex");
    const provider = await localProvider([
      functionToolCompletion("read_range", { path: "source.ts", startLine: 1, endLine: 1 }),
      functionToolCompletion("write_file", { path: "source.ts", expectedSha256, content: "export const value = 'after';\n" }),
      completion("The source is updated.")
    ]);
    const store = openStateStore(join(root, ".macus", "state", "state.db"));
    let approvals = 0;
    const kernel = new PiAgentKernel(
      root,
      selection(provider.baseUrl, { contextWindow: 16_384, reservedOutputTokens: 256, safetyMarginTokens: 256 }),
      undefined,
      store,
      async () => { approvals++; return true; },
    );
    try {
      await kernel.start();
      store.createSession({ sessionId: kernel.sessionId!, worktreeRoot: root, gitDirectory: null });
      await kernel.prompt("Read and update the file.");
      assert.equal(approvals, 1);
      assert.equal(await readFile(sourcePath, "utf8"), "export const value = 'after';\n");
      assert.equal(provider.requests(), 3);
      const finalRequest = provider.bodies()[2] ?? "";
      assert.match(finalRequest, /export const value = &#39;after&#39;|export const value = 'after'/);
      assert.doesNotMatch(finalRequest, /export const value = 'before'/);
      assert.equal(kernel.lastRequestManifest?.includedFragments[0]?.sourceSha256, createHash("sha256").update("export const value = 'after';\n").digest("hex"));
      assert.deepEqual(store.listSourceChanges(kernel.sessionId!).map((change) => ({ path: change.path, oldSha256: change.oldSha256, newSha256: change.newSha256, attribution: change.attribution })), [{ path: "source.ts", oldSha256: expectedSha256, newSha256: createHash("sha256").update("export const value = 'after';\n").digest("hex"), attribution: "agent" }]);
      assert.deepEqual(store.listUnresolvedExecutions(kernel.sessionId!), []);
    } finally {
      await kernel.dispose();
      store.close();
    }
  });

  it("propagates session cancellation to the active provider stream", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-pi-cancel-"));
    roots.push(root);
    const provider = await hangingProvider();
    const kernel = new PiAgentKernel(root, selection(provider.baseUrl, {
      contextWindow: 16_384,
      reservedOutputTokens: 256,
      safetyMarginTokens: 256,
    }));
    try {
      await kernel.start();
      const pending = kernel.prompt("Wait for cancellation.");
      await provider.waitForRequest();
      await assert.rejects(kernel.prompt("Do not overlap runs."), /while prompt is in progress/);
      await assert.rejects(kernel.compact(), /while prompt is in progress/);
      await kernel.cancel();
      await pending;
      const closed = await Promise.race([
        provider.waitForClose().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      assert.equal(closed, true);
      assert.equal(provider.wasClosed(), true);
    } finally {
      await kernel.dispose();
    }
  });

  it("uses Pi's public manual compaction API", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-pi-compact-"));
    roots.push(root);
    const provider = await localProvider([
      completion("A prior answer."),
      completion("The large request was received."),
      completion("A later answer."),
      completion("Preserve the current goal and result."),
    ]);
    const kernel = new PiAgentKernel(root, selection(provider.baseUrl, {
      contextWindow: 400_000,
      reservedOutputTokens: 1_000,
      safetyMarginTokens: 1_000,
    }));
    try {
      await kernel.start();
      assert.equal(kernel.autoCompactionEnabled, false);
      await kernel.prompt("Remember the current goal.");
      await kernel.prompt(`Continue this goal with detailed context. ${"context ".repeat(30_000)}`);
      await kernel.prompt("Continue with a later turn.");
      const result = await kernel.compact("Preserve the task's exact user constraint: COMPACTION_PRESERVATION_MARKER.");
      assert.match(result.summary, /current goal|result/i);
      assert.equal(provider.requests(), 4);
      assert.match(JSON.stringify(provider.bodies()[3]), /COMPACTION_PRESERVATION_MARKER/);
    } finally {
      await kernel.dispose();
    }
  });

  it("keeps the prior conversation usable when compaction is cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-pi-compact-cancel-"));
    roots.push(root);
    const provider = await providerHangingOnCompaction();
    const kernel = new PiAgentKernel(root, selection(provider.baseUrl, { contextWindow: 400_000, reservedOutputTokens: 1_000, safetyMarginTokens: 1_000 }));
    try {
      await kernel.start();
      await kernel.prompt("Keep this completed conversation available.");
      await kernel.prompt(`Add substantial context before compaction. ${"context ".repeat(30_000)}`);
      const compacting = kernel.compact("Preserve the completed conversation.");
      await provider.waitForCompaction();
      await kernel.cancel();
      const compactSettled = await Promise.race([
        compacting.then(() => true, () => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      assert.equal(compactSettled, true);
      const connectionClosed = await Promise.race([
        provider.waitForCompactionClose().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      assert.equal(connectionClosed, true);
      assert.equal(provider.wasCompactionClosed(), true);
      await kernel.prompt("Continue after cancelled compaction.");
      assert.equal(provider.requests(), 4);
      assert.match(provider.bodies()[3] ?? "", /Keep this completed conversation available/);
    } finally {
      await kernel.dispose();
    }
  });

  it("blocks prompts and compaction while an execution outcome is unresolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-pi-recovery-"));
    roots.push(root);
    const provider = await localProvider([]);
    const store = openStateStore(join(root, ".macus", "state", "state.db"));
    const kernel = new PiAgentKernel(root, selection(provider.baseUrl, {
      contextWindow: 16_384,
      reservedOutputTokens: 256,
      safetyMarginTokens: 256,
    }), undefined, store);
    try {
      await kernel.start();
      store.createSession({ sessionId: kernel.sessionId!, worktreeRoot: root, gitDirectory: null });
      store.prepareExecution({ executionId: "unresolved-write", sessionId: kernel.sessionId!, redactedInput: { path: "src/file" }, effectClass: "workspace-write" });
      store.recordExecutionEvent("unresolved-write", "unknown", { reason: "crash after launch; side effect uncertain" });
      await assert.rejects(kernel.prompt("Continue mutating"), /require recovery review/);
      await assert.rejects(kernel.compact(), /require recovery review/);
      assert.equal(provider.requests(), 0);
    } finally {
      await kernel.dispose();
      store.close();
    }
  });

  it("keeps the prompt gate closed for an already-unknown run after another restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-pi-unknown-run-"));
    roots.push(root);
    const provider = await localProvider();
    const store = openStateStore(join(root, ".macus", "state", "state.db"));
    const kernel = new PiAgentKernel(root, selection(provider.baseUrl, { contextWindow: 16_384, reservedOutputTokens: 256, safetyMarginTokens: 256 }), undefined, store);
    try {
      await kernel.start();
      const sessionId = kernel.sessionId!;
      store.createSession({ sessionId, worktreeRoot: root, gitDirectory: null });
      store.startRun({ runId: "crashed-run", sessionId, prompt: "Original request" });
      assert.equal(store.markInterruptedRunsUnknown(sessionId).length, 1);
      assert.equal(store.markInterruptedRunsUnknown(sessionId).length, 0);
      await assert.rejects(kernel.prompt("Do not continue after the persisted unknown run."), /unknown prior run/);
      assert.equal(provider.requests(), 0);
    } finally {
      await kernel.dispose();
      store.close();
    }
  });

  it("continues the recent persisted session and retains its prior conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "macus-pi-resume-"));
    roots.push(root);
    const provider = await localProvider([completion("first session answer"), completion("resumed answer")]);
    const model = selection(provider.baseUrl, { contextWindow: 16_384, reservedOutputTokens: 256, safetyMarginTokens: 256 });
    const firstKernel = new PiAgentKernel(root, model);
    let sessionId: string;
    let transcriptLeaf: string | null;
    try {
      await firstKernel.start();
      sessionId = firstKernel.sessionId!;
      await firstKernel.prompt("Start a saved conversation.");
      transcriptLeaf = firstKernel.transcriptEntryId;
      assert.ok(transcriptLeaf);
    } finally {
      await firstKernel.dispose();
    }
    const resumedKernel = new PiAgentKernel(root, model);
    try {
      await resumedKernel.start({ resumeRecent: true });
      assert.equal(resumedKernel.sessionId, sessionId!);
      assert.ok(transcriptLeaf);
      await resumedKernel.restoreTranscriptEntry(transcriptLeaf);
      await resumedKernel.prompt("Continue after restart.");
      const secondRequest = provider.bodies()[1] ?? "";
      assert.match(secondRequest, /first session answer/);
    } finally {
      await resumedKernel.dispose();
    }
  });
});
