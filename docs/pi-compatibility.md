# Pi Compatibility Record

Status: **local gate coverage complete; live-endpoint compatibility evidenced for one authorized OpenAI-compatible gateway**

All capabilities below are demonstrated against the pinned SDK with in-process
loopback-provider tests and real subprocess crash tests. Live-endpoint
compatibility is now evidenced for one authorized gateway and model (see the
section below); other providers and models remain untested.

## Pinned implementation under test

- Runtime contract: Node.js `24.21.x` (`.nvmrc` pins `24.21.0`; package engine is `>=24.21.0 <25`).
- SDK package: `@earendil-works/pi-coding-agent@0.85.1`, exact dependency pin and lockfile.
- Public reference: [Pi SDK](https://pi.dev/docs/latest/sdk).
- Extension reference: [Pi Extensions](https://pi.dev/docs/latest/extensions).
- Local verification: TypeScript build checks the imported public exports and method shapes against the pinned package.
- Startup now checks the public session lifecycle, streaming, prompt, cancellation, compaction, and transcript-navigation methods at runtime and fails with a versioned compatibility error if one is absent; an injected missing-capability test covers this path.

## Capability record

| Macus adapter capability | Evidence at this bootstrap stage | Result |
| --- | --- | --- |
| Create a session | `ModelRuntime.create`, `createAgentSession`, and `SessionManager.create(cwd)` are exercised against the pinned SDK. | Local loopback provider test passes |
| Stream events | `session.subscribe` and `message_update` / `text_delta` are used by the adapter. | Local OpenAI-compatible SSE exchange passes |
| Prompt and cancel | `session.prompt` and `session.abort` are wrapped by the adapter. | Loopback streaming request is observed closed after cancellation |
| Dispose and replacement | `session.dispose` is called on CLI exit and by the adapter lifecycle. | Local provider test disposes a live session, verifies its handle is cleared, then creates and successfully prompts a distinct replacement session |
| Centralized tool execution | Built-in Pi tools are disabled; registered repository, shell, and log tools pass through Macus policy, session journaling, and bounded outputs. | Deterministic nested tool, approved source-write, denied source-write (file preserved, no journal entry, denial observed by the next request), and log-spool tests pass |
| Prepare every provider request | Inline `before_provider_request` runs through the pinned SDK's `onPayload` route; Macus guards each payload. Pi's extension runner catches handler exceptions, so Macus catches budget errors and aborts the active session before returning. | Local fixture observed two prepared requests in a tool turn; an over-budget request produced zero HTTP requests; a startup capability probe fails closed with a versioned error when a required public Pi method is absent (injected-missing-capability test) |
| Compaction | Macus disables Pi auto-compaction and exposes checkpoint-gated `PiAgentKernel.compact()` over Pi's public `session.compact()`. Prompt, compact, restore, start, and dispose are serialized at the adapter boundary. | Loopback provider test compacts an earlier turn; overlapping prompt/compaction is rejected; cancellation mid-compaction closes the stream and keeps the prior conversation usable; an auth-style provider failure rejects `compact()` without a fabricated summary and the session stays retriable; a real SIGKILL during an in-flight compaction preserves the durable checkpoint, completed runs, and full prior conversation for the resumed session |
| Resume and replacement | Pi `SessionManager.open` resumes an explicit session; `/resume` uses the same adapter. Durable run/execution recovery blocks automatic replay, and `/clear` creates a fresh session. | Persisted-session loopback test passes; recent-session continuation after restart is verified; crash-point reconciliation covers subprocess crashes before completion, after durable completion before transcript persistence, inactive-branch results, and crashes during compaction and migration |
| Instruction loading | Pi auto-context discovery is disabled; Macus resolves root `MACUS.md`, `AGENTS.md`, and `CLAUDE.md` then injects them through the context hook. | Loopback request contains the fixture instruction exactly once; deeper per-target scopes remain incomplete |

These checks use an in-process loopback OpenAI-compatible SSE fixture, not the user's configured local/private endpoint. They establish adapter behavior for the tested Pi build only; endpoint-specific streaming/tool-call/error compatibility, full crash recovery, and benchmark evidence remain outstanding. The Phase 1 gate remains open.

## Live endpoint evidence (2026-09-20)

- Endpoint: OpenCode Go gateway (`https://opencode.ai/zen/go/v1`), model `deepseek-v4-flash`, OpenAI-compatible chat-completions with streaming.
- Adapter change: gateway endpoints receive a per-session `x-opencode-session` routing header and a `macus/0.1.0` user agent (`gatewayHeadersFor`, commit `887a91e`); generic providers are unaffected.
- Kernel-level probe: streamed completion returned and completed (`LIVE READY`), usage reported, durable run recorded `completed` with a request manifest.
- Full CLI run: `npx tsx src/cli.ts "Create a file named live-check.txt containing exactly LIVE_OK_2026 …"` in a fresh Git repository under the pinned Node.js 24.21.0 toolchain — the model streamed a response, requested the policy-controlled `bash` tool, the interactive approval + credential-boundary prompts were answered, the command ran, and `live-check.txt` contained exactly `LIVE_OK_2026` (oracle pass, clean `/exit`).
- This evidences streaming, nested tool-calls, the approval policy path, and a real workspace edit against one real endpoint. Hosted-provider variance (other gateways, models, error behaviors) is not claimed.
