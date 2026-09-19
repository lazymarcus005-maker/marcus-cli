# Phase 7 Evidence — Release Hardening

Status: **not passed; release audit remains incomplete**

## Verified on this workspace

- Platform: macOS 15.6 arm64 (`Darwin 25.6.0 arm64`).
- Runtime pin: Node.js 24.21.0 (`.nvmrc`; package engine `>=24.21.0 <25`).
- Clean dependency install: `npm ci` completed under Node.js 24.21.0; npm reported zero vulnerabilities. npm skipped several unapproved dependency install scripts; the full test suite passed after installation, including native parser fixtures.
- Build and tests: `npm test` (153 passed, 0 failed), `npm run typecheck`, and `npm run build` passed with Node.js 24.21.0 on macOS arm64 on 2026-09-19.
- Reference fixture generation: on the Mac mini M4 Pro 48 GB, the default generator produced 10,000 included source files (4,000 TypeScript, 3,000 JavaScript, 3,000 C#) totaling exactly 104,857,600 bytes and emitted a deterministic SHA-256 manifest. The temporary corpus was removed after verification. No indexing, search, startup, or performance benchmark was run.
- Packaged CLI: `npm pack --dry-run`, then installed the tarball into a clean prefix using Node.js 24.21.0. The installed `macus --help` and `macus --version` commands passed; version `0.1.0`.
- Dependency audit: `npm audit --omit=dev` reported zero vulnerabilities.
- Linux arm64 validation: a pinned Node 24.21.0 Debian Bookworm container completed clean install, all 153 tests, typecheck, and build against commit `e6f3a46`. `npm ci` and `npm audit --omit=dev` reported zero vulnerabilities. The packed tarball then installed into a clean prefix with `CXXFLAGS=-std=c++20` for Tree-sitter 0.21; packaged CLI help/version smoke checks passed (`0.1.0`). npm reported unapproved dependency install scripts that it skipped; the image included `git`, compiler tools, Python, and `ripgrep` for tests/build/runtime.
- Recovery regressions include cancellation during asynchronous log allocation before spawn, subprocess crashes before execution completion and after durable completion but before Pi transcript-result persistence, rejection of inactive-branch tool results during reconciliation, an unknown side-effect outcome that survives state-database reopen after result persistence fails, bounded redacted `/recovery` inspection, recent-session continuation after restart, interrupted compaction (cancellation, provider failure, and a real SIGKILL mid-compaction after checkpoint durability), a real process crash mid-migration with clean retry, schema-migration rollback, denied source writes, and duplicate Pi tool-call replay refusal. Details remain in [phase-1-evidence.md](phase-1-evidence.md) and [phase-5-evidence.md](phase-5-evidence.md).

## Verification of the final hardening pass (2026-09-19, commit `6d3988c`)

- Full suite under pinned Node.js 24.21.0: 157 passed, 0 failed (153 prior plus new recovery/authorization regression tests).
- `npm run typecheck`, `npm run build`, `npm pack --dry-run`, and packaged `macus --help`/`--version` (`0.1.0`) passed on this workspace.
- License inventory regenerated from the pinned lockfile: 204 production packages, unchanged identifiers, application license still deliberately unselected (`null`).
- Paired benchmark evidence recorded under the pinned runtime on this reference-hardware Mac mini; see [benchmark-report.md](benchmark-report.md).

## Remaining release blockers

- Macus conservative byte≈token budget guard pauses long tool-heavy sessions on 128k-context models before completion (measured in the live benchmark; see [benchmark-report.md](benchmark-report.md)) — the principal #20 blocker and a product decision point (refine the estimator per spec §5.2 or accept the ceiling).
- ~~Hosted CI evidence~~ — hosted run `35455212152` is green on both platforms (see above).
- ~~Authorized live endpoint~~ — evidenced for the OpenCode Go gateway (see `docs/pi-compatibility.md`); other providers remain untested.
- ~~Project license~~ — MIT selected; `docs/THIRD_PARTY_NOTICES.md` generated from the installed tree (204 packages, all permissive identifiers).
- `.github/workflows/ci.yml` defines Ubuntu 24.04 and macOS 15 arm64 jobs, including tarball install smoke checks. The first hosted runs failed only because the macOS runner lacked `rg`; after the workflow began installing ripgrep on both runners, hosted run `35455212152` completed green on `ubuntu-24.04` and `macos-15` against commit `abb2414` (tests, typecheck, build, license inventory, packed-CLI smoke checks).
- No authorized live provider endpoint is configured; live compatibility is not claimed.
- Two controlled paired benchmark records exist on the reference hardware: the deterministic loopback fixture run (18/18 oracles passed, no regression) and a live run against the authorized OpenCode Go gateway (`deepseek-v4-flash`, 3 task classes, 0 regressions on valid pairs, unknowns labeled). See [benchmark-report.md](benchmark-report.md). Open: remaining §39 task classes, warm-cache conditions, multi-provider coverage, and the Macus budget-guard scaling pause on long sessions (the principal #20 blocker).
- Phase gates 1–6 are not all green. Several compatibility, race/fault-injection, and large-repository performance cases remain explicitly open in their evidence files.
- Third-party license/attribution review is not complete. No project license was selected or inferred.

No external state was published or changed. This report does not claim release readiness or benchmark improvement.
