import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunController } from "../src/workflow/run-controller.js";

describe("bounded coding run controller", () => {
  it("stops before exceeding model-turn limits and respects run duration", () => {
    const run = new RunController({ maxModelTurns: 2, maxNoProgressAttempts: 3, maxDurationSeconds: 30 });
    assert.equal(run.beforeModelRequest(), true);
    run.assistantTurnEnded();
    assert.equal(run.beforeModelRequest(), true);
    run.assistantTurnEnded();
    assert.equal(run.beforeModelRequest(), false);
    assert.match(run.stopReason ?? "", /Model-turn limit/);
  });

  it("pauses on repeated identical failures but resets after progress", () => {
    const run = new RunController({ maxModelTurns: 40, maxNoProgressAttempts: 3, maxDurationSeconds: 30 });
    for (let attempt = 0; attempt < 2; attempt++) run.toolCompleted({ name: "read_range", isError: true, result: { message: "missing file" } });
    assert.equal(run.stopReason, undefined);
    run.toolCompleted({ name: "read_range", isError: false, result: { content: "fresh source" } });
    for (let attempt = 0; attempt < 2; attempt++) run.toolCompleted({ name: "read_range", isError: true, result: { message: "missing file" } });
    assert.equal(run.stopReason, undefined);
    run.toolCompleted({ name: "read_range", isError: true, result: { message: "missing file" } });
    assert.match(run.stopReason ?? "", /Repeated identical tool failure/);
  });
});
