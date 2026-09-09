import { minimatch } from "minimatch";
import type { ReviewInput } from "./review-ports.js";
import type { ReviewEvidence, ReviewResult } from "./review-schema.js";
import type { PriorFinding } from "./logic/adjudicate-review.js";
import { configuredRuleSignals } from "./logic/configured-rule-signals.js";

export function buildReviewSeed(
  input: ReviewInput,
  evidence: ReviewEvidence[],
  prior: PriorFinding[],
): string {
  return JSON.stringify({
    subject: input.subject,
    snapshot: input.repository.snapshot,
    branchAdvice: input.advisories ?? input.repository.snapshot.advisories,
    repositoryPolicies: input.policies,
    changedFiles: input.repository.files.map((file) => ({
      ...file,
      patch: file.excluded ? "" : file.patch,
    })),
    repositoryOmissions: input.repository.omissions,
    diffEvidence: evidence.map((entry) => ({
      id: entry.id,
      path: entry.path,
      revision: entry.revision,
      sha: entry.sha,
      startLine: entry.startLine,
      endLine: entry.endLine,
      kind: entry.kind,
      truncated: entry.truncated,
    })),
    priorFindingsToRevalidate: prior,
    priorReplies: input.priorReviews.flatMap((review) => review.replies),
    observedChecks: input.checks,
    reviewSettings: {
      blockingSeverity: input.config.review.blockingSeverity,
      scorecard: input.config.review.scorecard,
    },
    ...(input.config.rules.length === 0
      ? {}
      : {
          configuredRuleSignals: configuredRuleSignals(
            input.config.rules,
            input.repository.files,
            evidence,
          ),
          configuredRuleSignalPolicy:
            "Configured rules produce evidence-linked investigation signals or applicable policy, never automatic findings, grades, or verdict changes. Verify each concern with the repository evidence before confirming it. An incomplete text inspection cannot prove absence.",
        }),
  });
}

export function deterministicRisk(input: ReviewInput): ReviewResult["risk"] {
  if (input.repository.snapshot.integration.status === "conflict")
    return "high";
  if (
    input.repository.files.some((file) =>
      input.config.review.highRiskPaths.some((pattern) =>
        minimatch(file.path, pattern, { dot: true }),
      ),
    )
  )
    return "high";
  return input.repository.files.filter((file) => !file.excluded).length >= 25
    ? "medium"
    : "low";
}

export function highestRisk(
  ...risks: ReviewResult["risk"][]
): ReviewResult["risk"] {
  if (risks.includes("high")) return "high";
  if (risks.includes("medium")) return "medium";
  return "low";
}

export function changeSize(input: ReviewInput): ReviewResult["size"] {
  const lines = input.repository.files.reduce(
    (total, file) => total + file.additions + file.deletions,
    0,
  );
  if (lines < 10) return "XS";
  if (lines < 100) return "S";
  if (lines < 400) return "M";
  if (lines < 1000) return "L";
  return "XL";
}
