// Inline anchors must be present in the correct diff side; report findings survive any inline omission.
import { describe, expect, it } from "vitest";
import { formatReviewMarkdown } from "../reporting/format-review.js";
import type {
  ChangedFile,
  ReviewEvidence,
  ReviewResult,
} from "../review/review-schema.js";
import { commentableLines, selectInlineComments } from "./inline-comments.js";
import {
  makePullRequest,
  makeReview,
  testConfig,
} from "./github-test-fixtures.js";

const changedFile: ChangedFile = {
  path: "widget.ts",
  previousPath: null,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1,2 +1,2 @@\n-old\n+new\n context\n",
  binary: false,
  excluded: false,
  truncated: false,
};

function reviewWithFinding(line = 1): ReviewResult {
  const review = makeReview();
  review.findings = [
    {
      id: "f1",
      title: "Retain widget values",
      severity: "major",
      path: "widget.ts",
      line,
      side: "RIGHT",
      trigger: "A widget is updated.",
      impact: "Its existing value is lost.",
      suggestion: "Preserve the existing value.",
      evidenceIds: ["e1"],
      disposition: "blocking",
    },
  ];
  return review;
}

const invalidHeadEvidence: Array<{
  name: string;
  overrides: Partial<ReviewEvidence>;
}> = [
  { name: "prospective integration", overrides: { revision: "integration" } },
  { name: "a different SHA", overrides: { sha: "other-head" } },
  { name: "a different path", overrides: { path: "other.ts" } },
  { name: "an uncited record", overrides: { id: "uncited" } },
  { name: "history output", overrides: { kind: "history" } },
  { name: "a non-HEAD revision", overrides: { revision: "base" } },
  { name: "a later line range", overrides: { startLine: 2, endLine: 3 } },
];

describe("inline diff anchors", () => {
  it("distinguishes removed, added and context lines without inventing trailing anchors", () => {
    const lines = commentableLines("@@ -4,2 +4,2 @@\n-old\n+new\n context\n");
    expect([...lines]).toEqual(["LEFT:4", "RIGHT:4", "LEFT:5", "RIGHT:5"]);
  });
  it("suppresses inline placement when stacked comparison differs from GitHub's diff", () => {
    const review = makeReview();
    review.snapshot.comparisonBaseSha = "parent-sha";
    expect(
      selectInlineComments(review, makePullRequest(), [], testConfig),
    ).toEqual([]);
  });
  it.each(invalidHeadEvidence)(
    "keeps findings supported only by $name in the report without a RIGHT inline",
    ({ overrides }) => {
      const review = reviewWithFinding();
      review.evidence = review.evidence.map((evidence) => ({
        ...evidence,
        ...overrides,
      }));

      expect(
        selectInlineComments(
          review,
          makePullRequest(),
          [changedFile],
          testConfig,
        ),
      ).toEqual([]);
      expect(
        formatReviewMarkdown(review, makePullRequest(), testConfig),
      ).toContain("Retain widget values");
    },
  );
  it.each([1, 2])(
    "accepts cited HEAD evidence at inclusive range boundary %s",
    (line) => {
      const review = reviewWithFinding(line);
      review.evidence = review.evidence.map((evidence) => ({
        ...evidence,
        startLine: 1,
        endLine: 2,
      }));

      expect(
        selectInlineComments(
          review,
          makePullRequest(),
          [changedFile],
          testConfig,
        ),
      ).toMatchObject([{ path: "widget.ts", line, side: "RIGHT" }]);
    },
  );
  it("preserves LEFT placement under the existing baseline and coordinate guard", () => {
    const review = reviewWithFinding();
    review.findings = review.findings.map((finding) => ({
      ...finding,
      side: "LEFT",
    }));
    review.evidence = review.evidence.map((evidence) => ({
      ...evidence,
      revision: "base",
      sha: review.snapshot.baseSha,
    }));

    expect(
      selectInlineComments(
        review,
        makePullRequest(),
        [changedFile],
        testConfig,
      ),
    ).toMatchObject([{ path: "widget.ts", line: 1, side: "LEFT" }]);
  });
});
