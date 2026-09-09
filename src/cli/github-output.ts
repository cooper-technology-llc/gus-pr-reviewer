import { appendFile } from "node:fs/promises";
import type { PreparedGitHubEvent } from "../application/application-options.js";
import { GusError } from "../errors.js";

/** Only fixed keys with bounded single-line values may become workflow outputs. */
export function formatGitHubOutputs(event: PreparedGitHubEvent): string {
  if (
    !(event.repository === "" && !event.eligible) &&
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(event.repository)
  )
    throw new GusError(
      "INPUT_INVALID",
      "The event repository is not a valid OWNER/REPO output.",
    );
  if (
    event.pullRequest !== null &&
    (!Number.isSafeInteger(event.pullRequest) || event.pullRequest <= 0)
  )
    throw new GusError(
      "INPUT_INVALID",
      "The event pull request number is invalid.",
    );
  if (event.eligible && event.pullRequest === null)
    throw new GusError(
      "INPUT_INVALID",
      "An eligible event must identify a pull request.",
    );
  if (!["review", "issues", "review-and-issues"].includes(event.mode))
    throw new GusError("INPUT_INVALID", "The event mode is invalid.");
  return [
    `eligible=${event.eligible ? "true" : "false"}`,
    `repository=${event.repository}`,
    `pull_request=${event.pullRequest ?? ""}`,
    `mode=${event.mode}`,
    `manual=${event.manual ? "true" : "false"}`,
    "",
  ].join("\n");
}

export async function writeGitHubOutputs(
  path: string | undefined,
  event: PreparedGitHubEvent,
): Promise<void> {
  if (!path?.trim())
    throw new GusError(
      "INPUT_INVALID",
      "--github-output requires the GITHUB_OUTPUT environment variable.",
    );
  await appendFile(path, formatGitHubOutputs(event), "utf8");
}
