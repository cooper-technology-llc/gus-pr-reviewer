// The report keeps findings, factual grades and verification limits independent of optional personality.
import { describe, expect, it } from "vitest";
import { configSchema } from "../config/config-schema.js";
import type {
  ReviewEvidence,
  ReviewModelCallUsage,
} from "../review/review-schema.js";
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

  it("collapses provider usage into one row per stage with retries and repeated tools counted", () => {
    const review = makeReview();
    review.usage = {
      inputTokens: 600,
      outputTokens: 90,
      costUsd: 0.06,
      requests: 4,
      toolCalls: 3,
      elapsedMs: 2000,
      models: ["example/model"],
      usageComplete: true,
      calls: [
        makeCall({ stage: "triage" }),
        makeCall({
          turn: 2,
          inputTokens: 200,
          outputTokens: 30,
          costUsd: 0.02,
          attempts: 2,
          elapsedMs: 1000,
          toolNames: ["read_file", "read_file"],
        }),
        makeCall({
          turn: 3,
          trigger: "tool-results",
          inputTokens: 300,
          outputTokens: 40,
          costUsd: 0.03,
          elapsedMs: 500,
          toolNames: ["search"],
        }),
      ],
    };

    const report = formatReviewMarkdown(review, makePullRequest(), testConfig);

    expect(report).toContain(
      "<details>\n<summary>Model usage by stage</summary>",
    );
    expect(report).toContain(
      "| Stage | Calls | Attempts | Tools | Input tokens | Output tokens | Cost | Time |",
    );
    expect(report).toContain(
      "| triage | 1 | 1 | 0 | 100 | 20 | $0.0100 | 0.25s |",
    );
    expect(report).toContain(
      "| investigate | 2 | 3 | 3 | 500 | 70 | $0.0500 | 1.50s |",
    );
    expect(report).toContain("</details>");
    expect(parseReviewState(report)?.headSha).toBe("head-sha");
    expect(readReportIdentity(report)).not.toBeNull();
  });

  it("marks stage totals unknown when a failed call has no provider accounting", () => {
    const review = makeReview();
    review.verdict = "incomplete";
    review.usage.usageComplete = false;
    review.usage.calls = [
      makeCall(),
      makeCall({
        turn: 2,
        trigger: "tool-results",
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        attempts: 2,
        elapsedMs: 1000,
        status: "failed",
      }),
    ];

    const report = formatReviewMarkdown(review, makePullRequest(), testConfig);

    expect(report).toContain(
      "| investigate | 2 | 3 | 0 | Unknown | Unknown | Unknown | 1.25s |",
    );
    expect(report).toContain("1 failed call");
    expect(report).not.toContain("$0.0000");
    expect(report).toContain("accounting is incomplete");
  });

  it("keeps the existing aggregate report for legacy usage without call records", () => {
    const review = makeReview();
    expect(review.usage.calls).toBeUndefined();

    const report = formatReviewMarkdown(review, makePullRequest(), testConfig);

    expect(report).toContain(
      "1 requests, 1 tool calls. 10 input / 5 output tokens.",
    );
    expect(report).not.toContain("Model usage by stage");
    expect(parseReviewState(report)?.headSha).toBe("head-sha");
    expect(readReportIdentity(report)).not.toBeNull();
  });
});

function makeCall(
  overrides: Partial<ReviewModelCallUsage> = {},
): ReviewModelCallUsage {
  return {
    stage: "investigate",
    model: "example/model",
    trigger: "initial",
    policyChars: 100,
    turn: 1,
    inputChars: 1000,
    systemChars: 200,
    seedChars: 500,
    toolResultChars: 0,
    toolDefinitionChars: 200,
    inputTokens: 100,
    outputTokens: 20,
    costUsd: 0.01,
    attempts: 1,
    elapsedMs: 250,
    status: "completed",
    toolNames: [],
    ...overrides,
  };
}
