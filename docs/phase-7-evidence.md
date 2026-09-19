# Phase 7 Evidence — Release Hardening

Status: **not passed; release audit remains incomplete**

## Verified on this workspace

- Platform: macOS 15.6 arm64 (`Darwin 25.6.0 arm64`).
- Runtime pin: Node.js 24.21.0 (`.nvmrc`; package engine `>=24.21.0 <25`).
- Clean dependency install: `npm ci` completed under Node.js 24.21.0; npm reported zero vulnerabilities. npm skipped several unapproved dependency install scripts; the full test suite passed after installation, including native parser fixtures.
- Build and tests: `npm test` (134 passed, 0 failed), `npm run typecheck`, and `npm run build` passed with Node.js 24.21.0 on 2026-09-19. The Linux arm64 evidence below predates nine test additions made since that run; no Linux rerun was performed for these additions.
- Packaged CLI: `npm pack --dry-run`, then installed the tarball into a clean prefix using Node.js 24.21.0. The installed `macus --help` and `macus --version` commands passed; version `0.1.0`.
- Dependency audit: `npm audit --omit=dev` reported zero vulnerabilities.
- Linux arm64 validation: a pinned Node 24.21.0 Debian Bookworm container completed clean install (with `CXXFLAGS=-std=c++20` for Tree-sitter 0.21), all tests, typecheck, build, tarball installation, packaged CLI help/version smoke checks, and production dependency audit. The image included `ripgrep`, a runtime prerequisite.
- Recovery regressions include unknown outcome after a side effect when result persistence fails, recent-session continuation after restart, interrupted compaction, schema-migration rollback, and duplicate Pi tool-call replay refusal. Details remain in [phase-1-evidence.md](phase-1-evidence.md) and [phase-5-evidence.md](phase-5-evidence.md).

## Remaining release blockers

- `.github/workflows/ci.yml` now defines Ubuntu 24.04 and macOS 15 arm64 jobs, including tarball install smoke checks, but no hosted workflow run is available as evidence yet.
- No authorized live provider endpoint is configured; live compatibility is not claimed.
- The paired harness exists, but no controlled Macus-versus-unmodified-Pi measurements, baseline adapters, or quality-regression report exist. See [benchmark-protocol.md](benchmark-protocol.md).
- Phase gates 1–6 are not all green. Several compatibility, race/fault-injection, and large-repository performance cases remain explicitly open in their evidence files.
- Third-party license/attribution review is not complete. No project license was selected or inferred.

No external state was published or changed. This report does not claim release readiness or benchmark improvement.
