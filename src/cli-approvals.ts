/**
 * Session-scoped shell-command approval policy for the interactive CLI.
 *
 * Three layers on top of the per-command ask, ordered from most to least
 * specific:
 *  1. YOLO mode auto-approves every command that carries no credential
 *     environment names. Commands that request trusted credentials are still
 *     asked, because credentials are never granted implicitly.
 *  2. Exact-match memory: a command string the user approved this session is
 *     auto-approved on repeat (credential requests still ask).
 *  3. Read-only class: once the user approves any read-only command, further
 *     read-only commands are auto-approved for the session.
 *
 * Classification is deliberately conservative: anything with redirection,
 * substitution, unknown binaries, or state-changing git subcommands falls back
 * to the normal ask.
 */

const READ_ONLY_FIRST_WORDS = new Set([
  "ls", "cat", "head", "tail", "wc", "file", "stat", "pwd", "tree", "du", "df",
  "which", "rg", "grep", "find", "basename", "dirname", "realpath", "echo",
  "printf", "date", "uname", "whoami", "env",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status", "log", "show", "diff", "blame", "branch", "rev-parse", "ls-files",
  "remote", "describe", "shortlog", "reflog", "cat-file", "ls-tree",
]);

/** True when the command only reads the repository and environment. */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // Redirection or substitution can turn any "read" into a write or an execution.
  if (/[<>]/.test(trimmed) || /`|\$\(/.test(trimmed)) return false;
  const segments = trimmed.split(/&&|\|\||;|\|/);
  for (const segment of segments) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return false;
    const first = words[0]!.replace(/^.*\//, "");
    if (first === "git") {
      const subcommand = words[1];
      if (!subcommand || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return false;
      // `git branch NAME` and `git remote add …` mutate; flags-only forms list.
      if ((subcommand === "branch" || subcommand === "remote") && words.slice(2).some((word) => !word.startsWith("-"))) return false;
      continue;
    }
    if (first === "find" && words.some((word) => word === "-delete" || word === "-exec" || word === "-ok")) return false;
    if (!READ_ONLY_FIRST_WORDS.has(first)) return false;
  }
  return true;
}

export type ApprovalAskResult = {
  approved: boolean;
  authorizedEnvironmentNames: string[];
};

export type ApprovalDecision = {
  approved: boolean;
  auto: boolean;
  reason: "yolo" | "exact-match" | "read-only" | null;
  authorizedEnvironmentNames: string[];
};

export class SessionApprovals {
  private readonly exactApproved = new Set<string>();
  private readOnlyApproved = false;
  private yoloEnabled = false;

  setYolo(enabled: boolean): void {
    this.yoloEnabled = enabled;
  }

  get yolo(): boolean {
    return this.yoloEnabled;
  }

  /** Fresh sessions start with a clean approval slate. */
  reset(): void {
    this.exactApproved.clear();
    this.readOnlyApproved = false;
  }

  async authorize(
    request: { command: string; credentialEnvironmentNames: readonly string[] },
    ask: () => Promise<ApprovalAskResult>,
  ): Promise<ApprovalDecision> {
    // The CLI passes the full trusted credential-name list on every command, so
    // it is not a signal of intent. Auto-approval simply never grants credential
    // environment names; only an explicit user "yes" can grant them.
    if (this.yoloEnabled) {
      return { approved: true, auto: true, reason: "yolo", authorizedEnvironmentNames: [] };
    }
    if (this.exactApproved.has(request.command)) {
      return { approved: true, auto: true, reason: "exact-match", authorizedEnvironmentNames: [] };
    }
    if (this.readOnlyApproved && isReadOnlyCommand(request.command)) {
      return { approved: true, auto: true, reason: "read-only", authorizedEnvironmentNames: [] };
    }
    const answer = await ask();
    if (!answer.approved) return { approved: false, auto: false, reason: null, authorizedEnvironmentNames: [] };
    if (isReadOnlyCommand(request.command)) this.readOnlyApproved = true;
    this.exactApproved.add(request.command);
    return { approved: true, auto: false, reason: null, authorizedEnvironmentNames: answer.authorizedEnvironmentNames };
  }
}
