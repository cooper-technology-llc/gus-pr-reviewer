// The PR comment is short: verdict line, findings with evidence, summary, take, links, one hidden state comment.
import { describe, expect, it } from "vitest";
import { configSchema } from "../config/config-schema.js";
import type {
  ReviewCoverage,
  ReviewEvidence,
  ReviewFinding,
  ReviewResult,
} from "../review/review-schema.js";
import {
  makePullRequest,
  makeReview,
  testConfig,
} from "../github/github-test-fixtures.js";
import { formatReviewMarkdown } from "./format-review.js";
import { parseReviewState, readReportIdentity } from "./review-state.js";

const HIDDEN_COMMENT = /\n*<!-- gus-review:v1 [^>]*-->$/;

function visibleLength(report: string): number {
  return report.replace(HIDDEN_COMMENT, "").length;
}

function makeFinding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: "f1",
    title: "Persist widget updates before replying",
    severity: "major",
    path: "src/widgets/update-widget.ts",
    line: 42,
    side: "RIGHT",
    trigger: "A client updates a widget while another request is in flight.",
    impact: "The second write silently overwrites the first one.",
    suggestion:
      "Compare the stored version before writing and reject stale updates.",
    evidenceIds: ["e1"],
    disposition: "blocking",
    excerpts: [
      {
        evidenceId: "e1",
        path: "src/widgets/update-widget.ts",
        revision: "head",
        sha: "0123456789abcdef0123456789abcdef01234567",
        startLine: 40,
        endLine: 44,
        text: [
          "export async function updateWidget(id, patch) {",
          "  const widget = await store.read(id);",
          "  await store.write(id, { ...widget, ...patch });",
          "  return widget;",
          "}",
        ].join("\n"),
      },
    ],
    ...overrides,
  };
}

function twoFindingReview(): ReviewResult {
  const review = makeReview();
  review.verdict = "changes-requested";
  review.summary =
    "The change adds widget updates and a batch endpoint. Concurrent updates can lose data. The batch path skips validation.";
  review.findings = [
    makeFinding(),
    makeFinding({
      id: "f2",
      title: "Validate batch items like single updates",
      severity: "minor",
      path: "src/widgets/batch.ts",
      line: 17,
      trigger: "A batch request contains an item with a negative quantity.",
      impact: "Invalid widgets are stored.",
      suggestion: "Run the single-update validator on every batch item.",
      evidenceIds: ["e2"],
      disposition: "follow-up",
      excerpts: [
        {
          evidenceId: "e2",
          path: "src/widgets/batch.ts",
          revision: "head",
          sha: "0123456789abcdef0123456789abcdef01234567",
          startLine: 15,
          endLine: 18,
          text: "for (const item of items) {\n  await store.write(item.id, item);\n}\nreturn items.length;",
        },
      ],
    }),
  ];
  review.coverage = Array.from({ length: 63 }, (_, index): ReviewCoverage => ({
    path: `src/file-${index}.ts`,
    status: index < 61 ? "inspected" : "partial",
    reason: "Read changed behavior.",
  }));
  review.coverageSummary = {
    status: "partial",
    inspected: 61,
    partial: 2,
    unreviewed: 0,
    excluded: 0,
    notApplicable: 0,
  };
  review.limitations = [
    "The prospective integration has a conflict in src/widgets/batch.ts.",
    "The deadline stopped one search.",
  ];
  review.questions = ["Is the batch endpoint behind a flag?"];
  return review;
}

describe("review comment", () => {
  it("leads with the verdict line and lists findings before the summary and take", () => {
    const report = formatReviewMarkdown(
      twoFindingReview(),
      makePullRequest(),
      testConfig,
    );

    expect(
      report.startsWith(
        "**Gus · changes requested · 2 findings · coverage 61/63**",
      ),
    ).toBe(true);
    const firstFinding = report.indexOf("#### MAJOR · Persist widget updates");
    const secondFinding = report.indexOf("#### MINOR · Validate batch items");
    const summary = report.indexOf("The change adds widget updates");
    const take = report.indexOf("> A tidy home for widget updates.");
    expect(firstFinding).toBeGreaterThan(0);
    expect(secondFinding).toBeGreaterThan(firstFinding);
    expect(summary).toBeGreaterThan(secondFinding);
    expect(take).toBeGreaterThan(summary);
  });

  it("renders each finding with a head permalink, labeled lines and a collapsed evidence excerpt", () => {
    const report = formatReviewMarkdown(
      twoFindingReview(),
      makePullRequest(),
      testConfig,
    );

    expect(report).toContain(
      "[`src/widgets/update-widget.ts:42`](https://github.com/acme/widgets/blob/head-sha/src/widgets/update-widget.ts#L42) · blocking",
    );
    expect(report).toContain("**Trigger:** A client updates a widget");
    expect(report).toContain("**Impact:** The second write");
    expect(report).toContain("**Fix:** Compare the stored version");
    expect(report).toContain("<details><summary>Evidence (1)</summary>");
    expect(report).toContain(
      "[`src/widgets/update-widget.ts:40-44 @ 0123456`](https://github.com/acme/widgets/blob/0123456789abcdef0123456789abcdef01234567/src/widgets/update-widget.ts#L40-L44)",
    );
    expect(report).toContain(
      "```\nexport async function updateWidget(id, patch) {",
    );
  });

  it("keeps a two-finding review under 2,500 visible characters", () => {
    const report = formatReviewMarkdown(
      twoFindingReview(),
      makePullRequest(),
      testConfig,
      {
        checkRunUrl: "https://github.com/acme/widgets/runs/11",
        artifactUrl:
          "https://github.com/acme/widgets/actions/runs/99#artifacts",
      },
    );

    expect(visibleLength(report)).toBeLessThan(2_500);
  });

  it("drops verification, coverage lists, limitation lists, usage and boilerplate", () => {
    const review = twoFindingReview();
    review.checks = [
      {
        name: "unit",
        status: "failed",
        headSha: "head-sha",
        details: "The widget assertion failed.",
      },
    ];
    const report = formatReviewMarkdown(review, makePullRequest(), testConfig);

    expect(report).not.toContain("### Verification");
    expect(report).not.toContain("### Limitations");
    expect(report).not.toContain("### Scorecard");
    expect(report).not.toContain("src/file-62.ts");
    expect(report).not.toContain("unit: failed");
    expect(report).not.toContain("tool calls");
    expect(report).not.toContain("Model usage by stage");
    expect(report).not.toContain("No approval or merge-readiness");
    expect(report).not.toContain("Reviewed HEAD");
    expect(report).not.toContain("Comparison:");
  });

  it("keeps one-line coverage, limits and question notes", () => {
    const report = formatReviewMarkdown(
      twoFindingReview(),
      makePullRequest(),
      testConfig,
    );

    expect(report).toContain(
      "Coverage partial: 2 files not fully read (see details).",
    );
    expect(report).toContain(
      "Limits: The prospective integration has a conflict in src/widgets/batch.ts. and 1 more",
    );
    expect(report).toContain("1 open question (see details).");
  });

  it("omits the notes for full coverage without limitations", () => {
    const report = formatReviewMarkdown(
      makeReview(),
      makePullRequest(),
      testConfig,
    );

    expect(
      report.startsWith("**Gus · ready · 0 findings · coverage 1/1**"),
    ).toBe(true);
    expect(report).not.toContain("Coverage partial");
    expect(report).not.toContain("Limits:");
    expect(report).toContain("Widget updates preserve existing values.");
  });

  it("renders the links line only for the links that are known", () => {
    const review = makeReview();
    const none = formatReviewMarkdown(review, makePullRequest(), testConfig);
    const both = formatReviewMarkdown(review, makePullRequest(), testConfig, {
      checkRunUrl: "https://github.com/acme/widgets/runs/11",
      artifactUrl: "https://github.com/acme/widgets/actions/runs/99#artifacts",
    });
    const artifactOnly = formatReviewMarkdown(
      review,
      makePullRequest(),
      testConfig,
      {
        checkRunUrl: null,
        artifactUrl:
          "https://github.com/acme/widgets/actions/runs/99#artifacts",
      },
    );

    expect(none).not.toContain("[details]");
    expect(none).not.toContain("[evidence json]");
    expect(both).toContain(
      "[details](https://github.com/acme/widgets/runs/11) · [evidence json](https://github.com/acme/widgets/actions/runs/99#artifacts)",
    );
    expect(artifactOnly).not.toContain("[details]");
    expect(artifactOnly).toContain("[evidence json](");
  });

  it("carries exactly one hidden comment with state and an identity that ignores run links", () => {
    const review = twoFindingReview();
    const plain = formatReviewMarkdown(review, makePullRequest(), testConfig);
    const linked = formatReviewMarkdown(review, makePullRequest(), testConfig, {
      checkRunUrl: "https://github.com/acme/widgets/runs/11",
    });

    expect(plain.match(/<!--/g)).toHaveLength(1);
    expect(plain).not.toContain("gus-finding:v1");
    expect(parseReviewState(plain)?.headSha).toBe("head-sha");
    expect(parseReviewState(plain)?.findings[0]?.excerpts).toEqual([]);
    expect(readReportIdentity(plain)).not.toBeNull();
    expect(readReportIdentity(linked)).toBe(readReportIdentity(plain));
    expect(
      readReportIdentity(plain.replace("Concurrent updates", "Rare updates")),
    ).toBeNull();
    expect(plain).toBe(
      formatReviewMarkdown(review, makePullRequest(), testConfig),
    );
  });

  it("still reads the state of a review posted with the pre-0.1.8 separate comments", () => {
    const report = formatReviewMarkdown(
      makeReview(),
      makePullRequest(),
      testConfig,
    );
    const legacy = report.replace(
      / gus-report:v1 ([a-f0-9]{64}) -->/,
      " -->\n\n<!-- gus-report:v1 $1 -->",
    );

    expect(parseReviewState(legacy)?.headSha).toBe("head-sha");
    expect(readReportIdentity(legacy)).toBeNull();
  });

  it("keeps the take optional", () => {
    const review = makeReview();
    const disabled = formatReviewMarkdown(
      review,
      makePullRequest(),
      configSchema.parse({ personality: { enabled: false } }),
    );

    expect(disabled).not.toContain("A tidy home for widget updates.");
  });

  it("clips the summary to three sentences", () => {
    const review = makeReview();
    review.summary = "One. Two. Three. Four is too many.";
    const report = formatReviewMarkdown(review, makePullRequest(), testConfig);

    expect(report).toContain("One. Two. Three.");
    expect(report).not.toContain("Four is too many.");
  });

  it("falls back to cited evidence and never links prospective integration text", () => {
    const review = makeReview();
    const revisions: ReviewEvidence["revision"][] = ["head", "integration"];
    review.evidence = revisions.map((revision) => ({
      id: revision,
      path: "widget.ts",
      revision,
      sha: revision === "integration" ? "local-merge-tree" : `${revision}-sha`,
      startLine: 1,
      endLine: 2,
      text: "return value;\nreturn other;",
      kind: "file",
      truncated: false,
    }));
    review.findings = [
      makeFinding({
        path: "widget.ts",
        line: 1,
        evidenceIds: revisions,
        excerpts: [],
      }),
    ];

    const report = formatReviewMarkdown(review, makePullRequest(), testConfig);

    expect(report).toContain("<details><summary>Evidence (2)</summary>");
    expect(report).toContain(
      "[`widget.ts:1-2 @ head-sh`](https://github.com/acme/widgets/blob/head-sha/widget.ts#L1-L2)",
    );
    expect(report).toContain("`widget.ts:1-2 @ prospective integration`");
    expect(report).not.toContain("/blob/local-merge-tree/");
  });

  it("uses a fence that excerpt backticks cannot close", () => {
    const review = makeReview();
    review.findings = [
      makeFinding({
        excerpts: [
          {
            evidenceId: "e1",
            path: "docs/readme.md",
            revision: "head",
            sha: "head-sha",
            startLine: 1,
            endLine: 3,
            text: "```ts\nconst value = 1;\n```",
          },
        ],
      }),
    ];

    const report = formatReviewMarkdown(review, makePullRequest(), testConfig);

    expect(report).toContain("````\n```ts\nconst value = 1;\n```\n````");
  });
});
