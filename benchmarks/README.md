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
ratio magnifies timer noise. Transactions have a separate 5.5x ceiling: 3.0
adds scope enforcement, logical plugin transforms, keep-alive handling, and
serializable coordination that 2.1 did not provide. Repeated same-run evidence
peaked below 5x, so the 5.5x limit retains roughly 10% environmental headroom
without leaving the earlier 6x allowance in place. The ceiling makes that
intentional cost bounded rather than exempt from review.

Exceeding any budget, failing a correctness assertion, or changing the pinned
published package identity/integrity fails the command. Historical absolute
milliseconds remain observations rather than portable gates; a release must
retain the same-run JSON evidence.

## Release evidence workflow

`benchmark-results/release-3.0.1.json`, when present, is the authoritative
same-run evidence for the release candidate. Evidence files for earlier
releases, such as `release-3.0.0.json`, are kept as a record of what those tags
shipped. Do not duplicate its current
measurements in prose: those copies become stale after the next source or
package change. Generate the report with:

```sh
node scripts/compare-v2.1-baseline.mjs --skip-legacy-probes \
  --output benchmark-results/release-3.0.1.json
```

Run it only after the last source change, from a clean worktree at the candidate
tip. The harness records `candidate.dirty` from `git status --porcelain`, and
evidence captured over uncommitted changes does not identify what was measured.

Regenerating this file is a release step, not an occasional chore. Rerun it
once every source change for the release has landed, and commit the result on
its own. `candidate.gitCommit` then names the last commit that changed
behaviour: a file cannot contain its own commit hash, so the measured tree is
necessarily the parent of the commit carrying the file, and that parent must
differ from the tagged tree only by this report.

Never repoint the commit field by hand to make a stale file look current. If a
source change lands after the report, delete or regenerate the report before
the next commit. Because an in-tree report can never name its own commit,
publishing the same JSON as a CI artifact attached to the tag is the stronger
option if this ever needs to identify a tagged tree exactly.

Package size is measured separately from runtime speed. The baseline values are
from the immutable published tarball, while the candidate is measured with
`npm pack --dry-run --json` after its production build.

## LocalSpace 3.0 IndexedDB tuning decision

The E4 decision is backed by the complete same-process samples in
`benchmark-results/e4-before-removal.json` and
`benchmark-results/e4-after-removal.json`. Both runs used Node 24.16.0,
Playwright 1.60.0, and Chromium 148 on the same arm64 macOS host, with seven
measured samples and one warmup.

Both files are a frozen archive, not current release evidence. They were
captured on 2026-08-31 from a worktree that still carried the tuning removal as
uncommitted changes (`candidate.dirty` is `true` and `candidate.packageVersion`
still reads `2.1.0`), and their `candidate.gitCommit` was re-pointed when the
3.0 branch was rebased, so it identifies the rebased commit rather than the
tree that was measured. They also predate the 2026-09-01 removal of the core
StoredRecord wrapper, so their absolute milliseconds do not describe the
shipping value format.

Neither file can be regenerated: `prewarmTransactions`, `connectionIdleMs`, and
`maxConcurrentTransactions` no longer exist in the source, so the "before"
configuration is unreachable from the current tree. They are retained only as
the raw backing for the removal decision below. Current 3.0 performance claims
must come from a freshly generated `benchmark-results/release-3.0.1.json`.

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
