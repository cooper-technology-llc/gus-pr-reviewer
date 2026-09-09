import type { GusConfig } from "../config/config-schema.js";
import {
  parseFindingMarker,
  parseReviewState,
} from "../reporting/review-state.js";
import type { PriorReview } from "../review/review-schema.js";
import type { GitHubClient, GitHubReviewRecord } from "./github-port.js";

export async function trustedReviewerLogins(
  client: GitHubClient,
  config: GusConfig,
): Promise<Set<string>> {
  const logins = new Set(
    config.github.reviewerLogins.map((login) => login.toLowerCase()),
  );
  const authenticated = await client.getAuthenticatedLogin();
  if (authenticated) logins.add(authenticated.toLowerCase());
  return logins;
}

export async function trustedReviewRecords(
  client: GitHubClient,
  number: number,
  config: GusConfig,
): Promise<GitHubReviewRecord[]> {
  const trusted = await trustedReviewerLogins(client, config);
  return (await client.listReviews(number))
    .filter(
      (review) =>
        trusted.has(review.author.toLowerCase()) &&
        parseReviewState(review.body)?.headSha === review.commitId,
    )
    .sort(
      (left, right) =>
        right.submittedAt.localeCompare(left.submittedAt) || right.id - left.id,
    );
}

/** Loads authenticated, versioned state across all revisions, including reruns at the same HEAD. */
export async function readPriorReviews(
  client: GitHubClient,
  prNumber: number,
  config: GusConfig,
): Promise<PriorReview[]> {
  const trusted = await trustedReviewerLogins(client, config);
  const reviews = (await client.listReviews(prNumber))
    .filter((review) => trusted.has(review.author.toLowerCase()))
    .sort(
      (left, right) =>
        right.submittedAt.localeCompare(left.submittedAt) || right.id - left.id,
    );
  const records: PriorReview[] = [];
  for (const review of reviews) {
    const state = parseReviewState(review.body);
    if (state && state.headSha === review.commitId)
      records.push({
        id: review.id,
        author: review.author,
        url: review.url,
        submittedAt: review.submittedAt,
        state,
        replies: [],
      });
  }
  if (records.length === 0) return [];
  const threads = await client.listThreads(prNumber);
  for (const thread of threads) {
    const root = thread.comments[0];
    if (!root || !trusted.has(root.author.toLowerCase())) continue;
    const findingId = parseFindingMarker(root.body);
    if (!findingId) continue;
    const review = records.find(
      (entry) =>
        entry.id === root.reviewId &&
        entry.state.findings.some((finding) => finding.id === findingId),
    );
    if (!review) continue;
    review.replies.push({
      findingId,
      author: root.author,
      body: root.body,
      resolved: thread.resolved,
      threadId: thread.id,
    });
    for (const reply of thread.comments.slice(1))
      review.replies.push({
        findingId,
        author: reply.author,
        body: reply.body,
        resolved: thread.resolved,
        threadId: thread.id,
      });
  }
  return records;
}
