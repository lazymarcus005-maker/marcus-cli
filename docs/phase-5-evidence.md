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

- State-store and execution tests cover several recovery boundaries: cancellation before authorization and while authorization is pending do not prepare journal entries or spawn; cancellation after durable intent but during asynchronous log allocation records a confirmed prelaunch failure and does not spawn; post-launch journal failure kills and observes the process group; a completed side effect whose result persistence fails remains `unknown` after database reopen; a `started` execution remains unresolved after database reopen; duplicate completed tool-call IDs are refused after database reopen; and injected migration failure rolls back and can be retried. Additional tests cover ledger/checkpoint recovery, branch/HEAD mismatch, unknown/cancelled-effect gates across restart, checkpoint reconciliation, and single-writer locks. This is partial evidence for issue #19, not the complete interruption matrix; process-crash gaps remain listed below. The pinned Node.js 24.21.0 full suite passes 140 tests; typecheck, build, and CLI smoke checks pass.
- Pi loopback tests cover manual compaction, one-dispatch request-budget rejection, overlapping prompt/compaction rejection, run cancellation, and persisted-session resume.
- Focused state, graph, Pi runtime tests and typecheck passed during implementation.

## Open gate items

- Goal remains null until explicitly recorded; checkpoints include bounded test-evidence references but not full diagnostic payloads or current context-selection provenance.
- Pi compaction internals own message cut-point/group preservation; Macus has not independently fault-injected malformed/pending tool exchanges across compaction.
- No measured prompt-cache optimization is implemented; automatic compaction remains intentionally disabled. Cancellation has loopback coverage; additional failure-mode and compaction-boundary fault injection remains open.
- Cross-store crash reconciliation, cancellation during an active compaction request, and compaction crash-point tests remain open.
- Issue #19 still lacks a full process-restart matrix for durable execution completion before Pi transcript completion and explicit unknown commit/push/external-side-effect inspection. Existing journal tests validate refusal/gating but do not substitute for those crash/restart scenarios.
