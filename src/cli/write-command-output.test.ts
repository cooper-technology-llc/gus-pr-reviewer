// The exit code says whether a review reached the PR; a reviewer's opinion never turns a published run red.
import { describe, expect, it } from "vitest";
import type {
  CompletedReview,
  PublicationResult,
} from "../review/review-ports.js";
import type { ReviewResult } from "../review/review-schema.js";
import { testSnapshot } from "../review/review-test-fixtures.js";
import { publicationExitCode, reviewExitCode } from "./write-command-output.js";

function completedReview(
  verdict: ReviewResult["verdict"],
  status: PublicationResult["status"],
): CompletedReview {
  return {
    markdown: "Gus review.",
    publication: {
      status,
      reviewUrl: null,
      reviewId: null,
      inlinePosted: 0,
      issues: [],
      threadsResolved: 0,
      slackSent: false,
      errors: [],
      notices: [],
    },
    review: {
      version: 1,
      snapshot: testSnapshot,
      verdict,
      summary: "Reviewed.",
      risk: "low",
      size: "S",
      findings: [],
      reconciliations: [],
      questions: [],
      architecture: null,
      tests: null,
      personality: "",
      coverage: [],
      coverageSummary: {
        status: "full",
        inspected: 0,
        partial: 0,
        unreviewed: 0,
        excluded: 0,
        notApplicable: 0,
      },
      evidence: [],
      checks: [],
      limitations: [],
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: null,
        requests: 0,
        toolCalls: 0,
        elapsedMs: 0,
        models: [],
      },
    },
  };
}

describe("reviewExitCode", () => {
  it.each([
    { verdict: "ready", status: "dry-run", expected: 0 },
    { verdict: "changes-requested", status: "dry-run", expected: 1 },
    { verdict: "incomplete", status: "dry-run", expected: 2 },
    { verdict: "ready", status: "published", expected: 0 },
    { verdict: "changes-requested", status: "published", expected: 0 },
    { verdict: "incomplete", status: "published", expected: 0 },
    { verdict: "changes-requested", status: "already-published", expected: 0 },
    { verdict: "ready", status: "partial", expected: 2 },
    { verdict: "changes-requested", status: "stale", expected: 2 },
  ] satisfies Array<{
    verdict: ReviewResult["verdict"];
    status: PublicationResult["status"];
    expected: number;
  }>)(
    "returns $expected for a $verdict review with $status publication",
    ({ verdict, status, expected }) => {
      expect(reviewExitCode(completedReview(verdict, status))).toBe(expected);
    },
  );
});

describe("publicationExitCode", () => {
  it("ignores notices and treats already-published as success", () => {
    const { publication } = completedReview("ready", "published");
    publication.notices = ["Check run skipped."];
    expect(publicationExitCode(publication)).toBe(0);
    expect(
      reviewExitCode({ ...completedReview("ready", "published"), publication }),
    ).toBe(0);
    publication.status = "already-published";
    expect(publicationExitCode(publication)).toBe(0);
    publication.errors = ["The review was not posted."];
    expect(publicationExitCode(publication)).toBe(2);
  });
});
