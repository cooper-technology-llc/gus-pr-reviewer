import { GusError } from "../errors.js";
import type { GitHubClient, GitHubPullRequest } from "./github-port.js";

export async function requireCurrentRevision(
  client: GitHubClient,
  subject: GitHubPullRequest,
): Promise<void> {
  const current = await client.getPullRequest(subject.number);
  if (
    current.headSha !== subject.headSha ||
    current.baseSha !== subject.baseSha ||
    current.baseRef !== subject.baseRef ||
    current.headRef !== subject.headRef ||
    current.state !== "open" ||
    current.merged
  )
    throw new GusError(
      "STALE_REVIEW",
      "Pull request HEAD, base, branch, or open state changed; publication stopped.",
    );
}
