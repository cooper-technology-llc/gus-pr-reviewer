# Configure Gus

Gus reads declarative JSON with defaults for omitted fields and validation for
unknown or malformed fields. The package exports its JSON Schema at
`gus-pr-reviewer/config-schema` and ships `gus.config.schema.json` for editors.
JavaScript configuration is not executed.

## Configuration sources

- GitHub reviews load `gus.config.json`, prompt files, and configured context
  from the PR's pinned target revision.
- Local reviews load those files from the specified base revision.
- `--config /trusted/path/gus.config.json` explicitly uses local configuration.
  Referenced files must stay inside that file's directory, including symlink
  resolution. An explicit missing file is an error.
- `doctor` checks local `gus.config.json` when present. Its report does not
  prove what another PR's target configuration contains.

An unmerged config change cannot grant the same PR new review authority. Use an
explicit trusted file to try configuration changes locally before merging them.

## Example

```json
{
  "version": 1,
  "name": "Gus",
  "provider": {
    "baseUrl": "https://openrouter.ai/api/v1",
    "apiKeyEnv": "OPENROUTER_API_KEY",
    "model": "openai/gpt-5.6-luna",
    "stages": {
      "investigate": { "reasoningEffort": "high" },
      "personality": { "reasoningEffort": "low" }
    }
  },
  "review": {
    "maxTurns": 20,
    "maxToolCalls": 80,
    "maxDurationMs": 600000,
    "maxTotalTokens": 180000,
    "maxCostUsd": 2,
    "blockingSeverity": "major"
  },
  "contextFiles": [],
  "personality": { "enabled": true, "style": "dry" },
  "github": { "allowForks": false, "maxInlineComments": 5 },
  "issues": { "mode": "on-request", "maxIssues": 3 },
  "slack": { "enabled": false }
}
```

The model and reasoning values must be supported by the provider. Gus uses
chat-completions-style requests; different semantics require a compatible
gateway or a library-level model client.

## Keep repository context focused

`contextFiles` is an explicit list of policy files loaded in full from the
trusted configuration revision. Their text is included in triage,
investigation, and validation, including subsequent tool turns. A large file
there can dominate input usage even for a small change.

Start with a concise review policy covering the rules that apply to every PR.
It can name larger reference documents and the circumstances in which their
relevant sections should be read from the pinned base revision. Keep current
source inspection separate from those trusted review criteria. Explicitly
selected files are never silently shortened or discarded.

Fresh noninteractive initialization leaves `contextFiles` empty. Interactive
setup suggests discovered guidance, explains its repeated context cost, and
retains the paths you explicitly select. Existing installed configurations are
preserved by runtime updates.

## Models and credentials

| Setting                     | Default                        | Meaning                                                                                    |
| --------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------ |
| `provider.baseUrl`          | `https://openrouter.ai/api/v1` | Compatible API base.                                                                       |
| `provider.apiKeyEnv`        | `OPENROUTER_API_KEY`           | Variable containing the key.                                                               |
| `provider.model`            | `openai/gpt-5.6-luna`          | Default model identifier.                                                                  |
| `provider.stages`           | `{}`                           | Model/reasoning overrides per stage.                                                       |
| `provider.requestTimeoutMs` | `90000`                        | Per-request timeout.                                                                       |
| `provider.retries`          | `2`                            | Bounded transient-request retries.                                                         |
| `provider.jsonMode`         | `true`                         | Request JSON mode for triage only. Review assessments and personality always use text DSL. |
| `provider.reasoningFormat`  | `openrouter`                   | `openrouter`, `openai`, or `none`.                                                         |

`GUS_MODEL` overrides the default model; explicit stage models remain selected.
`GUS_PROVIDER_URL` overrides the provider URL. Configuration stores names of
credential variables, never credential values.

For GitHub, `--api-url` wins over `GITHUB_API_URL`, followed by an explicitly
trusted config's `github.apiUrl`. When fetching config from GitHub, supply the
host through the flag or environment so the first connection reaches the right
server. The default is `https://api.github.com`.

`github.tokenEnv` defaults to `GITHUB_TOKEN`; `GH_TOKEN` is the fallback. A
custom token variable needed to fetch remote config must be selected through
explicit local config. `doctor` lists credential names and presence only; it
does not print values or test account permissions.

## Replace, extend, or keep a prompt

The five stages are `triage`, `investigate`, `validate`, `report`, and
`personality`. Omit a stage to keep its default. Supply exactly one of `text`
or `file` per override:

```json
{
  "prompts": {
    "validate": {
      "mode": "replace",
      "file": ".gus-prompts/validate.md"
    },
    "investigate": {
      "mode": "extend",
      "text": "Trace cancellation through our job queue and its consumers."
    }
  }
}
```

`replace` removes the entire bundled stage prompt. For personality it also
removes the bundled style instruction. Runtime schemas, tool permissions,
evidence validation, and budgets remain in force. Custom prompts should ask the
model to obey the supplied output contract.

Investigation, validation, and report responses use `REVIEW v1`; personality
uses `PERSONALITY v1`. Gus parses the text locally and applies its stage schemas
and evidence checks before rendering comments. Triage retains its small JSON
response. The [DSL protocol](review-behavior.md#dsl-responses) describes the
records and escaping rules for custom prompts and model clients.

```sh
gus prompts
gus prompts --stage investigate
gus prompts --export .gus-prompts
gus prompts --stage personality --export custom-voice
```

Without `--export`, Gus prints JSON for all stages or plain text for one stage.
Exports create Markdown with exclusive writes. Existing target files stop the
command before replacement.

With a vendored runtime, keep custom prompts outside `.github/gus`, for example
in `.gus-prompts`. The former is generated distribution content. `gus update`
preserves repository configuration and outside prompt files, and refuses local
edits inside its generated asset set unless `--force` explicitly replaces them.
Changing the runtime does not change where trusted repository policy is loaded.

## Personality

| Setting                | Default | Meaning                                      |
| ---------------------- | ------- | -------------------------------------------- |
| `personality.enabled`  | `true`  | Add a reaction after technical adjudication. |
| `personality.style`    | `dry`   | `warm`, `dry`, or `snarky`.                  |
| `personality.maxChars` | `600`   | Maximum reaction length.                     |

The reaction cannot change findings, grades, or the verdict. Every bundled style
keeps humor professional and appropriate for a workplace code review. `snarky`
adds wry, mildly sarcastic teasing of demonstrated code problems, never the
author. Set `enabled` to `false` to omit the reaction entirely.

## Scope and limits

| Setting                        | Default            |
| ------------------------------ | ------------------ |
| `review.maxTurns`              | `20`               |
| `review.maxToolCalls`          | `80`               |
| `review.maxDurationMs`         | `600000`           |
| `review.maxInputChars`         | `220000`           |
| `review.maxOutputTokens`       | `8192` per request |
| `review.maxTotalTokens`        | `180000`           |
| `review.maxCostUsd`            | `null`             |
| `review.maxFiles`              | `500`              |
| `review.maxFileBytes`          | `120000`           |
| `review.maxDiffCharsPerFile`   | `16000`            |
| `review.maxToolOutputChars`    | `32000`            |
| `review.maxSubmitContextChars` | `180000`           |
| `review.maxSubmitSeedChars`    | `100000`           |
| `review.blockingSeverity`      | `major`            |
| `review.scorecard`             | `true`             |

`maxCostUsd` is a stop threshold using observed provider cost, not a hard dollar
guarantee. An in-flight request can exceed it. Providers that omit cost leave
the amount unknown. Missing token accounting prevents a fully accounted review
and is reported as incomplete. Use provider account controls when a strict
spending boundary is required.

`review.exclude` accepts globs. Defaults exclude dependencies, build output,
vendor code, lockfiles, minified files, and `*.generated.*`.
`review.highRiskPaths` directs attention to migrations, authorization/permission
paths, billing, and workflows. Replacing either array replaces its defaults.
Excluded and truncated files remain visible in coverage.

`contextFiles` defaults to an empty list. Interactive setup suggests existing
`README.md`, `CONTRIBUTING.md`, and `AGENTS.md` files and lets you choose other
guidance or none. Larger and nested references remain available through bounded
reads. See [focused repository context](#keep-repository-context-focused) before
adding complete reference documents to every model turn.

## Deterministic repository rules

Optional `rules` identify suspicious added text or missing companion changes.
They supply review evidence; a match alone is not a demonstrated defect.

```json
{
  "rules": [
    {
      "id": "contract-fixture",
      "paths": ["contracts/**/*.ts"],
      "companionPaths": ["contracts/**/*.test.ts"],
      "message": "Check whether this contract change requires a fixture update.",
      "severity": "major"
    }
  ]
}
```

Each rule requires `id`, `paths`, and `message`; optional fields are `severity`
(default `major`), `forbiddenAddedText`, and `companionPaths`. Repository-specific
conventions belong here or in prompts rather than generic defaults.

## Observed checks

`--checks checks.json` accepts an array. Each result must name the exact head
revision it proves:

```json
[
  {
    "name": "unit tests",
    "status": "passed",
    "headSha": "the-full-reviewed-commit-sha",
    "details": "81 tests passed in the owning package",
    "url": "https://github.com/YOUR-ORG/YOUR-REPO/actions/runs/123"
  }
]
```

Statuses are `passed`, `failed`, `not-run`, or `inconclusive`. `details` and
`url` are optional. These are caller-supplied observations, not tests executed
or independently authenticated by Gus. Another head's results do not prove the
current review.

## Publication

`--publish` opts into GitHub reviews, inline comments, thread resolution, issue
creation, and Slack. Without it none of those writes occur. Configuring Slack
or issues alone does not grant publication permission.

- `github.maxInlineComments`: default `5`, maximum `30`.
- `github.reviewerLogins`: default `["github-actions[bot]"]`; list your actual
  publisher identities for trusted historical reviews.
- `github.allowForks`: default `false`.
- `github.reviewCommand`: default `@gus`.
- `github.issuesCommand`: default `@gus issues`.
- `issues.mode`: `off` (default), `on-request`, or `merge-clean`.
- `issues.maxIssues`: default `3`, limiting newly attempted issues per run.
- `issues.labels`: default `[]`; labels must already exist.
- `slack.enabled`: default `false`.
- `slack.webhookEnv`: default `SLACK_WEBHOOK_URL`.

`merge-clean` files nonblocking follow-ups after a ready review. Explicit issue
commands request filing even when automatic filing is off. Only findings marked
as follow-ups are filed. `issues` reuses a trusted current review with no new
model call; an issue never substitutes for fixing a blocking defect.
