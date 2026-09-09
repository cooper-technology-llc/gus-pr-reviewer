// The report keeps findings, factual grades and verification limits independent of optional personality.
import { describe, expect, it } from "vitest";
import { configSchema } from "../config/config-schema.js";
import type { ReviewEvidence } from "../review/review-schema.js";
import {
  makePullRequest,
  makeReview,
  testConfig,
} from "../github/github-test-fixtures.js";
import { formatReviewMarkdown } from "./format-review.js";
import { parseReviewState, readReportIdentity } from "./review-state.js";

describe("review report", () => {
  it("round-trips hidden state and detects changed report content", () => {
    const review = makeReview();
    const report = formatReviewMarkdown(review, makePullRequest(), testConfig);
    expect(parseReviewState(report)?.headSha).toBe("head-sha");
    expect(readReportIdentity(report)).not.toBeNull();
    expect(
      readReportIdentity(
        report.replace("Widget updates preserve", "Widget updates discard"),
      ),
    ).toBeNull();
    expect(report).toBe(
      formatReviewMarkdown(review, makePullRequest(), testConfig),
    );
  });
  it("keeps persona optional without changing factual grades", () => {
    const review = makeReview();
    const enabled = formatReviewMarkdown(review, makePullRequest(), testConfig);
    const disabled = formatReviewMarkdown(
      review,
      makePullRequest(),
      configSchema.parse({ personality: { enabled: false } }),
    );
    expect(enabled).toContain("A tidy home for widget updates.");
    expect(disabled).not.toContain("A tidy home for widget updates.");
    expect(disabled).toContain("| S | A | B | low |");
    expect(disabled).toContain("No executed check results");
  });
  it("does not show a scorecard for incomplete reviews or describe missing cost as free", () => {
    const review = makeReview();
    review.verdict = "incomplete";
    review.usage.usageComplete = false;
    const report = formatReviewMarkdown(review, makePullRequest(), testConfig);
    expect(report).not.toContain("### Scorecard");
    expect(report).toContain("Review incomplete");
    expect(report).toContain("Cost unavailable");
    expect(report).toContain("accounting is incomplete");
  });
  it("labels prospective integration evidence without fabricating a remote blob link", () => {
    const review = makeReview();
    const revisions: ReviewEvidence["revision"][] = [
      "head",
      "base",
      "parent",
      "integration",
    ];
    review.evidence = revisions.map((revision) => ({
      id: revision,
      path: "widget.ts",
      revision,
      sha: revision === "integration" ? "local-merge-tree" : `${revision}-sha`,
      startLine: 1,
      endLine: 2,
      text: "return value;",
      kind: "file",
      truncated: false,
    }));
    review.findings = [
      {
        id: "f1",
        title: "Retain widget values after integration",
        severity: "major",
        path: "widget.ts",
        line: 1,
        side: "RIGHT",
        trigger: "The updated branches are combined.",
        impact: "Existing widget values are lost.",
        suggestion: "Preserve the existing values.",
        evidenceIds: revisions,
        disposition: "blocking",
      },
    ];

    const report = formatReviewMarkdown(review, makePullRequest(), testConfig);

    expect(report).toContain("Retain widget values after integration");
    expect(report).toContain(
      "`integration` (prospective integration, `widget.ts:1-2`)",
    );
    expect(report).not.toContain("/blob/local-merge-tree/");
    for (const revision of ["head", "base", "parent"]) {
      expect(report).toContain(
        `[${revision}](https://github.com/acme/widgets/blob/${revision}-sha/widget.ts#L1)`,
      );
    }
  });
});
