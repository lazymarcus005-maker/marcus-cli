# Paired Benchmark Protocol

`src/workflow/benchmark.ts` provides a runner-independent harness.
`src/workflow/pi-baseline.ts` provides a partial in-process adapter around the
pinned Pi SDK session, with the already-trusted model selection, explicit
built-in tool allowlist, and caller-supplied test/recovery oracles. Workspace
preparation, endpoint selection, and the Macus adapter still must be supplied
by explicit adapters.

Each scenario pins the task prompt, starting repository revision, test oracle,
endpoint/model, generation settings, and context/output limits. Each condition
labels repository and provider cache state independently. The harness runs at
least three paired repetitions, alternating which system runs first, and
records raw observations alongside prompt hashes. Workspace/runner failures
are retained as unknown observations, never treated as passes; exception text
is omitted from reports to avoid persisting secrets. The plan is capped at
2,000 executions.

Correctness and recovery regressions are reported before metrics. Token, cache,
latency, first-edit, tool-call, peak-context, and CLI-RSS distributions are
reported separately; missing metrics remain absent. A report explicitly makes
no performance or equivalence claim. Cache metrics require adapter-supplied
measurements and units/denominators before interpretation.

The Pi adapter has a deterministic loopback-provider test for observed token
usage and confirms that oracle time is excluded from task wall time. This is
adapter evidence only: no authorized live endpoint, controlled paired
Macus/unmodified-Pi run, or benchmark result has been recorded. The adapter
records but cannot apply scenario generation settings, and its in-process form
does not measure isolated CLI RSS or first-useful-edit latency; those metrics
remain unknown. Its wall-time interval covers the Pi prompt turn only; session
setup, test/recovery oracles, and cleanup are excluded. Consequently the
benchmark and release gates remain open.
Before release, complete the adapters and run the same fixed task set from
identical repository revisions, prompts, endpoint/model versions, generation
settings, limits, and test oracles; retain raw reports and document machine,
runtime, endpoint capability evidence, and limitations.
