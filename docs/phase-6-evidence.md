# Phase 6 Evidence — Lightweight Relationships

Status: **implemented slice; phase gate not passed**

## Implemented

- Relationship edges and metadata are persisted in `.macus/cache/index.db`, keyed to the symbol-index generation and resolver version. Refresh replaces edge rows transactionally; the cache remains rebuildable.
- File containment is confirmed from indexed Tree-sitter declarations. Explicit TypeScript `implements` clauses are confirmed only when the named interface is unique. Static local imports are confirmed only when their source and uniquely resolved destination both have complete syntax coverage.
- Identifier-name references and possible test references are candidates only. The resolver does not infer receiver types, aliases, overload dispatch, or dynamic call targets.
- `find_references`, `find_dependencies`, `find_dependents`, and `impact` are registered as bounded, journaled repository tools. Results contain evidence path/range/hash/extraction, resolution, confidence hint, index generation, and coverage limitations.
- Work is bounded to 5,000 graph files, 64 MiB scanned source, 1 MiB per file, 100,000 edges, and 200 returned relationships. A source hash mismatch between symbol indexing and graph extraction omits that file's relationships.
- Graph absence never changes ordinary search/read/edit behavior. Empty graph results explicitly report partial coverage and do not claim absence of callers.
- Ambiguous extension/index imports remain unresolved; duplicate-name and method-call references remain candidates with source hash, resolver version, and generation evidence, never confirmed callers.

## Focused verification

- `test/relationship-graph.test.ts` verifies confirmed containment/import/implements edges, candidate references/test references, ambiguous-import and duplicate-name uncertainty, persistent cache readback, and partial empty-result behavior.
- `test/pi-runtime.test.ts` verifies dependency inspection through a journaled Pi custom tool.
- Focused graph and Pi runtime tests plus TypeScript typecheck passed during implementation.

## Open gate items

- C# `using`/base-type relations, re-export chains, aliases, and dynamic imports remain unresolved; JavaScript/TypeScript identifier references are deliberately lexical candidates.
- Graph refresh is generation-transactional but is not incrementally updated edge-by-edge after each changed file.
- No impact-driven broader test runner is wired; partial/empty graph results must continue to use ordinary search and user-selected broader tests.
- Full language fixtures, race/fault injection, performance bounds at repository scale, and the complete seven-phase release gates remain outstanding.
