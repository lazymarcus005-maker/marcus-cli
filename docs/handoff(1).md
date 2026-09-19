# Macus Code — Implementation Handoff

Version: 1.1
Updated: 2026-09-19
Companion specification: Macus Code Product & Technical Specification v1.1
Execution scope: Implement Phases 1–7 sequentially, continuing after each successful gate unless the user explicitly limits scope.

---

# 1. Mission and Document Authority

Build **Macus Code**, a standalone local CLI coding agent with command `macus`, using Pi as the agent kernel. Macus adds practical source retrieval, actual request context control, durable task/workflow state, Git/test evidence and terminal UX.

The primary differentiator is selecting sufficient current source context for correct coding actions while controlling total token and latency costs. Correctness and recovery must not regress merely to reduce tokens.

Read this handoff and the complete paired specification before changing implementation. Specification v1.1 owns product behavior, configuration schema and phase acceptance criteria. This handoff owns the implementation procedure. Explicit user instructions and scope remain authoritative.

Canonical repository files are `spec.md` and `handoff.md`. The delivered pair may be named `spec(20260919-011512).md` and `handoff(1).md`. Confirm their title and Version 1.1, then install under canonical names when bootstrapping a new repository. If canonical files already exist, compare versions/content and preserve unrelated user edits; do not overwrite a different specification blindly. Do not infer a specification from an unrelated file with the same name.

If the pair disagrees, use the specification for technical behavior, record and resolve the handoff discrepancy before proceeding. Do not quietly invent an alternative product contract.

---

# 2. Product Boundary

Primary platform: macOS, with practical Linux portability. No dependency on Cowork, Web UI, document upload/generation, document knowledge graphs, vector databases, mandatory embeddings, Neo4j, Docker, cloud indexing or an always-running background service.

Use Pi, a pinned Node LTS runtime, Git, ripgrep, Tree-sitter and local SQLite. Bun compatibility is optional. Use one package manager with a lockfile. Do not add infrastructure or duplicate the Pi agent loop without a demonstrated need.

V1 checkpoints restore agent state, not source code. V1 local shell execution is not an OS sandbox. Automatic model routing, source rollback, mandatory sub-agents and automatic publication are out of scope.

Phases 1–4 produce an internal preview. A V1 release requires all seven phase gates and explicit evidence. Do not label a preview production-ready.

---

# 3. Required Reading and Repository Assessment

Before editing:

1. Read the complete specification v1.1 and this handoff.
2. Inspect repository root, applicable repository instructions, README, package manifest, runtime/package-manager pins, TypeScript configuration, source, tests, config and CI commands where present.
3. Inspect Git status, staged/unstaged/untracked changes and worktree identity. Preserve user changes.
4. Locate current Pi dependencies or source. Inspect public session, event, tool, resource-loader, request-context, compaction and provider APIs for the actual version.
5. Detect existing CLI/TUI structure, lint/typecheck/build/test commands and state formats.
6. Identify supported target endpoint(s), language fixtures and test runners. Never invent credentials or successful connectivity.
7. Write `docs/implementation-map.md` mapping spec sections to existing/new modules, and create an implementation TODO list.

An empty repository is valid: record absent files, choose the minimal Node/TypeScript scaffold and create only what is needed. A missing README/package.json does not justify fabricating existing architecture or blocking all useful work.

Reuse working modules and integrations. Keep edits focused; do not rewrite architecture solely to match the suggested package tree.

---

# 4. Architecture and Pi Compatibility Gate

Logical components:

| Component | Responsibility |
| --- | --- |
| CLI/TUI | User interaction, streaming display, commands and status |
| Agent Harness | Durable workflow transitions, bounded continuation and user interruption |
| PiAgentKernel | Public Pi integration behind stable internal DTOs |
| Context Runtime | Per-provider-request selection, freshness, budget and protocol validation |
| Code Intelligence / Git Context | Bounded retrieval candidates and evidence |
| Task Engine / State Store | Session-scoped tasks, ledger, journal and test evidence |
| Policy Executor | Unified tool authorization, execution, cancellation and bounded output |

Prefer supported SDK composition/extensions behind `AgentKernel`, then wrappers where sufficient. A Pi core patch is a last resort with a documented failing requirement, narrow change and upstream maintenance plan. No direct Pi-internal imports outside the adapter.

Do not implement only `send(): Promise<AgentResult>` and assume the integration is complete. Required adapter capabilities are session create/resume/switch/dispose, streaming events, explicit input queue/steering, cancellation, request preparation before every model request, centralized tools, coordinated compaction, model switching and recovery of tool exchanges. Exact internal naming is an implementation choice; exact Pi method names must be verified.

Phase 1 writes `docs/pi-compatibility.md` with pinned package/version/commit, runtime, public API/source references and demonstrated mappings for each capability. Verify that nested model/tool turns also pass through context and policy checks. Inspect resource-loader behavior so instructions are not loaded twice. Rebind event subscriptions/resources after session replacement where required.

If a required API is missing, test a supported alternative and record the limitation. Do not claim request control merely because `/context` looks correct. A fake or incomplete hook implementation fails the gate.

---

# 5. Non-Negotiable Implementation Contracts

## 5.1 Effective context

Keep Pi's persisted transcript separate from the effective request view. Before every provider request, validate source versions, deduplicate fragments, account for retained tool/history content and enforce the complete request budget. Preserve chronological messages and valid tool-call/result groups.

HOT/WARM/COLD and working-set membership are retrieval metadata, not evidence that old prompt content disappeared. Old source retained in history must be accounted for or removed/summarized through supported APIs. Keep superseded source only for explicit comparisons, labelled with its version.

Keep mandatory user constraints, applicable instructions, pending tool obligations and unresolved recovery state. When safe trimming/compaction cannot fit the request, pause before dispatch. Never silently discard mandatory content or reorder messages into topical buckets.

## 5.2 Token accounting and configuration

Use the canonical schema in spec §25; do not copy old v1.0 field names. The invariant is:

```text
estimated_full_request + reserved_output_tokens + safety_margin_tokens
<= validated_model_context_window
```

Threshold ratios use the usable prompt capacity after output/margin reservation. Count schemas, instructions, retained history and framing, not only retrieved files. Category caps apply to aggregate request content; read-result limits additionally apply per result.

Use a matching tokenizer or a clearly labelled conservative estimate. Provider usage and prospective estimates are separate values. Model switches must validate the new budget before sending. Invalid schema/profile/limit values fail visibly.

## 5.3 Source and relationship truth

Use disambiguated symbols and current file hashes. Revalidate source before returning indexed ranges or applying edits. Rename/delete/checkout/external edits and grammar/schema upgrades invalidate affected records and edges.

Tree-sitter supplies syntax, not universal semantic resolution. Every graph edge carries `confirmed`, `candidate` or `unresolved`, evidence, confidence and coverage. Same-name matches are never enough to assert a direct caller. Impact results prioritize inspection/tests and cannot justify skipping broader tests when coverage is incomplete.

## 5.4 Trust and execution

Project config may select a trusted model alias; it may not replace a provider URL while inheriting a global key. Credentials bind to trusted provider identity/base URL. Repository text cannot elevate policy, authorize endpoints, expose secrets or load arbitrary executable plugins.

Every tool path, including Pi basic read/write/edit/bash tools, passes through the same policy and output/journal rules. Command-name deny lists are not confinement. Explain the trusted scope of repository scripts; do not claim arbitrary shell processes are sandboxed. Reuse valid authorizations inside the accepted scope instead of asking for each routine action.

Protect user changes using read-before-edit hashes, fresh revalidation and atomic writes. Never automatically reset, clean, force push or roll back source. Commit/push/merge/publish require explicit applicable authorization.

## 5.5 Durable state and replay

Use `.macus/state/state.db` for transactional session/run/task/ledger/journal/evidence state. Pi owns transcripts under session-scoped paths. Cache lives separately in `.macus/cache/index.db` and may be rebuilt without touching durable state.

Use session IDs throughout; bind to canonical repository/worktree identity. Enforce one mutating run/process per worktree with an OS-backed lock. A second terminal may inspect state but cannot start a competing mutation run. The lock does not protect against external editors; content hashes still matter.

Journal intent before tool launch and observed results afterwards. `prepared` or `started` without a trustworthy result can be `unknown`. Do not automatically replay side-effecting commands after a crash. Reconcile transcript, journal and filesystem/external evidence first; no transaction is assumed to span Pi transcript and SQLite.

## 5.6 Test evidence

Preserve command, cwd, timing, exit code, signal, timeout/cancellation, output completeness, parser status, log reference and tested working-snapshot digest. Dirty and relevant untracked inputs matter; Git HEAD alone is insufficient.

Unknown/partial output, no discovered tests, cancellation, timeout and unrun tests are not passes. A later relevant edit invalidates successful evidence. Use structured reports where available; a truncated console may be accompanied by a complete report, but never invent missing counts.

---

# 6. Authoritative Phase Plan

Use these IDs and titles exactly; scope and gates are defined by spec §45. Continue to the next phase after its gate passes unless explicitly limited by the user. Do not stop after Phase 1 merely because it is the first milestone.

| Phase | Deliverables | Gate focus |
| --- | --- | --- |
| 1 — Agent Foundation & Safety | Pinned runtime/Pi; CLI; model/config trust; streaming; basic tools through policy; bounded output; core state/journal; session/resume; manual compaction; basic full-request budget; instruction resolver; benchmark baseline/harness | Verified Pi capabilities, request bounds/protocol, cancellation, crash-after-write reconciliation, endpoint trust, user-change preservation and baseline evidence |
| 2 — Code Retrieval & Freshness | ripgrep; TS/TSX, JS/JSX and C# syntax fixtures; symbols; smart read; bounded repo map; incremental cache | Ambiguity explicit, correct freshness/invalidation, bounded output, exclusions and authorized paths |
| 3 — Context Runtime | Working set/tiers; selector; deduplication; provenance; request manifests; inspector | Actual requests match manifests, current source replaces superseded content, valid exchange groups and smaller-model budgets |
| 4 — Coding Workflow & Evidence | Plan/tasks; bounded test/fix loop; Node/JUnit and .NET TRX adapters; Git/diff; review | Durable tasks, truthful test outcomes, fresh evidence, preserved user changes and enforced run limits |
| 5 — Durable Context & Optimization | Ledger; state checkpoints; full compaction coordination; stage-aware policy; prompt stability; refined summaries | Preserved essential state, safe failed/cancelled compaction, no source rollback, supported feature-flag behavior |
| 6 — Lightweight Relationships | Optional graph; references/dependencies/dependents; impact | Confirmed/candidate/unresolved distinctions, explicit coverage and broader test fallback |
| 7 — Release Hardening | Expanded recovery/migration testing; measured performance/paired benchmarks; clean install/package/docs/license verification | Earlier gates remain green; interruption cases handled; quality regression gate; installation and truthful result report |

Safety, output limits, core recovery and benchmark instrumentation start in Phase 1. Later phases extend them; never postpone the first implementation of these foundations to Phase 7.

---

# 7. Phase Execution Procedure

For each phase:

1. Map required spec sections and gate cases to TODOs.
2. Inspect relevant existing code and supported APIs.
3. Implement one coherent unit.
4. Run focused meaningful tests, typecheck and build.
5. Review the diff and unintended changes.
6. Exercise the feature through `macus` with a reproducible fixture.
7. Run the remaining required phase gates.
8. Update documentation, TODOs and `docs/phase-N-evidence.md`.
9. Continue to the next phase after all required gates pass.

The evidence file records pinned versions, commands, outcome, source revision/working snapshot, test/log locations, requirement coverage and blockers. No placeholder success statements. Lint is required when configured. Existing unrelated failures must be identified with evidence and assessed against the affected gate.

If a necessary endpoint, dependency, authorization or API is unavailable, complete independent useful work, record the exact blocked gate and continue only independent safe tasks. Do not label the phase complete or simulate a live compatibility pass. A mock provider proves local behavior, not real-provider compatibility.

---

# 8. Retrieval and Index Implementation Details

Use `search_code` with structured ripgrep arguments, explicit literal/regex behavior, bounded global results, timeout and truncation/continuation metadata. Never interpolate untrusted query text into a shell command or pass unlimited output to the model.

Default retrieval: use known context when valid; otherwise search → locate → smart read → expand. Escalation is a cost heuristic, not a requirement to call every tool. Repo maps have a default 1200-token cap and are not injected wholesale each turn.

Initial structural languages are TS/TSX, JS/JSX and C# as scoped in spec §8. Other text languages fall back to ripgrep/range reads with explicit unsupported structural coverage. Pin parser/query versions and handle syntax errors/oversized files without inventing symbols.

Index updates replace each changed file's symbols/edges transactionally. Use metadata scans for discovery and content hashes for verification. Do not parse all files each turn. Required cases: external editor edits, delete, rename, branch checkout, resume, parser/schema upgrade and corrupt cache.

Respect `.gitignore`, `.macusignore`, generated/dependency/binary exclusions and policy-denied secret paths. Do not follow symlinks outside authorized roots. Default parse limit is 1 MiB per file. Index work is bounded and in-process; basic prompt/text search remains usable during cold indexing.

---

# 9. State, Compaction and Recovery Implementation Details

Use the layout and database authority in spec §32. Do not retain v1.0's single task.json/ledger.json/session.json files as competing writable authorities. If an existing implementation has such files, provide a versioned migration or explicitly import a validated snapshot; never delete working state blindly.

Checkpoints record state revision, session/worktree identity, transcript entry reference, tasks/decisions, file hashes, evidence, next action and unknown executions. Write atomically and register transactionally; reconcile incomplete/orphan records on startup. Restoring a checkpoint never changes source bytes automatically.

Compaction is serialized with tool execution and session replacement. Preserve essential state, use one automatic trigger authority, and include compaction requests in token metrics. If compaction fails/cancels or cannot preserve a valid request, retain usable prior state and pause. Do not create a second independent compaction engine.

Recovery must inspect the journal and Pi transcript before replaying work. Reconcile known file writes with expected before/after hashes; unexpected hashes mean conflict. Unknown shell/external effects require inspection and explicit authorization before replay. Supported adapter APIs must repair or represent incomplete exchanges; never patch Pi transcript files directly.

Exercise failures at the boundaries listed in spec §38, especially after side effects but before persistence and after durable result persistence but before transcript completion. Also cover worktree mismatch, external edits, branch change, concurrent sessions, cancellation, schema migration and unavailable logs.

---

# 10. Configuration, Instructions and Feature Dependencies

Copy schema examples only from spec §25. Validate unknown fields and incompatible budgets. Resolve defaults → global → allowed project → explicit CLI, with selected-profile context overrides and final CLI overrides as defined in spec §25/§30. `MACUS_CONFIG` chooses the user config path; `--config` takes precedence. Environment substitution does not grant project authority.

Instruction hierarchy: runtime safety/user authority remain above repository guidance. Within repository guidance, deeper directory wins; at equal scope `MACUS.md` > `AGENTS.md` > `CLAUDE.md`. Preserve non-conflicting text and each instruction's path/hash/scope. Sibling instructions cannot override each other. Confirm Pi does not auto-load the same guidance twice.

Use spec §31's feature dependency table. Core session identity, execution journaling, policy and request budgets are always active. Disabling ledger/checkpoints removes enhanced summaries/snapshots, not core resume. Disabling graph removes graph scoring and certainty claims. Disabling automatic compaction cannot disable the budget guard. Semantic search and telemetry remain unsupported in V1 and cannot be silently enabled.

Phase 1 previews default all optional flags to false while retaining core budget/policy/journal/resume and basic manual Pi compaction. Availability: repo map in Phase 2; tasks/Git context in Phase 4; ledger/checkpoint/automatic compaction/prompt-cache optimization in Phase 5; graph in Phase 6. Full V1 uses spec §25 defaults; preserve existing user flag choices on upgrade. Default graph remains false. Report disabled/unavailable commands clearly and reject explicit enablement of unimplemented features. Do not claim enhanced recovery metadata when its optional feature is disabled.

---

# 11. CLI and Inspection

Follow the command availability and semantics in spec §27. Phase 1 supports `/help`, `/status`, `/model`, `/models`, `/settings`, `/resume`, `/clear`, `/compact`, basic `/context` and `/exit`. Later phases add detailed context/files, tasks, diff and checkpoints.

`/clear` starts a new session without deleting code or previous sessions. `/resume` validates identity and reconciles before mutations. Ctrl-C cancels the active run. `macus "task"` starts an interactive session with an initial prompt; do not assume a noninteractive automation interface exists.

`/context` shows the last dispatched request manifest and a separately labelled next-request estimate. Counts must sum; category nesting must not double-count. Show provider usage only when available. `/context files` explains included/omitted fragments, source freshness, reason and uncertainty. `/settings` shows value provenance with secrets redacted.

Status may show model, prompt usage/cap, active files/tasks and branch. Cache percentages require a reported numerator/denominator or must be omitted.

---

# 12. Output and Test Evidence

Bound output from Phase 1, including basic tools. Spec §17 sets initial caps: 8 MiB memory buffer and 100 MiB log per execution; session logs have 7-day retention and a 1 GiB aggregate cap. Token limits additionally bound model-facing results. Keep opaque log references and bounded `read_log` access; report expired logs explicitly.

Default execution timeout is 120 seconds; configured build/test profiles may use 600 seconds. Cancellation terminates the process group with a bounded grace period and records confirmed or unknown outcome. Strip unsafe terminal control sequences and redact secrets before persistence/forwarding. Do not inherit model credentials into subprocess environments by default.

Use structured runner evidence in Phase 4. Preserve exit/signal/timeout/cancel/parser/output-completeness fields and source snapshot digest. No parser support means unknown counts, not guessed zero failures. Zero discovered tests is not a pass. Relevant edits invalidate evidence; when dependency coverage is unknown, invalidate conservatively and broaden tests.

Review output includes Changed, Tested, Remaining Risk and Unresolved Issue, tied to the current snapshot. A finished model response does not prove a finished coding task.

---

# 13. Meaningful Tests and Acceptance Cases

Each phase adds tests for its real failure modes. At minimum cover:

| Area | Required cases |
| --- | --- |
| Config/trust | Precedence, aliases, missing env, forbidden endpoint/credential/policy override, redacted errors |
| Pi adapter | Streaming, inner tool turns, request hook, valid tool groups, session replacement, cancellation, compact/resume |
| Context | Aggregate budget, schema/tool overhead, deduplication, stale removal, model switch, exact category sums |
| Index/read/edit | Duplicate symbols, unsupported language, parse error, rename/delete/checkout, same-size external change, hash conflict, symlink escape |
| State/recovery | Session isolation, second writer rejected, atomic migration, crash boundaries, unknown tool outcome, no duplicate replay |
| Output/tests | Large stdout/stderr, truncation, parser failure, incomplete report, timeout/cancel, zero tests, stale pass evidence |
| Graph | Aliases/overloads/dynamic calls labelled honestly; partial graph triggers broader tests |
| Workflow | Run/turn/no-progress limits, durable tasks, review evidence and preserved user changes |
| Flags | Supported ledger/checkpoint/graph/auto-compaction/task combinations retain core safeguards |

Use deterministic fixtures and a mock provider for repeatable protocol tests, plus an actual configured endpoint for live compatibility evidence. Do not make every test depend on network/model availability. Do not write tests that merely mirror implementation constants without validating behavior.

---

# 14. Benchmark and Performance Evidence

Start the harness and unmodified pinned Pi baseline in Phase 1. Spec §39 defines the reference fixture, hardware, repetitions and numeric targets. The default reference is a Mac mini M4 Pro 48 GB; if implementation runs elsewhere, label results and leave the reference gate pending until measured there or explicitly rebaselined with evidence.

For each task and condition, run at least three paired Pi/Macus repetitions with the same starting revision, prompt, model endpoint/version, generation settings, context/output limits and test oracle. Reset task workspaces between runs; separate cold/warm repository and provider cache conditions. Record uncontrolled cache conditions as unknown.

Report task correctness first, then all request/response tokens including retries/compaction, cached input if available, latency, first useful edit, tool calls, context size and CLI peak RSS separately from inference memory. Record per-run data and distributions. A smaller working set alone does not establish token savings.

No newly failing fixed-suite correctness/recovery cases versus baseline is the initial quality gate, not a statistical equivalence claim. Report regressions and limitations explicitly. Performance targets are targets until measured; never report fabricated results or mark a required gate passed without evidence.

---

# 15. Definition of Done and Final Delivery

Every phase requires implementation, meaningful passing tests, typecheck/build, lint where configured, CLI verification, updated docs, reviewed diff, no unrelated changes and `docs/phase-N-evidence.md`.

V1 final delivery requires all seven phase gates, clean installation on macOS arm64 and the chosen Linux environment, pinned dependencies/attribution, live endpoint compatibility evidence, measured benchmark report, documented feature limitations and successful recovery interruption tests or explicit safe pauses for unsupported states.

Demonstrate a coding task such as “Fix refresh token expiration handling and update the tests” through instruction resolution, bounded search/read, task tracking, current-source edit, appropriate tests/fix loop, review, durable state and resume. Include an interrupted-run demonstration proving that unknown side effects are not replayed automatically.

Final implementation report states what changed, exact validation performed, evidence locations, remaining blockers and limitations. Preserve user changes and do not commit/push/merge/publish without applicable authorization.

---

# 16. First Actions for the Implementing Agent

1. Resolve and read this v1.1 pair completely.
2. Inspect repository, instructions, Git status and existing implementation.
3. Pin the runtime/Pi dependencies and inspect actual supported APIs.
4. Create the implementation map and phase TODOs.
5. Implement Phase 1 first, including policy, journal, output bounds, request-budget proof and benchmark baseline.
6. Build, test, exercise the CLI and review the diff.
7. Record the Phase 1 evidence; continue through Phases 2–7 in order as their gates pass.
8. Pause only for a failed required gate, genuine blocker, missing required authorization or explicit user scope limit. Keep completed work and evidence intact.

Prefer simple deterministic code, bounded resources and supported Pi APIs. Do not add infrastructure or abstractions without a concrete requirement. Do not send content to the model merely because it exists.
