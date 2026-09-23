# Gus PR Reviewer

[npm package](https://www.npmjs.com/package/gus-pr-reviewer) ·
[GitHub repository](https://github.com/cooper-technology-llc/gus-pr-reviewer)

Gus is the teammate who reads the surrounding code, follows a suspicious change
to its consequence, and occasionally has something dry to say about it.

He reviews GitHub pull requests or committed local branches, keeps findings tied
to the revisions he inspected, and separates branch maintenance advice from code
defects. Every review prompt can be extended or completely replaced.

Version **0.1.8** includes the CLI and a runtime you can commit to your repository.
The earlier `0.0.1-alpha.0` package contains prompts only.

Review assessments use a compact text DSL that Gus parses and validates locally
before rendering GitHub comments. Finding submissions and personality responses
do not use provider JSON mode. See the [response protocol](docs/review-behavior.md#dsl-responses).

## Quick start

Run once from the repository where you want Gus:

```sh
npx --yes gus-pr-reviewer@0.1.8 init
```

Setup walks you through the model provider, model, API-key environment variable,
personality, review budget, and repository guidance files. Selected guidance is
sent in full on repeated review turns, so prefer a concise review policy and
read larger references as needed. Add the provider secret selected during setup
and commit `gus.config.json`, `.github/gus`, and the generated workflow.
GitHub runs the committed copy without installing Gus from npm.

Use `gus init --yes` to accept defaults without questions. Noninteractive runs
also use defaults, with no repository guidance preloaded automatically. All
settings remain editable in `gus.config.json`, and every review prompt can be
replaced.

## Start from this checkout

Requires Node.js **22.14 or newer**, Git **2.38 or newer**, and an OpenAI-compatible chat-completions
provider. OpenRouter is the default. Repository scripts and tests are not run by
Gus; the model receives bounded read-only Git inspection tools.

```sh
npm install
npm run build
node dist/cli.js --help
node dist/cli.js doctor
```

For the default provider, set `OPENROUTER_API_KEY` in your environment; use the
variable selected during setup for another provider. Set `GITHUB_TOKEN` for GitHub access.
Do not put secret values in `gus.config.json`.

```sh
# Inspect a PR and save the complete report, without GitHub or Slack writes.
node dist/cli.js review --repo YOUR-ORG/YOUR-REPO --pr 42 --output review.md

# Review committed local changes, including the appropriate stack parent.
node dist/cli.js review --path /path/to/repo --base main --parent feature/parent

# Explicitly publish a GitHub review and any configured follow-up actions.
node dist/cli.js review --repo YOUR-ORG/YOUR-REPO --pr 42 --publish
```

Unpublished reviews still contact the model and can incur provider charges.
Local reviews inspect committed revisions; uncommitted and untracked files are
outside their scope.

For local CLI use, you can also install a pinned version:

```sh
npm install --save-dev --save-exact gus-pr-reviewer@0.1.8
npx gus --help
```

Both `gus` and `gus-pr-reviewer` invoke the same CLI.

## Give Gus a repository

```sh
node dist/cli.js init --directory /path/to/repo
```

This creates `gus.config.json`, `.github/workflows/gus-review.yml`, and a complete
runtime under `.github/gus`. Existing files stop setup before replacement;
`--force` explicitly replaces generated setup files. Review the workflow, add
the provider secret, and commit those files to the repository's default branch
through your normal process.

**GitHub jobs do not install Gus from npm.** They run the committed bundle:

```sh
node .github/gus/runtime/bin/gus.mjs --version
```

The bundle contains its runtime dependencies. Prompts, templates, version
metadata, integrity records, Gus's license, and original third-party notices
are included beside it. No `node_modules`, dependency installation, or build is
needed on a review job. Node, Git, GitHub access, and the model provider are
still required. A local source build can be initialized without publishing it.

The generic defaults assume no language, framework, default branch, deployment
status, or required policy files. During setup, choose the guidance that applies
to your repository. Configuration is ordinary editable JSON.

The workflow reads only `.github/gus` from the trusted default branch. After
validating event eligibility, the review job uses the exact same runtime commit.
PR code is inspected through Gus's separate immutable snapshots. See
[GitHub setup](docs/github.md) for permissions, forks, manual commands, and
GitHub Enterprise Server differences.

## Update the committed runtime

Obtain or build the Gus version you want locally, then run that version's CLI:

```sh
gus update --directory /path/to/repo
```

`update` copies the currently installed version; it does not contact npm or
choose a newer release. Review and commit the runtime diff to adopt it. The
command preserves `gus.config.json`, the installed workflow, and custom prompts
outside `.github/gus`. Keep that directory for generated assets and place your
prompts in `.gus-prompts` or another separate directory.

Integrity checks refuse locally edited generated assets by default. Save those
customizations elsewhere before updating, or use `gus update --force` to
explicitly replace them. Obsolete generated presets are removed during updates;
files outside the previous generated manifest are preserved. Symlinks are refused.
An uninitialized repository needs `gus init` first. Updates include the latest
workflow template inside `.github/gus/templates`; adopting workflow changes is
a separate reviewed edit to `.github/workflows/gus-review.yml`.

## A useful reviewer with a personality

Gus investigates with file, diff, search, and history tools, validates proposed
findings, and reports concrete triggers, consequences, and corrections. Findings
carry stable identifiers for later review rounds; a prior accusation needs
current evidence to remain open.

The PR comment is short: a verdict line
(`Gus · changes requested · 2 findings · coverage 61/63`), each finding with its
`path:line` permalink, trigger, impact, fix, and a collapsed excerpt of the
cited source at the pinned commit, then a short summary and Gus's take. The
revisions, coverage table, limitations, check results, diagnostics, questions,
and usage by stage live on the `Gus review` Check Run page and in the JSON
artifact, both linked from the comment. A new review marks the previous Gus
review on the PR as superseded.

Coverage is the host's job: Gus pages truncated patches itself and re-reads the
source each confirmed finding cites, so neither depends on the model asking.
Partial coverage is one line in the comment, never a verdict. A prose-report
failure cannot erase the validated technical assessment. Claims about an external API require defining
evidence for the exact installed version; indirect usage or model memory alone
becomes a focused question, not a defect.

His reaction is written after the technical result is finalized. For example,
Gus might say, “That retry loop was committed to the bit.” Humor cannot add a
finding or change a verdict. Choose a voice:

```json
{
  "personality": { "enabled": true, "style": "dry" }
}
```

`warm`, `dry`, and `snarky` are supported. Every bundled style keeps humor
professional and about the code. `snarky` adds wry, mildly sarcastic teasing of
demonstrated code problems, never the author. Set `enabled` to `false` for a
strictly technical review, or replace the personality prompt with your own
character.

## Your prompts, completely

```sh
node dist/cli.js prompts --export /path/to/repo/.gus-prompts
```

This exports five Markdown files: `triage`, `investigate`, `validate`, `report`,
and `personality`. Existing prompt files are never overwritten.

```json
{
  "prompts": {
    "investigate": {
      "mode": "replace",
      "file": ".gus-prompts/investigate.md"
    },
    "report": {
      "mode": "extend",
      "text": "Use our supplied severity definitions and keep corrections concise."
    }
  }
}
```

`replace` removes all bundled guidance for that stage. `extend` appends to it.
The runtime still supplies the output schema, bounded tools, and evidence rules
needed to operate Gus. Prompt files are resolved beside the trusted config,
never from an arbitrary PR checkout. See [configuration](docs/configuration.md).

The original CommonJS prompt export remains available:

```js
const prompts = require("gus-pr-reviewer/prompts");
const investigationPrompt = prompts.investigate;
```

That compatibility export remains the four original strings: `triage`,
`investigate`, `validate`, and `report`. Use `gus prompts` for all five stages.

The runtime also exposes an ESM API:

```js
import { reviewPullRequest } from "gus-pr-reviewer";

const completed = await reviewPullRequest({
  repository: "YOUR-ORG/YOUR-REPO",
  pullRequest: 42,
  publish: false,
});

process.stdout.write(completed.markdown);
```

`reviewLocalChanges`, `prepareGitHubEvent`, and `filePullRequestIssues` are
available too. Lower-level `reviewChange` accepts injected model and repository
interfaces for a custom host; exported TypeScript types describe those seams.

## Stacked branches and rebases

Gus records the head, target, merge base, parent, and prospective integration
state. He distinguishes a child's own changes from inherited parent changes.
Use `--parent REF` when an automatic relationship is ambiguous.

An outdated or squash-merged parent can justify advice to update or retarget a
branch. Being behind the default branch alone does not. Prior findings are
revalidated after a rebase or base change, and an isolated prospective merge
helps determine whether an upstream fix survives integration. Gus never rewrites
the author's branch. See [review behavior](docs/review-behavior.md) for limits.

## Commands and outcomes

| Command                                | Purpose                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| `review --repo OWNER/REPO --pr N`      | Review a GitHub PR; add `--publish` for writes.                               |
| `review --path DIR --base REF`         | Review local committed history.                                               |
| `review --event PATH`                  | Authorize and process a GitHub event.                                         |
| `issues --repo OWNER/REPO --pr N`      | File follow-ups from a trusted current review; requires `--publish` to write. |
| `trigger --event PATH --github-output` | Authorize an event and export safe workflow fields, without a model call.     |
| `init`                                 | Vendor the runtime and create configuration and a trusted workflow.           |
| `update`                               | Refresh generated runtime assets from the locally installed version.          |
| `prompts`                              | Print or export bundled review prompts.                                       |
| `doctor`                               | Show runtime/config validity and credential presence only.                    |

Reviews support `--config`, `--parent`, `--checks`, `--output`, and
`--format markdown|json`. Local reviews additionally support `--head` (default
`HEAD`) and `--default-branch` when the remote default cannot be discovered.
GitHub commands support `--api-url` for another API host. `issues`
supports `--config`, `--output`, and `--format`; `trigger` supports `--config`.
Run `gus --help` for all options and combinations.

With `--publish`, exit **0** means a review is on the PR (any verdict) and **2**
means nothing was published. Without `--publish`, exit **0** means ready, **1**
changes requested, and **2** incomplete. `incomplete` means no validated
assessment exists; coverage gaps, open questions, binaries, and renames never
cause it. A completed static review does not prove tests, CI, production, or
hardware behavior.

Use [check input](docs/configuration.md#observed-checks) to supply results from
your own verification process, tied to the exact reviewed head. Gus does not
manufacture test results or approve/merge a pull request.

## Development and distribution

```sh
npm run typecheck
npm test
npm run build
npm pack --dry-run
```

Tests use temporary Git repositories and mocked provider/GitHub responses to
exercise topology, evidence, budgets, publication, and CLI behavior. Live
provider quality and a hosted workflow require separate acceptance evidence.
Copyright (c) 2026 Cooper Technology. Gus uses the standard
[PolyForm Perimeter License 1.0.1](LICENSE). Teams can use it on commercial
projects; offering a competing product or service is restricted, including
free competing offerings. Bundled dependencies retain their original terms.
See the [licensing guide](docs/licensing.md) for the boundaries.
