# Macus Code — Implementation Handoff

You are taking over implementation of **Macus Code**.

Macus Code is a standalone local CLI coding agent.

It is NOT part of Cowork.

Read this document completely before making changes.

---

# 1. Mission

Build a lightweight, practical CLI coding agent named:

```text
Macus Code
```

CLI command:

```bash
macus
```

The system uses Pi as the underlying agent kernel but adds its own:

* coding workflow
* task engine
* code intelligence
* context runtime
* token optimization
* Git awareness
* CLI/TUI experience

The primary differentiator is not a custom LLM agent loop.

The primary differentiator is:

> selecting the right source-code context at the right time while using as few tokens as practical.

---

# 2. Required Reading

Before implementation, locate and read:

```text
spec.md
README.md
package.json
tsconfig.json
existing source structure
existing tests
existing configuration files
```

If Pi source or Pi dependency exists, inspect:

```text
agent/session APIs
extension APIs
tool APIs
compaction APIs
model/provider APIs
```

Do not assume APIs.

Inspect the actual installed/upstream version before implementation.

---

# 3. Repository Assessment

Before writing code:

1. Inspect repository tree.
2. Detect package manager.
3. Detect runtime.
4. Detect existing Pi integration.
5. Detect tests.
6. Detect lint/typecheck/build commands.
7. Detect existing CLI framework.
8. Inspect Git status.
9. Do not overwrite unrelated user changes.

Produce an internal implementation map before editing.

---

# 4. Architecture Constraints

The intended structure is:

```text
Macus Code CLI
      │
      ▼
Agent Harness
      │
      ▼
Context Runtime
      │
 ┌────┼────┐
 ▼    ▼    ▼
Code Git  Task
Intel     Engine
      │
      ▼
Pi Agent Kernel
      │
      ▼
LLM
```

Do not make application modules depend directly on Pi internals where avoidable.

Create a clean adapter boundary around the agent kernel.

Preferred abstraction:

```text
AgentKernel
```

Pi-backed implementation:

```text
PiAgentKernel
```

---

# 5. Major Rule

Prefer:

```text
Pi extension
Pi SDK
wrapper
adapter
composition
```

over modifying Pi core.

Patch Pi core only when the required behavior cannot reasonably be implemented through supported APIs.

Every Pi core modification must be documented.

---

# 6. Product Boundary

Do NOT implement:

* Cowork integration
* web workspace
* document upload
* document knowledge graph
* document generation
* vector database
* mandatory embedding model
* Neo4j
* cloud synchronization

Macus Code must run independently from a terminal.

---

# 7. Platform

Primary environment:

```text
macOS
```

Implementation should remain portable to Linux where practical.

Do not introduce dependencies that require Docker or an always-running external service.

---

# 8. Runtime Dependencies

Target dependency footprint:

```text
Pi
Node.js or Bun
Git
ripgrep
Tree-sitter
SQLite
```

Do not add new infrastructure without strong justification.

---

# 9. Implementation Workflow

Use this workflow for the implementation itself:

```text
Inspect
↓
Plan
↓
Create TODOs
↓
Implement small unit
↓
Test
↓
Review diff
↓
Continue
```

Maintain a task list during implementation.

Do not attempt the whole specification in one uncontrolled change.

---

# 10. Phase 1 — Foundation

Implement first:

```text
macus CLI
configuration
Pi adapter
model configuration
basic session
resume
basic read/write/edit/bash tools
```

Expected result:

```bash
cd repository
macus
```

opens an interactive agent session.

Minimum commands:

```text
/help
/status
/model
/settings
/resume
/exit
```

Do not move to advanced indexing until basic Pi integration works reliably.

---

# 11. Phase 2 — Search & Smart Read

Add:

```text
search_code
search_symbol
read_symbol
read_range
expand_context
```

`search_code` should use ripgrep.

Results must be bounded.

Never pass unlimited ripgrep output into the LLM.

---

# 12. Tree-sitter

Use Tree-sitter for structural source-code information.

Initial language support should prioritize repository needs.

Do not attempt dozens of languages before core behavior works.

Tree-sitter responsibilities:

```text
symbols
imports
exports
definitions
basic references where reliable
```

Do not send raw AST to the LLM.

---

# 13. Smart Read Policy

Preferred workflow:

```text
search
↓
locate symbol
↓
read symbol
↓
expand context if necessary
```

Avoid reading entire large files by default.

A request for a symbol should normally return:

```text
file
line range
symbol signature
body
minimal surrounding context
```

---

# 14. Repository Index

Create local cache:

```text
.macus/cache/index.db
```

Use SQLite unless there is a compelling reason otherwise.

Track:

```text
files
symbols
edges
file hashes
```

Incremental update must use:

```text
path
mtime
size
content hash
```

Only reparse changed files.

---

# 15. Repository Map

Build a lightweight repo map.

It should describe structure without reproducing implementation.

Example:

```text
src/auth/auth.service.ts

class AuthService
  login(...)
  refresh(...)


src/token/token.service.ts

class TokenService
  createToken(...)
  refreshToken(...)
```

Repo map must have a configurable token budget.

Recommended starting default:

```text
1200 tokens
```

Repo map is retrieval metadata.

Do NOT inject the entire repo map into every model turn.

---

# 16. Context Runtime

Implement Context Runtime as a first-class module.

Suggested package:

```text
packages/context-runtime
```

Responsibilities:

```text
context candidate collection
ranking
deduplication
working set
token budgeting
context tiers
provenance
compaction coordination
```

---

# 17. Context Tiers

Implement:

```text
HOT
WARM
COLD
```

HOT:

```text
current task
current error
edited files
current diff
current tests
```

WARM:

```text
dependencies
references
related tests
interfaces
implementations
```

COLD:

```text
repo map
distant files
old Git history
unrelated modules
```

COLD context should remain outside model context until requested or promoted.

---

# 18. Working Set

Maintain:

```text
ACTIVE
RELATED
DISCOVERED
STALE
```

Example:

```text
ACTIVE
auth.service.ts

RELATED
token.service.ts
auth.service.test.ts
```

The working set should change dynamically as the agent searches, reads, edits and tests.

---

# 19. Context Selector

Do not use an extra LLM request for routine context ranking.

Use deterministic ranking first.

Signals can include:

```text
exact symbol match
path match
current task match
working-set membership
graph distance
edited-file bonus
test relationship
recent access
```

Keep ranking implementation simple and inspectable.

---

# 20. Context Provenance

Every selected context item should carry metadata.

Example:

```json
{
  "source": "src/auth/token.service.ts",
  "symbol": "refreshToken",
  "startLine": 87,
  "endLine": 132,
  "reason": "direct-reference",
  "score": 0.94,
  "contentHash": "..."
}
```

Use content hashes to invalidate stale fragments.

---

# 21. Token Budget

Implement a central ContextBudgetManager.

It must know:

```text
model context window
current usage
output reservation
repo-map budget
tool-output budget
search-result budget
compaction threshold
```

Do not hardcode one context policy for every model.

---

# 22. Context Policy

Use lifecycle-aware priority.

Discovery stage:

```text
search      high
repo map    high
symbols     high
diff        low
```

Implementation stage:

```text
working files high
references    high
repo map      low
```

Testing stage:

```text
errors        very high
tests         very high
current diff  high
repo map      very low
```

---

# 23. Tool Output

All high-volume tools must use bounded output.

Especially:

```text
build
test
lint
grep
git diff
logs
```

Save full output locally when useful.

Send summary to LLM.

Example:

```text
Tests

Passed: 214
Failed: 2

Failure:
AuthService.refresh
auth.service.test.ts:218

Full log:
/tmp/macus/test-932.log
```

Implement a `read_log` mechanism for follow-up inspection.

---

# 24. Error Retrieval

When a compiler/test error identifies:

```text
file
line
symbol
```

automatically promote that location into the working context.

Then locate:

```text
current symbol
related signature
related test
direct dependency
```

Do not inject unrelated logs.

---

# 25. Git Context

Git should be treated as context rather than only as shell commands.

Implement:

```text
git_state
git_diff
git_log
git_show
```

`git_state` should return a compact summary.

Never automatically:

```text
git reset --hard
git clean -fd
force push
```

Preserve user-existing changes.

---

# 26. Change Impact

After editing a symbol, update relationships.

Provide lightweight impact analysis:

```text
changed symbol
direct callers
interfaces
implementations
tests
```

Do not attempt full program analysis.

---

# 27. Code Graph

Keep V1 graph intentionally small.

Edges:

```text
file imports file
file contains symbol
symbol references symbol
symbol implements symbol
test references symbol
```

Store in SQLite.

Do not introduce Neo4j.

---

# 28. Task Engine

Implement task state independently from conversation history.

Suggested:

```text
.macus/state/task.json
```

Statuses:

```text
pending
in_progress
completed
blocked
skipped
```

CLI should show:

```text
Tasks 3/6

[✓] Locate implementation
[✓] Inspect dependencies
[✓] Create plan
[ ] Modify code
[ ] Run tests
[ ] Review diff
```

Tasks should survive session resume.

---

# 29. Context Ledger

Persist durable agent state separately from chat.

Suggested:

```text
.macus/state/ledger.json
```

Store only durable information:

```text
goal
important decisions
working files
changed files
test state
blockers
next action
```

Do NOT store every conversation message in the Ledger.

Do NOT inject the entire Ledger into every prompt.

---

# 30. Checkpoints

Create checkpoints:

```text
before compaction
after major phase
before risky refactor
before long test/fix cycle
```

Suggested directory:

```text
.macus/checkpoints/
```

Checkpoint should preserve:

```text
goal
tasks
decisions
changed files
important symbols
test state
failure state
next action
```

---

# 31. Compaction

Use Pi compaction support when possible.

Macus should coordinate:

```text
ledger update
↓
checkpoint
↓
compaction
↓
restore essential state
```

Do not write a completely new compaction engine unless necessary.

---

# 32. Prompt Cache Stability

Keep stable prompt components stable.

Order:

```text
System
Tools
Agent Rules
Repository Instructions
Task
Working Context
Dynamic Results
Recent Conversation
```

Avoid unnecessary reordering or rewriting of stable sections every turn.

---

# 33. Repository Instructions

Resolve:

```text
AGENTS.md
CLAUDE.md
MACUS.md
```

Support hierarchical scope.

More specific directory instructions override broader ones where they conflict.

---

# 34. Model Configuration

Support at minimum:

```text
OpenAI-compatible endpoint
custom base URL
API key
model name
context window
reserved output
```

Do not hardcode OpenRouter credentials or paths.

Example:

```yaml
models:
  default: my-model

  providers:
    my-model:
      type: openai-compatible
      base_url: ${MACUS_MODEL_BASE_URL}
      api_key: ${MACUS_MODEL_API_KEY}
      model: glm-5.3
```

---

# 35. Secrets

Never commit:

```text
API keys
tokens
credentials
private endpoints containing credentials
```

Use environment variables where practical.

Add safe `.gitignore` entries.

---

# 36. Configuration

Global:

```text
~/.macus/config.yaml
```

Project:

```text
.macus/config.yaml
```

Priority:

```text
CLI
project
global
defaults
```

---

# 37. Feature Flags

Implement optional modules so expensive/nonessential features can be disabled.

At minimum:

```yaml
features:
  repo_map: true
  code_graph: true
  context_ledger: true
  checkpoint: true
  auto_compaction: true
  task_engine: true
  git_context: true
  semantic_search: false
```

---

# 38. CLI UX

Target status line:

```text
glm-5.3 | ctx 21k/128k | files 4 | tasks 3/6 | feature/auth
```

Commands:

```text
/help
/status
/tasks
/context
/context files
/model
/settings
/checkpoint
/compact
/diff
/resume
/exit
```

Keep UX terminal-first.

Do not build Web UI for V1.

---

# 39. Context Inspection

The user must be able to inspect what the agent sees.

`/context` should show token allocation.

`/context files` should show:

```text
file
reason
tier
estimated tokens
```

This is required for debugging hallucination/context failures.

---

# 40. Tests

Each phase must add tests.

At minimum test:

```text
config resolution
symbol indexing
incremental indexing
context ranking
token budget enforcement
tool-output truncation
task persistence
checkpoint restore
Git-state parsing
resume
```

Add integration tests around the Pi adapter.

---

# 41. Benchmark

Create a small benchmark suite later containing repositories/tasks that test:

```text
search efficiency
tokens consumed
tool calls
time to first useful edit
test success
context size
resume reliability
```

Do not optimize only for tokens.

Measure:

```text
correctness
latency
tokens
tool calls
```

together.

---

# 42. Definition of Done for Each Phase

A phase is complete only when:

```text
implementation exists
tests pass
typecheck passes
lint passes if configured
feature works from CLI
documentation updated
no unrelated files changed
diff reviewed
```

---

# 43. Final Definition of Done

The first production-ready Macus Code is complete when a user can:

```bash
cd existing-project
macus
```

then ask:

```text
Fix refresh token expiration handling and update the tests.
```

and Macus Code can:

1. inspect repository instructions
2. search relevant code
3. build a small working set
4. construct tasks
5. read only relevant source
6. edit implementation
7. determine impacted tests
8. run targeted tests
9. analyze failures
10. fix errors
11. inspect Git diff
12. run final review
13. preserve session state
14. resume later
15. avoid unnecessary context growth

without requiring:

```text
Cowork
Vector DB
Embedding Server
Neo4j
Docker
Cloud Indexing
```

---

# 44. Implementation Philosophy

When choosing between two implementations, prefer the one that is:

```text
simpler
more deterministic
lower-token
lower-latency
easier to inspect
easier to maintain
```

Do not add intelligence where deterministic code is sufficient.

Do not add infrastructure where a local library or SQLite is sufficient.

Do not send information to the model merely because it exists.

Only send information that helps the model perform its current action.

---

# 45. First Action for the Implementing Agent

Start by doing exactly this:

```text
1. Read spec.md completely.
2. Inspect the repository.
3. Inspect current Pi integration or dependencies.
4. Inspect Git status.
5. Identify existing architecture.
6. Create an implementation TODO list.
7. Map the specification to existing modules.
8. Implement Phase 1 only.
9. Build and test.
10. Review the resulting diff before starting Phase 2.
```

Do not rewrite an existing working architecture unnecessarily.

Reuse existing implementation wherever it already satisfies the specification.

Proceed continuously through implementation while keeping tasks, tests and evidence current.
