import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  createRequestBudgetGuard,
  RequestBudgetExceededError,
  RequestCategoryBudgetExceededError,
  type RequestManifest,
} from "../src/context/request-budget.js";

const model = {
  contextWindow: 2048,
  reservedOutputTokens: 256,
  safetyMarginTokens: 128,
};

describe("effective provider request budget", () => {
  it("accounts for the full serialized request and clamps requested output", () => {
    const prepare = createRequestBudgetGuard(model);
    const result = prepare({
      messages: [{ role: "user", content: "small request" }],
      tools: [{ name: "example", description: "schema" }],
      max_tokens: 512,
    }) as { max_tokens: number };

    assert.equal(result.max_tokens, 256);
  });

  it("refuses to dispatch a payload that cannot fit the configured prompt cap", () => {
    const prepare = createRequestBudgetGuard(model);

    assert.throws(
      () => prepare({ messages: [{ role: "user", content: "x".repeat(1800) }] }),
      RequestBudgetExceededError,
    );
  });

  it("fails closed for non-object payloads", () => {
    assert.throws(
      () => createRequestBudgetGuard(model)("not a provider payload"),
      /payload is not an object/,
    );
  });

  it("rejects invalid provider output limits", () => {
    assert.throws(
      () => createRequestBudgetGuard(model)({ max_tokens: -1 }),
      /max_tokens must be a positive integer/,
    );
  });

  it("emits an exact-sum manifest for the provider payload categories", () => {
    let manifest: RequestManifest | undefined;
    const prepare = createRequestBudgetGuard(model, (value) => { manifest = value; }, () => ({
      sessionId: "session-one",
      modelId: "fixture-model",
      includedFragments: [{ fragmentId: "fragment-one", path: "src/app.ts", sourceSha256: "a".repeat(64), startLine: 1, endLine: 3, reason: "verified-read", tier: "HOT", estimatedTokens: 42, freshness: "verified" }],
      includedInstructions: [{ path: "AGENTS.md", sourceSha256: "b".repeat(64), reason: "repository-instruction", estimatedTokens: 80 }],
      omittedFragments: [{ path: "src/old.ts", reason: "stale", detail: "source hash changed" }],
    }));
    const payload = {
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: `<repository-instruction path="AGENTS.md" sha256="${"b".repeat(64)}">guidance</repository-instruction>` },
        { role: "tool", content: "command result" },
        { role: "user", content: '<macus-context-fragment path="src/app.ts" sha256="aaaaaaaa">source</macus-context-fragment>' },
        { role: "assistant", content: "conversation" },
      ],
      tools: [{ name: "search_code", parameters: { type: "object" } }],
      max_tokens: 128,
    };
    const result = prepare(payload);
    const expectedBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
    assert.ok(manifest);
    assert.equal(manifest.estimatedPromptTokens, expectedBytes);
    assert.equal(manifest.payloadSha256, createHash("sha256").update(JSON.stringify(result)).digest("hex"));
    assert.equal(Object.values(manifest.categories).reduce((sum, value) => sum + value, 0), expectedBytes);
    assert.ok(manifest.categories.system > 0);
    assert.ok(manifest.categories.repositoryInstructions > 0);
    assert.ok(manifest.categories.toolSchemas > 0);
    assert.ok(manifest.categories.otherToolOutput > 0);
    assert.ok(manifest.categories.workingSource > 0);
    assert.equal(manifest.sessionId, "session-one");
    assert.equal(manifest.modelId, "fixture-model");
    assert.equal(manifest.includedFragments[0]?.path, "src/app.ts");
    assert.equal(manifest.includedInstructions[0]?.path, "AGENTS.md");
    assert.equal(manifest.includedInstructions[0]?.sourceSha256, "b".repeat(64));
    assert.equal(manifest.omittedFragments[0]?.reason, "stale");
  });

  it("enforces category and single-file read caps before provider dispatch", () => {
    const categoryGuard = createRequestBudgetGuard({ ...model, contextBudgets: { searchResultsTokens: 20 } });
    assert.throws(
      () => categoryGuard({ messages: [{ role: "toolResult", content: "<macus-search-results>" + "x".repeat(60) + "</macus-search-results>" }] }),
      RequestCategoryBudgetExceededError,
    );
    const readGuard = createRequestBudgetGuard({ ...model, contextBudgets: { singleFileReadTokens: 20 } });
    assert.throws(
      () => readGuard({ messages: [{ role: "toolResult", content: '<macus-source-read contentBytes="21" contentLength="21">source</macus-source-read>' }] }),
      /singleFileRead/,
    );
  });

  it("uses a configured max-input ceiling in addition to context/output reservations", () => {
    const constrained = createRequestBudgetGuard({ ...model, maxInputTokens: 300, reservedOutputTokens: 100, safetyMarginTokens: 50 });
    assert.throws(() => constrained({ messages: [{ role: "user", content: "x".repeat(151) }] }), RequestBudgetExceededError);
  });
});
