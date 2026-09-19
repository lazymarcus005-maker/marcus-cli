# Phase 5 Evidence — Durable Context & Optimization

Status: **partial; phase gate not passed**

## Implemented

- Transactional session-scoped ledger revisions record tasks, test evidence, source changes, run lifecycle, and checkpoints.
- Durable checkpoint files are bounded, private, fsynced, atomically renamed, then registered in SQLite. Checkpoints include Pi transcript leaf, recent ledger, task snapshot, source hashes, repository snapshot digest, goal, decisions, blockers, important working-set symbols, current evidence references, pending execution references in both the file and SQLite row, and next action. `/goal`, `/decision`, `/blocker`, and `/next-action` append bounded provenance-bearing ledger revisions.
- Restore checks session/worktree identity, transcript entry, checkpoint-file integrity, task payload shape, and changed-source hashes. It restores transcript/task state only; source bytes and shell side effects are not rolled back.
- Manual `/compact` writes a durable checkpoint first. Pi automatic compaction is disabled so Macus remains the only compaction authority. Kernel operation guards serialize prompt, compaction, transcript restore, and session start/dispose; compaction is rejected during an active prompt or unresolved execution.
- Request budgets remain active after compaction, so a later over-budget request is rejected before provider dispatch.
- `/compact` now supplies Pi a bounded preservation contract and checkpoint state covering goal, tasks, decisions, blockers, evidence freshness, unresolved executions, and next action. The context selector changes ranking by workflow stage: broader related context during discovery, active/HOT and task-file context during implementation, and test-focused context after a failed test result.
- Explicit cancellation uses Pi's public compaction-specific abort API. A loopback integration test confirms the compaction request settles, its stream closes, and the prior conversation is still present and usable for a later prompt. Model requests, including compaction, still pass through the serialized-payload budget hook.

## Focused verification

- State-store tests cover ledger/checkpoint persistence including unresolved executions in the durable checkpoint file, task snapshot restore, legacy migrations through schema v5, an injected transactional migration failure with successful retry, checkpoint source verification, single-writer locks, refusal to replay a completed Pi tool-call ID, and recovery pauses for explicitly unknown or cancelled side-effecting executions and already-unknown runs across repeated restarts. Explicit session resume compares the saved Git branch/HEAD baseline and pauses on mismatch or when legacy identity is unavailable. The pinned Node.js 24.21.0 full suite passes 120 tests; typecheck, build, and CLI smoke checks pass.
- Pi loopback tests cover manual compaction, one-dispatch request-budget rejection, overlapping prompt/compaction rejection, run cancellation, and persisted-session resume.
- Focused state, graph, Pi runtime tests and typecheck passed during implementation.

## Open gate items

- Goal remains null until explicitly recorded; checkpoints include bounded test-evidence references but not full diagnostic payloads or current context-selection provenance.
- Pi compaction internals own message cut-point/group preservation; Macus has not independently fault-injected malformed/pending tool exchanges across compaction.
- No measured prompt-cache optimization is implemented; automatic compaction remains intentionally disabled. Cancellation has loopback coverage; additional failure-mode and compaction-boundary fault injection remains open.
- Cross-store crash reconciliation, cancellation during an active compaction request, and compaction crash-point tests remain open.
