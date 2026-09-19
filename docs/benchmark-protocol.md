# Paired Benchmark Protocol

`src/workflow/benchmark.ts` provides a runner-independent harness.
`src/workflow/pi-baseline.ts` provides a partial in-process adapter around the
pinned Pi SDK session, with the already-trusted model selection, explicit
built-in tool allowlist, and caller-supplied test/recovery oracles.
`src/workflow/macus-baseline.ts` runs the actual Macus kernel with its default
request-budget guard, durable session state, worktree mutation lock, and
explicit caller-supplied command authorization. It requires a clean Git
workspace at the scenario's pinned starting revision. Workspace preparation
and endpoint selection remain explicit caller responsibilities.

Each scenario pins the task prompt, starting repository revision, test oracle,
endpoint/model, generation settings, and context/output limits. Each condition
labels repository and provider cache state independently. The harness runs at
least three paired repetitions, alternating which system runs first, and
records raw observations alongside prompt hashes. Workspace/runner failures
are retained as unknown observations, never treated as passes; exception text
is omitted from reports to avoid persisting secrets. The plan is capped at
2,000 executions.

Both adapters apply the scenario's validated OpenAI-compatible generation
settings at Pi's pre-provider-request hook. Supported controls are temperature,
top-p, presence/frequency penalties, seed, stop sequences, and one output-token
cap no greater than the configured reserved output budget. Unknown fields or
invalid values fail before a request is sent.

Correctness and recovery regressions are reported before metrics. Token, cache,
latency, first-edit, tool-call, peak-context, and CLI-RSS distributions are
reported separately; missing metrics remain absent. A report explicitly makes
no performance or equivalence claim. Cache metrics require adapter-supplied
measurements and units/denominators before interpretation.

Both adapters have deterministic loopback-provider tests for observed token
usage; omitted usage stays unknown and a failed model response does not run the
correctness/recovery oracles. This is adapter evidence only: no authorized live
endpoint, controlled paired Macus/unmodified-Pi run, or benchmark result has
been recorded. Both adapters apply the same validated scenario generation
settings, but their in-process form does not measure isolated CLI RSS or
first-useful-edit latency; those metrics remain unknown. Wall time covers the
prompt turn only; session setup, test/recovery oracles, and cleanup are excluded. Consequently
the benchmark and release gates remain open.
Before release, complete the adapters and run the same fixed task set from
identical repository revisions, prompts, endpoint/model versions, generation
settings, limits, and test oracles; retain raw reports and document machine,
runtime, endpoint capability evidence, and limitations.
