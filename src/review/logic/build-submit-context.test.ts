// Compact submissions preserve whole records and resolve source references across discarded turns.
import { describe, expect, it } from "vitest";
import {
  buildCompactSubmitContent,
  conversationHasToolResults,
} from "./build-submit-context.js";

describe("buildCompactSubmitContent", () => {
  it("rebuilds a capped submit payload from seed and investigation notes", () => {
    const content = buildCompactSubmitContent(
      "SEED_PATCH",
      [
        { role: "assistant", content: "Need the caller.", toolCalls: [] },
        { role: "tool", content: "Tool result: caller uses the export." },
      ],
      { maxSubmitContextChars: 180000, maxSubmitSeedChars: 100000 },
    );
    expect(content).toContain("Compact submit");
    expect(content).toContain("SEED_PATCH");
    expect(content).toContain("Need the caller.");
    expect(content).toContain("caller uses the export.");
  });

  it("omits oversized sections explicitly without slicing JSON or tool records", () => {
    const content = buildCompactSubmitContent(
      "S".repeat(400),
      [{ role: "tool", content: "T".repeat(400) }],
      { maxSubmitContextChars: 220, maxSubmitSeedChars: 80 },
    );
    expect(content.length).toBeLessThanOrEqual(220);
    expect(() => JSON.parse(content)).not.toThrow();
    expect(content).toContain("omittedSections");
    expect(content).not.toContain("SSSS");
    expect(content).not.toContain("TTTT");
    expect(conversationHasToolResults([{ role: "tool", content: "ok" }])).toBe(
      true,
    );
    expect(conversationHasToolResults([{ role: "user", content: "ok" }])).toBe(
      false,
    );
  });

  it("preserves complete candidate and prior records when bulky source sections do not fit", () => {
    const candidate = { id: "candidate-42", evidenceIds: ["evidence-42"] };
    const prior = { id: "prior-7", evidenceIds: ["evidence-7"] };
    const content = buildCompactSubmitContent(
      JSON.stringify({
        reviewInput: { files: [{ patch: "P".repeat(8000) }], prior: [prior] },
        candidateAssessment: { findings: [candidate] },
      }),
      [],
      { maxSubmitContextChars: 2000, maxSubmitSeedChars: 1200 },
    );
    expect(() => JSON.parse(content)).not.toThrow();
    expect(content).toContain(JSON.stringify(candidate));
    expect(content).toContain(JSON.stringify(prior));
    expect(content).toContain("reviewInput.files");
    expect(content).not.toContain("PPPP");
    expect(content.length).toBeLessThanOrEqual(2000);
  });

  it("carries a tool's exact source when its reference was defined in an earlier discarded message", () => {
    const content = buildCompactSubmitContent(
      "seed",
      [
        {
          role: "user",
          content: JSON.stringify({
            format: "gus-context-v1",
            sourceTexts: [{ id: "source-1", text: "exact caller source" }],
            payload: {},
          }),
        },
        {
          role: "tool",
          content: JSON.stringify({
            format: "gus-context-v1",
            sourceTexts: [],
            evidence: [{ id: "caller", text: { textRef: "source-1" } }],
          }),
        },
      ],
      { maxSubmitContextChars: 2000, maxSubmitSeedChars: 1000 },
    );
    expect(content).toContain("exact caller source");
    expect(content).not.toContain('"textRef"');
  });
});
