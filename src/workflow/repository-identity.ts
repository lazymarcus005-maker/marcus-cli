import type { SessionIdentity } from "../state/state-store.js";
import type { GitContext } from "./git-context.js";

export type RepositoryResumeCheck =
  | { status: "verified" }
  | { status: "mismatch"; reason: string }
  | { status: "unavailable"; reason: string };

/** Fail closed when the saved session lacks a Git baseline or branch/HEAD changed. */
export function checkRepositoryResumeIdentity(saved: SessionIdentity, current: GitContext): RepositoryResumeCheck {
  if (!saved.gitIdentityCaptured) return { status: "unavailable", reason: "Saved session has no branch/HEAD baseline; start a new session after reviewing repository state" };
  if (saved.gitBranch !== current.branch || saved.gitHead !== current.head) {
    return {
      status: "mismatch",
      reason: `Repository branch/HEAD changed (saved ${saved.gitBranch ?? "detached"}/${saved.gitHead ?? "unborn"}, current ${current.branch ?? "detached"}/${current.head ?? "unborn"}); inspect changes and use /clear to begin a new session`,
    };
  }
  return { status: "verified" };
}
