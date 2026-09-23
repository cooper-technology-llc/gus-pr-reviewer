import { Buffer } from "node:buffer";
import type { GusConfig } from "../config/config-schema.js";
import { GusError } from "../errors.js";
import { formatReviewMarkdown } from "../reporting/format-review.js";
import {
  findHiddenStateComment,
  parseFindingMarker,
  parseReviewState,
  readReportIdentity,
  stateFromReview,
} from "../reporting/review-state.js";
import type { PublicationResult } from "../review/review-ports.js";
import type { PriorReview } from "../review/review-schema.js";
import { createReviewCheckRun, evidenceArtifactUrl } from "./check-run.js";
import { requireCurrentRevision } from "./current-revision.js";
import { publishFollowUpIssues } from "./follow-up-issues.js";
import type {
  GitHubClient,
  GitHubPullRequest,
  GitHubReviewRecord,
  PublishReviewInput,
} from "./github-port.js";
import { selectInlineComments } from "./inline-comments.js";
import {
  trustedReviewRecords,
  trustedReviewerLogins,
} from "./prior-reviews.js";
import { resolveEvidencedFindings } from "./resolve-findings.js";
import { notifyPublication } from "./slack.js";

const GITHUB_BODY_LIMIT = 65_000;
/** Room for the details and evidence links added to the body at post time. */
const LINKS_ALLOWANCE = 1_000;
const SUPERSEDED_PREFIX = "Superseded by ";

/** Publishes only the exact reviewed revision and reports confirmed external outcomes. */
export async function publishReview(
  input: PublishReviewInput,
): Promise<PublicationResult> {
  const result = emptyPublication(input.publish);
  if (!input.publish) return result;
  if (input.subject.isFork && !input.config.github.allowForks)
    throw new GusError("INPUT_INVALID", "Fork review publication is disabled.");
  const state = parseReviewState(input.markdown);
  const reportIdentity = readReportIdentity(input.markdown);
  if (
    !state ||
    !reportIdentity ||
    JSON.stringify(state) !== JSON.stringify(stateFromReview(input.review))
  )
    throw new GusError(
      "INPUT_INVALID",
      "Review Markdown does not match its structured review state.",
    );
  if (
    input.review.snapshot.headSha !== input.subject.headSha ||
    input.review.snapshot.baseSha !== input.subject.baseSha
  )
    return stalePublication(result);
  if (
    Buffer.byteLength(input.markdown, "utf8") >
    GITHUB_BODY_LIMIT - LINKS_ALLOWANCE
  ) {
    result.status = "partial";
    result.errors.push(
      "The complete review exceeds GitHub's comment size limit; no review was posted. Use the complete local report.",
    );
    return finishPublication(input, result);
  }

  try {
    const priorReviews = await trustedReviewRecords(
      input.client,
      input.subject.number,
      input.config,
    );
    const existing = priorReviews.find((review) =>
      isIdenticalReview(review, input, reportIdentity),
    );
    await requireCurrentRevision(input.client, input.subject);
    if (existing) {
      result.status = "already-published";
      result.reviewId = existing.id;
      result.reviewUrl = existing.url;
    } else {
      const posted = await postNewReview(input, reportIdentity, result);
      if (!posted) return finishPublication(input, result);
      await supersedePriorReviews(input, priorReviews, result);
    }

    if (
      input.requestedIssues ||
      (input.config.issues.mode === "merge-clean" &&
        input.review.verdict === "ready")
    ) {
      await publishFollowUpIssues(
        {
          client: input.client,
          subject: input.subject,
          findings: input.review.findings,
          config: input.config,
        },
        result,
      );
    }
    await resolveEvidencedFindings(input, result);
    if (
      result.status === "already-published" &&
      (result.issues.some((issue) => issue.created) ||
        result.threadsResolved > 0)
    )
      result.status = "published";
  } catch (error) {
    applyPublicationFailure(result, error);
  }
  return finishPublication(input, result);
}

/**
 * Creates the Check Run first so the comment can link to it, then posts the review.
 * Returns false when the review write was not confirmed.
 */
async function postNewReview(
  input: PublishReviewInput,
  reportIdentity: string,
  result: PublicationResult,
): Promise<boolean> {
  const environment = input.environment ?? process.env;
  const checkRun = await createReviewCheckRun({
    client: input.client,
    review: input.review,
    headSha: input.subject.headSha,
    config: input.config,
    environment,
    notices: result.notices,
  });
  if (checkRun.status === "skipped") result.notices.push(checkRun.notice);
  const markdown = formatReviewMarkdown(
    input.review,
    input.subject,
    input.config,
    {
      checkRunUrl: checkRun.status === "created" ? checkRun.url : null,
      artifactUrl: evidenceArtifactUrl(environment),
    },
  );
  const comments = selectInlineComments(
    input.review,
    input.subject,
    input.changedFiles,
    input.config,
  );
  await requireCurrentRevision(input.client, input.subject);
  try {
    const posted = await input.client.createReview(input.subject.number, {
      body: markdown,
      commitId: input.subject.headSha,
      comments,
    });
    result.reviewId = posted.id;
    result.reviewUrl = posted.url;
    result.inlinePosted = comments.length;
    return true;
  } catch {
    return recoverReview(input, reportIdentity, result);
  }
}

/**
 * Points every earlier Gus review on the PR at the new one. The hidden state comment is kept
 * because reconciliation reads it. Failures are notices; the new review is already posted.
 */
async function supersedePriorReviews(
  input: PublishReviewInput,
  priorReviews: GitHubReviewRecord[],
  result: PublicationResult,
): Promise<void> {
  const reviewUrl = result.reviewUrl;
  if (!reviewUrl) return;
  const sha7 = input.subject.headSha.slice(0, 7);
  let failed = 0;
  for (const prior of priorReviews) {
    if (prior.id === result.reviewId || isSuperseded(prior.body)) continue;
    const stateComment = findHiddenStateComment(prior.body);
    if (!stateComment) continue;
    try {
      await input.client.updateReview(
        input.subject.number,
        prior.id,
        `${SUPERSEDED_PREFIX}[this review](${reviewUrl}) at \`${sha7}\`.\n\n${stateComment}`,
      );
    } catch {
      failed += 1;
    }
  }
  if (failed > 0)
    result.notices.push(
      `Could not mark ${failed} earlier review${failed === 1 ? "" : "s"} as superseded; the new review was still posted.`,
    );
}

function isSuperseded(body: string): boolean {
  return body.startsWith(SUPERSEDED_PREFIX);
}

export interface FileReviewIssuesInput {
  client: GitHubClient;
  subject: GitHubPullRequest;
  priorReviews: PriorReview[];
  config: GusConfig;
  publish: boolean;
  slackWebhook?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

/** Replays explicit issue filing from the latest trusted report without another model call. */
export async function fileReviewIssues(
  input: FileReviewIssuesInput,
): Promise<PublicationResult> {
  const result = emptyPublication(input.publish);
  if (!input.publish) return result;
  if (input.subject.isFork && !input.config.github.allowForks)
    throw new GusError("INPUT_INVALID", "Fork review publication is disabled.");
  try {
    const latest = (
      await trustedReviewRecords(
        input.client,
        input.subject.number,
        input.config,
      )
    )[0];
    const state = latest ? parseReviewState(latest.body) : null;
    if (!latest || !state) {
      result.status = "partial";
      result.errors.push("No trusted review is available for issue filing.");
      return finishPublication(input, result);
    }
    if (
      state.headSha !== input.subject.headSha ||
      state.baseSha !== input.subject.baseSha
    )
      return stalePublication(result);
    await requireCurrentRevision(input.client, input.subject);
    result.reviewId = latest.id;
    result.reviewUrl = latest.url;
    await publishFollowUpIssues(
      {
        client: input.client,
        subject: input.subject,
        findings: state.findings,
        config: input.config,
      },
      result,
    );
    if (
      result.status !== "partial" &&
      !result.issues.some((issue) => issue.created)
    )
      result.status = "already-published";
  } catch (error) {
    applyPublicationFailure(result, error);
  }
  return finishPublication(input, result);
}

async function findIdenticalReview(
  input: PublishReviewInput,
  identity: string,
): Promise<GitHubReviewRecord | undefined> {
  return (
    await trustedReviewRecords(input.client, input.subject.number, input.config)
  ).find((review) => isIdenticalReview(review, input, identity));
}

function isIdenticalReview(
  review: GitHubReviewRecord,
  input: PublishReviewInput,
  identity: string,
): boolean {
  return (
    readReportIdentity(review.body) === identity &&
    parseReviewState(review.body)?.baseSha === input.subject.baseSha &&
    review.commitId === input.subject.headSha
  );
}

async function recoverReview(
  input: PublishReviewInput,
  identity: string,
  result: PublicationResult,
): Promise<boolean> {
  try {
    const review = await findIdenticalReview(input, identity);
    if (review) {
      result.reviewId = review.id;
      result.reviewUrl = review.url;
      const trusted = await trustedReviewerLogins(input.client, input.config);
      const threads = await input.client.listThreads(input.subject.number);
      result.inlinePosted = threads.filter((thread) => {
        const root = thread.comments[0];
        return (
          root !== undefined &&
          root.reviewId === review.id &&
          trusted.has(root.author.toLowerCase()) &&
          parseFindingMarker(root.body) !== null
        );
      }).length;
      return true;
    }
  } catch {
    result.errors.push(
      "Unable to query GitHub to reconcile the review write outcome.",
    );
  }
  result.status = "partial";
  result.errors.push(
    "Review creation was not confirmed; the request was not retried because its outcome may be unknown.",
  );
  return false;
}

function emptyPublication(publish: boolean): PublicationResult {
  return {
    status: publish ? "published" : "dry-run",
    reviewUrl: null,
    reviewId: null,
    inlinePosted: 0,
    issues: [],
    threadsResolved: 0,
    slackSent: false,
    errors: [],
    notices: [],
  };
}

async function finishPublication(
  input: Pick<
    PublishReviewInput,
    "subject" | "config" | "slackWebhook" | "fetch" | "signal"
  >,
  result: PublicationResult,
): Promise<PublicationResult> {
  await notifyPublication({
    subject: input.subject,
    config: input.config,
    publication: result,
    ...(input.slackWebhook ? { webhook: input.slackWebhook } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return result;
}

function stalePublication(result: PublicationResult): PublicationResult {
  result.status = "stale";
  result.errors.push(
    "Review does not match the pull request's current HEAD and base; no new actions were taken.",
  );
  return result;
}

function applyPublicationFailure(
  result: PublicationResult,
  error: unknown,
): void {
  const confirmed =
    result.reviewId !== null ||
    result.issues.some((issue) => issue.created) ||
    result.threadsResolved > 0;
  if (error instanceof GusError && error.code === "STALE_REVIEW") {
    result.status = confirmed ? "partial" : "stale";
    result.errors.push(
      "The pull request changed during publication; remaining actions were stopped.",
    );
  } else {
    result.status = "partial";
    result.errors.push(
      "GitHub publication could not complete; inspect the confirmed counts before retrying.",
    );
  }
}
