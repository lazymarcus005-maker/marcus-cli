# Phase 1 Evidence — Agent Foundation & Safety

Status: **in progress; gate not passed**

## Environment

- Workspace: bootstrapped locally on macOS.
- Required runtime: Node.js 24.21.0 (`.nvmrc`); focused and full verification currently runs through `npx node@24.21.0`.
- Pi SDK: `@earendil-works/pi-coding-agent@0.85.1`.
- Live provider endpoint: not configured or tested.

## Completed checks

| Check | Command | Result |
| --- | --- | --- |
| Current automated suite | `npm test` | 153 passed, 0 failed (2026-09-19); deterministic local providers only |
| Pi protocol and recovery checks | `npx tsx --test test/pi-runtime.test.ts` | 22 passed, 0 failed; nested tool-call and tool-result IDs form a correctly ordered protocol group; streaming, cancellation, compaction, dispose/replacement, resume, durable-completion/missing-transcript-result recovery, and inactive-branch reconciliation run against the deterministic local provider |
| Stale-edit preservation | `npx tsx --test test/safe-edit.test.ts` | 2 passed; an external edit is byte-for-byte retained when a stale replacement is rejected (2026-09-19) |
| Typecheck/build/package | `npm run typecheck`, `npm run build`, `npm pack --dry-run`, install the tarball in a clean prefix, then run packaged `macus --help` and `--version` with Node.js 24.21.0 | Passed on macOS arm64 (2026-09-19; tarball contains runtime artifacts, not compiled tests; version `0.1.0`) |
| Help/version smoke test | `node dist/src/cli.js --help` and `--version` under Node 24.21.0 | Passed (2026-09-19; version `0.1.0`) |
| Clean install / dependency audit | `npm ci` under Node.js 24.21.0 on Darwin arm64 | 272 packages installed; 0 vulnerabilities; npm reported unapproved optional/dependency install scripts, and the post-install full suite still passed |
| Previous-runtime check | `npx --yes -p node@22.19.0 -c 'node --version ...'` | Node 22.19.0; tests, typecheck, build and CLI smoke checks passed; superseded by the updated Node 24 LTS pin |

## Remaining gate evidence

- Rerun tests, typecheck, build and CLI smoke test under pinned Node 24.21.0 at phase sign-off; current checks pass, but the final release audit is still open.
- Explicitly unknown executions and cancelled side-effecting commands now keep recovery paused; reused Pi tool-call IDs are refused to prevent replay after a durable result but before transcript completion.
- The executor rechecks cancellation after asynchronous log allocation and before spawn; cancellation there records a confirmed prelaunch failure, leaves no unresolved effect, and does not run the command (covered by `test/policy-executor.test.ts`).
- Hash-checked replacement rejects stale source and verifies that the externally edited bytes remain unchanged; a denied source write preserves the file, journals nothing, and the denial is observed by the next provider request. Concurrent filesystem races beyond the final hash check remain open.
- Normal CLI startup continues the recent Pi session and verifies repository identity, preventing a process restart from silently creating a clean session around unresolved work. `/recovery` shows bounded redacted execution/tool intent, effect class, unknown run IDs, and repository identity blockers without exposing raw journal payloads or offering replay. A focused executor test confirms that a successful file side effect followed by failed result persistence remains unknown and a recovery gate after reopening SQLite.
- Real subprocess-crash tests leave `prepared` and workspace-changing `started` executions unfinished, and separately terminate after a durable completion but before Pi records the tool result. Resume changes each uncertain execution to `unknown` and keeps it recovery-blocking without replay.
- Live compatibility evidence is recorded for one authorized gateway (OpenCode Go, `deepseek-v4-flash`): streaming, tool-calls, the approval path, and a real workspace edit through the full CLI — see `docs/pi-compatibility.md`. The paired live benchmark is recorded in `docs/benchmark/live-paired-report.json`. Other providers/models remain untested; loopback tests still cover 8 MiB in-memory / 100 MiB spool limits, bounded session-scoped log access, retention and aggregate limits.
- Clean installation was verified on macOS arm64 and Linux arm64 (Debian Bookworm container); see [phase-7-evidence.md](phase-7-evidence.md). Hosted CI has not yet supplied an independent run.
- Configure an authorized endpoint for live compatibility evidence; current provider testing is loopback-only.
- A controlled paired benchmark has been recorded on the deterministic loopback provider (three order-alternated pairs, all correctness/recovery oracles passed, no regression); see `docs/benchmark-report.md` and `docs/benchmark/loopback-paired-report.json`. This is adapter-machinery evidence only: the loopback model is synthetic, so no live-endpoint or performance conclusion is supported.

The Pi adapter disables built-in tools and registers Macus policy-controlled tools. Local provider tests prove nested tool-call turns, session disposal/replacement, missing-capability fail-closed startup, denied writes, and compaction fault/crash boundaries; logs are spooled and checkpoint files reconciled. Crash-point reconciliation now covers before launch, after launch, write-before-persistence, durable completion before transcript persistence, crashes during compaction, and crashes mid-migration. The remaining Phase 1 gate item is authorized configured-endpoint compatibility evidence, so this is still not a Phase 1 pass.
