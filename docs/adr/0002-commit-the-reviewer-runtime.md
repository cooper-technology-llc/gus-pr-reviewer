# 0002 — Commit the reviewer runtime

**Status:** Accepted
**Date:** 2026-09-09

## Context

GitHub-hosted jobs start on fresh runners. Installing a pinned Gus package on
every job works, but makes reviews depend on npm availability and repeated
dependency setup. A cache can reduce downloads but cannot promise a hit.
The intended setup is a team running Gus on its own repository, with an
explicitly chosen version and independently editable review policy.

Running repository files introduces a separate trust concern: privileged review
jobs must not execute a replacement reviewer supplied by the PR under review.

## Decision

Build a portable Node.js ESM bundle with esbuild during package preparation,
including its runtime dependencies. Have `gus init` copy that bundle and its
required assets into `.github/gus`, alongside the generated configuration and
workflow. Commit these files through the repository's normal review process.
The generated workflow executes this copy without installing Gus from npm.

Use the base repository's explicit default branch to select the runtime in the
prepare job. Pass the resolved commit to the review job so both jobs execute
the same trusted version. Keep event eligibility ahead of review concurrency.
PR content remains read-only evidence in separate Git storage; configuration
and custom prompts retain the target-revision policy from [0001](./0001-review-immutable-revisions.md).

Provide `gus update` to replace generated runtime assets from the selected
installed release while preserving repository configuration, workflow edits,
and custom prompts. Preflight writes and preserve the existing containment and
rollback protections. Include Gus's license and original third-party notices
with every generated runtime.

## Alternatives considered

- Install a pinned npm package per job: simple distribution, but does not meet
  the requirement to remove recurring Gus installation.
- Cache an npm installation: helps warm runs but requires installation after
  cache misses and adds cache trust considerations.
- Commit `node_modules`: carries an installation layout and more files than
  the executable needs, with platform and dependency-resolution concerns.
- Check out the PR's runtime: allows the reviewed code to replace the reviewer
  in a job with repository credentials and provider secrets.
- Fetch the latest reviewer automatically: changes review behavior without a
  repository change and reintroduces an external distribution dependency.

## Consequences

A repository can run its committed Gus version even when npm is unavailable.
The npm package remains useful for initial setup, local reviews, and intentional
updates. CI still uses GitHub Actions, Node.js, GitHub access, and a model
provider; this is not a promise of an offline review job.

Repositories carry a generated bundle and must review and commit upgrades to
receive fixes. Runtime updates preserve workflow edits, so workflow changes
require their own deliberate update. Bundled dependencies require retained
license notices and executable artifact verification. A checksum can detect
inconsistent generated files, but trusted provenance comes from the repository
revision and its review controls.

See [GitHub setup](../github.md) for the operating procedure and
[licensing](../licensing.md) for redistribution terms.
