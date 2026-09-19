# Phase 7 Evidence — Release Hardening

Status: **not passed; release audit remains incomplete**

## Verified on this workspace

- Platform: macOS 15.6 arm64 (`Darwin 25.6.0 arm64`).
- Runtime pin: Node.js 24.21.0 (`.nvmrc`; package engine `>=24.21.0 <25`).
- Clean dependency install: `npm ci` completed under Node.js 24.21.0; npm reported zero vulnerabilities. npm skipped several unapproved dependency install scripts; the full test suite passed after installation, including native parser fixtures.
- Build and tests: `npm test` (148 passed, 0 failed), `npm run typecheck`, and `npm run build` passed with Node.js 24.21.0 on macOS arm64 on 2026-09-19.
- Packaged CLI: `npm pack --dry-run`, then installed the tarball into a clean prefix using Node.js 24.21.0. The installed `macus --help` and `macus --version` commands passed; version `0.1.0`.
- Dependency audit: `npm audit --omit=dev` reported zero vulnerabilities.
- Linux arm64 validation: a pinned Node 24.21.0 Debian Bookworm container completed clean install, all 148 tests, typecheck, and build against commit `f8145e6`. `npm ci` reported zero vulnerabilities. The packed tarball then installed into a clean prefix with `CXXFLAGS=-std=c++20` for Tree-sitter 0.21; packaged CLI help/version smoke checks passed. npm reported unapproved dependency install scripts that it skipped; the image included `git`, compiler tools, Python, and `ripgrep` for tests/build/runtime.
- Recovery regressions include cancellation during asynchronous log allocation before spawn, a subprocess crash after a file side effect but before completion persistence, an unknown side-effect outcome that survives state-database reopen after result persistence fails, bounded redacted `/recovery` inspection, recent-session continuation after restart, interrupted compaction, schema-migration rollback, and duplicate Pi tool-call replay refusal. Details remain in [phase-1-evidence.md](phase-1-evidence.md) and [phase-5-evidence.md](phase-5-evidence.md).

## Remaining release blockers

- `.github/workflows/ci.yml` now defines Ubuntu 24.04 and macOS 15 arm64 jobs, including tarball install smoke checks, but no hosted workflow run is available as evidence yet.
- No authorized live provider endpoint is configured; live compatibility is not claimed.
- The paired harness and partial in-process Pi/Macus adapters exist, but no controlled Macus-versus-unmodified-Pi measurements or quality-regression report exist. See [benchmark-protocol.md](benchmark-protocol.md).
- Phase gates 1–6 are not all green. Several compatibility, race/fault-injection, and large-repository performance cases remain explicitly open in their evidence files.
- Third-party license/attribution review is not complete. No project license was selected or inferred.

No external state was published or changed. This report does not claim release readiness or benchmark improvement.
