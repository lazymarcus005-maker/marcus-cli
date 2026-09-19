import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatReviewReport } from "../src/workflow/review-report.js";
import type { GitContext } from "../src/workflow/git-context.js";

describe("bounded close-out review report", () => {
  it("reports changed, tested, risk, and unresolved issue sections without overstating evidence", () => {
    const context: GitContext = {
      isRepository: true,
      branch: "feature",
      head: "abc",
      changedFiles: [{ path: "src/new.ts", status: "untracked" }],
      fileHashes: [],
      diff: "",
      diffTruncated: false,
      snapshotDigest: "current",
    };
    const report = formatReviewReport({
      context,
      evidence: [{ evidenceId: "ev-1", snapshotDigest: "old", status: "passed", payload: { executionId: "test-exec-1", command: "npm test", durationMs: 52, tests: 3, passed: 3, failed: 0, parserStatus: "parsed", exitCode: 0, signal: null, timedOut: false, cancelled: false, outputComplete: true, logRef: "log-1" } }],
      latestTestExecutionId: "test-exec-1",
      unresolvedExecutions: [{ executionId: "exec-1", status: "started" }],
      runs: [],
      tasks: [],
    });
    for (const heading of ["Changed:", "Tested:", "Remaining Risk:", "Unresolved Issue:"]) assert.ok(report.includes(heading));
    assert.match(report, /npm test/);
    assert.doesNotMatch(report, /no matching evidence/);
    assert.match(report, /stale for the current workspace snapshot/);
    assert.match(report, /Untracked files/);
    assert.match(report, /execution exec-1: started/);
  });

  it("surfaces blocked tasks as unresolved and distinguishes tests not run from unknown evidence", () => {
    const context: GitContext = { isRepository: false, branch: null, head: null, changedFiles: [], fileHashes: [], diff: "", diffTruncated: false, snapshotDigest: "none" };
    const report = formatReviewReport({
      context,
      evidence: [],
      unresolvedExecutions: [],
      runs: [],
      tasks: [{ sessionId: "s", id: "t", title: "Investigate regression", status: "blocked", relatedFiles: [], relatedSymbols: [], notes: [], createdAt: "now", updatedAt: "now", evidenceIds: [] }],
      ledger: [{ revision: 3, payload: { kind: "blocker", text: "Need live provider access." } }],
    });
    assert.match(report, /no test command recorded \(not_run\)/);
    assert.match(report, /test status is not_run/);
    assert.match(report, /task t: blocked/);
    assert.match(report, /Need live provider access/);
    assert.match(report, /Git snapshot unavailable/);

    const unrecordedRun = formatReviewReport({
      context,
      evidence: [],
      unresolvedExecutions: [],
      runs: [],
      tasks: [],
      latestTestExecutionId: "test-exec-1",
    });
    assert.match(unrecordedRun, /test command ran, but no evidence was recorded \(unknown\)/);
  });
});
