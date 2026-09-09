export const cliHelp = `Gus — your configurable PR review teammate

Usage:
  gus review --repo OWNER/REPO --pr NUMBER [--publish]
  gus review --path DIRECTORY --base REF [--head REF]
  gus review --event EVENT_JSON [--publish]
  gus issues --repo OWNER/REPO --pr NUMBER [--publish]
  gus trigger --event EVENT_JSON [--github-output]
  gus init [--directory DIRECTORY] [--yes] [--force]
  gus update [--directory DIRECTORY] [--force]
  gus prompts [--stage triage|investigate|validate|report|personality] [--export DIRECTORY]
  gus doctor [--config FILE]

Review options:
  --config FILE      Use an explicitly trusted local JSON configuration.
  --parent REF       Override the parent of a stacked branch.
  --default-branch REF  Local only: identify the default branch when not discoverable.
  --checks FILE      JSON array of observed checks, each tied to a headSha.
  --output FILE      Write an artifact instead of printing it to stdout.
  --format FORMAT    markdown (default) or json.
  --publish          Allow configured GitHub and Slack writes. Omitted by default.
  --api-url URL      GitHub API base URL; overrides GITHUB_API_URL and config.

Other options:
  --config FILE      Also supported by issues, trigger, and doctor.
  --api-url URL      Also supported by issues and trigger; GitHub commands only.
  --output FILE      Also supported by issues.
  --format FORMAT    Also supported by issues.
  --github-output    Append validated eligibility fields to GITHUB_OUTPUT.
  --force            init: replace setup files; update: replace locally edited generated assets.
  --yes, -y          init: use defaults and discovered guidance without questions.
  --help, -h         Show this help.
  --version, -v      Show the installed package version.

Credentials: OPENROUTER_API_KEY and GITHUB_TOKEN (GitHub commands).
GUS_MODEL overrides the default model. Config supports other providers and hosts.
Event commands also require GITHUB_EVENT_NAME. No repository scripts are executed.
init vendors the runtime into .github/gus; update copies this installed Gus version there.
Interactive init asks about your provider, model, key variable name, voice, guidance, and budget.
Noninteractive init never waits for input. Secret values are never requested or stored.
GitHub jobs run the committed runtime without npm. update does not fetch new versions.

Exit codes: 0 ready/success/skipped; 1 changes requested; 2 incomplete/error.
An unpublished review still calls the model and can incur provider charges.
`;
