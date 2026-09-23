import type { GusConfig } from "../config/config-schema.js";
import {
  formatCheckRunOutput,
  type CheckRunOutput,
} from "../reporting/format-check-run.js";
import type { ReviewResult } from "../review/review-schema.js";
import type { GitHubCheckRunInput, GitHubClient } from "./github-port.js";
import { GitHubRequestError } from "./github-request.js";

export const GUS_CHECK_RUN_NAME = "Gus review";

type RunEnvironment = Record<string, string | undefined>;

/** success = ready, failure = changes requested, neutral = incomplete or ready on partial coverage. */
export function checkRunConclusion(
  review: ReviewResult,
): GitHubCheckRunInput["conclusion"] {
  if (review.verdict === "changes-requested") return "failure";
  if (review.verdict === "incomplete") return "neutral";
  return review.coverageSummary.status === "partial" ? "neutral" : "success";
}

/** The Actions run page, when the review runs inside GitHub Actions. */
export function workflowRunUrl(environment: RunEnvironment): string | null {
  const server = environment["GITHUB_SERVER_URL"];
  const repository = environment["GITHUB_REPOSITORY"];
  const runId = environment["GITHUB_RUN_ID"];
  if (!server || !repository || !runId) return null;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return null;
  if (!/^\d+$/.test(runId)) return null;
  try {
    const origin = new URL(server);
    if (origin.protocol !== "https:" || origin.username || origin.password)
      return null;
    return `${origin.origin}/${repository}/actions/runs/${runId}`;
  } catch {
    return null;
  }
}

/** The artifacts section of the run page; the artifact's own ID is not known until after upload. */
export function evidenceArtifactUrl(
  environment: RunEnvironment,
): string | null {
  const run = workflowRunUrl(environment);
  return run ? `${run}#artifacts` : null;
}

export interface CreateReviewCheckRunInput {
  client: GitHubClient;
  review: ReviewResult;
  headSha: string;
  config: GusConfig;
  environment: RunEnvironment;
  /** Publication notices already known when the Check Run is created. */
  notices?: string[];
}

export type CheckRunOutcome =
  { status: "created"; url: string } | { status: "skipped"; notice: string };

/**
 * Creates the completed `Gus review` Check Run. Never throws: a missing `checks: write`
 * permission or any other API failure becomes a notice and the review is still posted.
 */
export async function createReviewCheckRun(
  input: CreateReviewCheckRunInput,
): Promise<CheckRunOutcome> {
  const detailsUrl = workflowRunUrl(input.environment);
  const output: CheckRunOutput = formatCheckRunOutput(
    input.review,
    { artifactUrl: evidenceArtifactUrl(input.environment) },
    input.config.name,
    input.notices ?? [],
  );
  try {
    const checkRun = await input.client.createCheckRun({
      name: GUS_CHECK_RUN_NAME,
      headSha: input.headSha,
      conclusion: checkRunConclusion(input.review),
      ...(detailsUrl ? { detailsUrl } : {}),
      output,
    });
    return { status: "created", url: checkRun.url };
  } catch (error) {
    return { status: "skipped", notice: checkRunNotice(error) };
  }
}

function checkRunNotice(error: unknown): string {
  if (
    error instanceof GitHubRequestError &&
    (error.status === 403 || error.status === 404)
  )
    return "Check run skipped: the token lacks `checks: write`; the review was still posted.";
  return "Check run could not be created; the review was still posted.";
}
