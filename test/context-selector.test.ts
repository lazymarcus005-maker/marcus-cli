import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectContextFragments, type ContextCandidate } from "../src/context/context-selector.js";

function candidate(path: string, content: string, options: Partial<ContextCandidate> = {}): ContextCandidate {
  return {
    path,
    sourceSha256: "a".repeat(64),
    startLine: 1,
    endLine: 1,
    content,
    status: "ACTIVE",
    tier: "HOT",
    reason: "verified-read",
    freshness: "verified",
    lastAccessedAt: "2026-09-19T00:00:00.000Z",
    ...options,
  };
}

describe("deterministic working-set context selection", () => {
  it("prioritizes exact task-path and active HOT context with stable tie-breaking", () => {
    const selected = selectContextFragments({
      candidates: [
        candidate("src/zeta.ts", "z"),
        candidate("src/alpha.ts", "a"),
        candidate("src/current.ts", "current", { tier: "WARM", status: "RELATED" }),
      ],
      currentIntent: "Fix src/current.ts",
      maxBytes: 100,
    });
    assert.deepEqual(selected.included.map((item) => item.path), ["src/current.ts", "src/alpha.ts", "src/zeta.ts"]);
  });

  it("omits stale, unverified, duplicate, and over-budget fragments with explicit reasons", () => {
    const source = candidate("src/a.ts", "same\n");
    const selected = selectContextFragments({
      candidates: [
        source,
        { ...source },
        candidate("src/stale.ts", "stale", { freshness: "stale" }),
        candidate("src/discovered.ts", "not yet read", { status: "DISCOVERED", tier: "COLD" }),
        candidate("src/large.ts", "0123456789", { tier: "WARM", status: "RELATED" }),
      ],
      currentIntent: "",
      maxBytes: Buffer.byteLength("same\n"),
    });
    assert.deepEqual(selected.included.map((item) => item.path), ["src/a.ts"]);
    assert.deepEqual(selected.omitted.map((item) => item.reason), ["duplicate", "not-verified", "stale", "budget"]);
    assert.equal(selected.estimatedBytes, Buffer.byteLength("same\n"));
  });

  it("selects identically regardless of candidate arrival order and resolves duplicates by tier", () => {
    const warm = candidate("src/dedup.ts", "same", { tier: "WARM", status: "RELATED", reason: "older-read" });
    const hot = candidate("src/dedup.ts", "same", { tier: "HOT", status: "ACTIVE", reason: "current-read" });
    const upper = candidate("src/A.ts", "upper");
    const lower = candidate("src/a.ts", "lower");
    const select = (candidates: ContextCandidate[]) => selectContextFragments({ candidates, currentIntent: "", maxBytes: 100 });
    const forward = select([warm, lower, upper, hot]);
    const reversed = select([hot, upper, lower, warm]);
    assert.deepEqual(forward, reversed);
    assert.equal(forward.included[0]?.path, "src/A.ts");
    assert.equal(forward.included.find((item) => item.path === "src/dedup.ts")?.tier, "HOT");
    assert.equal(forward.omitted.filter((item) => item.path === "src/dedup.ts")[0]?.reason, "duplicate");
  });

  it("changes context priorities for discovery, implementation, and test-failure recovery", () => {
    const candidates = [
      candidate("src/feature.ts", "implementation source", { tier: "HOT", status: "ACTIVE" }),
      candidate("test/feature.spec.ts", "related test", { tier: "WARM", status: "RELATED" }),
      candidate("src/related.ts", "task-related source", { tier: "COLD", status: "RELATED" }),
    ];
    const first = (stage: "discovery" | "implementation" | "failure", relatedPaths: string[] = []) => selectContextFragments({
      candidates,
      currentIntent: "inspect feature",
      maxBytes: 100,
      stage,
      relatedPaths,
    }).included[0]?.path;
    assert.equal(first("discovery"), "test/feature.spec.ts");
    assert.equal(first("implementation"), "src/feature.ts");
    assert.equal(first("failure"), "test/feature.spec.ts");
    assert.equal(first("implementation", ["src/related.ts"]), "src/related.ts");
  });
});
