# Macus Code — Product & Technical Specification

Version: 1.1
Updated: 2026-09-19
Status: Implementation contract; Pi compatibility gate required before feature development
Product Type: Local CLI Agentic Coding Tool
Primary Platform: macOS
Architecture Style: Lightweight, local-first, extensible
Agent Kernel: Pi-based

---


# Document Contract

Version 1.1 supersedes version 1.0 of this specification and its paired handoff. The original product scope remains; v1.1 closes review findings R1–R9 with executable contracts and aligned phase gates.

Canonical repository filenames are `spec.md` and `handoff.md`. The delivered filenames `spec(20260919-011512).md` and `handoff(1).md` are transport names for this same pair; when bootstrapping a repository, install them under the canonical names. Never silently replace an existing different spec: reconcile versions and user changes first.

This specification owns product behavior, configuration schema and acceptance gates. Handoff owns implementation procedure and references this version. If the pair disagrees, apply this specification for technical behavior, record the discrepancy and correct handoff before proceeding. Explicit user scope/instructions remain authoritative.

Only Phase 1 compatibility evidence establishes which Pi APIs are usable. This document does not claim implementation, test success or benchmark results already exist.

---

# 1. Overview

**Macus Code** คือ CLI Coding Agent สำหรับทำงานกับ source-code repository โดยตรงจาก terminal

เป้าหมายของระบบคือสร้าง coding agent ที่:

* เบา
* ใช้งานได้จริง
* startup เร็ว
* ประหยัด token
* เข้าใจ codebase โดยไม่ต้องส่ง repository ทั้งหมดเข้า LLM
* รองรับ long-running coding task
* มี task/todo tracking
* มี context management ที่เหมาะกับแต่ละ model
* ทำงานกับ Git และ test/build workflow ได้
* รองรับ local/private LLM gateway
* ไม่ผูกกับระบบ Cowork

Macus Code ใช้ **Pi เป็น Agent Kernel** สำหรับ agent loop, session, tools, streaming และ model interaction

Macus Code จะเพิ่ม layer ของตัวเองสำหรับ:

* Code Intelligence
* Context Runtime
* Token Optimization
* Task Engine
* Coding Workflow
* Git Context
* CLI/TUI UX
* Model Selection and Profiles (automatic routing is out of scope for V1)
* Settings
* Checkpoint/Recovery

---

# 2. Product Boundary

Macus Code เป็นผลิตภัณฑ์แยกจาก Cowork อย่างสมบูรณ์

```text
Macus Code
=
CLI Coding Agent
Repository
Source Code
Git
Terminal
Build
Tests
Agent Loop
```

ไม่รวม:

```text
Cowork
=
Document Workspace
Document Upload
Knowledge Documents
Web Project Workspace
Document Generation
Document Knowledge Graph
```

ห้ามสร้าง runtime dependency จาก Macus Code ไปยัง Cowork

ทั้งสองระบบสามารถ share utility libraries ในอนาคตได้ แต่ต้อง deploy และ run แยกกันได้

---

# 3. Core Principles

## 3.1 Lightweight First

หลีกเลี่ยง infrastructure ที่ไม่จำเป็น

V1 ห้าม require:

* Vector Database
* Neo4j
* External database server
* Embedding server
* Background indexing service
* Kubernetes
* Docker daemon
* Cloud service

Local dependencies ควรจำกัดอยู่ประมาณ:

```text
Pi
Node.js (one supported LTS version pinned by Phase 1)
Git
ripgrep
Tree-sitter
SQLite
```

---

## 3.2 Deterministic Retrieval Before AI Retrieval

การค้นหา code ให้เริ่มจาก deterministic tools ก่อน

ลำดับ:

```text
Known Context
   ↓
ripgrep
   ↓
Symbol Index
   ↓
References
   ↓
Code Graph
   ↓
Git History
   ↓
Optional Semantic Search
```

ไม่ใช้ LLM เพื่อ search/rank ถ้า deterministic method สามารถทำได้

---

## 3.3 Context Is a Budget

Context window ของ model ไม่ใช่พื้นที่ที่ต้องพยายามใช้ให้เต็ม

ระบบต้องจัด context ตาม:

* relevance
* token cost
* current task
* current workflow stage
* current changes
* model context limit

---

## 3.4 Minimal Pi Fork

Pi ต้องถูกใช้ในรูปแบบ:

```text
Pi
=
Agent Kernel
```

Macus Code:

```text
Macus Code
=
Product Layer
+
Context Runtime
+
Coding Intelligence
+
Workflow
+
UX
```

Preferred implementation order:

```text
Supported SDK composition and extensions behind PiAgentKernel
>
Wrapper where sufficient
>
Documented core patch only after a demonstrated API gap
```

หลีกเลี่ยงการแก้ Pi internals โดยไม่จำเป็น

เพื่อให้สามารถ merge upstream Pi ในอนาคตได้

---

# 4. High-Level Architecture

Macus Code CLI/TUI ส่ง user intent ไปยัง Agent Harness; Harness ใช้ Task Engine และ PiAgentKernel เพื่อขับ workflow.

| Component | Authority and integration |
| --- | --- |
| PiAgentKernel | Pi session, streaming, model requests, tool lifecycle and base compaction |
| Agent Harness | Workflow transitions and bounded continuation; does not duplicate the Pi model/tool loop |
| Context Runtime | Builds the effective request view before every model request, including requests inside one agent turn |
| Code Intelligence / Git Context | Produce versioned retrieval candidates; do not invoke the model directly |
| Task Engine / State Store | Session-scoped durable tasks, ledger, execution and test evidence |
| Policy Executor | Authorizes and journals tool execution; owns cancellation and output bounds |

Context Runtime and Policy Executor integrate through documented, pinned Pi APIs behind the adapter. They are not merely prompt instructions. Verify the exact supported hooks in Phase 1. Application modules must not import Pi internal types or mutate Pi session files directly.

The implementation may begin as a single package with these module boundaries. Physical package splitting is optional.

---

# 5. Major Components

# 5.1 Pi Agent Kernel

Responsibilities:

* agent loop
* message streaming
* tool execution
* model communication
* session management
* session resume
* base compaction support
* extension lifecycle

Macus Code ต้องไม่ reimplement agent loop หาก Pi รองรับอยู่แล้ว

---

# 5.2 Agent Harness

Agent Harness controls the coding workflow: understand → discover → plan → implement → test → inspect/fix → review → finish.

Pi owns the inner model/tool loop. Harness owns durable workflow stage, task transitions and whether to continue after the Pi run stops. There must be only one active mutating run per worktree.

Stop or pause on task completion, a blocker, policy denial, user cancellation, repeated failure without progress, or a configured limit. Baseline limits: 40 model turns per user run, 3 consecutive attempts with the same normalized failure fingerprint and no relevant source change, and 30 minutes per run. Count automatic retries and continuation; users can configure limits or explicitly extend a paused run. Shell command timeouts are separate (§34).

Cancellation must propagate through the adapter to the model request and active tool process group, then persist the observed outcome. Never automatically continue a cancelled run. Network retry is distinct from tool replay (§38).

---

# 5.3 Task Engine

Multi-step work maintains a task list independently of conversation history.

Statuses: `pending`, `in_progress`, `completed`, `blocked`, `skipped`.

Each task stores `sessionId`, `id`, `title`, `status`, `relatedFiles`, `relatedSymbols`, `notes`, `createdAt`, `updatedAt`, and optional `evidenceIds`. Enforce valid transitions and at most one `in_progress` task per active run by default. Marking a task completed must not imply that unrun tests passed.

Store tasks in the transactional state database defined in §32, scoped by session. A JSON export may be produced for inspection; it is not an independent writable authority. `/tasks` shows progress and blockers. State changes and the corresponding ledger revision are committed together where related.

---

# 6. Context Runtime

Context Runtime selects the smallest useful context while keeping correctness and tool protocol integrity.

Two representations are mandatory:

1. **Persisted transcript:** Pi-owned session history for audit and resume. Supported Pi compaction may add its own entries; Macus never rewrites the underlying file itself.
2. **Effective request view:** the messages and selected fragments actually passed to the provider for one model request. This view may omit or summarize older optional content through supported adapter hooks.

Before **every** provider request, including follow-up requests within one Pi run:

1. Load current user intent, applicable instructions and pending tool protocol obligations.
2. Validate candidate source hashes and cached evidence freshness.
3. Combine newly retrieved context with retained history; deduplicate overlapping fragments and identify superseded source versions.
4. Rank optional context, apply the total budget, and omit or compact low-priority historical content.
5. Validate chronological message order, tool-call/result relationships and provider-specific message constraints.
6. Record a request manifest and dispatch the validated view through PiAgentKernel.

Moving an item from HOT to COLD is only retrieval metadata; it does not prove that tokens were removed from retained history. The request composer must explicitly account for or remove that historical copy.

Preserve complete tool exchange groups. Never retain a tool result without its call, discard a required pending result, or reorder history into topical buckets. Where the pinned Pi/provider combination cannot safely transform an exchange, keep it or use Pi-supported compaction at a valid boundary. If no supported mechanism can satisfy the request limit, pause before sending; do not silently bypass the budget.

Mark historical source as superseded after edits; by default include only its current version unless an explicit before/after comparison is needed. Retain the user's constraints, unresolved errors and current task during compaction. Any omission of mandatory content must cause a visible blocked state, not silent truncation.

Phase 1 must prove request interception, bounded tool results, valid exchanges, cancellation and compaction against a pinned Pi build before the full selector is implemented.

---

# 6.1 Context Tiers

ใช้สามระดับ

## HOT

ควรอยู่ใน context บ่อยที่สุด

เช่น:

* current task
* current todo
* currently edited files
* current diff
* current error
* current test failure

## WARM

โหลดเมื่อเกี่ยวข้อง

เช่น:

* direct dependency
* related symbol
* test
* caller
* interface
* implementation

## COLD

ไม่ inject โดย default

เช่น:

* repo map เต็ม
* unrelated files
* old git history
* distant modules

Flow:

```text
HOT
always considered

WARM
retrieve when relevant

COLD
retrieve on demand
```

---

# 6.2 Working Set

Maintain `ACTIVE`, `RELATED`, `DISCOVERED`, `STALE` entries scoped to session, with canonical path, source hash, symbols, last access and selection reason.

Search discovers entries; verified reads activate them; edit/test events update them. Git checkout, external edits, rename or deletion invalidate affected entries. An entry whose freshness is unknown cannot be presented as current source.

Working-set status and HOT/WARM/COLD tier are separate fields: status describes the work relationship; tier controls request priority. Neither guarantees inclusion. The effective request manifest is the authority for what the model actually receives.

Bound retained metadata by configurable item count and age; eviction removes retrieval metadata, not user files or durable decisions.

---

# 6.3 Context Selector

Use deterministic selection; no extra LLM call for routine ranking.

Eligible candidates carry source identity, source version, estimated tokens, tier, reason and evidence. Deduplicate equal fragments and merge overlapping ranges before scoring. Validate freshness before selection.

Initial scoring uses configurable non-negative weights for exact symbol/path match, active working-set membership, edited-file relevance, related test, task keyword match and recent access. Graph contribution decreases with distance, e.g. `weight / (1 + distance)`, and is multiplied by edge confidence. Disable that contribution when the graph is unavailable or disabled. Normalize only for presentation; a ranking score is not semantic confidence.

Use stable path/symbol ordering to break ties. Mandatory instructions and current tool protocol obligations are reserved before ranking optional items. Fill category and total budgets without splitting valid protocol groups. A selected fragment too large for its category must be narrowed to a safe range or returned as a paginated reference.

Low-confidence retrieval triggers broader text search or additional source reads. The goal is correct task completion with minimal sufficient context, not token reduction at any cost.

---

# 6.4 Context Provenance

Every source fragment includes:

```json
{
  "fragmentId": "opaque-id",
  "source": "src/auth/token.service.ts",
  "symbolId": "opaque-symbol-id",
  "startLine": 87,
  "endLine": 132,
  "reason": "direct-reference",
  "tier": "WARM",
  "score": 0.94,
  "contentHash": "sha256-of-current-file",
  "indexGeneration": 42,
  "freshness": "verified",
  "estimatedTokens": 650
}
```

Hashes cover the exact source version used to produce the fragment. Revalidate against disk before returning source, not only when indexing. Symbol IDs include language, normalized path, qualified name, kind and disambiguating signature/location; do not use a bare name as identity. Changed versions may receive new IDs with old IDs invalidated.

Each request manifest records request/session/model IDs, instruction hashes, included fragment IDs and hashes, omissions with reasons, category totals, estimation method and adapter/Pi versions. Avoid copying secrets or full raw source into manifests.

---

# 6.5 Context Budget

Use the single schema in §25. Legacy aliases such as `reserve_output`, `target_context_ratio` and `target_utilization` are not valid v1.1 fields; reject them with a migration hint rather than silently ignoring them.

Define:

```text
C = configured and validated total model context window
R = reserved_output_tokens (also constrain the requested maximum output)
M = safety_margin_tokens
P = C - R - M
estimated_full_request <= P
estimated_full_request + R + M <= C
```

The full request includes system and repository instructions, tool schemas, retained messages, tool exchanges, current user input and retrieved content, including provider framing estimates. Provider limits on input/output are additional constraints; profiles cannot override a lower known provider limit. Reasoning/output accounting follows the validated provider capability profile.

`target_prompt_ratio`, `compact_prompt_ratio`, and `emergency_prompt_ratio` are fractions of **P**, not C. Require `0 < target < compact < emergency < 1`. Category budgets are aggregate caps across the effective request, not per tool call. `single_file_read_tokens` is additionally a per-result limit. Categories are mutually exclusive: classify repo maps, search matches and source fragments by those content categories, regardless of their message role; classify remaining tool-result payload as other tool output. Assign message/framing overhead once. Old results retained in history still count in their respective categories and cannot evade a cap by being called history.

Use a matching tokenizer when available. Otherwise label the count estimated, use a conservative fallback (initially one token per UTF-8 byte plus tested framing overhead), and retain the safety margin. Calibrate against provider usage when supplied; fallback estimates are not a proof of the provider's exact tokenization. Never present previous-request usage as an exact current count.

At thresholds: reduce optional context toward target, then invoke supported compaction when needed. If mandatory content still exceeds P, pause with actionable diagnostics. On context-length rejection, allow one bounded rebuild/compaction retry; never retry the identical oversized request indefinitely.

On `/model`, recompute profile, tokenizer, output allowance and all budgets before the next request. Invalid or unknown limits require explicit configuration rather than assuming a large window.

---

# 6.6 Dynamic Context Policy

Context priority ต้องเปลี่ยนตาม workflow stage

ก่อนแก้ code:

```text
Repo Map        HIGH
Search          HIGH
Symbols         HIGH
Diff            LOW
Tests           MEDIUM
```

หลังแก้ code:

```text
Current Diff    VERY HIGH
Tests           VERY HIGH
Edited Files    VERY HIGH
Repo Map        LOW
Search          MEDIUM
```

หลัง test fail:

```text
Failure         VERY HIGH
Failing Symbol  VERY HIGH
Related Test    VERY HIGH
Repo Map        VERY LOW
```

---

# 7. Code Search

`search_code` uses ripgrep with structured argv, no shell interpolation.

Input: `query`, `path?`, `fileType?`, `maxResults?`, `caseSensitive?`, `literal?`, `cursor?`. Default literal search; regex must be explicit. Validate paths and enforce the repository inclusion policy (§14, §34).

Default maximum is 100 matches with a 10-second search timeout, subject to lower token/output limits. Stop collection at a global bound; do not mistake a per-file ripgrep limit for a repository-wide cap.

Output includes bounded matches with path/range, `returnedCount`, `totalKnown` (nullable), `truncated`, `nextCursor` when available, and a reason for partial results. Do not claim an exact total unless actually counted. Cursors bind to query and source/index generation; reject stale cursors or restart search explicitly.

No matches, invalid regex, timeout, cancellation and process failure are distinct outcomes. Use real source reads to verify matches before edits.

---

# 8. Symbol Intelligence

Use Tree-sitter for syntactic structure: classes, functions, methods, interfaces, types, selected declarations, imports and exports. Do not send raw ASTs to the model.

Initial language scope:

| Language | Phase 2 required support | Relationship limit |
| --- | --- | --- |
| TypeScript / TSX | Declarations, signatures, ranges, import/export syntax | Cross-file resolution only for explicitly supported forms |
| JavaScript / JSX | Declarations, signatures, ranges, import/export syntax | Dynamic binding remains unresolved/candidate |
| C# | Namespace/type/member declarations, signatures, ranges, using/base-type syntax | Syntax does not resolve overloads, runtime DI or interface dispatch |
| Other text languages | ripgrep and bounded range reads | Report structural intelligence as unsupported |

Pin grammar/query versions and ship fixtures for each supported language. Parse errors or unsupported constructs produce partial coverage metadata, never invented symbols. Lazy-load parsers; use a bounded in-process worker for large files so indexing does not block the TUI. No required daemon.

`search_symbol` accepts query, language/path/kind filters, result limit and cursor. Return disambiguated symbol IDs, source hash, signature, range and coverage metadata. If several symbols match, expose candidates; do not silently choose the first one.

---

# 9. Smart Read

Use known context or search → locate symbol → `read_symbol` / `read_range` → `expand_context` when needed. A known path or symbol may be read directly; escalation is a cost heuristic, not a mandatory series of extra calls.

Inputs accept a disambiguated symbol ID or path/range and optional expected content hash. Output includes current file hash, signature, numbered range, body and minimal imports/type context where useful. Never silently read a different symbol when the requested one is ambiguous, deleted or stale.

Validate the current file hash before serving cached ranges. On change, refresh the affected index or fall back to a bounded fresh text read. Large bodies return truncation metadata and a continuation mechanism. Line numbering is 1-based and inclusive; byte offsets, if exposed, are separately named.

Read-before-edit records the observed hash. Edit must compare that hash before writing; a mismatch requires a fresh read and patch recalculation (§33).

---

# 10. Repository Map

สร้าง lightweight repo map

Map แสดง:

* important files
* classes
* functions
* interfaces
* selected signatures
* important dependencies

ไม่ส่ง implementation เต็ม

Example:

```text
src/auth/auth.service.ts

class AuthService
  login(LoginRequest): Token
  refresh(RefreshRequest): Token


src/token/token.service.ts

class TokenService
  createToken(...)
  verifyToken(...)
  refreshToken(...)
```

Repo Map ต้องมี token budget

Default:

```text
1200 tokens
```

สามารถเพิ่มเมื่อ agent ยังหา working files ไม่เจอ

เมื่อ working set ชัดแล้ว ลด repo-map budget ลง

---

# 11. Lightweight Code Graph

Graph scope remains deliberately small: file imports file; file contains symbol; symbol references symbol; symbol implements interface; test references symbol.

Store in SQLite `index.db` with files, symbols, edges and metadata. Files carry content hash and parse generation; no separate duplicate hash authority is required.

Every edge stores `edgeType`, `fromId`, `toId` (nullable), `targetText`, `resolution`, `confidence`, `evidence` (path/range/hash and extraction method), `resolverVersion`, and `indexGeneration`.

`resolution` is `confirmed`, `candidate`, or `unresolved`. A parser can confirm containment. A same-name text match is a candidate, not a confirmed caller. Use confirmed cross-file resolution only for uniquely resolved cases within the documented resolver coverage. Confidence is an evidence/ranking hint, not a calibrated probability. Unsupported aliases, overloads, dynamic dispatch and ambiguous names must remain explicit.

Grammar/query/resolver changes invalidate affected index generations. Remove edges to deleted or superseded symbols transactionally. Graph absence or partial coverage cannot prevent ordinary search/read/edit operation.

No mandatory language server, compiler semantic engine, embeddings or graph server in V1.

---

# 12. Reference & Impact Tools

Tools: `find_references`, `find_dependencies`, `find_dependents`, `impact`.

Return bounded metadata before source: target symbol/version, confirmed references, candidate references, unresolved relationships, possible tests and coverage limits. Include evidence and resolution per relationship. Report `coverage: partial` whenever completeness is unknown; zero results must not imply zero callers.

Candidate example: a method name matches in `AuthService.refresh`, but receiver type has not been resolved. Display it as a possible caller, not a direct caller.

Impact is a hint for prioritizing inspection and targeted tests. Never exclude broader relevant tests solely because the graph found no relationship or reported partial coverage. When confidence is insufficient, broaden text search and test scope. No automatic injection of every returned source file.

---

# 13. Search Escalation

Use the cheapest suitable mechanism first. This is a cost heuristic: skip irrelevant stages, reuse verified known context and read a known symbol/path directly when possible. Do not call every stage for each action.

```text
1. Working Set
2. ripgrep
3. Symbol Index
4. References
5. Code Graph
6. Git History
7. Optional semantic search
```

Semantic search ไม่อยู่ใน default V1

---

# 14. Incremental Index

Cache: `.macus/cache/index.db`. It is rebuildable and never the source of truth for source code.

Track canonical path, size, high-resolution mtime, content hash, language, grammar/query/resolver versions, parse status and index generation. mtime/size are change-detection hints only; re-hash a requested file before serving cached source or accepting an edit.

Required invalidation events:

| Event | Action |
| --- | --- |
| Agent edit or known shell-generated file change | Refresh changed files after execution; invalidate affected working fragments and test evidence |
| External editor change | Discover with bounded metadata scans and validate hashes on read/edit |
| Delete / rename | Remove old symbols and edges; parse the new path; do not retain dangling links |
| Branch/HEAD change or resume | Reconcile repository/worktree identity and filesystem; mark affected or uncertain data stale |
| Grammar/query/resolver/schema change | Migrate or rebuild the affected cache; never reuse incompatible records |

Use transactional replacement of each file's symbols and edges so readers see a complete generation. Do not full-reparse every turn. File inventory/metadata scans are distinct from parsing; parse only changed or invalidated files. A full rebuild is allowed for incompatible cache schema or explicit repair.

Default exclusions: `.git`, `.macus`, dependency directories, build/generated output, binary files and known secret files. Respect `.gitignore` plus `.macusignore`; policy-denied paths remain excluded even if tracked. Default maximum parsed file size is 1 MiB, configurable; oversized files use bounded text retrieval. Do not follow symlinks outside the authorized worktree. Detect symlink loops and normalize paths for the host filesystem.

Index lazily in a bounded in-process worker. When stale, unavailable or corrupt, expose degraded status and retain fresh ripgrep/range-read functionality. Cache rebuild must not delete durable session state.

---

# 15. Git Context

Git เป็น first-class context source

Tool:

```text
git_state
```

Result example:

```text
branch: feature/auth

modified:
  auth.service.ts +21 -8
  auth.service.test.ts +17 -2

untracked:
  none

last_commit:
  91ae772 implement refresh endpoint
```

Additional tools:

```text
git_diff
git_log
git_show
git_blame
```

ห้าม inject full diff ทุก turn

---

# 16. Change-Aware Context

After a successful edit, invalidate old source fragments and relevant test evidence, update the changed file's symbols/edges, then collect callers/interfaces/tests as bounded metadata with resolution and coverage.

Only verified fresh source enters the effective request. Candidate relationships may promote a file to RELATED but must retain their uncertainty. Track provenance from the edit to each promotion for `/context files`.

Agent edits, shell changes, external editor changes and Git checkout all require freshness checks. Changes not attributable with confidence are `unknown/external`; never claim ownership based only on a dirty Git status.

---

# 17. Tool Output Compression

All high-volume execution paths, including basic bash/read tools, must be bounded from Phase 1. Implement structured parsing for supported runners in Phase 4; unknown formats use deterministic excerpts, not an extra summarization LLM call by default.

Each execution result stores:

```text
executionId, sessionId, toolCallId, command, cwd
startedAt, finishedAt, exitCode (nullable), signal (nullable)
timedOut, cancelled, outputComplete, truncated
parserId/version, parserStatus: parsed|partial|unsupported|error
testCounts (nullable), failureExcerpts, logRef
repoIdentity, head, testedSnapshotDigest, evidenceStatus
```

Sanitize/redact credentials before persistence and model forwarding. Commands containing sensitive arguments must have a redacted display form. Preserve stdout/stderr provenance and useful failure excerpts. Strip unsafe terminal control sequences in display output.

Baseline resource caps: retain at most 8 MiB in memory per execution, spool at most 100 MiB to disk per execution, and enforce configured token caps before returning tool results. Stream to disk while collecting; never buffer an unlimited process output. Report dropped bytes and incomplete capture honestly. Keep logs under `.macus/logs/<sessionId>/`; default retention 7 days with a 1 GiB total cap, evicting oldest inactive logs first. Active log handles must remain valid or return an explicit resource-limit error.

`read_log` uses an authorized opaque log reference with bounded range/cursor, not unrestricted filesystem access. Expired/missing logs produce an explicit error.

Test success requires exit code 0, no timeout/cancellation, and sufficient runner evidence for the claimed result. Use structured reports when available. A complete parsed report may establish counts even when console display is truncated; an incomplete report may not. Unsupported or partial parsing returns `unknown` counts/status. Never convert `unknown`, `not_run` or zero discovered tests into a pass.

Evidence binds to the tested working snapshot including dirty source/config and relevant untracked inputs, not just Git HEAD. Phase 4 may conservatively hash all included workspace inputs before and after tests; if inputs changed during execution, mark evidence stale/unknown. Any later relevant edit invalidates that pass. If the dependency set is unknown, invalidate conservatively.

---

# 18. Error-Focused Retrieval

Recognized compiler/test diagnostics promote bounded file/line/symbol locations into the working set, then retrieve the failing symbol, related signature and likely test.

Diagnostic paths are untrusted tool data: normalize and authorize them before reading. Validate line ranges against current source. Unsupported output falls back to bounded failure excerpts and a targeted search; never invent file/symbol mappings or inject unrelated logs.

Error fingerprints for loop detection include normalized diagnostic, location and relevant source versions. Preserve raw evidence references for follow-up inspection.

---

# 19. Context Ledger

Ledger is session-scoped durable state, stored in the transactional database (§32), not an independent conversation transcript or prompt.

Store goal, decisions with provenance, working/changed files with hashes, task references, evidence references, blockers and next action. Every update has a revision and session ID. Test status is derived from current evidence; do not copy a passed count indefinitely after source changes.

Only selected essential ledger content enters the request. Enforce a bounded size for decisions/notes and retain references to older details. If disabled, Pi transcript and core execution/session persistence remain enabled; resume still works but custom durable summaries are unavailable.

---

# 20. Checkpoint

Create checkpoints before compaction, after a major phase and before a risky refactor or long fix cycle when enabled.

A checkpoint contains schema version, session/repository/worktree identity, Pi transcript entry reference, state revision, goal, task states, decisions, changed file paths and hashes, important symbols, current evidence/failures, next action and pending/unknown executions.

Write a complete checkpoint to a temporary file, flush and atomically rename; register it in the state database. On recovery, reconcile orphan checkpoint files and incomplete records. Never treat an incomplete checkpoint as committed.

**V1 checkpoints restore agent state only. They do not restore source bytes or undo shell side effects.** The filesystem remains authoritative. On restore, compare identities and file hashes, invalidate stale fragments/evidence and reconcile outstanding executions. No automatic reset, clean or checkout. Source rollback is out of scope for V1.

---

# 21. Compaction

Pi's supported compaction is the base. Macus coordinates policy and preservation through the pinned adapter.

Normal/manual/emergency flow: reach a safe tool boundary → commit current task/ledger state → create checkpoint if enabled → invoke Pi compaction → validate and rebuild the effective request → continue only if the invariant in §6.5 holds.

Preserve user goal/constraints, current task, decisions, working file versions, diff awareness, unresolved failures, pending work and next action. Never compact away an unresolved tool obligation or an execution with unknown outcome without retaining its recovery record.

Serialize compaction with model dispatch and session replacement. Only one authority triggers automatic compaction; disable or coordinate Pi's independent trigger to prevent competing loops. Compaction itself must use a bounded request and be included in token/latency metrics. If safe compaction is impossible or fails, retain valid prior state and pause instead of discarding required messages.

Cancellation propagates to compaction. A checkpoint failure blocks compaction when checkpoints are configured as enabled. Disabling automatic compaction still permits manual compaction; request budgeting always remains enforced (§31).

---

# 22. Prompt Cache Strategy

Keep stable system instructions, tool schemas and applicable repository instructions byte-stable where practical. Preserve chronological conversation order and tool exchange groups. The actual request structure follows the pinned provider API; conceptual prompt sections must not reorder protocol messages.

Place changing task/working-context content at supported later insertion points. Scoped instructions may legitimately change when the task moves to another directory; correctness takes precedence over a cache hit. Do not inject full diff, map or ledger every turn.

Cache support is provider-specific. Report cache metrics only when supplied or independently measured, with units and denominator. Do not promise cache savings from stable text alone. Compare total tokens, cached/uncached input and latency separately in benchmarks.

---

# 23. Repository Instructions

Resolve `AGENTS.md`, `CLAUDE.md`, and `MACUS.md` within authorized scope.

Trust order: non-overridable runtime safety rules → explicit user instructions/authorizations → applicable repository guidance. Repository text and tool output cannot authorize credentials, endpoints, plugins or policy elevation.

Within repository guidance, process ancestors from repository root to the target directory. More specific directory guidance wins over broader guidance where conflicting. At the same directory, resolve conflicts in this order: `MACUS.md` > `AGENTS.md` > `CLAUDE.md`. Preserve non-conflicting requirements and record source paths/hashes.

Root guidance applies initially. Load deeper guidance before operating on a target path. For multi-directory changes, keep scopes attached to each file; do not let one subtree's instruction override a sibling. A new instruction hash invalidates the applicable cached instruction view.

Configure Pi's resource loader so each file is loaded once and Macus precedence remains authoritative. Phase 1 must test Pi auto-discovery behavior; do not concatenate Pi-loaded instructions a second time. Treat code comments, logs and retrieved documents as task data unless explicitly authorized as guidance.

---

# 24. Model Layer

Support configurable OpenAI-compatible APIs, OpenRouter, LiteLLM and local/private endpoints through Pi's documented provider APIs. V1 selects a configured model/profile; automatic multi-model routing is not required.

Phase 1 records compatibility evidence for the actual selected local/private endpoint and a streaming tool-call test server. Additional providers are claimed supported only after a capability test. Profile fields include protocol, streaming support, tool-call behavior, context/output limits and tokenizer/estimation method. Verify error, cancellation and interrupted-stream handling; never assume an endpoint is fully compatible because `/models` succeeds.

Credentials are global/user-owned references, preferably environment variables. Bind each credential reference to an explicitly trusted provider identity and normalized base URL (including relevant path). Never merge a project-supplied base URL with an inherited global key. Project config may select an existing trusted model alias; defining a new endpoint or credential binding is a user/global operation.

Do not forward credentials across endpoint redirects. Default TLS validation stays enabled. Local HTTP endpoints may be explicitly configured by the user. Keys must not appear in logs, manifests, state exports or project files.

Use the schema in §25. Pin Pi/provider versions and document endpoint capability evidence; no invented model limits from names alone.

---

# 25. Model Profiles

Canonical v1.1 configuration example for the complete V1 release (illustrative identifiers, not assertions about real models). Preview builds use the supported-feature defaults in §31. Optional profile/provider fields described below are validated by the same schema.

```yaml
schema_version: 1
models:
  default: primary
  providers:
    private_gateway:
      protocol: openai-compatible
      base_url: ${MACUS_MODEL_BASE_URL}
      api_key_env: MACUS_MODEL_API_KEY
      profile: standard
      model: your-model-id
  aliases:
    primary: private_gateway

context:
  reserved_output_tokens: 8192
  safety_margin_tokens: 2048
  target_prompt_ratio: 0.55
  compact_prompt_ratio: 0.72
  emergency_prompt_ratio: 0.85
  budget:
    repo_map_tokens: 1200
    search_results_tokens: 2500
    tool_output_tokens: 5000
    single_file_read_tokens: 8000

model_profiles:
  standard:
    context_window: 131072
    max_output_tokens: 8192
    tokenizer: conservative-byte-estimate
    context:
      reserved_output_tokens: 8192

run:
  max_model_turns: 40
  max_no_progress_attempts: 3
  max_duration_seconds: 1800

execution:
  command_timeout_seconds: 120
  test_build_timeout_seconds: 600
  termination_grace_seconds: 2
  max_output_memory_bytes: 8388608
  max_log_bytes: 104857600
  environment_allowlist: [PATH, HOME, TMPDIR, LANG, LC_ALL]

retrieval:
  search_max_results: 100
  search_timeout_seconds: 10
  max_parse_file_bytes: 1048576

logs:
  retention_days: 7
  max_total_bytes: 1073741824

features:
  repo_map: true
  code_graph: false
  context_ledger: true
  checkpoint: true
  auto_compaction: true
  git_context: true
  task_engine: true
  prompt_cache_optimization: true
  semantic_search: false
  telemetry: false
```

Resolve trusted config layers per §30, then apply the selected profile's `context` fields over the common context defaults; explicit user CLI context overrides win last. `context_window`, `max_output_tokens` and `reserved_output_tokens` must be positive and mutually valid. R must not exceed the validated model output limit. All budgets are non-negative and constrained by the effective total cap.

Optional provider `api_key_env` is omitted only for an explicitly configured unauthenticated endpoint; otherwise a referenced but missing variable is an error. Optional profile `max_input_tokens` further constrains P. Provider capability metadata records the validated protocol/streaming/tool-call and reasoning accounting mode; implementation must use an explicit typed schema and reject unsupported modes. Baseline streaming/tool-call support is mandatory for an agent model. Auth protocol and exact Pi capability mapping are confirmed in Phase 1.

The `run`, `execution`, `retrieval` and `logs` fields above are canonical configuration keys. Numeric time/count/byte limits must be positive; context category caps may be zero to disable optional inclusion. Environment names are an explicit allowlist; adding a variable requires user/global configuration. Runtime removes configured model credential variables even if accidentally listed unless the user explicitly authorizes that specific tool environment. Project overrides cannot expand authority or resource limits beyond user/global ceilings. Versioned schema additions require documentation and validation tests.

Reject unknown fields, missing environment references, unknown aliases/profiles, impossible budgets and unsupported profile capabilities with actionable errors. Never print the resolved key in `/settings` or validation errors.

---

# 26. CLI

Main executable:

```bash
macus
```

Examples:

```bash
cd project
macus
```

หรือ:

```bash
macus "fix refresh token bug"
```

---

# 27. CLI Commands

Required V1:

| Command | Contract | Phase |
| --- | --- | --- |
| `/help`, `/status`, `/exit` | Help, current run/state, graceful cancellation and exit | 1 |
| `/model`, `/models` | Select/list trusted aliases; revalidate context before dispatch | 1 |
| `/settings` | Show resolved values and provenance with secrets redacted | 1 |
| `/resume [id]` | Select one session; verify worktree and reconcile execution journal | 1 |
| `/clear` | Start a new session after current run is idle/cancelled; preserve old session; never delete code | 1 |
| `/compact` | Manual Pi-backed compaction with budget/protocol validation | 1 base, 5 full preservation |
| `/context` | Actual last-request manifest plus separately labelled next-request estimate | 1 basic, 3 detailed |
| `/context files` | Included/omitted source, reason, tier, hash/freshness and token estimate | 3 |
| `/tasks` | Current session's persisted tasks and evidence | 4 |
| `/diff` | Bounded current Git diff with user/agent/unknown attribution | 4 |
| `/checkpoint` | Create/list/select state checkpoints; no source rollback | 5 |

Recommended optional commands: `/map`, `/search`, `/symbol`, `/test`, `/review`. Unsupported or disabled features return a clear status rather than a success placeholder.

Ctrl-C cancels the active run; a subsequent idle exit is explicit. Define one consistent behavior for `macus "task"`: start an interactive session with that initial prompt. Noninteractive/CI execution is not required for V1 and must not be inferred from this syntax.

---

# 28. CLI Status Bar

Example:

```text
glm-5.3 | ctx 21k/128k | files 4 | tasks 3/6 | branch feature/auth
```

Optional provider metrics:

```text
cache input 82% (reported cached input / total input, last request)
```

only when available

---

# 29. Context Inspector

`/context` must describe the actual effective request, not only the working-set database.

Show model/profile, context limit, reserved output, safety margin, prompt cap, actual last-request ID/time, estimated category totals and provider-reported input usage when available. Display the estimation method. Show prospective next-request estimates separately; they are not exact provider usage.

Use mutually exclusive categories: system, tool schemas, repository instructions, task/ledger, working source, repo map, search results, other tool output and remaining conversation. Category totals must sum to the displayed estimated prompt total; nested breakdowns must be labelled and excluded from that sum.

`/context files` shows included and omitted fragments with path/symbol, reason, tier, source hash, freshness, estimated tokens and omission reason. It must reveal stale fragments, truncation and uncertain relationship evidence. Credentials are never displayed.

---

# 30. Settings

Global config: `~/.macus/config.yaml`. Project config: `.macus/config.yaml`.

Resolve defaults → global config → allowed project fields → explicit user CLI overrides. `MACUS_CONFIG` selects an alternate user/global config path; CLI `--config` wins over that path. Environment references substitute values only in trusted user/global fields; they do not introduce a hidden precedence layer. Follow profile resolution in §25 after merging.

Project may select an already trusted model alias, adjust retrieval budgets within validated bounds, set ignore patterns and configure optional feature flags. Project cannot define endpoints/credentials, extend filesystem or network authority, load arbitrary executable plugins, or weaken execution policy. Reject forbidden overrides visibly; do not silently apply them.

Execution trust belongs to a user-owned record outside the repository, bound to canonical repository/worktree identity and an explicit policy scope. A repository config file cannot mark itself trusted. Reuse valid authorizations; do not re-prompt for every routine action inside the accepted scope. Material policy/endpoint/plugin changes require a new authorization.

Validate the complete schema before creating a model request. `/settings` exposes resolved values, their source and feature limitations, with credential references redacted as appropriate.

---

# 31. Feature Flags

The complete V1 example in §25 is authoritative. Optional features may be disabled, but core safety, request budgets, session identity and execution journaling are never optional.

Preview builds declare their completed phase/capabilities. In Phase 1, all optional flags in §25 default to false, while basic Pi manual compaction, core request budgeting and instruction/session recovery stay active. `repo_map` becomes available in Phase 2; `task_engine` and optional `git_context` in Phase 4; `context_ledger`, `checkpoint`, `auto_compaction`, and `prompt_cache_optimization` in Phase 5; `code_graph` in Phase 6. New complete-V1 configurations use §25 defaults. Never silently overwrite an existing user's disabled flag on upgrade. Explicitly enabling an unimplemented feature is an error; no successful placeholder behavior.

| Flag disabled | Required behavior |
| --- | --- |
| `repo_map` | Search and smart reads continue without injected map |
| `code_graph` | Remove graph scoring; reference/impact tools return unavailable or labelled text candidates; broaden tests |
| `context_ledger` | Resume uses Pi transcript plus core execution/task/evidence state; no custom ledger summary |
| `checkpoint` | Skip user-visible snapshots; atomic core persistence and resume remain active |
| `auto_compaction` | Manual compact remains; pause if budgets cannot be satisfied safely |
| `task_engine` | Hide structured task UX; retain core run identity, user goal and execution recovery |
| `git_context` | Disable optional Git history/context tools; retain mandatory baseline and identity checks where Git exists |
| `prompt_cache_optimization` | Keep protocol validity; no cache-oriented tuning |

`semantic_search: true` is rejected as unsupported in V1. `telemetry: true` is rejected until an explicit telemetry feature exists; local benchmark metrics do not upload data. Enabling `code_graph` before Phase 6 is available returns a clear unsupported-feature error.

If ledger/checkpoints are disabled, compaction uses the Pi summary plus essential core state and the retention checks in §21. Reduced recovery metadata is visible in status; it must never imply source rollback support.

---

# 32. Local Storage

```text
.macus/
  config.yaml
  state/
    state.db
  sessions/
    <sessionId>/
      <Pi-owned transcript files>
  cache/
    index.db
  checkpoints/
    <sessionId>/
      <checkpointId>.json
  logs/
    <sessionId>/
  metrics/
    <runId>.json
```

`state.db` uses SQLite transactions with foreign keys, a schema version, WAL mode and `synchronous=FULL` on the supported local filesystem. Test crash durability; reject or explicitly document unsupported filesystem locking/durability behavior. Core tables: sessions, runs, tasks, ledger_revisions, executions, execution_events, test_evidence, checkpoints and schema_metadata. Every session-owned row is scoped by `sessionId`; relevant rows also reference `runId` and state revision. The index cache is separate and rebuildable, and may use less stringent durability settings without weakening state.db.

Pi owns transcript serialization through supported APIs. Macus stores transcript path/entry references, not a second editable message history. There is no assumed transaction spanning Pi transcript and state.db: reconciliation uses execution IDs, transcript tool-call IDs, state revision and checkpoint boundaries (§38).

Bind sessions to canonical worktree root and Git directory/common-directory identity where present; branch/HEAD are revisions, not session identities. Non-Git directories use canonical root identity. A moved repository requires explicit rebinding; never silently resume into a different folder.

Enforce one mutating process/run per worktree with an OS-backed exclusive lock released on process termination; do not rely on a stale PID file alone. Separate sessions retain separate tasks/ledger/transcripts. Other terminals may inspect stored state read-only and are refused a second mutation run. Shared index/state database access remains transactional.

Restrict local state and logs to the current user where supported. Exclude sessions, state, checkpoints, logs, metrics and cache from Git and retrieval. Keep shareable config/ignore files eligible for version control without secrets. User/global credentials and trust records remain outside project state.

Migrations are versioned, transactional and tested. Unsupported future schema versions fail clearly; do not erase state to repair them. A corrupt cache can be rebuilt; corrupt durable state is preserved for recovery and reported.

---

# 33. Safety Around File Changes

Record initial Git status and hashes of files before editing; preserve staged, unstaged and untracked user changes. Classify changes as `agent`, `pre_existing`, or `external_or_unknown` using recorded writes/hashes, not Git status alone.

Read-before-edit: validate the current content hash against the observed version, compute the patch, and perform the write atomically while preserving relevant permissions. On mismatch, re-read and recompute; never overwrite an intervening user edit. A worktree lock protects Macus instances but not external editors, so recheck at commit time and document the remaining filesystem race limits.

Resolve real paths before access; reject traversal and symlinks escaping authorized roots. Protect Macus internal state from generic agent editing. Supported state/config tools use validated operations; source edit tools cannot bypass journal/policy checks by writing state files directly.

No automatic hard reset, untracked-file cleanup, force push or destructive source rollback. Normal commit/push also requires explicit user authorization within the current task or a saved applicable policy; coding-task completion alone does not grant publication permission.

---

# 34. Command Execution

All executable paths, including Pi built-in tools, custom tools and approved extensions, pass through Policy Executor. A direct Pi bash/write route that bypasses policy, journaling or output bounds is a Phase 1 gate failure.

Tool contract: `cwd`, structured args or explicit shell command, timeout, output limits, allowed environment, cancellation signal and execution identity. Default command timeout is 120 seconds; test/build profiles may use up to 600 seconds unless the user configures a different bound. Do not inherit model credentials into tool subprocesses by default; use an explicit environment allowlist with required runtime variables.

Policies distinguish read operations, workspace edits, trusted test/build scripts, external effects and destructive actions. Repository authorization may approve routine edits/tests for that scope once. Unknown shell commands or effects outside scope require explicit authorization; noninteractive use fails closed. Existing authorization remains valid within its scope.

Command-name matching is only a diagnostic, not a security boundary: `npm test`, scripts, shell wrappers and interpreters can perform arbitrary actions. V1 local execution is **not an OS sandbox**. Describe this honestly when authorizing repository scripts; path restrictions on built-in read/edit tools do not confine arbitrary shell processes. OS sandboxing is optional future work and must not be claimed without implementation.

Journal intent before launch, then observed completion/cancellation. On timeout/cancellation terminate the process group, wait a bounded grace period (default 2 seconds), force termination if needed, and record confirmed or unknown outcome. Process cleanup alone does not prove that an external side effect did not happen. Never replay unknown side-effecting executions automatically (§38).

---

# 35. Coding Workflow

Default:

```text
1. Inspect repository
2. Read repository instructions
3. Understand task
4. Search code
5. Build working set
6. Create plan
7. Create tasks
8. Implement
9. Run targeted tests
10. Fix failures
11. Run broader tests
12. Inspect diff
13. Review
14. Complete
```

Agent should not repeatedly plan after implementation has started unless:

* task changes
* major blocker discovered
* initial assumptions invalid

---

# 36. Testing Strategy

Prefer targeted tests → affected module tests → full relevant suite according to change risk. Do not run the full repository after every small edit.

Discover test commands from project configuration and applicable instructions, inspect their scope and apply execution policy. Initial structured result adapters: Node test/JUnit-compatible reports and .NET TRX. Unknown runners remain usable with explicit unknown test counts and bounded logs.

Impact analysis prioritizes tests; it is not proof that unlisted tests are unaffected. If graph resolution is incomplete, broaden search and run the relevant module/suite. Persist test evidence per §17, including the tested working snapshot. An edit after a successful test invalidates affected evidence.

No test command, no discovered tests, timeout, cancellation, incomplete parser output and command failure are distinct results. Report `not_run`, `unknown` or `failed` as appropriate. Review cannot promote any of these into `passed`.

---

# 37. Review Stage

Before completion inspect the current diff, task state, current test/build evidence, unexpected changes and remaining type/syntax failures. Distinguish pre-existing failures from introduced ones with evidence.

Output includes Changed, Tested (commands, snapshot and evidence IDs), Remaining Risk and Unresolved Issue. A successful model response or stopped Pi run is not sufficient for completion. Check completion criteria in the user task and mark unresolved blockers explicitly.

Evidence must still match the current source snapshot. Never reuse a green result from before the final edit or claim unrun tests. Review does not automatically commit, push, merge or publish.

---

# 38. Recovery

Resume after process/terminal termination, machine restart, model/network error or compaction must reconcile durable state before a new mutation or model dispatch.

Execution journal lifecycle:

```text
prepared -> started -> completed | failed | cancelled | unknown
```

`prepared` intent is committed before launch. A crash between launch and its acknowledgement means either prepared or started may have an uncertain outcome. Store an execution ID, Pi tool-call ID, redacted inputs, preconditions/expected hashes, effect classification and evidence references. For non-idempotent external effects, intent/result records do not provide exactly-once execution.

Recovery order:

1. Acquire the worktree mutation lock; verify repository/worktree/session identity and schema.
2. Load Pi transcript using supported APIs and load the corresponding state revision.
3. Reconcile journal entries with recorded tool results and filesystem/external evidence. Do not append a duplicate successful result when one already exists.
4. Resolve incomplete tool exchanges through the supported adapter. A completed durable result may be restored once; an uncertain result remains explicitly unknown. If Pi cannot repair the exchange through supported APIs, pause instead of editing its session file.
5. Revalidate working files, branch/HEAD, source hashes, index generations and test evidence.
6. Build the next request with unresolved executions and blockers preserved, then resume only authorized safe work.

Read-only retrieval may be retried after validation. A write can be reconciled by known before/after hashes; if neither matches, it is a conflict. Unknown shell commands, migrations, commits, pushes or external effects require inspection and explicit authorization before replay. Never assume that a missing response means the operation did not execute.

Network retries before tool dispatch are separately bounded. After a partial assistant stream or tool dispatch, inspect lifecycle state before retrying; avoid duplicate tool calls. If a child process survives an unexpected parent termination, identify it through the supervised process identity before taking action; do not kill unrelated processes by PID alone.

Mandatory recovery tests include termination before launch, after launch, after file write but before result persistence, after durable completion but before transcript result, during compaction, during schema migration, and after external edits/branch changes. Unsupported recovery states must pause with preserved evidence rather than silently restart the task.

---

# 39. Performance Targets

These are acceptance targets to measure, not achieved performance claims. Reference environment: Mac mini M4 Pro 48 GB, local SSD, recorded macOS and pinned Node/Pi versions. Use a versioned mixed TS/JS/C# fixture of 10,000 included source files and approximately 100 MiB text; record the exact manifest and exclusions.

| Metric | Initial target / reporting rule |
| --- | --- |
| Warm startup to usable prompt | p95 < 2 seconds over 30 starts; excludes network model latency; no full reparse before prompt |
| Warm bounded text search | p95 <= 500 ms over 100 recorded representative queries, up to 100 results |
| Verified cached symbol read | p95 <= 200 ms over 100 queries, including source freshness check |
| Single-file index refresh | p95 <= 1 second for files <= 100 KiB; report parser/language |
| Idle CPU | Average < 1% of one core over 60 seconds after background work settles |
| CLI/indexing peak RSS | Report separately from local inference memory; initial engineering budget <= 512 MiB on reference fixture |
| Cold indexing | Record duration, peak RSS and files/second; must not block basic text search or prompt use |

If fixtures/hardware differ, report separately rather than claiming the reference gate passed. Revisit targets explicitly with evidence; do not silently relax them.

Create the benchmark harness and unmodified Pi baseline in Phase 1. Compare the pinned Pi baseline and Macus on the same initial repository revision, task prompt, model endpoint/version, generation settings, context/output limits and test oracle. Reset task workspaces between runs. Include discovery, edit/test, large-output, ambiguity, compaction and crash/resume tasks.

Run at least 3 paired repetitions per task/condition. Separate cold/warm repository caches and provider cache conditions; record uncontrolled provider cache state as unknown. Alternate run order where practical. Measure task success first, then all input/output tokens including summaries/retries/compaction, reported cached/uncached tokens, wall time, first useful edit time, tool calls, peak context and CLI memory. Record cost only with an explicit pricing source/config; do not estimate savings from context size alone.

For the small fixed acceptance suite, require no newly failing correctness/recovery cases versus baseline. This is a regression gate, not statistical proof of equivalence. Report per-task distributions and raw run data. Claim token/latency improvement only for measured conditions, without hiding quality regressions. Publish measured results in Phase 7; the baseline and harness already exist from Phase 1.

---

# 40. Non-Goals V1

ไม่ทำ:

```text
Vector DB
Full repository embeddings
Neo4j
Full program analysis
Distributed agent system
Mandatory sub-agents
Web UI
Cowork integration
Cloud project sync
Full IDE replacement
Continuous background daemon
```

---

# 41. Suggested Package Structure

Start with one TypeScript package unless the repository already has a working monorepo. Keep logical modules for cli/tui, agent-runtime, context-runtime, code-intelligence, task-engine, git-context, model/config, policy and state. Split packages only when independent APIs/builds justify it.

Use one Node LTS runtime and one detected/chosen package manager, pinned with a lockfile in Phase 1. Bun compatibility is optional and must not double the initial support matrix. Pin Tree-sitter bindings/grammars and SQLite implementation; validate installation on macOS arm64 and the chosen Linux test environment.

Keep `docs/`, tests/fixtures, benchmark fixtures and third-party notices. No Docker or persistent external indexing/database service is required. Do not build a custom TUI framework when supported Pi composition can satisfy the product UX.

---

# 42. Pi Integration Rules

Pi remains behind `AgentKernel` / `PiAgentKernel`. Pin the actual upstream package(s), version or commit, runtime and license notices after inspecting the installed/upstream code. Do not infer an API or package name from this conceptual specification.

Required internal adapter capabilities (names below are Macus contracts, not asserted Pi SDK method names):

| Capability | Required behavior |
| --- | --- |
| Session lifecycle | Create, resume, switch and dispose while reconciling worktree state |
| Streaming | Subscribe/unsubscribe to model, tool, retry, compaction and run events |
| User input | Start a run; explicitly queue or steer new input without parallel mutation loops |
| Cancellation | Abort model/compaction and propagate tool process-group cancellation |
| Request preparation | Inspect/transform or safely compact the effective context before every provider request |
| Tool registration/execution | One policy/journal/output pipeline for built-in and custom tools |
| Compaction | Preserve essential state at safe boundaries; one automatic trigger authority |
| Model selection | Validate capabilities and budgets before switching |
| Recovery | Restore/reconcile tool exchanges through supported APIs and expose unsupported cases |

Use async events or an async iterable for streaming rather than a `send(): Promise<AgentResult>`-only abstraction. Expose stable internal DTOs for request manifests, tool outcomes and session references; keep Pi types inside the adapter.

Phase 1 writes `docs/pi-compatibility.md` mapping every capability to an exact public API and pinned source/example, with tests for streaming, nested tool turns, context transformation, compaction, cancellation, session replacement and resume. Re-subscribe/rebind resources on session replacement where the pinned API requires it.

If any required hook is unavailable, record the observed limitation and test a supported extension/SDK alternative. A core patch requires a narrow documented rationale and upstream maintenance plan. Do not fake context control by changing only the status bar or working-set list.

---

# 43. Branding

User-facing brand:

```text
Macus Code
```

CLI:

```text
macus
```

Paths:

```text
~/.macus
.macus/
```

Environment variables:

```text
MACUS_MODEL_API_KEY
MACUS_MODEL_BASE_URL
MACUS_CONFIG
```

Pi branding should not appear in normal UX unless technically necessary

Third-party attribution/license must remain compliant with upstream licenses

---

# 44. MVP Definition

V1 release scope retains the original capabilities: interactive CLI, configurable Pi-backed model, instructions, bounded search, structural symbols, smart reads, repo map, working set, tasks, edits, build/tests, output summaries, Git/diff, ledger, checkpoints, compaction/resume, context inspection and test/review evidence.

Add the mandatory correctness contracts in v1.1: actual request budgeting, source freshness, session isolation, crash reconciliation, credential/endpoint binding and centralized execution policy. Lightweight graph is Phase 6 and remains optional at runtime; it must not block basic operation.

Phases 1–4 yield a usable internal preview; it must not be labelled production-ready. V1 release requires all seven phase gates, truthful recovery limitations, installation evidence and measured benchmarks. Checkpoints provide state recovery only. No automatic model routing, source rollback, external sandbox, mandatory sub-agents or cloud integration is implied.

---

# 45. Recommended Implementation Order

This table is the authoritative phase contract. Handoff uses the same IDs and gates. Continue automatically to the next phase after its gate passes; stop only for a real blocker, missing required authorization, failed gate or explicit user scope limit.

| Phase | Deliverables | Required gate evidence |
| --- | --- | --- |
| 1 — Agent Foundation & Safety | Pinned Node/Pi adapter; branded CLI; trusted config/model binding; streaming; basic tools through policy; bounded output; core state DB/journal; session/resume; manual compaction; basic request budget; instruction resolver; baseline benchmark harness | Prove every adapter hook; each provider request meets budget; no orphan tool exchanges; cancel propagates; crash after write does not replay; forbidden endpoint override fails; unrelated edits survive; baseline recorded |
| 2 — Code Retrieval & Freshness | ripgrep; TS/JS/C# syntax fixtures; symbol IDs; smart read; bounded repo map; bounded incremental SQLite cache | Ambiguous/unsupported symbols explicit; edited/deleted/renamed files and checkout refresh correctly; stale hashes never drive edits; exclusions/symlink bounds verified |
| 3 — Context Runtime | Working set; tiers; deterministic selector; request manifests; deduplication; provenance; detailed inspector | Actual dispatched requests match manifests and category sums; repeated reads do not duplicate source; current source replaces superseded source; switch to smaller model stays within budget; all tool groups valid |
| 4 — Coding Workflow & Evidence | Plan/tasks; bounded test/fix loop; structured test adapters; Git context/diff; review | Tasks survive resume; partial/unknown/timeout/no-test results never pass; final evidence matches source; user changes preserved; loop caps and blockers work |
| 5 — Durable Context & Optimization | Ledger; state checkpoints; full compaction coordination; stage-aware context; prompt stability; refined output summaries | Goal/constraints/tool obligations survive compaction; failures/cancellation preserve usable state; checkpoint restore invalidates stale evidence without reverting code; supported feature-flag combinations work |
| 6 — Lightweight Relationships | Optional graph; references/dependencies/dependents; impact with resolution/evidence/coverage | Duplicate names, aliases, overloads and dynamic calls never yield false certainty; incomplete graph does not exclude required tests; graph disabled retains search/workflow |
| 7 — Release Hardening | Expand recovery/migration tests; performance and paired benchmark report; macOS/Linux install/package validation; documentation/license audit | All earlier gates remain green; clean install works; recovery interruption matrix passes or unsupported states explicitly pause; quality regression gate passes; metrics/limitations published |

Common gate for every phase: implementation works through the CLI; meaningful tests and typecheck pass; build passes; lint passes if configured; docs updated; diff reviewed; no unrelated changes; write `docs/phase-N-evidence.md` with commands, versions, result locations, requirement coverage and blockers. A failed command or absent required test cannot be marked complete.

Baseline journal/policy/recovery, bounded outputs and benchmark instrumentation are Phase 1 foundations. Phase 7 expands their coverage; it does not introduce them for the first time.

---

# 46. Success Criteria

Macus Code succeeds when it completes real coding tasks correctly with a bounded, inspectable request context and resumes without losing intent or duplicating unknown side effects. It remains a fast independent CLI with local retrieval and optional lightweight relationships.

Primary objective: minimum sufficient context for correct action. Secondary objective: durable, verifiable continuation through compaction/failure/resume. Quality regressions cannot be traded away silently for token savings.

## v1.1 review closure and acceptance mapping

| Review finding | Normative sections | Acceptance evidence |
| --- | --- | --- |
| R1 Effective request control and adapter gaps | §6, §6.2–6.5, §21–22, §29, §42 | Capture actual dispatches across multiple tool turns; verify bounded size, deduplication, valid protocol and cancellation |
| R2 Session isolation and unsafe replay | §5.3, §19–20, §32, §38 | Two sessions keep separate state; second writer refused; injected crashes never replay unknown effects |
| R3 Credential/config trust and tool policy | §23–25, §30, §33–34 | Project endpoint/key/policy overrides rejected; all tool routes covered; authorization survives within scope |
| R4 Overstated semantic relationships | §8, §11–12, §36 | Ambiguous/dynamic fixtures labelled candidate/unresolved; broader test fallback exercised |
| R5 Budget schema and accounting | §6.5, §25, §29 | Invalid aliases/budgets fail; model switch validated; category sum equals estimate; actual usage separately labelled |
| R6 Stale index and edits | §6.4, §9, §14, §16, §33 | Rename/delete/checkout/external changes invalidate stale fragments and compare-before-write guards |
| R7 Incorrect test/output summaries | §17–18, §36–37 | Partial, timed-out, cancelled and zero-test runs cannot report passed; after-edit evidence becomes stale |
| R8 Missing baseline and measurable targets | §39, §45 | Phase 1 baseline and Phase 7 paired report include correctness, all tokens, latency, caches and memory |
| R9 Cross-document drift | §23, §27, §31, §45 and document contract | Same phase IDs/gates, feature dependencies, command scope and continuation rule in both documents |

## Technical reference pointers

These are upstream reference entry points, not a guarantee that the implementation uses their latest API. Pin an exact source version and save compatibility evidence in Phase 1.

- [Pi SDK documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md): session lifecycle, events, abort and compaction APIs.
- [Tree-sitter introduction](https://tree-sitter.github.io/tree-sitter/): incremental concrete syntax parsing; cross-file semantic resolution remains a Macus contract with stated limits.

---
