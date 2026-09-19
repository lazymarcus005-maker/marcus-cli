# Phase 4 Evidence — Coding Workflow & Evidence

Status: **in progress; gate not passed**

## Implemented slices

- Session-scoped tasks are persisted in SQLite with validated lifecycle transitions, one `in_progress` task per session, and `/tasks` plus `/task` commands. Test evidence recorded during an active task is linked in the same transaction; `/tasks` shows progress, blocked tasks, ledger blockers, and evidence statuses. Completing a task without evidence leaves `evidenceIds` empty and does not create or promote test evidence.
- A durable ledger blocker pauses new coding prompts at both the CLI and kernel boundaries until explicitly resolved by its same-session revision. A blocked task also pauses prompts unless an independent task is explicitly started; initial CLI prompts are gated by the same workflow checks.
- Git context reports branch/HEAD, bounded tracked diff, changed paths, and a digest that includes Git-reported dirty and non-ignored untracked file bytes. Ignored files are not included in that snapshot. New durable sessions atomically record their initial dirty paths as `pre_existing`; agent writes record old/new hashes, and shell-observed changes are labelled `external_or_unknown`.
- Before each coding prompt, changed Git paths are reconciled against their latest durable source hashes. Unrecorded differences are attributed `external_or_unknown`, related working-set fragments are marked stale, and passing test evidence is atomically invalidated. Recorded agent/shell changes also stale related fragments and passing evidence. In-session branch/HEAD mismatches stale all working-set fragments and passing evidence, then block the prompt pending a new session.
- Bounded `/git diff|log|show|blame` and a journaled agent `git_inspect` tool use fixed argument forms, repository-contained paths, cancellation, a 10-second subprocess limit, and 32 KiB model-facing output. Agent writes record old/new hashes; shell-observed worktree changes are explicitly `external_or_unknown`.
- `/test node-json -- COMMAND`, `/test junit|trx REPORT_PATH -- COMMAND`, and `/test unknown -- COMMAND` run through approval, the execution journal, timeout and output bounds. Parsed counts are persisted with command, timing, exit/signal, cancellation/timeout, output completeness, execution ID and snapshot identity. Node counts must reconcile with outcomes; TRX requires case-sensitive recognized run data and consistent counters. `/review` distinguishes `not_run` from an attempted command missing its evidence record. Unknown runners are recorded with status `unknown`, never passed. Commands are redacted before evidence persistence.
- Trusted global execution/log settings now reach the shell and test runners: command/test timeouts, termination grace, in-memory and spool caps, environment allowlist, retention, and aggregate log limits are applied. Every trusted provider API-key environment variable is stripped even if listed in the allowlist. Project attempts to add execution/log settings remain rejected.
- `/review` reports Changed, Tested, Remaining Risk, and Unresolved Issue from current Git context and durable test/run/task/execution records; missing test-command evidence is identified as `not_run`. It explicitly warns that the bounded report is not semantic code review.
- Empty, malformed, partial, timed-out, cancelled, stale-snapshot, unparseable and non-Git snapshot cases cannot produce a passing evidence status. TRX results additionally require a recognized completed/failed run outcome and internally consistent outcome counters; error/timeout counters count as failures, while incomplete or contradictory summaries remain unknown. JUnit/TRX sidecar reports must also have a changed file identity during the run; an unchanged valid report (including one with a future timestamp) remains unknown.
- Prompts and compaction are refused at the kernel boundary while an execution outcome is unresolved.

## Focused verification

Focused verification under Node.js 24.21.0 includes test-evidence classification, unknown-runner persistence, review formatting, Git snapshot attribution, and session state:

```text
node node_modules/tsx/dist/cli.mjs --test test/git-context.test.ts test/test-evidence.test.ts test/test-runner.test.ts test/state-store.test.ts test/search.test.ts test/pi-runtime.test.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
```

Focused verification under Node.js 24.21.0 passes; the full suite currently passes 134 tests. Typecheck, build and CLI help/version smoke checks pass. Live endpoint and cross-platform gates still remain.

## Open gate items

- Run limits exist for model turns, duration and repeated failures, but there is no full stage-aware bounded fix-loop controller.
- Attribution is hash-backed for Macus writes and startup dirty paths; shell-side changes remain `external_or_unknown`, and external editor changes are not continuously monitored.
- Snapshot hashing omits ignored files; test commands that rely on ignored inputs need additional freshness coverage before this gate can pass.
- Evidence stores bounded log references and supports JUnit/TRX/Node JSON, but broader report adapters and automatic test discovery are not implemented.
- `/review` reports evidence and unresolved state but does not perform semantic review or choose broader test fallback automatically.
