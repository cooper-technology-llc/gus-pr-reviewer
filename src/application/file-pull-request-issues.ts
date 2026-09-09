import { readPriorReviews } from "../github/prior-reviews.js";
import { fileReviewIssues } from "../github/publish-review.js";
import type { PublicationResult } from "../review/review-ports.js";
import type { PullRequestReviewOptions } from "./application-options.js";
import { createGitHubReviewHost } from "./github-review-host.js";

/** File bounded follow-ups from a trusted current review without invoking a model. */
export async function filePullRequestIssues(
  options: PullRequestReviewOptions,
): Promise<PublicationResult> {
  const host = await createGitHubReviewHost(options);
  const priorReviews = await readPriorReviews(
    host.client,
    host.subject.number,
    host.config,
  );
  const webhook = host.environment[host.config.slack.webhookEnv];
  return fileReviewIssues({
    client: host.client,
    subject: host.subject,
    priorReviews,
    config: host.config,
    publish: options.publish === true,
    ...(webhook ? { slackWebhook: webhook } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
