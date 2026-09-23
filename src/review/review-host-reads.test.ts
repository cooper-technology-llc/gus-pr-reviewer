// The host owns coverage and evidence text: it pages truncated patches, re-reads cited ranges, and never lets either decide the verdict.
import { describe, expect, it } from "vitest";

import { configSchema } from "../config/config-schema.js";
import {
  attachFindingExcerpts,
  excerptRange,
} from "./host-repository-reads.js";
import { ReviewBudget } from "./review-budget.js";
import { reviewChange } from "./review-change.js";
import type { ToolExecution } from "./review-ports.js";
import type {
  ChangedFile,
  PriorReview,
  ReviewEvidence,
} from "./review-schema.js";
import type { ReviewEvidenceState } from "./structured-stage.js";
import {
  answerStage,
  fileExecution,
  headEvidence,
  reviewTestInput,
  testAnalysis,
  testFinding,
} from "./review-test-fixtures.js";

describe("host patch prefetch", () => {
  it("pages a truncated patch before triage without spending model tool calls", async () => {
    const input = reviewTestInput();
    input.repository.files = input.repository.files.map(markTruncated);
    const hostReads: unknown[] = [];
    input.tools.execute = async (name, argumentsValue) => {
      hostReads.push({ name, argumentsValue });
      return hostReads.length === 1
        ? diffPage(801, [])
        : diffPage(null, ["src/a.ts"]);
    };

    const result = await reviewChange(input);

    expect(hostReads).toEqual([
      {
        name: "read_diff",
        argumentsValue: { path: "src/a.ts", startLine: 1, lineCount: 800 },
      },
      {
        name: "read_diff",
        argumentsValue: { path: "src/a.ts", startLine: 801, lineCount: 800 },
      },
    ]);
    expect(result.coverage[0]?.status).toBe("inspected");
    expect(result.coverageSummary).toMatchObject({
      status: "full",
      inspected: 1,
    });
    expect(result.usage.toolCalls).toBe(0);
    expect(result.verdict).toBe("ready");
  });

  it("keeps an unfinished file partial as a fact, not a verdict or a limitation", async () => {
    const input = reviewTestInput();
    input.repository.files = input.repository.files.map(markTruncated);
    input.tools.execute = async () => diffPage(null, []);

    const result = await reviewChange(input);

    expect(result.verdict).toBe("ready");
    expect(result.coverage[0]?.status).toBe("partial");
    expect(result.coverageSummary).toMatchObject({
      status: "partial",
      partial: 1,
    });
    expect(result.limitations).toEqual([]);
  });

  it("skips binary and excluded files", async () => {
    const input = reviewTestInput();
    input.repository.files.push(
      { ...changedFile("docs/diagram.png"), binary: true, truncated: true },
      { ...changedFile("package-lock.json"), excluded: true, truncated: true },
    );
    let reads = 0;
    input.tools.execute = async () => {
      reads += 1;
      return diffPage(null, []);
    };

    await reviewChange(input);

    expect(reads).toBe(0);
  });
});

describe("not-applicable coverage", () => {
  it("marks a binary file not-applicable and keeps it out of limitations", async () => {
    const input = reviewTestInput();
    input.repository.files.push({
      ...changedFile("docs/diagram.png"),
      binary: true,
    });

    const result = await reviewChange(input);

    expect(result.verdict).toBe("ready");
    expect(
      result.coverage.find((entry) => entry.path === "docs/diagram.png")
        ?.status,
    ).toBe("not-applicable");
    expect(result.coverageSummary).toMatchObject({
      status: "full",
      inspected: 1,
      notApplicable: 1,
    });
    expect(result.limitations).toEqual([]);
  });

  it("marks a pure rename not-applicable", async () => {
    const input = reviewTestInput();
    input.repository.files.push({
      ...changedFile("src/renamed.ts"),
      previousPath: "src/original.ts",
      status: "renamed",
    });

    const result = await reviewChange(input);

    expect(
      result.coverage.find((entry) => entry.path === "src/renamed.ts")?.status,
    ).toBe("not-applicable");
    expect(result.coverageSummary.status).toBe("full");
  });
});

describe("finding excerpts", () => {
  it("attaches host re-read text for each cited evidence ID", async () => {
    const analysis = testAnalysis([testFinding()]);
    const input = reviewTestInput({
      model: { complete: async (request) => answerStage(request, analysis) },
    });
    const reads: unknown[] = [];
    input.tools.execute = async (name, argumentsValue) => {
      reads.push({ name, argumentsValue });
      return fileExecution("reread-1", "src/a.ts", "export const value = 2;  ");
    };

    const result = await reviewChange(input);

    expect(result.verdict).toBe("changes-requested");
    expect(reads).toEqual([
      {
        name: "read_file",
        argumentsValue: {
          path: "src/a.ts",
          revision: "head",
          startLine: 1,
          endLine: 1,
        },
      },
    ]);
    expect(result.findings[0]?.excerpts).toEqual([
      {
        evidenceId: headEvidence().id,
        path: "src/a.ts",
        revision: "head",
        sha: "head-1",
        startLine: 1,
        endLine: 1,
        text: "export const value = 2;",
      },
    ]);
    expect(result.usage.toolCalls).toBe(0);
  });

  it("attaches one excerpt when a diff record and a file record cite the same range", async () => {
    const input = reviewTestInput();
    input.tools.execute = async () =>
      fileExecution("reread", "src/a.ts", "export const value = 2;");
    const diffRecord = headEvidence();
    const fileRecord: ReviewEvidence = {
      ...diffRecord,
      id: "file:src/a.ts:1",
      kind: "file",
    };
    const state: ReviewEvidenceState = {
      evidence: new Map([
        [diffRecord.id, diffRecord],
        [fileRecord.id, fileRecord],
      ]),
      inspectedPaths: new Set(),
      limitations: [],
      notices: [],
    };
    const finding = testFinding({
      evidenceIds: [diffRecord.id, fileRecord.id],
    });

    await attachFindingExcerpts(
      [finding],
      input,
      new ReviewBudget(input.config, () => 0),
      state,
    );

    expect(finding.excerpts).toHaveLength(1);
    expect(finding.excerpts[0]?.evidenceId).toBe(diffRecord.id);
  });

  it("keeps the finding and verdict when a re-read fails", async () => {
    const analysis = testAnalysis([testFinding()]);
    const input = reviewTestInput({
      model: { complete: async (request) => answerStage(request, analysis) },
    });
    input.tools.execute = async () => {
      throw new Error("Repository unavailable.");
    };

    const result = await reviewChange(input);

    expect(result.verdict).toBe("changes-requested");
    expect(result.findings[0]?.excerpts).toEqual([]);
    expect(result.diagnostics).toContain(
      `Evidence ${headEvidence().id} could not be re-read for its excerpt; the finding keeps its evidence ID.`,
    );
  });

  it("centers a long cited range on the finding line in at most 12 lines", () => {
    const cited = { path: "src/a.ts", startLine: 1, endLine: 40 };
    expect(excerptRange(cited, { path: "src/a.ts", line: 20 })).toEqual({
      startLine: 15,
      endLine: 26,
    });
    expect(excerptRange(cited, { path: "src/a.ts", line: 39 })).toEqual({
      startLine: 29,
      endLine: 40,
    });
    expect(excerptRange(cited, { path: "src/other.ts", line: 3 })).toEqual({
      startLine: 16,
      endLine: 27,
    });
  });
});

describe("oversized changes", () => {
  it("skips a change over maxFiles with a short summary instead of throwing", async () => {
    let calls = 0;
    const input = reviewTestInput({
      config: configSchema.parse({
        review: { maxFiles: 1 },
        personality: { enabled: false },
      }),
      model: {
        complete: async (request) => {
          calls += 1;
          return answerStage(request);
        },
      },
    });
    input.repository.files.push(changedFile("src/b.ts"));

    const result = await reviewChange(input);

    expect(calls).toBe(0);
    expect(result).toMatchObject({
      verdict: "incomplete",
      summary:
        "Skipped: 2 changed files exceed maxFiles (1). Split the change or raise the limit, then rerun with @gus.",
      coverage: [],
      coverageSummary: {
        status: "partial",
        inspected: 0,
        partial: 0,
        unreviewed: 0,
        excluded: 0,
        notApplicable: 0,
      },
      limitations: [],
    });
  });

  it("skips reconciliation of more than 100 prior findings with a short summary", async () => {
    const priorReviews = [0, 1, 2].map((index) =>
      priorReviewWith(index, index === 2 ? 1 : 50),
    );

    const result = await reviewChange(reviewTestInput({ priorReviews }));

    expect(result.verdict).toBe("incomplete");
    expect(result.summary).toBe(
      "Skipped: 101 prior findings exceed the reconciliation limit (100). Resolve or dismiss earlier findings, then rerun with @gus.",
    );
    expect(result.coverage).toEqual([]);
  });
});

function markTruncated(file: ChangedFile): ChangedFile {
  return { ...file, truncated: true };
}

function changedFile(path: string): ChangedFile {
  return {
    path,
    previousPath: null,
    status: "added",
    additions: 0,
    deletions: 0,
    patch: "",
    binary: false,
    excluded: false,
    truncated: false,
  };
}

function diffPage(
  nextLine: number | null,
  inspectedPaths: string[],
): ToolExecution {
  return {
    content: JSON.stringify({ path: "src/a.ts", patch: "", nextLine }),
    evidence: [],
    inspectedPaths,
    warnings: [],
  };
}

function priorReviewWith(index: number, findingCount: number): PriorReview {
  return {
    id: index + 1,
    author: "gus",
    url: `https://example.test/review/${index + 1}`,
    submittedAt: `2026-01-0${index + 1}`,
    replies: [],
    state: {
      version: 1,
      headSha: "old-head",
      baseSha: "old-base",
      comparisonBaseSha: "old-base",
      findings: Array.from({ length: findingCount }, (_, findingIndex) =>
        testFinding({ id: `review-${index}-finding-${findingIndex}` }),
      ),
      reconciliations: [],
      verdict: "changes-requested",
    },
  };
}
