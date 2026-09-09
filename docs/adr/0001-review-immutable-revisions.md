# 0001 — Review immutable revisions and separate publication

**Status:** Accepted
**Date:** 2026-09-09

## Context

Gus serves repositories with different languages, policies, GitHub hosts, and
branch workflows. Its predecessor worked well as a repository-specific reviewer,
but review history could keep concerns alive after a stacked branch or target
changed. A mutable checkout and an old-head-to-new-head diff do not establish
which contribution introduced a defect or whether it survives integration.

The reviewer also needs a recognizable, entertaining voice. That voice must not
change the evidence, severity, or technical decision made during review.

## Decision

Use a standalone TypeScript npm package with declarative configuration and
replaceable stage prompts. Review Git objects in temporary bare storage, with
separate immutable identifiers for the author head, current target, contribution
baseline, and prospective merge tree. Keep repository reads, model requests,
review decisions, and publication behind explicit interfaces.

Require current evidence for findings and revalidate prior concerns after
history changes. Represent incomplete coverage explicitly. Run personality only
after technical adjudication. Gate every GitHub and Slack mutation through
explicit publication intent and recheck the current PR revisions before writing.
Load automatic repository configuration and prompts from the trusted target
revision; an explicit local configuration path is a host-controlled override.

## Alternatives considered

- Copy the predecessor unchanged: preserves its repository assumptions and
  ambiguous relationship between branch history and current findings.
- Always ask the author to rebase: disrupts valid stacked workflows and leaves
  the reviewer unable to distinguish inherited problems from new defects.
- Rely only on prompt instructions: cannot enforce snapshot identity, evidence
  references, output shape, budgets, or a zero-mutation dry run.
- Let personality rewrite the final review: risks changing technical facts and
  turning a clear finding into misleading or contradictory advice.

## Consequences

Repositories can share one reviewer while owning their policies and tone. A
history change triggers fresh validation instead of perpetually carrying a stale
finding. A dry run can exercise the review path without posting messages.

The package requires Git and temporary disk space. Snapshot collection, merge
analysis, structured model protocols, and publication recovery need dedicated
tests. Some stacks cannot be inferred confidently and need an explicit parent.
Missing evidence produces an incomplete review rather than an approval.

Provider usage reports determine actual cost accounting. A monetary stop
threshold can stop subsequent requests but cannot guarantee the cost of an
already-running request. Automated fixture tests prove protocol and workflow
behavior; real review quality also needs evaluation on representative PRs.

See the [package guide](../../README.md) for the public workflow and configuration.
