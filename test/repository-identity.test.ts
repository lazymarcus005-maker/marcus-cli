import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkRepositoryResumeIdentity } from "../src/workflow/repository-identity.js";
import type { GitContext } from "../src/workflow/git-context.js";
import type { SessionIdentity } from "../src/state/state-store.js";

const context = (branch: string | null, head: string | null): GitContext => ({ isRepository: true, branch, head, changedFiles: [], fileHashes: [], diff: "", diffTruncated: false, snapshotDigest: "snapshot" });
const saved: SessionIdentity = { sessionId: "s", worktreeRoot: "/repo", gitDirectory: "/repo/.git", gitBranch: "main", gitHead: "abc", gitIdentityCaptured: true };

describe("repository resume identity", () => {
  it("allows exact branch and HEAD identity and pauses on either change", () => {
    assert.deepEqual(checkRepositoryResumeIdentity(saved, context("main", "abc")), { status: "verified" });
    assert.equal(checkRepositoryResumeIdentity(saved, context("feature", "abc")).status, "mismatch");
    assert.equal(checkRepositoryResumeIdentity(saved, context("main", "def")).status, "mismatch");
  });

  it("fails closed for legacy sessions without a captured repository baseline", () => {
    const legacy: SessionIdentity = { sessionId: "old", worktreeRoot: "/repo", gitDirectory: "/repo/.git" };
    const result = checkRepositoryResumeIdentity(legacy, context("main", "abc"));
    assert.equal(result.status, "unavailable");
    assert.ok("reason" in result);
    assert.match(result.reason, /no branch\/HEAD baseline/);
  });
});
