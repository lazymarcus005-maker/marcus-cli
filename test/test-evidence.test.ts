import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateTestEvidence } from "../src/workflow/test-evidence.js";

const execution = { exitCode: 0, timedOut: false, cancelled: false, outputComplete: true };
const snapshot = "a".repeat(64);
const defaultTrxCounters = {
  total: 2,
  executed: 2,
  passed: 2,
  failed: 0,
  error: 0,
  timeout: 0,
  aborted: 0,
  inconclusive: 0,
  passedButRunAborted: 0,
  notRunnable: 0,
  notExecuted: 0,
  disconnected: 0,
  warning: 0,
  completed: 0,
  inProgress: 0,
  pending: 0,
};

function trxSummary(outcome: string, counters: Partial<typeof defaultTrxCounters> = {}): string {
  const attributes = Object.entries({ ...defaultTrxCounters, ...counters })
    .map(([name, count]) => `${name}="${count}"`)
    .join(" ");
  return `<TestRun><ResultSummary outcome="${outcome}"><Counters ${attributes}/></ResultSummary></TestRun>`;
}

describe("test evidence classification", () => {
  it("passes only a parsed non-empty successful report for an unchanged snapshot", () => {
    const evidence = evaluateTestEvidence({
      format: "junit",
      report: '<testsuites><testsuite tests="3" failures="0" errors="0" skipped="1"/></testsuites>',
      execution,
      snapshotBefore: snapshot,
      snapshotAfter: snapshot,
    });
    assert.equal(evidence.status, "passed");
    assert.equal(evidence.tests, 3);
    assert.equal(evidence.skipped, 1);
  });

  it("does not call empty, malformed, stale, partial, timed-out, or cancelled results a pass", () => {
    const common = { format: "junit" as const, execution, snapshotBefore: snapshot, snapshotAfter: snapshot };
    assert.equal(evaluateTestEvidence({ ...common, report: '<testsuite tests="0" failures="0"/>' }).status, "unknown");
    assert.equal(evaluateTestEvidence({ ...common, report: "not xml" }).parserStatus, "failed");
    assert.equal(evaluateTestEvidence({ ...common, report: '<testsuite tests="2" failures="0">' }).status, "unknown");
    assert.equal(evaluateTestEvidence({ ...common, report: '<testsuite tests="2" failures="0"/>', snapshotAfter: "b".repeat(64) }).status, "unknown");
    assert.equal(evaluateTestEvidence({ ...common, report: '<testsuite tests="2" failures="0"/>', snapshotValid: false }).status, "unknown");
    assert.equal(evaluateTestEvidence({ ...common, report: '<testsuite tests="2" failures="0"/>', execution: { ...execution, outputComplete: false } }).status, "unknown");
    assert.equal(evaluateTestEvidence({ ...common, report: '<testsuite tests="2" failures="0"/>', execution: { ...execution, timedOut: true } }).status, "unknown");
    assert.equal(evaluateTestEvidence({ ...common, report: '<testsuite tests="2" failures="0"/>', execution: { ...execution, cancelled: true } }).status, "unknown");
  });

  it("reports an actual test failure as failed rather than unknown", () => {
    const report = trxSummary("Failed", { passed: 1, failed: 1 });
    const evidence = evaluateTestEvidence({ format: "trx", report, execution: { ...execution, exitCode: 1 }, snapshotBefore: snapshot, snapshotAfter: snapshot });
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.failed, 1);
  });

  it("passes a complete, internally consistent TRX summary", () => {
    const report = trxSummary("Completed");
    const evidence = evaluateTestEvidence({ format: "trx", report, execution, snapshotBefore: snapshot, snapshotAfter: snapshot });
    assert.equal(evidence.status, "passed");
    assert.equal(evidence.tests, 2);
    assert.equal(evidence.passed, 2);
  });

  it("does not pass Node JSON reports with contradictory test totals", () => {
    const common = {
      format: "node-json",
      execution,
      snapshotBefore: snapshot,
      snapshotAfter: snapshot,
    } as const;
    const inconsistent = JSON.stringify({ summary: { counts: { tests: 3, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 } } });
    const consistent = JSON.stringify({ summary: { counts: { tests: 3, passed: 1, failed: 0, cancelled: 0, skipped: 1, todo: 1 } } });
    const cancelled = JSON.stringify({ summary: { counts: { tests: 2, passed: 1, failed: 0, cancelled: 1, skipped: 0, todo: 0 } } });
    assert.equal(evaluateTestEvidence({ ...common, report: inconsistent }).status, "unknown");
    assert.equal(evaluateTestEvidence({ ...common, report: consistent }).status, "passed");
    assert.equal(evaluateTestEvidence({ ...common, report: cancelled }).status, "unknown");
  });

  it("does not pass TRX summaries with no passed tests or contradictory outcomes", () => {
    const noOutcomes = trxSummary("Completed", { total: 1, executed: 0, passed: 0 });
    const contradictory = trxSummary("Failed");
    const common = { format: "trx" as const, execution, snapshotBefore: snapshot, snapshotAfter: snapshot };
    assert.notEqual(evaluateTestEvidence({ ...common, report: noOutcomes }).status, "passed");
    assert.notEqual(evaluateTestEvidence({ ...common, report: contradictory }).status, "passed");
  });

  it("rejects inconsistent executed counters and ignores summary-like XML comments", () => {
    const executedMismatch = trxSummary("Completed", { executed: 0 });
    const passingComment = `<TestRun><!-- ${trxSummary("Completed")} -->${trxSummary("Failed", { passed: 1, failed: 1 })}</TestRun>`;
    const conflictingAttributes = '<TestRun><ResultSummary outcome="Failed" outcome="Completed"><Counters total="2" executed="2" passed="2" failed="0" error="0" timeout="0" aborted="0" inconclusive="0" passedButRunAborted="0" notRunnable="0" notExecuted="0" disconnected="0" warning="0" completed="0" inProgress="0" pending="0"/></ResultSummary></TestRun>';
    const malformedEntity = '<TestRun>unescaped & text<ResultSummary outcome="Completed"><Counters total="2" executed="2" passed="2" failed="0" error="0" timeout="0" aborted="0" inconclusive="0" passedButRunAborted="0" notRunnable="0" notExecuted="0" disconnected="0" warning="0" completed="0" inProgress="0" pending="0"/></ResultSummary></TestRun>';
    const malformedComment = '<TestRun><!-- invalid -- comment -->' + trxSummary("Completed").replace(/^<TestRun>|<\/TestRun>$/g, "") + "</TestRun>";
    const malformedCommentTerminator = '<TestRun><!--x--->' + trxSummary("Completed").replace(/^<TestRun>|<\/TestRun>$/g, "") + "</TestRun>";
    const malformedDeclaration = `<?xml?>${trxSummary("Completed")}`;
    const validDeclaration = `<?xml version="1.0" encoding="utf-8"?>${trxSummary("Completed")}`;
    const wrongCaseTags = trxSummary("Completed")
      .replaceAll("ResultSummary", "resultsummary")
      .replaceAll("Counters", "counters");
    const hiddenPass = trxSummary("Completed");
    const failedWithHiddenPass = `<TestRun><!--${hiddenPass}--><![CDATA[${hiddenPass}]]><?review ${hiddenPass} ?>${trxSummary("Failed", { passed: 1, failed: 1 })}</TestRun>`;
    const common = { format: "trx" as const, execution, snapshotBefore: snapshot, snapshotAfter: snapshot };
    assert.notEqual(evaluateTestEvidence({ ...common, report: executedMismatch }).status, "passed");
    assert.equal(evaluateTestEvidence({ ...common, report: passingComment }).status, "failed");
    assert.notEqual(evaluateTestEvidence({ ...common, report: conflictingAttributes }).status, "passed");
    assert.notEqual(evaluateTestEvidence({ ...common, report: malformedEntity }).status, "passed");
    assert.notEqual(evaluateTestEvidence({ ...common, report: malformedComment }).status, "passed");
    assert.notEqual(evaluateTestEvidence({ ...common, report: malformedCommentTerminator }).status, "passed");
    assert.notEqual(evaluateTestEvidence({ ...common, report: malformedDeclaration }).status, "passed");
    assert.equal(evaluateTestEvidence({ ...common, report: validDeclaration }).status, "passed");
    assert.notEqual(evaluateTestEvidence({ ...common, report: wrongCaseTags }).status, "passed");
    assert.equal(evaluateTestEvidence({ ...common, report: trxSummary("Completed", { total: 0, executed: 0, passed: 0 }) }).status, "unknown");
    assert.notEqual(evaluateTestEvidence({ ...common, report: '<Bogus>' + trxSummary("Completed").replace(/^<TestRun>|<\/TestRun>$/g, "") + "</Bogus>" }).status, "passed");
    assert.equal(evaluateTestEvidence({ ...common, report: failedWithHiddenPass }).status, "failed");
  });

  it("counts TRX error and timeout outcomes as failures", () => {
    const report = trxSummary("Failed", { total: 1, executed: 1, passed: 0, error: 1 });
    const evidence = evaluateTestEvidence({ format: "trx", report, execution, snapshotBefore: snapshot, snapshotAfter: snapshot });
    assert.equal(evidence.status, "failed");
    assert.equal(evidence.failed, 1);
  });

  it("keeps unsupported test runners explicitly unknown", () => {
    const evidence = evaluateTestEvidence({ format: "unknown", report: "", execution, snapshotBefore: snapshot, snapshotAfter: snapshot });
    assert.equal(evidence.status, "unknown");
    assert.match(evidence.reason ?? "", /unsupported/);
    assert.equal(evidence.tests, null);
  });
});
