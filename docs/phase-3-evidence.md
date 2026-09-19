# Phase 3 Evidence — Context Runtime

Status: **in progress; gate not passed**

## Implemented

- SQLite schema v5 stores session-scoped ACTIVE/RELATED/DISCOVERED/STALE working-set entries independently from HOT/WARM/COLD priority. Search discovers paths, verified reads activate them, symbol lookup marks related candidates, and successful writes replace their stored hash/range.
- The pinned Pi 0.85.1 async `context` hook composes source context before each provider request. Each ACTIVE/RELATED candidate is re-read and hash-checked; stale or unauthorized ranges are omitted and marked stale.
- Deterministic selection scores exact path/task relevance, tier, status, and path overlap; tie ordering is locale-independent, candidate-order-independent, and resolves duplicate keys by a fixed HOT/ACTIVE-first preference. It deduplicates exact path/hash/range candidates, applies a conservative byte budget, and records explicit omission reasons.
- The effective provider view adds tagged selected fragments. Existing tool call/result messages remain paired and in order. When a prior tagged read is superseded by a changed hash, only its effective-view result body is replaced with a superseded marker; Pi's stored transcript remains untouched.
- Request manifests identify request/session/model/adapter, SHA-256 of the exact serialized payload observed at the HTTP boundary, repository-instruction paths/hashes, included/omitted source-fragment provenance, and mutually exclusive serialized-byte categories. `/context files` exposes instruction and source details; `/context` shows last request separately from its next-request cap. The last manifest is preserved across an in-session model switch until a new request is dispatched.
- Per-prompt run limits enforce model-turn, duration, and repeated-identical-failure ceilings. Runs are persisted, executions link to their run, and interrupted runs are marked unknown and gated from automatic continuation.

## Verification performed

- Focused selector, state-store, request-budget, and loopback Pi runtime tests passed after the implementation changes; the loopback test observed a fresh injected fragment, omitted a stale one, and confirmed a write-follow-up request used the new hash/content without the prior read body.
- Typecheck passed after those changes.
- Current full suite passes on Node.js 24.21.0 (134 tests); typecheck and build pass on the current implementation snapshot. This is not a phase sign-off because the open gate items below remain.
- Loopback Pi integration asserts the manifest payload hash equals the serialized HTTP request body and that repository instructions appear with their source hash.

## Open gate items

- No category-specific configuration schema/limits or full configurable relevance weights yet.
- Historical source is replaced for tagged Macus `read_range` results, but arbitrary source copied into user/assistant prose or untagged legacy transcript entries cannot be safely identified and superseded.
- Full protocol-group-aware optional-history selection/compaction, model-switch budget validation, provider usage calibration, and comprehensive provenance for repo maps/test failures remain incomplete.
- Concurrency/serialization around context preparation, compaction, and session replacement needs stress/failure-boundary tests.
