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
ratios. Release budgets are committed in `baselines/v2.1.0.json` and are
evaluated against the interleaved baseline median from the same Chromium
process. Ordinary single and batch operations use ratio limits. Sub-millisecond
startup and short iteration use absolute millisecond allowances because a
ratio magnifies timer noise. Transactions have a separate 6x ceiling: 3.0 adds
scope enforcement, logical plugin transforms, keep-alive handling, and
serializable coordination that 2.1 did not provide. The ceiling makes that
intentional cost bounded rather than exempt from review.

Exceeding any budget, failing a correctness assertion, or changing the pinned
published package identity/integrity fails the command. Historical absolute
milliseconds remain observations rather than portable gates; a release must
retain the same-run JSON evidence.

Package size is measured separately from runtime speed. The baseline values are
from the immutable published tarball, while the candidate is measured with
`npm pack --dry-run --json` after its production build.

## LocalSpace 3.0 IndexedDB tuning decision

The E4 decision is backed by the complete same-process samples in
`benchmark-results/e4-before-removal.json` and
`benchmark-results/e4-after-removal.json`. Both runs used Node 24.16.0,
Playwright 1.60.0, and Chromium 148 on the same arm64 macOS host, with seven
measured samples and one warmup.

Before removal, the candidate's prewarm-on and prewarm-off ready medians were
both 0.4 ms. The pinned 2.1.0 artifact measured 0.4 ms with prewarm and 0.5 ms
without it in that run, while the independently captured baseline observation
in `baselines/v2.1.0.json` measured 0.4 ms for both. Capping 80 concurrent
writes at one transaction was slower for both the candidate (9.0 ms versus
7.6 ms) and 2.1.0 (8.9 ms versus 7.4 ms). Idle close had no demonstrated
throughput benefit and introduced a reconnection path.

After removal, every main candidate median was between 0.80x and 1.014x of its
pre-removal same-host median. These numbers are observations, not portable
release thresholds. Because none of the three mechanisms had stable evidence,
and no cross-engine evidence justified retaining them, 3.0 removes prewarm,
idle close, the custom transaction queue, and their configuration options.
