// The Check Run page carries everything the short comment drops, within GitHub's output limits.
import { describe, expect, it } from "vitest";
import type {
  ReviewCoverage,
  ReviewFinding,
  ReviewModelCallUsage,
} from "../review/review-schema.js";
import { makeReview } from "../github/github-test-fixtures.js";
import {
  CHECK_RUN_ANNOTATION_LIMIT,
  CHECK_RUN_TEXT_LIMIT,
  formatCheckRunOutput,
} from "./format-check-run.js";

function finding(
  index: number,
  overrides: Partial<ReviewFinding> = {},
): ReviewFinding {
  return {
    id: `f${index}`,
    title: `Finding ${index}`,
    severity: "major",
    path: "widget.ts",
    line: index,
    side: "RIGHT",
    trigger: "An input arrives.",
    impact: "A value is lost.",
    suggestion: "Keep the value.",
    evidenceIds: ["e1"],
    disposition: "blocking",
    excerpts: [],
    ...overrides,
  };
}

const call: ReviewModelCallUsage = {
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
  toolNames: ["read_file"],
};

describe("check run output", () => {
  it("returns title, summary, long-form text and annotations", () => {
    const review = makeReview();
    review.verdict = "changes-requested";
    review.findings = [finding(1)];
    review.limitations = ["The deadline stopped one search."];
    review.diagnostics = ["A search skipped a binary attachment."];
    review.questions = ["Is the endpoint behind a flag?"];
    review.reconciliations = [
      {
        id: "old-1",
        status: "resolved",
        reason: "The guard now exists.",
        evidenceIds: ["e1"],
      },
    ];
    review.snapshot.advisories = [
      {
        code: "conflict",
        message: "Resolve the target conflict.",
        evidence: "widget.ts conflicts.",
        action: "resolve-conflicts",
      },
    ];
    review.coverage.push({
      path: "docs/big.md",
      status: "partial",
      reason: "Only the first page was read.",
    });
    review.checks = [
      {
        name: "unit",
        status: "passed",
        headSha: "old-head-sha",
        details: "Ran on the previous head.",
      },
    ];
    review.usage.calls = [call];

    const output = formatCheckRunOutput(review, {
      artifactUrl: "https://github.com/acme/widgets/actions/runs/9#artifacts",
    });

    expect(output.title).toBe(
      "Gus · changes requested · 1 finding · coverage 1/1",
    );
    expect(output.summary).toContain(
      "Widget updates preserve existing values.",
    );
    expect(output.summary).toContain(
      "[Evidence JSON](https://github.com/acme/widgets/actions/runs/9#artifacts)",
    );
    for (const heading of [
      "## Verdict",
      "## Findings",
      "## Coverage",
      "## Verification",
      "## Limitations",
      "## Diagnostics",
      "## Open questions",
      "## Previous findings",
      "## Branch advice",
      "## Usage",
    ])
      expect(output.text).toContain(heading);
    expect(output.text).toContain("- Head: `head-sha`");
    expect(output.text).toContain("| `docs/big.md` | partial |");
    expect(output.text).toContain(
      "<details><summary>1 inspected files</summary>",
    );
    expect(output.text).toContain("inconclusive (ran on `old-hea`)");
    expect(output.text).toContain("Model usage by stage");
    expect(output.annotations).toEqual([
      {
        path: "widget.ts",
        start_line: 1,
        end_line: 1,
        annotation_level: "failure",
        title: "MAJOR · Finding 1",
        message:
          "An input arrives.\n\nImpact: A value is lost.\n\nFix: Keep the value.",
      },
    ]);
  });

  it("uses warning for minor findings and skips base-side lines", () => {
    const review = makeReview();
    review.findings = [
      finding(1, { severity: "minor" }),
      finding(2, { severity: "critical" }),
      finding(3, { side: "LEFT" }),
    ];

    const levels = formatCheckRunOutput(review).annotations.map(
      (annotation) => [annotation.start_line, annotation.annotation_level],
    );

    expect(levels).toEqual([
      [1, "warning"],
      [2, "failure"],
    ]);
  });

  it("renders publication notices under diagnostics", () => {
    const review = makeReview();
    review.diagnostics = ["A search skipped a binary attachment."];

    const { text } = formatCheckRunOutput(review, {}, "Gus", [
      "An earlier notice.",
    ]);

    expect(text).toContain(
      "## Diagnostics\n\n- A search skipped a binary attachment.\n- An earlier notice.",
    );
  });

  it("caps annotations at 50", () => {
    const review = makeReview();
    review.findings = Array.from({ length: 60 }, (_, index) =>
      finding(index + 1),
    );

    expect(formatCheckRunOutput(review).annotations).toHaveLength(
      CHECK_RUN_ANNOTATION_LIMIT,
    );
  });

  it("clips the text to 65,000 characters with a visible marker", () => {
    const review = makeReview();
    review.coverage = Array.from(
      { length: 3_000 },
      (_, index): ReviewCoverage => ({
        path: `src/generated/very/long/path/to/file-number-${index}.ts`,
        status: "unreviewed",
        reason:
          "The file was not read before the deadline expired for this run.",
      }),
    );

    const { text } = formatCheckRunOutput(review);

    expect(text.length).toBeLessThanOrEqual(CHECK_RUN_TEXT_LIMIT);
    expect(text).toMatch(
      /… \[truncated \d+ chars; see the evidence JSON artifact\]$/,
    );
  });
});
