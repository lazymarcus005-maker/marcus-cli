# Paired Benchmark Protocol

`src/workflow/benchmark.ts` provides a runner-independent harness. It does not
launch Macus or an unmodified Pi baseline by itself. Workspace preparation,
endpoint selection, metric collection, and the authoritative test oracle must
be supplied by explicit adapters.

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

This repository currently has harness unit tests only. No controlled paired
Macus/unmodified-Pi runs, endpoint compatibility measurements, or benchmark
results have been recorded. Consequently the benchmark and release gates remain
open. Before release, implement adapters and run the same fixed task set from
identical repository revisions, prompts, endpoint/model versions, generation
settings, limits, and test oracles; retain raw reports and document machine,
runtime, endpoint capability evidence, and limitations.
