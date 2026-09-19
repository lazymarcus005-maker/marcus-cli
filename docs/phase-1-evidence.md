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
| Current automated suite | `npm test` | 137 passed, 0 failed (2026-09-19); deterministic local providers only |
| Pi protocol and recovery checks | `npx tsx --test test/pi-runtime.test.ts` | 20 passed, 0 failed; nested tool-call and tool-result IDs form a correctly ordered protocol group; streaming, cancellation, compaction, dispose/replacement, and resume checks run against the deterministic local provider |
| Stale-edit preservation | `npx tsx --test test/safe-edit.test.ts` | 2 passed; an external edit is byte-for-byte retained when a stale replacement is rejected (2026-09-19) |
| Typecheck/build/package | `npm run typecheck`, `npm run build`, `npm pack --dry-run`, install the tarball in a clean prefix, then run packaged `macus --help` and `--version` with Node.js 24.21.0 | Passed on macOS arm64 (2026-09-19; tarball contains runtime artifacts, not compiled tests; version `0.1.0`) |
| Help/version smoke test | `node dist/src/cli.js --help` and `--version` under Node 24.21.0 | Passed (2026-09-19; version `0.1.0`) |
| Clean install / dependency audit | `npm ci` under Node.js 24.21.0 on Darwin arm64 | 272 packages installed; 0 vulnerabilities; npm reported unapproved optional/dependency install scripts, and the post-install full suite still passed |
| Previous-runtime check | `npx --yes -p node@22.19.0 -c 'node --version ...'` | Node 22.19.0; tests, typecheck, build and CLI smoke checks passed; superseded by the updated Node 24 LTS pin |

## Remaining gate evidence

- Rerun tests, typecheck, build and CLI smoke test under pinned Node 24.21.0 at phase sign-off; current checks pass, but the final release audit is still open.
- Complete Pi compatibility evidence for explicit unavailable-capability failures and session replacement; streaming, nested tool turn, cancellation, manual compaction, instruction injection, and request-budget rejection have loopback-provider tests.
- Complete centralized read/write/tool authorization and bounded-output policy; interrupted runs and execution intents are journaled and gated, but full crash-point reconciliation and user-change preservation remain open.
- Explicitly unknown executions and cancelled side-effecting commands now keep recovery paused; reused Pi tool-call IDs are refused to prevent replay after a durable result but before transcript completion.
- Hash-checked replacement rejects stale source and verifies that the externally edited bytes remain unchanged; concurrent filesystem races beyond the final hash check remain open.
- Normal CLI startup continues the recent Pi session and verifies repository identity, preventing a process restart from silently creating a clean session around unresolved work. A focused executor test confirms that a successful file side effect followed by failed result persistence is recorded as unknown and remains a recovery gate.
- Run the authorized configured-endpoint checks; current execution/log unit tests cover 8 MiB in-memory / 100 MiB spool limits, bounded session-scoped log access, retention and aggregate limits.
- Clean installation was verified on macOS arm64 and Linux arm64 (Debian Bookworm container); see [phase-7-evidence.md](phase-7-evidence.md). Hosted CI has not yet supplied an independent run.
- Configure an authorized endpoint for live compatibility evidence; current provider testing is loopback-only.
- The paired benchmark harness and a partial in-process Pi SDK baseline adapter are implemented and locally tested. The adapter reports observed loopback token usage, preserves unknown metrics when usage is omitted, and treats failed prompts as unknown correctness/recovery; it does not apply scenario generation settings or measure isolated CLI RSS/first-useful-edit time. No live endpoint or controlled paired measurements are available; no performance claims are made. See `docs/benchmark-protocol.md`.

The Pi adapter disables built-in tools and registers Macus policy-controlled tools. Local provider tests prove nested tool-call turns and session disposal/replacement; logs are spooled and checkpoint files reconciled. Full interruption/crash reconciliation, baseline evidence, and actual configured endpoint compatibility remain incomplete, so this is not a Phase 1 pass.
