# Macus Code — Product & Technical Specification

Version: 1.0
Status: Initial Implementation Specification
Product Type: Local CLI Agentic Coding Tool
Primary Platform: macOS
Architecture Style: Lightweight, local-first, extensible
Agent Kernel: Pi-based

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
* Model Routing
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
Node.js/Bun
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
Extension
>
Wrapper
>
SDK composition
>
Core patch
```

หลีกเลี่ยงการแก้ Pi internals โดยไม่จำเป็น

เพื่อให้สามารถ merge upstream Pi ในอนาคตได้

---

# 4. High-Level Architecture

```text
                    Macus Code CLI
                           │
                    CLI / TUI Layer
                           │
                  ┌────────▼────────┐
                  │   Task Engine    │
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │  Agent Harness   │
                  └────────┬────────┘
                           │
             ┌─────────────▼─────────────┐
             │       Context Runtime      │
             ├────────────────────────────┤
             │ Context Selector           │
             │ Working Set                │
             │ Context Budget             │
             │ Context Tiers              │
             │ Context Ledger             │
             │ Prompt Cache Policy        │
             │ Compaction Policy          │
             │ Checkpoint Manager         │
             └─────────────┬─────────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼

     Code Search      Code Intelligence    Git Context

     ripgrep          Tree-sitter          status
     glob             symbol index         diff
     smart read       repo map             log
                      references           blame
                      impact               changed files

          │                │                │
          └────────────────┼────────────────┘
                           ▼
                       Pi Kernel
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
             LLM          Tools       Session
```

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

Agent Harness ควบคุม long-running coding workflow

Default loop:

```text
Understand
   ↓
Discover
   ↓
Plan
   ↓
Create Tasks
   ↓
Implement
   ↓
Test
   ↓
Inspect
   ↓
Fix
   ↓
Review
   ↓
Finish
```

agent สามารถ loop:

```text
Implement
→ Test
→ Failure
→ Analyze
→ Fix
→ Test
```

จนกว่า:

* task complete
* blocker
* safety rule
* user interruption
* configured maximum loop condition

---

# 5.3 Task Engine

ทุกงานที่มีหลายขั้นตอนควรมี Task List

Example:

```text
Tasks 4/7

[✓] Inspect authentication flow
[✓] Find token implementation
[✓] Create implementation plan
[✓] Modify AuthService
[ ] Update tests
[ ] Run test suite
[ ] Review diff
```

Task state:

```text
pending
in_progress
completed
blocked
skipped
```

แต่ละ task ต้องสามารถเก็บ:

```text
id
title
status
relatedFiles
relatedSymbols
notes
createdAt
updatedAt
```

เก็บ local state

ตัวอย่าง:

```text
.macus/
  state/
    task.json
```

---

# 6. Context Runtime

Context Runtime เป็น feature หลักที่ทำให้ Macus Code แตกต่างจาก Pi distribution ปกติ

หน้าที่หลัก:

```text
Find Context
↓
Rank Context
↓
Filter Context
↓
Apply Token Budget
↓
Send Minimum Useful Context
```

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

Context Manager ต้อง maintain Working Set

ตัวอย่าง:

```text
ACTIVE

src/auth/auth.service.ts
src/token/token.service.ts

RELATED

src/auth/auth.controller.ts
tests/auth.service.test.ts

DISCOVERED

src/user/user.repository.ts
```

สถานะ:

```text
ACTIVE
RELATED
DISCOVERED
STALE
```

Working Set ต้อง update ตาม:

* search
* read
* edit
* git changes
* test failures
* code references

---

# 6.3 Context Selector

Context Selector รับ candidate context แล้ว rank ก่อนส่ง LLM

ไม่ใช้ LLM ranking เป็น default

Possible scoring:

```text
score =
  exactSymbolMatch
+ pathMatch
+ workingSetWeight
+ graphDistance
+ changedFileWeight
+ testRelation
+ recentAccess
+ taskKeywordMatch
```

Example:

```text
0.97 AuthService.refresh
0.93 TokenService.verifyRefreshToken
0.82 auth.service.test.ts
0.62 TokenRepository
0.12 PaymentService
```

เลือกเฉพาะ context ที่อยู่ใน budget

---

# 6.4 Context Provenance

ทุก context fragment ต้อง track metadata

Example:

```json
{
  "source": "src/auth/token.service.ts",
  "symbol": "verifyRefreshToken",
  "startLine": 120,
  "endLine": 178,
  "reason": "direct-reference",
  "score": 0.92,
  "contentHash": "..."
}
```

ใช้สำหรับ:

* stale detection
* debugging retrieval
* context inspection
* reproducibility

---

# 6.5 Context Budget

ระบบต้องรู้:

```text
model context window
reserved output
current prompt usage
compaction threshold
tool-result budget
repo-map budget
```

Configuration example:

```yaml
context:
  target_utilization: 0.55
  compact_at: 0.72
  emergency_compact_at: 0.85

  reserve_output_tokens: 16000

  budget:
    repo_map: 1200
    search_results: 2500
    tool_output: 5000
    single_file_read: 8000
```

ค่าจริงสามารถ override ตาม model

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

ใช้ `ripgrep` เป็น primary text search engine

Tool:

```text
search_code
```

Input:

```text
query
path?
fileType?
maxResults?
caseSensitive?
```

Output ต้อง summarize และ bound

ห้ามส่ง raw result หลายพันบรรทัดให้ model

Example:

```text
Found 7 results

src/auth/auth.service.ts
  42: refreshToken(...)
  86: verifyRefreshToken(...)

src/token/token.service.ts
  53: refreshToken(...)

tests/auth.test.ts
  114: refreshToken(...)
```

---

# 8. Symbol Intelligence

ใช้ Tree-sitter สำหรับ:

* class
* function
* method
* interface
* type
* variable declarations ที่จำเป็น
* imports
* exports

Core tool:

```text
search_symbol
```

Example:

```text
search_symbol("TokenService")
```

Result:

```text
TokenService
src/token/token.service.ts:12

methods
  createToken      32-52
  verifyToken      55-84
  refreshToken     87-132
```

---

# 9. Smart Read

Default behavior ต้องเป็น:

```text
search_symbol
→ read_symbol
→ expand_if_needed
```

ไม่ใช่:

```text
read entire file
```

Tools:

```text
read_symbol
read_range
expand_context
```

ตัวอย่าง:

```text
read_symbol(
  symbol="TokenService.refreshToken"
)
```

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

ห้ามสร้าง full static-analysis graph ใน V1

เก็บแค่ high-value relationships

```text
file
  imports
    file

file
  contains
    symbol

symbol
  references
    symbol

symbol
  implements
    interface

test
  references
    symbol
```

Storage:

```text
SQLite
```

Suggested tables:

```text
files
symbols
edges
file_hashes
metadata
```

ไม่ใช้ Neo4j

---

# 12. Reference & Impact Tools

Tools:

```text
find_references
find_dependencies
find_dependents
impact
```

Example:

```text
impact("TokenService.refreshToken")
```

Result:

```text
Changed symbol:
TokenService.refreshToken

Direct callers:
AuthService.refresh
SessionService.renew

Tests:
token.service.test.ts
auth.service.test.ts

Interface:
ITokenService.refreshToken
```

ห้าม auto inject source ของทุก result

agent ต้อง request source เพิ่มเมื่อจำเป็น

---

# 13. Search Escalation

Use cheapest mechanism first

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

ห้าม reindex repository ทั้งหมดทุก turn

Track:

```text
path
mtime
size
content hash
```

เมื่อ file เปลี่ยน:

```text
detect change
→ parse changed file
→ update symbol index
→ update relations
→ update repo map
```

Cache directory:

```text
.macus/
  cache/
    index.db
```

`.macus/cache` ควรถูก ignore จาก Git โดย default

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

เมื่อมีการแก้ symbol:

```text
Changed Symbol
      ↓
Find callers
      ↓
Find interfaces
      ↓
Find tests
      ↓
Update Working Set
```

ผลลัพธ์ควรเป็น metadata ก่อน

source code โหลดเมื่อ agent request

---

# 17. Tool Output Compression

ทุก command output ต้องผ่าน output processor

Example raw:

```text
npm test
5000 lines
```

ควรกลายเป็น:

```text
Test Result

Passed: 214
Failed: 2
Skipped: 3

Failures

AuthService.refresh
auth.service.test.ts:218
Expected 200
Received 401

TokenService.expired
token.service.test.ts:317
TokenExpiredError

Full log:
/tmp/macus/test-932.log
```

agent สามารถอ่าน log เพิ่มได้

Tool:

```text
read_log
```

---

# 18. Error-Focused Retrieval

เมื่อ build/test fail:

```text
Parse Error
   ↓
Locate File/Symbol
   ↓
Find Relevant Definition
   ↓
Add Minimal Context
```

Example:

```text
CS1503
AuthService.cs:182

cannot convert Token to RefreshToken
```

Context:

```text
AuthService.Refresh
lines 160-200

TokenService.Rotate signature
```

ไม่ส่ง compile output ทั้งหมด

---

# 19. Context Ledger

Context Ledger เป็น persistent state ไม่ใช่ prompt

Example:

```json
{
  "goal": "Implement refresh token rotation",
  "decisions": [
    "Store refresh token hash only"
  ],
  "workingFiles": [
    "src/auth/auth.service.ts",
    "src/token/token.service.ts"
  ],
  "tests": {
    "passed": 43,
    "failed": 1
  },
  "blockers": [
    "expiry test failing"
  ],
  "nextAction": "inspect TokenService.verifyRefreshToken"
}
```

LLM ไม่จำเป็นต้องเห็น Ledger ทั้งหมด

Context Runtime เลือกเฉพาะ relevant state

---

# 20. Checkpoint

ก่อน compaction หรือ milestone สำคัญ ให้สร้าง checkpoint

Checkpoint:

```text
Goal
Plan
Completed Tasks
Pending Tasks
Modified Files
Important Symbols
Decisions
Known Errors
Test State
Next Action
```

Example:

```text
Checkpoint #4

Goal:
Refresh token rotation

Completed:
✓ implementation
✓ migration

Pending:
□ expiry test
□ integration test

Changed:
auth.service.ts
token.service.ts

Decision:
Store SHA256 hash only

Failure:
expiry test expected 401 but received 200
```

---

# 21. Compaction

Pi compaction ใช้เป็น base

Macus Code เพิ่ม policy layer

Trigger:

```text
normal compact
emergency compact
manual compact
checkpoint compact
```

ก่อน compact:

```text
update ledger
→ create checkpoint
→ compact
```

หลัง compact ต้อง preserve:

* current goal
* current task
* decisions
* working files
* current diff awareness
* failures
* pending tasks
* next action

---

# 22. Prompt Cache Strategy

Prompt structure ต้อง stable

```text
STABLE PREFIX

System Prompt
Tool Definitions
Agent Rules
Repository Instructions


SEMI-STABLE

Task
Working Set Summary


DYNAMIC

Current Diff
Search Results
Errors
Tool Results
Recent Conversation
```

หลีกเลี่ยง reorder stable sections ระหว่าง turns

---

# 23. Repository Instructions

รองรับอย่างน้อย:

```text
AGENTS.md
CLAUDE.md
MACUS.md
```

Instruction resolver ต้อง support directory hierarchy

Example:

```text
repo/
  AGENTS.md

  backend/
    AGENTS.md

    auth/
      MACUS.md
```

เมื่อแก้:

```text
backend/auth/auth.service.ts
```

ให้ merge instruction ตาม scope

```text
root
+
backend
+
auth
```

specific instruction มี precedence สูงกว่า global instruction

---

# 24. Model Layer

รองรับ:

* OpenAI-compatible API
* OpenRouter
* LiteLLM Gateway
* custom base URL
* local inference endpoint
* model-specific context window
* model-specific token policy

Configuration:

```yaml
models:
  default: glm

  providers:
    glm:
      type: openai-compatible
      base_url: ${MACUS_MODEL_BASE_URL}
      api_key: ${MACUS_MODEL_API_KEY}
      model: glm-5.3
      context_window: 131072
```

API key ห้าม persist plaintext โดย default ถ้ามี secure storage option

Environment variables preferred

---

# 25. Model Profiles

รองรับ model profile

Example:

```yaml
model_profiles:

  glm-5.3:
    context_window: 131072
    reserve_output: 16000
    target_context_ratio: 0.55

  local-qwen:
    context_window: 262144
    reserve_output: 8192
    target_context_ratio: 0.35
```

Context Runtime ต้อง adapt ตาม profile

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

```text
/help
/status
/tasks
/context
/context files
/model
/models
/settings
/compact
/checkpoint
/resume
/clear
/exit
```

Recommended:

```text
/map
/search
/symbol
/diff
/test
/review
```

---

# 28. CLI Status Bar

Example:

```text
glm-5.3 | ctx 21k/128k | files 4 | tasks 3/6 | branch feature/auth
```

Optional provider metrics:

```text
cache 82%
```

only when available

---

# 29. Context Inspector

Command:

```text
/context
```

Example:

```text
Context

Current: 21,421
Maximum: 131,072

System          4,122
Task              682
Instructions      918
Working Set     7,210
Recent Chat     5,821
Tools           2,668

Repo Map          734
```

Command:

```text
/context files
```

Example:

```text
ACTIVE

auth.service.ts
reason: edited
tokens: 2418

token.service.ts
reason: direct dependency
tokens: 1724

auth.service.test.ts
reason: test relation
tokens: 1183
```

---

# 30. Settings

Settings location:

```text
~/.macus/config.yaml
```

Project overrides:

```text
.macus/config.yaml
```

Priority:

```text
CLI option
>
project config
>
global config
>
default
```

---

# 31. Feature Flags

Optional features must be individually configurable

Example:

```yaml
features:

  repo_map: true

  code_graph: true

  context_ledger: true

  checkpoint: true

  auto_compaction: true

  git_context: true

  task_engine: true

  prompt_cache_optimization: true

  semantic_search: false

  telemetry: false
```

---

# 32. Local Storage

Recommended layout:

```text
.macus/
├── config.yaml
├── state/
│   ├── task.json
│   ├── ledger.json
│   └── session.json
│
├── cache/
│   └── index.db
│
├── checkpoints/
│   ├── checkpoint-001.json
│   └── checkpoint-002.json
│
└── logs/
```

Secrets must not be stored here unless explicitly encrypted/configured

---

# 33. Safety Around File Changes

Before destructive operation:

* understand Git state
* do not overwrite unrelated user modifications
* do not reset repository automatically
* do not force push
* do not delete untracked files unless explicitly instructed

Agent should distinguish:

```text
agent-created changes
user-existing changes
```

---

# 34. Command Execution

Shell command tool should support:

```text
cwd
timeout
maxOutput
environment
```

Dangerous commands can optionally require policy approval

Examples:

```text
rm -rf
git reset --hard
git clean -fd
git push --force
```

Approval policy must be configurable

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

Prefer:

```text
targeted test
↓
module test
↓
full relevant test suite
```

ไม่ควร run full repository tests หลังทุก small edit ถ้าไม่จำเป็น

---

# 37. Review Stage

ก่อน finish:

```text
inspect git diff
check TODO
check test results
check unexpected file changes
check syntax/type errors
```

Review output should include:

```text
Changed
Tested
Remaining Risk
Unresolved Issue
```

---

# 38. Recovery

Macus Code ต้องสามารถ resume หลัง:

* process terminated
* terminal closed
* model request failure
* network error
* compaction
* machine restart

Persist:

```text
session
task state
ledger
checkpoint
working set metadata
```

ไม่จำเป็นต้อง persist ephemeral tool output ทั้งหมด

---

# 39. Performance Targets

Initial targets:

Startup:

```text
< 2 seconds
```

สำหรับ repository ที่ cache พร้อม

Search:

```text
interactive response expected
```

Index:

* incremental
* no full rebuild unless required

Idle:

* no mandatory daemon
* negligible CPU usage

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

```text
macus-code/
├── apps/
│   └── cli/
│
├── packages/
│   ├── agent-runtime/
│   ├── context-runtime/
│   ├── code-intelligence/
│   ├── task-engine/
│   ├── git-context/
│   ├── model-runtime/
│   ├── config/
│   ├── tui/
│   └── shared/
│
├── extensions/
│   └── builtin/
│
├── docs/
│
├── THIRD_PARTY_NOTICES.md
├── LICENSE
└── README.md
```

---

# 42. Pi Integration Rules

Pi should remain replaceable at architectural boundary

Create adapter:

```text
AgentKernel
```

Example conceptual interface:

```ts
interface AgentKernel {
  startSession(): Promise<Session>;
  resumeSession(id: string): Promise<Session>;
  send(message: AgentMessage): Promise<AgentResult>;
  registerTool(tool: Tool): void;
  compact(): Promise<void>;
}
```

Pi implementation:

```text
PiAgentKernel
```

Macus modules should depend on:

```text
AgentKernel
```

not Pi internals directly wherever practical

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

MVP is complete when Macus Code can:

1. Open repository
2. Read repository instructions
3. Connect to configurable LLM API
4. Run Pi-based agent loop
5. Search code using ripgrep
6. Search symbols
7. Read symbols/ranges
8. Generate lightweight repo map
9. Maintain Working Set
10. Maintain task list
11. Edit code
12. Execute build/tests
13. Compress tool output
14. Track Git state
15. Show current diff
16. Maintain Context Ledger
17. Create checkpoint
18. Compact/resume
19. Inspect context usage
20. Finish coding task with test/review evidence

---

# 45. Recommended Implementation Order

## Phase 1 — Agent Foundation

Implement:

* branded CLI
* Pi integration
* configuration
* model provider
* basic tools
* session/resume

## Phase 2 — Code Retrieval

Implement:

* ripgrep
* Tree-sitter
* symbol index
* smart read
* incremental cache

## Phase 3 — Context Runtime

Implement:

* working set
* context tiers
* context selector
* token budget
* provenance

## Phase 4 — Coding Workflow

Implement:

* plan
* todo/task engine
* test loop
* Git context
* diff review

## Phase 5 — Token Optimization

Implement:

* tool output compression
* dynamic context policy
* ledger
* checkpoint
* Pi compaction integration
* prompt cache stability

## Phase 6 — Lightweight Relationships

Implement:

* code graph
* references
* dependencies
* impact analysis

## Phase 7 — Hardening

Implement:

* recovery
* destructive-command policy
* benchmark
* integration tests
* installer/package distribution

---

# 46. Success Criteria

Macus Code should feel like:

```text
fast CLI
+
strong coding agent
+
smart local code retrieval
+
controlled context usage
```

not:

```text
large RAG platform
+
vector database
+
heavy indexing service
+
agent framework with unnecessary abstractions
```

Primary optimization target:

> Give the model the smallest amount of context required to correctly perform the current coding action.

Secondary target:

> Preserve enough durable state that a long-running task can continue reliably after compaction, failure, or resume.

This principle should guide every implementation decision.
ß