# What Gus reviews

Gus builds a pinned Git snapshot, maps changed behavior, investigates with
bounded read-only tools, validates candidate findings, and produces a report.
The personality stage receives finalized technical facts afterward.

## Focused investigation and source reuse

Each stage starts with the evidence relevant to its job. Investigation follows
specific questions about the contribution; validation checks its candidates
against the collected evidence and reads more when a gap or contradiction
requires it. Documentation describing future verification steps does not claim
those steps have already run. Missing execution results remain visible without
automatically becoming an unanswered source-review question.

The model receives source through a `gus-context-v1` envelope. `payload` holds
the stage or tool result; `sourceTexts` defines each distinct source string by
an ID, and `{ "textRef": "..." }` refers to that definition. A stage receives
every definition it needs. Repeated tool results can reuse definitions already
present in that stage's conversation.

Reusing text does not merge evidence identities. Every evidence record retains
its path, revision, SHA, coordinates, and truncation state, and the host keeps
the full original text for local validation. Equal text at two revisions still
requires the corresponding inspection evidence. Exact successful reads may be
reused within the immutable review session; failed reads are not treated as
successful cached evidence.

## DSL responses

Gus asks the model to write a compact, line-oriented text protocol for review
assessments. It parses those records locally, validates their types and evidence,
then renders the findings as GitHub comments. Multiline explanations do not need
JSON quoting or escaped newlines. The provider receives no `response_format`
constraint for investigation, validation, reporting, or personality.

Triage keeps its small JSON response. Investigation and validation can still use
native read-only tools while collecting evidence; their final text uses
`REVIEW v1`. Reporting and personality have no tools. A separate model and
reasoning setting can be selected for each stage through `provider.stages`.

An assessment looks like this:

```text
REVIEW v1
SUMMARY
The change updates an exported value and its caller contract.
RISK | low
ARCHITECTURE | A
The change stays within its existing module.
TESTS | B
The available evidence is static; no test results were supplied.
FINDING | candidate-1 | major | src/value.ts | 12 | RIGHT | blocking
TITLE
Preserve the one-unit contract
TRIGGER
A caller requests "one" and reads the exported constant.
IMPACT
The caller receives two units.
FIX
Preserve the documented one-unit value.
EVIDENCE | supplied-evidence-id
COVERAGE | src/value.ts | inspected
The changed line and its caller were inspected.
EVIDENCE | supplied-evidence-id
END
```

The evidence identifier above is a placeholder: actual output must cite an ID
supplied by the host. Evidence, current diff coordinates, coverage, prior
findings, and candidate resolutions are checked after conversion. The DSL
cannot grant permissions or invent a successful check result.

The assessment records are:

| Record                                                             | Content                                                                      |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `SUMMARY`                                                          | Required multiline summary.                                                  |
| `RISK \| low/medium/high`                                          | Required risk classification; the host retains its deterministic floor.      |
| `ARCHITECTURE \| A/B/C/D/F` and `TESTS \| A/B/C/D/F`               | Grade followed by its explanation, or an explicit `none` instead of a grade. |
| `QUESTION`                                                         | An open question; repeat for additional questions.                           |
| `FINDING \| id \| severity \| path \| line \| side \| disposition` | A finding with `TITLE`, `TRIGGER`, `IMPACT`, `FIX`, and `EVIDENCE` sections. |
| `COVERAGE \| path \| inspected/partial/unreviewed`                 | A reason followed by `EVIDENCE`.                                             |
| `PRIOR \| id \| still-open/resolved/rejected/unverified`           | Current reconciliation reason followed by `EVIDENCE`.                        |
| `CANDIDATE \| id \| confirmed/rejected/unverified`                 | Validation-stage resolution reason followed by `EVIDENCE`.                   |
| `EVIDENCE \| id \| another-id`                                     | Evidence IDs for the current finding, coverage, prior, or candidate record.  |

Severity is `critical`, `major`, or `minor`; side is `LEFT` or `RIGHT`;
disposition is `blocking` or `follow-up`. Findings require a positive integer
line. Repeating record kinds creates lists; omitting them means an empty list.
This does not bypass required coverage or reconciliation of supplied candidates
and prior findings. A bare `EVIDENCE` records missing evidence for coverage or
reconciliation; a finding must have at least one actual evidence ID. `END` is
required on its own line.

The report stage accepts only `REVIEW v1`, `SUMMARY`, its prose, and `END`.
Findings, grades, and the verdict are already frozen. Personality similarly
uses a separate small response:

```text
PERSONALITY v1
TAKE
That retry loop was committed to the bit.
END
```

Outer Markdown fences and CRLF line endings are accepted. Prose retains its
quotes, backslashes, code fences, and line breaks. Escape a literal pipe in a
header field as `\|` and a literal backslash there as `\\`. A reserved or
marker-shaped line in prose needs a leading backslash, such as `\END`. Literal
`\n` inside a code example remains literal text.

Malformed blocks, unknown markers, duplicate singleton fields, and missing
`END` produce bounded correction requests. Invalid findings are never silently
dropped to turn a malformed review into a clean one. Existing plain or fenced
JSON responses remain a locally validated compatibility fallback; the host
still requests DSL and does not enable provider JSON mode for these stages.

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

## Usage reporting

The JSON review artifact includes `usage.calls`: one record for each admitted
model turn, with its stage, trigger, model, input character breakdown,
provider-reported tokens and cost, request attempts, tool names, and elapsed
time. Failed requests and unavailable accounting remain explicit. Character
counts describe input size; they are not token estimates or billable usage.

These records contain no prompts, source text, tool arguments, or credential
values. The Markdown review includes a collapsed summary by stage. The existing
aggregate usage fields remain available, and older artifacts without call
records remain supported. Provider retries can make request-attempt counts
larger than the number of model turns. This release does not collect separate
cached-token or reasoning-token counts.

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
