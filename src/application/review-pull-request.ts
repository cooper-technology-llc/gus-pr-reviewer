import { loadPrompts } from "../config/load-config.js";
import { defaultConfig } from "../config/config-schema.js";
import { GusError } from "../errors.js";
import { readPriorReviews } from "../github/prior-reviews.js";
import { publishReview } from "../github/publish-review.js";
import type { GitHubPullRequest } from "../github/github-port.js";
import { createModelClient } from "../model/model-client.js";
import { createRepositorySession } from "../repository/repository-session.js";
import { createRepositoryTools } from "../repository/repository-tools.js";
import { formatReviewMarkdown } from "../reporting/format-review.js";
import { reviewChange } from "../review/review-change.js";
import type {
  CompletedReview,
  RepositorySource,
} from "../review/review-ports.js";
import {
  createGitHubReviewHost,
  type GitHubReviewHost,
} from "./github-review-host.js";
import type { PullRequestReviewOptions } from "./application-options.js";
import { loadPolicies, requireModelKey } from "./review-input.js";
import { createReviewDeadline } from "./review-deadline.js";

/** Review immutable PR revisions; publishing requires an explicit host opt-in. */
export async function reviewPullRequest(
  options: PullRequestReviewOptions,
): Promise<CompletedReview> {
  const deadline = createReviewDeadline(
    options.config?.review.maxDurationMs ?? defaultConfig.review.maxDurationMs,
    options.signal,
  );
  try {
    return await runPullRequestReview(options, deadline);
  } finally {
    deadline.dispose();
  }
}

async function runPullRequestReview(
  options: PullRequestReviewOptions,
  deadline: ReturnType<typeof createReviewDeadline>,
): Promise<CompletedReview> {
  const signal = deadline.signal;
  const host = await createGitHubReviewHost({ ...options, signal }, deadline);
  const { client, config, subject, environment } = host;
  deadline.setDuration(config.review.maxDurationMs);
  if (subject.isFork && !config.github.allowForks) {
    throw new GusError(
      "INPUT_INVALID",
      "Fork reviews are disabled. Enable github.allowForks in trusted configuration to review this PR.",
    );
  }
  const apiKey = requireModelKey(config, environment);
  const [prompts, policies, priorReviews, parents] = await Promise.all([
    loadPrompts(config, host.readConfigurationFile),
    loadPolicies(config, host.readConfigurationFile),
    readPriorReviews(client, subject.number, config),
    findParentCandidates(host, options.parent),
  ]);
  const prior = priorReviews[0];
  const source: RepositorySource = {
    remoteUrl: host.repository.cloneUrl,
    token: host.token,
    base: subject.baseSha,
    head: subject.headSha,
    baseRef: subject.baseRef,
    headRef: subject.headRef,
    defaultBranch: host.repository.defaultBranch,
    defaultRef: host.repository.defaultSha,
    headRemoteUrl: subject.headCloneUrl,
    parentCandidates: parents.map(toParent),
    ...(options.parent
      ? { parent: explicitParent(options.parent, parents) }
      : {}),
    ...(prior
      ? {
          previousHeadSha: prior.state.headSha,
          previousBaseSha: prior.state.baseSha,
        }
      : {}),
  };
  const repository = await createRepositorySession(source, { config, signal });
  try {
    const review = await reviewChange({
      subject,
      repository,
      tools: createRepositoryTools(repository, config),
      model: createModelClient(config, {
        apiKey,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
      config,
      prompts,
      policies,
      priorReviews,
      checks: options.checks ?? [],
      signal,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    const markdown = formatReviewMarkdown(review, subject, config);
    const webhook = environment[config.slack.webhookEnv];
    const publication = await publishReview({
      client,
      subject,
      review,
      markdown,
      changedFiles: repository.files,
      priorReviews,
      config,
      publish: options.publish === true,
      signal,
      ...(options.requestedIssues !== undefined
        ? { requestedIssues: options.requestedIssues }
        : {}),
      ...(webhook ? { slackWebhook: webhook } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    return { review, markdown, publication };
  } finally {
    await repository.dispose();
  }
}

async function findParentCandidates(
  host: GitHubReviewHost,
  explicit?: string,
): Promise<GitHubPullRequest[]> {
  const open = await host.client.listPullRequests({ state: "open" });
  const parentRef = explicit ?? host.subject.baseRef;
  if (parentRef === host.repository.defaultBranch)
    return open.filter((pull) => pull.number !== host.subject.number);
  const closed = await host.client.listPullRequests({
    state: "closed",
    head: `${host.repository.owner}:${parentRef}`,
  });
  return [...open, ...closed].filter(
    (pull) =>
      pull.number !== host.subject.number &&
      (!pull.isFork || pull.headOwner === host.subject.headOwner),
  );
}

function toParent(pull: GitHubPullRequest) {
  return {
    ref: pull.headRef,
    sha: pull.headSha,
    pullRequest: pull.number,
    merged: pull.merged,
  };
}

function explicitParent(ref: string, parents: GitHubPullRequest[]) {
  const candidate = parents.find(
    (pull) => pull.headRef === ref || pull.headSha === ref,
  );
  return candidate
    ? toParent(candidate)
    : { ref, sha: ref, pullRequest: null, merged: false };
}
