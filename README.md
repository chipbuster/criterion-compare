<p align="center">
  <a href="https://github.com/actions/typescript-action/actions"><img alt="typescript-action status" src="https://github.com/actions/typescript-action/workflows/build-test/badge.svg"></a>
</p>

# Criterion Performance Comparison for GitHub Actions

> ⚠️ **WARNING**: Performance benchmarks provided by this action may fluctuate
> [up to 50% on cloud infrastructure](https://bheisler.github.io/post/benchmarking-in-the-cloud/).
> Run benchmarks locally or on a [dedicated test runner](https://docs.github.com/en/actions/hosting-your-own-runners/about-self-hosted-runners)
> before making any decisions based on the results.

This Github action compares performance between a PR and a dedicated target
branch (usually the master or main branch).

<!-- Insert example here -->

## Usage

### Quickstart

Create a `.github/workflows/pull_request.yml` workflow file in your repo:

```yaml
# in file: .github/workflows/pull_request.yml
on: [pull_request]
name: Benchmark Pull Request
jobs:
  runBenchmark:
    name: run benchmark
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@master
      - uses: chipbuster/criterion-compare@vX.Y.Z
        with:
          cwd: subDirectory (optional)
          benchName: my-criterion-benchmark
          branchName: trunk
          token: ${{ secrets.GITHUB_TOKEN }}
```

You should now get a comment on new PRs for performance!

### Options

This action supports the following options passed via the `with` parameter:

###### token

The GitHub token which provides access to the repo (specifically, to comment).
You don't need to do anything special for this aside from provide the string
`${{ secrets.GITHUB_TOKEN }}` as in the example: GitHub has already generated
this token for you.

###### workDir (default: ./)

The working directory relative to the project root. Useful if your project is
not in the repository root (e.g. if you have multiple crates in one repo).

###### cargoBenchName (default: none)

The name of the cargo benchmark to run. If not provided, is not passed to
`cargo bench`, resulting in all benchmarks being run.

###### gitBranchName (default: ${{ github.base_ref }})

The name of the branch to use as the baseline performance. Will usually be the
branch that the PR wants to merge into, or another stable branch (like `main` or
`trunk`).

If not provided, defaults to the base_ref, i.e. the branch that is being merged to.

###### doFetch (default: true)

The [default checkout action](https://github.com/actions/checkout) only checks
out the ref that causes the PR. This action needs a reference to `gitBranchName`
in order to do the benchmarks, so we usually have to perform a fetch before
running benchmarks.

If you need to disable this behavior, you can set `doFetch` to false. Just
make sure you've gotten the branch referred to by `gitBranchName` in some other
way, e.g. by passing parameters to a checkout action before this one.

###### doClean (default: false)

Whether to run `cargo clean` before executing benchmarks. Should not be needed
most of the time.

###### doComment (default: true)

Whether to post a comment to the repository describing the results. Defaults
to true. However, if you want to aggregate results (e.g. with a different
benchmark suite), you can set this to false. The benchmark results will be
available in the outputs `results_markdown` and `results_json`, respectively.

## Troubleshooting

#### Unrecognized option: 'save-baseline'

Check out the upstream docs for criterion [here](https://bheisler.github.io/criterion.rs/book/faq.html#cargo-bench-gives-unrecognized-option-errors-for-valid-command-line-options)
to get the full details of what's going on and the fixes. The short version is
that this is caused by an issue with `cargo bench` and you currently have two
options for a fix:

- Pass the benchname to this action with `cargoBenchName`. This works only if
  there is a single benchmark you want to run.
- Disable benchmarks for your lib/bin crates by adding `bench = false` to the
  appropriate locations in your `Cargo.toml`.