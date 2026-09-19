# Macus Code

Macus Code is a local-first CLI coding agent built around the public Pi SDK. The repository is being bootstrapped against the v1.1 product specification; preview capabilities are gated by the evidence in `docs/phase-1-evidence.md` and later phase reports.

## Requirements

- Node.js 24.21.x
- npm
- `ripgrep` (`rg`) and Git
- On Linux, a C++20-capable compiler toolchain (`make`, Python, and a C++ compiler) for the pinned Tree-sitter native binding.

## Development

```sh
# Linux: compile the pinned Tree-sitter 0.21 binding with C++20.
CXXFLAGS=-std=c++20 npm ci
npm test
npm run typecheck
npm run build
node scripts/license-inventory.mjs
npm start -- --help
```

Run `npm start -- "your coding task"` to begin an interactive session with an initial prompt. Configure a trusted provider first; see `docs/configuration.md`. Repository and shell tools run through Macus's approval-gated policy, journaling, and output bounds. The release tarball also exposes a `macus` executable.

The current build has broad implemented functionality, but it is not yet a production-ready release: live-provider compatibility, baseline measurements, Linux validation, and several phase gates remain open. See `docs/implementation-map.md` and the phase evidence, especially `docs/phase-7-evidence.md`, for the exact status.
