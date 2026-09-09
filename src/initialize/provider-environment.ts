import { GusError } from "../errors.js";

const reservedNames = new Set([
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "ENV",
  "BASH_ENV",
  "CODEX_HOME",
  "GH_TOKEN",
  "SLACK_WEBHOOK_URL",
]);

/** Keep provider credentials separate from runner controls and other integrations. */
export function assertProviderEnvironmentName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.length > 128)
    throw new GusError(
      "INPUT_INVALID",
      "Use an environment variable name such as MODEL_API_KEY, not a secret value.",
    );
  if (
    reservedNames.has(name.toUpperCase()) ||
    /^(GITHUB_|RUNNER_|ACTIONS_|GUS_|NODE_|LD_|DYLD_)/i.test(name)
  )
    throw new GusError(
      "INPUT_INVALID",
      "Choose a dedicated provider credential variable such as MODEL_API_KEY. This name is reserved for the runner or another integration.",
    );
}
