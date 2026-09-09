# Run Gus on GitHub

Generate a starter with `gus init` and review `.github/workflows/gus-review.yml`
before committing it. The package template is inert until installed in a
repository and merged to its default branch. `init` also copies the complete
Gus runtime and required assets to `.github/gus`. Commit that directory with the
workflow and configuration. Review jobs run that copy directly, with no npm,
npx, dependency-install, or build step.

## Permissions and secrets

Set the provider secret chosen during `gus init` as an Actions secret;
the default name is `OPENROUTER_API_KEY`. Setup writes the matching environment
variable and secret reference into the workflow. The workflow uses the job's
`GITHUB_TOKEN`. Optional Slack requires `SLACK_WEBHOOK_URL` and
`slack.enabled: true` in trusted config. If you later change the provider secret
name, update both the workflow environment and `provider.apiKeyEnv`.

The prepare job uses `contents: read` and `pull-requests: read`. It validates
the event, PR status, fork policy, and a manual requester's permission before
the review job can enter per-PR concurrency. Ordinary discussion cannot cancel
another review by merely triggering the workflow.

The review job uses `contents: read`, `pull-requests: write`, and `issues: write`.
If you remove issue permissions, also keep issue commands/automation disabled
in your usage. Repository or organization settings must permit reviews using
the token. A personal or app token needs equivalent repository access.

Gus posts `COMMENT` reviews. His verdict is advisory text and an exit code;
he does not submit an approval, merge, change protection, or rewrite branches.
The step fails for changes requested or incomplete review. Choose whether to
make that workflow a required repository check yourself.

## Events and commands

The template listens to `pull_request_target`, new issue comments, new inline
review comments, and manual dispatch. Automatic draft reviews are skipped;
authorized manual commands can request a draft review.

Write a command on its own line:

```text
@gus
```

`@gus review` requests the same review. `@gus issues` files follow-ups from a
trusted current review. `@gus review issues` requests a new review and issue
filing. Commands inside quotes, code blocks, HTML comments, or ordinary sentences
are ignored. Bot actors and callers without write, maintain, or admin permission
cannot request manual work.

Manual dispatch accepts a PR number and `review`, `issues`, or
`review-and-issues`. Event-based execution repeats authorization.

```sh
gus trigger --event "$GITHUB_EVENT_PATH" --github-output
gus review --event "$GITHUB_EVENT_PATH" --publish --format json --output gus-review.json
```

Both commands need `GITHUB_EVENT_NAME`. `trigger` makes read-only GitHub requests
and no model request. `--github-output` requires `GITHUB_OUTPUT` and appends
fixed keys with validated single-line values: `eligible`, `repository`,
`pull_request`, `mode`, and `manual`. Comment text never becomes shell code or
workflow output instructions.

## Trust boundary

`pull_request_target` has access to base-repository permissions. The workflow
checks out only `.github/gus` from the explicit
`refs/heads/${{ github.event.repository.default_branch }}` ref in
`${{ github.repository }}`. It does not use the PR head or manual dispatch ref
as the runtime source. Checkout credentials are not persisted.

The prepare job validates the checkout action's commit SHA and exports it to
the review job, which checks out that exact same commit. If the default branch
advances between jobs, the review still uses the runtime that authorized the
event. Review eligibility remains outside per-PR cancellation concurrency.

Only the trusted runtime is executed. PR scripts, dependencies, tests, and
reviewer code are never executed. Gus reads the reviewed source through separate
immutable Git snapshots. Prompt/config policy still comes from the pinned PR
target, or an explicitly supplied trusted file; vendoring does not alter that
policy boundary.

Separate prepare/review jobs keep rejected comments outside cancellation
concurrency. No PR title, body, branch name, or comment is interpolated into a
shell command. Keep the workflow and committed Gus runtime under trusted
review. Do not add PR checkout or PR-provided command execution to this
privileged workflow. See GitHub's
[event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target).

Forks are disabled by default. Trusted `github.allowForks` enables source
inspection under the same no-execution boundary. It does not allow contributor
workflow changes to run with secrets. Private fork access, token policy, and
repository visibility still determine which Git objects are readable.

## GitHub Enterprise Server

Use the server API base, usually `https://HOST/api/v3`, through `--api-url`,
`GITHUB_API_URL`, or explicit local config. The flag wins, then environment,
then config. A hostname stored only in remote config cannot bootstrap the first
connection; supply it outside the repository.

```sh
gus review --repo YOUR-ORG/YOUR-REPO --pr 42 --api-url https://github.example.com/api/v3
```

Core REST/GraphQL integration is configurable. The generated workflow targets
GitHub.com hosted runners. Check Enterprise Server action support, provider
network access, runner version, and artifact action compatibility before use.
Do not assume the GitHub.com artifact action works on every GHES release. See
[setup-node](https://github.com/actions/setup-node) and
[upload-artifact GHES guidance](https://github.com/actions/upload-artifact#ghes-support).

The template uses official `checkout@v7`, `setup-node@v7`, and `upload-artifact@v7`,
Node 22 for Gus, and automatic package manager caching disabled. Organizations
requiring immutable action pins can substitute reviewed commit SHAs. Sources:
[setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0) and
[upload-artifact v7.0.1](https://github.com/actions/upload-artifact/releases/tag/v7.0.1),
plus [checkout's documented commit output](https://github.com/actions/checkout/blob/v7.0.1/action.yml).

## Updating Gus

Obtain a newer Gus package or build it locally, then run `gus update` from that
version against the repository. The command copies a fixed list of generated
runtime assets, checks their integrity, and includes unchanged Gus license and
original third-party notices. It does not fetch a new version during the update
or during GitHub jobs.

Review and commit the resulting `.github/gus` diff. Config, workflow, and custom
prompts outside that generated directory remain unchanged. Locally edited
generated assets require preservation or explicit `gus update --force`.
Workflow updates are supplied as a template inside `.github/gus/templates`, for
separate adoption. The vendored CLI itself can initialize another repository
or copy its own version through `update` without `node_modules`.

This choice trades repository size and reviewed runtime updates for independent
operation from npm during review jobs. See
[the distribution decision](adr/0002-commit-the-reviewer-runtime.md) and
[licensing](licensing.md).

## Results and retries

JSON artifacts include review evidence, coverage, usage, rendered Markdown,
and confirmed publication outcomes. They can contain source code; keep artifact
access aligned with source access.

Before publishing, Gus checks the PR head and target still match the reviewed
revisions. He stops remaining actions if either changes. Identical reviews and
stable issue markers avoid repeated writes. Uncertain writes are reconciled
with GitHub instead of blindly repeated.

Publication distinguishes `dry-run`, `published`, `already-published`, `partial`,
and `stale`, with confirmed review URL, issue IDs, inline count, resolved-thread
count, and Slack outcome. Partial/stale results exit 2 even if the old technical
review said ready. Inspect those outcomes before retrying.
