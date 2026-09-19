# Phase 2 Evidence — Repository Intelligence

Status: **partial; phase gate not passed**

## Implemented

- Repository enumeration uses ripgrep with a 16 MiB listing cap and a 20,000-file cap, with Git/Macus ignore rules and generated, dependency, credential, key, and secret exclusions.
- Tree-sitter indexing supports the configured TS/TSX, JS/JSX, and C# grammars. Per-file parser input is capped at 1 MiB; the indexer checks file size before reading, reads no more than the cap plus one byte, and detects metadata changes during the read. Oversized and unstable files produce partial coverage without invented symbols.
- The index cache rehashes supported-size files before reuse, invalidates renamed/deleted paths, and records parse coverage. The repository map prioritizes important files and declarations within its configured conservative byte/token budget.
- A malformed rebuildable symbol-index database is quarantined and rebuilt; indexing continues if cache recovery is unavailable, and cache/coverage status is shown in map and symbol inspection. Durable session-state files are not modified by this recovery path.
- Literal-by-default ripgrep search, query-bound continuation, bounded source ranges, hash-checked source edits, and explicit partial graph coverage are implemented. Search continuation tokens reject repository file-set/stat-generation changes.

## Focused verification

- `test/symbol-index.test.ts` covers TS/JS/C# declarations, parse/unsupported coverage, freshness, exclusions, a 32 MiB sparse source file that remains partial without being read or hashed, and corrupt-cache quarantine/rebuild with a byte-identical session-state sentinel.
- `test/repo-map.test.ts` verifies priority ordering and map-budget bounds.
- `test/search.test.ts` verifies literal search, continuation, stale-cursor rejection, invalid regex, no-match, bounded reads, and path exclusions.
- The full suite, typecheck, build, and CLI smoke checks passed on the current implementation snapshot under Node.js 24.21.0. These checks do not prove large-repository latency or cross-platform parser behavior.

## Open gate items

- Indexing and parsing are synchronous and do not run in a bounded worker; maps/indexes may delay TUI work on a large but allowed repository.
- Symlink traversal, concurrent rename/replacement, and source changes between authorization and use need broader race tests.
- Full language fixture coverage, incremental invalidation fault injection, configurable worker/resource budgets, and large-repository performance evidence remain outstanding.
