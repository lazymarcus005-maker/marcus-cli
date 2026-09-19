import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateTestEvidence } from "../src/workflow/test-evidence.js";

const execution = { exitCode: 0, timedOut: false, cancelled: false, outputComplete: true };
const snapshot = "a".repeat(64);

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
    const evidence = evaluateTestEvidence({ format: "trx", report: '<ResultSummary outcome="Failed"><Counters total="2" passed="1" failed="1" notExecuted="0"/></ResultSummary>', execution: { ...execution, exitCode: 1 }, snapshotBefore: snapshot, snapshotAfter: snapshot });
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
