# Configuration (preview)

Macus reads user-owned model trust from `~/.macus/config.yaml`, or from the path in `MACUS_CONFIG`. A project may select only an alias already trusted globally by setting `models.default` in `.macus/config.yaml`; project files cannot introduce providers, endpoints, or credential bindings.

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
model_profiles:
  standard:
    context_window: 131072
    max_output_tokens: 8192
    max_input_tokens: 114688
    context:
      reserved_output_tokens: 8192
      safety_margin_tokens: 2048
context:
  reserved_output_tokens: 8192
  safety_margin_tokens: 2048
  budget:
    repo_map_tokens: 1200
    search_results_tokens: 2500
    tool_output_tokens: 5000
    single_file_read_tokens: 8000
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
logs:
  retention_days: 7
  max_total_bytes: 1073741824
features:
  repo_map: true
  code_graph: false
  context_ledger: true
  checkpoint: true
  git_context: true
  task_engine: true
  auto_compaction: false
  prompt_cache_optimization: false
```

Set `MACUS_MODEL_BASE_URL` and `MACUS_MODEL_API_KEY` in the user's environment. Never put a credential value in project config. HTTPS is required except for loopback HTTP endpoints. URL user-info credentials are rejected. Configuration parse errors do not echo raw YAML values.

The request guard counts each byte in the serialized provider payload as one estimated token, caps requested output at `reserved_output_tokens`, applies the lower configured input/context ceiling, and checks configured category and single-file read caps before dispatch. This deliberately conservative estimate is not provider-reported token usage. This preview currently maps configured endpoints to Pi's OpenAI-compatible completions protocol; other protocol-specific behavior has not been validated.

The trusted global `execution` section controls command/test timeouts, termination grace, in-memory and spooled output caps, and the child-process environment allowlist. Macus always removes every trusted provider's API-key environment variable from child processes, even if listed here. `logs` controls local log retention and aggregate size. Project config cannot override either section. `/settings` reports the effective non-secret values.

`context.budget.repo_map_tokens` also bounds the `/map` output (default 1200 conservative byte/token units; maximum 20000). Set it to `0` to suppress map output while leaving ordinary search and reads available.

Supported optional feature switches may be narrowed by project config but not enabled against a global `false`. Disabling ledger/checkpoint metadata does not disable core session, task, execution-journal, or test-evidence recovery. In this preview, automatic compaction and prompt-cache optimization cannot be enabled; Macus disables Pi's independent auto-compaction authority.

`/models` lists trusted aliases, `/model ALIAS` switches the current Pi session without changing trust configuration, and `/settings` displays validated non-secret model settings and their source. Unsupported feature enables and project attempts to turn on globally disabled features are rejected.
