// Prior findings must be re-established at current revisions, including after rewrites and removed-line changes.
import { describe, expect, it } from "vitest";
import { reviewChange } from "./review-change.js";
import {
  answerStage,
  fileExecution,
  jsonCompletion,
  parentEvidence,
  reviewTestInput,
  testAnalysis,
  testFinding,
  toolCompletion,
} from "./review-test-fixtures.js";
import type { PriorReview } from "./review-schema.js";
import {
  priorFindingLedger,
  stableFindingId,
} from "./logic/adjudicate-review.js";

function priorReview(): PriorReview {
  return {
    id: 1,
    author: "gus",
    url: "https://example.test/review/1",
    submittedAt: "2026-01-01",
    replies: [],
    state: {
      version: 1,
      headSha: "old-head",
      baseSha: "old-base",
      comparisonBaseSha: "old-base",
      findings: [
        testFinding({ id: "old-finding", evidenceIds: ["old-proof"] }),
      ],
      reconciliations: [],
      verdict: "changes-requested",
    },
  };
}

describe("current review reconciliation", () => {
  it("does not copy old blockers when a history rewrite prevents revalidation", async () => {
    const input = reviewTestInput({ priorReviews: [priorReview()] });
    input.repository.snapshot = {
      ...input.repository.snapshot,
      historyRewritten: true,
    };
    const analysis = testAnalysis();
    analysis.reconciliations = [
      {
        id: "old-finding",
        status: "unverified",
        reason: "The current caller evidence is still missing.",
        evidenceIds: [],
      },
    ];
    input.model = {
      complete: async (request) => answerStage(request, analysis),
    };
    const result = await reviewChange(input);
    expect(result).toMatchObject({
      verdict: "incomplete",
      findings: [],
      architecture: null,
    });
    expect(result.reconciliations[0]?.status).toBe("unverified");
  });

  it("rejects prior resolution based only on a stale evidence identifier", async () => {
    const analysis = testAnalysis();
    analysis.reconciliations = [
      {
        id: "old-finding",
        status: "resolved",
        reason: "The old review said this was fixed.",
        evidenceIds: ["old-proof"],
      },
    ];
    const result = await reviewChange(
      reviewTestInput({
        priorReviews: [priorReview()],
        model: { complete: async (request) => answerStage(request, analysis) },
      }),
    );
    expect(result.verdict).toBe("incomplete");
    expect(result.reconciliations[0]?.status).toBe("unverified");
  });

  it("does not resurrect findings that a later review explicitly resolved", () => {
    const older = priorReview();
    const newer: PriorReview = {
      ...older,
      id: 2,
      submittedAt: "2026-01-02",
      state: {
        ...older.state,
        findings: [],
        reconciliations: [
          {
            id: "old-finding",
            status: "resolved",
            reason: "The caller now supplies the documented value.",
            evidenceIds: ["current-proof"],
          },
        ],
      },
    };
    expect(priorFindingLedger([older, newer])).toEqual([]);
  });

  it("requires prospective integration proof before blocking on a behind-target head", async () => {
    const input = reviewTestInput();
    input.repository.snapshot = {
      ...input.repository.snapshot,
      baseSha: "new-target",
    };
    input.model = {
      complete: async (request) =>
        answerStage(request, testAnalysis([testFinding()])),
    };
    expect(await reviewChange(input)).toMatchObject({
      verdict: "incomplete",
      findings: [],
    });
  });

  it("keeps a clean-looking assessment incomplete when required integration is unavailable", async () => {
    const input = reviewTestInput();
    input.repository.snapshot = {
      ...input.repository.snapshot,
      historyRewritten: true,
      integration: {
        ...input.repository.snapshot.integration,
        status: "unavailable",
        treeSha: null,
      },
    };
    expect(await reviewChange(input)).toMatchObject({
      verdict: "incomplete",
      architecture: null,
      tests: null,
    });
  });

  it("accepts removed-line evidence with fresh caller evidence proving the current consequence", async () => {
    const input = reviewTestInput();
    const analysis = testAnalysis([
      testFinding({
        side: "LEFT",
        evidenceIds: [parentEvidence().id, "caller-proof"],
      }),
    ]);
    let investigations = 0;
    input.model = {
      complete: async (request) => {
        if (request.stage === "investigate" && investigations++ === 0)
          return toolCompletion("caller", "read_file", "src/caller.ts");
        if (request.stage === "validate")
          return jsonCompletion({
            ...analysis,
            candidateResolutions: [
              {
                id: "candidate-1",
                status: "confirmed",
                reason:
                  "The current caller still depends on the removed behavior.",
                evidenceIds: ["caller-proof"],
              },
            ],
          });
        return answerStage(request, analysis);
      },
    };
    input.tools.execute = async () =>
      fileExecution("caller-proof", "src/caller.ts", "consume(value, 1);");
    const result = await reviewChange(input);
    expect(result.verdict).toBe("changes-requested");
    expect(result.findings[0]?.side).toBe("LEFT");
  });

  it("uses issue identity independent of line-number movement", () => {
    const finding = testFinding({ line: 1 });
    const moved = { ...finding, line: 80 };
    expect(stableFindingId(finding)).toBe(stableFindingId(moved));
  });
});
