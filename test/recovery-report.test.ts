import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatRecoveryReport } from "../src/workflow/recovery-report.js";

describe("recovery report", () => {
  it("shows redacted execution intent and recovery blockers without suggesting replay", () => {
    const report = formatRecoveryReport({
      executions: [{
        executionId: "push-1",
        status: "unknown",
        effectClass: "external",
        intentSummary: "git push origin main --token=[REDACTED]",
      }],
      unknownRunIds: ["run-1"],
      repositoryIdentityIssue: "saved branch/HEAD differs from the current workspace",
    });

    assert.match(report, /Execution "push-1" \["unknown"; "external"\]/);
    assert.match(report, /git push origin main --token=\[REDACTED\]/);
    assert.match(report, /run-1/);
    assert.match(report, /branch\/HEAD differs/);
    assert.match(report, /No command will be replayed automatically/i);
    assert.match(report, /\/clear/);
  });

  it("bounds command text and reports when recovery details are truncated", () => {
    const report = formatRecoveryReport({
      executions: [{ executionId: "large-1", status: "started", effectClass: "external", intentSummary: "x".repeat(2_000) }],
      unknownRunIds: [],
    });

    assert.ok(report.length < 1_000);
    assert.match(report, /intent summary truncated/i);
  });

  it("reports when no recovery blocker is present", () => {
    assert.equal(formatRecoveryReport({ executions: [], unknownRunIds: [] }), "No unresolved recovery items are recorded.\n");
  });
});
