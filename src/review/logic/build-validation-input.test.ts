// Validation keeps complete supporting source and discovery metadata without replaying every inspected byte.
import { describe, expect, it } from "vitest";
import { buildValidationInput } from "./build-validation-input.js";
import {
  headEvidence,
  testAnalysis,
  testFinding,
} from "../review-test-fixtures.js";

describe("buildValidationInput", () => {
  it("preserves the review manifest and indexes evidence without replaying source", () => {
    const cited = {
      ...headEvidence(),
      id: "late-caller-evidence",
      kind: "file" as const,
      text: `${"caller context\n".repeat(1000)}DECISIVE_CALLER_CONTRACT`,
    };
    const unrelated = {
      ...headEvidence(),
      id: "unrelated-source",
      kind: "file" as const,
      text: "UNRELATED_SOURCE_TEXT",
    };
    const result = buildValidationInput({
      reviewSource: {
        changedFiles: [
          { path: "src/a.ts", truncated: true, patch: "UNRELATED_PATCH" },
        ],
        priorFindingsToRevalidate: [{ id: "prior-finding-42" }],
        observedChecks: [{ headSha: "head-1", status: "passed" }],
        repositoryPolicies: [{ text: "Preserve tenant isolation." }],
      },
      triage: { summary: "Inspect the unchanged caller." },
      candidateAssessment: testAnalysis([
        testFinding({ evidenceIds: [cited.id] }),
      ]),
      evidence: [cited, unrelated],
      blockingSeverity: "major",
    });

    expect(result).not.toContain("DECISIVE_CALLER_CONTRACT");
    expect(result).toContain(cited.id);
    expect(result).toContain("prior-finding-42");
    expect(result).toContain("Preserve tenant isolation.");
    expect(result).toContain('"status":"passed"');
    expect(result).toContain('"truncated":true');
    expect(result).toContain("unrelated-source");
    expect(result).not.toContain("UNRELATED_PATCH");
    expect(result).not.toContain("UNRELATED_SOURCE_TEXT");
  });

  it("identifies evidence cited only by reconciliation or coverage for reinspection", () => {
    const analysis = testAnalysis();
    analysis.reconciliations.push({
      id: "prior-1",
      status: "resolved",
      reason: "The unchanged caller now accepts this value.",
      evidenceIds: ["reconciliation-source"],
    });
    const evidence = [
      {
        ...headEvidence(),
        kind: "file" as const,
        text: "FULL_COVERAGE_SOURCE",
      },
      {
        ...headEvidence(),
        id: "reconciliation-source",
        kind: "file" as const,
        text: "FULL_RECONCILIATION_SOURCE",
      },
    ];

    const result = buildValidationInput({
      reviewSource: {},
      triage: {},
      candidateAssessment: analysis,
      evidence,
      blockingSeverity: "major",
    });

    expect(result).not.toContain("FULL_COVERAGE_SOURCE");
    expect(result).not.toContain("FULL_RECONCILIATION_SOURCE");
    expect(result).toContain(headEvidence().id);
    expect(result).toContain("reconciliation-source");
  });

  it("defers every cited source for independent validation without replaying a large seed", () => {
    const result = buildValidationInput({
      reviewSource: {},
      triage: {},
      candidateAssessment: testAnalysis(),
      evidence: [
        { ...headEvidence(), text: "CITED_SEED_SOURCE" },
        {
          ...headEvidence(),
          id: "possible-future-citation",
          kind: "file",
          text: "POSSIBLE_FUTURE_SOURCE",
        },
      ],
      blockingSeverity: "major",
    });

    expect(result).not.toContain("CITED_SEED_SOURCE");
    expect(result).toContain(headEvidence().id);
    expect(result).not.toContain("POSSIBLE_FUTURE_SOURCE");
  });
});
