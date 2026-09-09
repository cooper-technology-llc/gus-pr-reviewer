// Context references must preserve source bytes, metadata, and plain-text tool compatibility without sharing definitions across stages.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createReviewContext } from "./review-context.js";

const envelopeSchema = z.object({
  format: z.literal("gus-context-v1"),
  sourceTexts: z.array(z.object({ id: z.string(), text: z.string() })),
  payload: z.unknown(),
});

describe("stage source references", () => {
  it("preserves literal source and makes a new stage self-contained", () => {
    const text =
      'Read "quoted" | text.\n' +
      String.raw`Keep C:\new\file.ts and literal \n.`;
    const input = JSON.stringify({
      repositoryPolicies: [{ path: "policy.md", text }],
      changedFiles: [{ path: "policy.md", patch: text }],
    });
    const firstStage = createReviewContext();
    const first = envelopeSchema.parse(
      JSON.parse(firstStage.projectInput(input)),
    );
    const repeated = envelopeSchema.parse(
      JSON.parse(firstStage.projectInput(input)),
    );
    const next = envelopeSchema.parse(
      JSON.parse(createReviewContext().projectInput(input)),
    );
    expect(first.sourceTexts).toEqual([{ id: expect.any(String), text }]);
    expect(repeated.sourceTexts).toEqual([]);
    expect(next.sourceTexts).toEqual(first.sourceTexts);
    expect(next.payload).toEqual(first.payload);
    expect(JSON.parse(input)).toMatchObject({
      repositoryPolicies: [{ text }],
      changedFiles: [{ patch: text }],
    });
  });

  it("keeps non-JSON tool messages and all inspection notices readable", () => {
    const projected = createReviewContext().projectTool({
      content: "The requested source could not be read.",
      evidence: [],
      inspectedPaths: [],
      warnings: ["Missing source remains unreviewed."],
    });
    expect(JSON.parse(projected)).toEqual({
      format: "gus-context-v1",
      sourceTexts: [],
      payload: "The requested source could not be read.",
      evidence: [],
      inspectedPaths: [],
      warnings: ["Missing source remains unreviewed."],
    });
  });

  it("does not equate overlapping pages or alter non-source strings", () => {
    const context = createReviewContext();
    const first = envelopeSchema.parse(
      JSON.parse(
        context.projectInput(
          JSON.stringify({ text: "first\nsecond", reason: "first\nsecond" }),
        ),
      ),
    );
    const second = envelopeSchema.parse(
      JSON.parse(
        context.projectInput(JSON.stringify({ text: "second\nthird" })),
      ),
    );
    expect(first.sourceTexts.map((entry) => entry.text)).toEqual([
      "first\nsecond",
    ]);
    expect(second.sourceTexts.map((entry) => entry.text)).toEqual([
      "second\nthird",
    ]);
    expect(second.sourceTexts[0]?.id).not.toBe(first.sourceTexts[0]?.id);
    expect(first.payload).toMatchObject({ reason: "first\nsecond" });
  });
});
