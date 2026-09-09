import type { GusConfig } from "../config/config-schema.js";
import { parseFindingMarker } from "../reporting/review-state.js";
import type { PublicationResult } from "../review/review-ports.js";
import type { PriorReview, ReviewResult } from "../review/review-schema.js";
import { requireCurrentRevision } from "./current-revision.js";
import type { GitHubClient, GitHubPullRequest } from "./github-port.js";
import { trustedReviewerLogins } from "./prior-reviews.js";

export async function resolveEvidencedFindings(
  input: {
    client: GitHubClient;
    subject: GitHubPullRequest;
    review: ReviewResult;
    priorReviews: PriorReview[];
    config: GusConfig;
  },
  publication: PublicationResult,
): Promise<void> {
  if (input.review.verdict === "incomplete") return;
  const resolvedIds = new Set(
    input.review.reconciliations
      .filter(
        (resolution) =>
          resolution.status === "resolved" &&
          resolution.evidenceIds.some((id) =>
            input.review.evidence.some(
              (evidence) =>
                evidence.id === id &&
                evidence.revision === "head" &&
                evidence.sha === input.subject.headSha &&
                !evidence.truncated &&
                evidence.text.trim().length > 0,
            ),
          ),
      )
      .map((resolution) => resolution.id),
  );
  if (resolvedIds.size === 0) return;
  const allowedReviewIds = new Set(
    input.priorReviews.map((review) => review.id),
  );
  const trusted = await trustedReviewerLogins(input.client, input.config);
  const threads = await input.client.listThreads(input.subject.number);
  for (const thread of threads) {
    const root = thread.comments[0];
    const findingId = root ? parseFindingMarker(root.body) : null;
    if (
      thread.resolved ||
      !root ||
      root.reviewId === null ||
      !allowedReviewIds.has(root.reviewId) ||
      !trusted.has(root.author.toLowerCase()) ||
      !findingId ||
      !resolvedIds.has(findingId)
    )
      continue;
    if (
      !input.priorReviews.some(
        (review) =>
          review.id === root.reviewId &&
          review.state.findings.some((finding) => finding.id === findingId),
      )
    )
      continue;
    await requireCurrentRevision(input.client, input.subject);
    try {
      await input.client.resolveThread(thread.id);
      publication.threadsResolved += 1;
    } catch {
      publication.errors.push(
        `Resolution of finding ${findingId} was not confirmed.`,
      );
      publication.status = "partial";
    }
  }
}
