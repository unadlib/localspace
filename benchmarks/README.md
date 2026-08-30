# Baseline comparisons

`baselines/v2.1.0.json` pins both the source tag and the integrity of the
published npm artifact used as the LocalSpace 3.0 comparison baseline. The
benchmark contract is intentionally small enough to run repeatedly and covers
default IndexedDB startup, single-item throughput, iteration, batch operations,
transactions, and the three legacy tuning mechanisms.

Run the published baseline and the current worktree in the same Chromium
process:

```sh
pnpm benchmark:compare:2.1
```

The command needs npm registry access to fetch the pinned published tarball;
its integrity and complete package manifest are checked before measurement.

Use `--output <path>` to retain the complete samples and environment metadata.
`--samples` and `--warmups` may override the committed defaults for exploration;
the output records the effective contract. Use `--skip-legacy-probes` after the
legacy configuration options have been removed.

The harness reports medians, interquartile ranges, and candidate/baseline
ratios. It has no absolute pass/fail latency threshold: browser scheduling,
hardware, power state, and filesystem state make a historical millisecond value
unsuitable as a release gate. A design decision must use an interleaved same-run
comparison and retain its JSON evidence. Correctness assertions and published
package identity/integrity checks do fail the run.

Package size is measured separately from runtime speed. The baseline values are
from the immutable published tarball, while the candidate is measured with
`npm pack --dry-run --json` after its production build.
