# What Gus reviews

Gus builds a pinned Git snapshot, maps changed behavior, investigates with
bounded read-only tools, validates candidate findings, and produces a report.
The personality stage receives finalized technical facts afterward.

## Branch context

Snapshots record target/head SHAs, merge base, comparison base, default branch,
inferred or explicit parent, and prospective integration status. A child's
change is compared with its parent when that relationship is established.
`--parent REF` can settle an ambiguous stack.

GitHub normally shows a three-dot PR diff: merge base to head. Comparing two
branch tips can include unrelated upstream changes. Gus retains the PR's own
contribution and examines integration separately. See
[GitHub's comparison documentation](https://docs.github.com/en/pull-requests/reference/branches).

An isolated prospective merge is evidence about the combined tree. A clean
merge proves no textual conflict, not correct behavior. Unavailable integration
is a reported limitation. Gus does not rebase or update the author's checkout.

After a parent squash merge, previously merged commits can appear again. That
can justify restacking or retargeting advice when inherited changes distort
review. Being behind alone is insufficient.
[GitHub describes the squash behavior here](https://docs.github.com/en/pull-requests/reference/pull-request-merges).

Branch advice appears separately from defects. A concern fixed upstream should
be checked against prospective merged behavior before becoming a blocker. If
the contribution reintroduces it in the merged tree, it remains a real candidate.
Previous review text alone cannot settle either outcome.

## Findings and evidence

A confirmed finding names a realistic trigger, consequence, location, focused
correction, and inspected evidence. Validation checks evidence references and
current revision. A grep match or nearby test file alone is insufficient proof.

Prior reviews require a trusted reviewer identity and valid Gus state. Stable
identifiers carry continuity, while each prior finding gets a current status:
still open, resolved, rejected, or unverified. Rebases and base changes need
fresh validation rather than automatically preserving an old allegation.

Human replies can explain a fix or design choice; they cannot redefine tools,
permissions, or runtime contracts. Only evidenced resolution can resolve a
corresponding historical Gus thread.

## Coverage and verification

The report identifies inspected, excluded, unreviewed, and partial files.
Truncation and missing context remain visible. Size, risk, scorecards, and
verdict are distinct from executed test results.

Gus does not run project code, tests, builds, or deployments. Supply observations
through `--checks`, tied to the head SHA. A caller-supplied pass is not an
independently authenticated CI result. Static inspection, synthetic integration,
tests, hosted CI, and device/production observations remain separate evidence.

Turns, tool calls, context, duration, tokens, and optional observed cost have
explicit limits. Provider failure, exhausted investigation, missing accounting,
or incomplete coverage can prevent a ready result. Fallbacks describe failures
instead of handing out confident grades.

## Known boundaries

- Stack inference depends on available Git/GitHub evidence. Missing refs,
  unusual merge strategies, private forks, or missing history can require an
  explicit parent or an incomplete result.
- Automatic parent discovery checks open PR tips already present in the head's
  history and the PR's declared target. If a parent advanced while its child
  still targets the default branch, use `--parent` to identify it explicitly.
- Local snapshots copy regular Git objects and refs, with a 2 GiB / 200,000
  object limit. Git alternates are not imported. Remote snapshots use HTTPS
  within one trusted origin; prospective integration requires Git 2.38 or newer.
- Credential paths, symlinks, submodules, binary content, and invalid UTF-8 are
  unavailable to source inspection. Repository tool globs do not expand braces.
- LLM findings remain fallible. Evidence checks reduce unsupported claims;
  semantic correctness still needs judgment and relevant verification.
- Provider behavior varies for tools, structured output, reasoning controls,
  token accounting, and cost metadata.
- Gus does not automatically run or certify every repository's CI pipeline.
- Mocked APIs and temporary Git fixtures prove bounded behavior. They do not
  establish a real-world false-positive rate or live deployment readiness.

Before adopting a release as a merge gate, replay representative PRs: ordinary
edits, an unmerged stack, a moved parent, a parent squash merge, a history-only
rebase, a retargeted PR, an upstream fix, and an actual reintroduction. The same
effective code should retain substantive findings across history-only rebases;
actual code or integration changes may change the result.
