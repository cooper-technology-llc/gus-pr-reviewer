import { z } from "zod";
import {
  adjudicationSchema,
  findingSchema,
  gradeSchema,
  reconciliationSchema,
  riskSchema,
} from "./review-schema.js";

export const stageTriageSchema = z.strictObject({
  summary: z.string().min(1).max(8000),
  risk: riskSchema,
  questions: z.array(z.string().min(1).max(2000)).max(30),
});

export const coverageClaimSchema = z.strictObject({
  path: z.string().min(1),
  status: z.enum(["inspected", "partial", "unreviewed"]),
  evidenceIds: z.array(z.string().min(1)).max(100),
  reason: z.string().min(1).max(2000),
});
export type CoverageClaim = z.infer<typeof coverageClaimSchema>;

export const analysisSchema = adjudicationSchema.extend({
  findings: z
    .array(
      findingSchema.extend({
        side: z.enum(["LEFT", "RIGHT"]),
        disposition: z.enum(["blocking", "follow-up"]),
      }),
    )
    .max(50),
  reconciliations: z
    .array(
      reconciliationSchema.extend({
        evidenceIds: z.array(z.string().min(1)).max(100),
      }),
    )
    .max(100),
  architecture: gradeSchema.nullable(),
  tests: gradeSchema.nullable(),
  coverage: z.array(coverageClaimSchema).max(10000),
});
export type Analysis = z.infer<typeof analysisSchema>;

export const validationSchema = analysisSchema.extend({
  candidateResolutions: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        status: z.enum(["confirmed", "rejected", "unverified"]),
        reason: z.string().min(1).max(4000),
        evidenceIds: z.array(z.string().min(1)).max(100),
      }),
    )
    .max(50),
});
export type Validation = z.infer<typeof validationSchema>;

export const reportNarrativeSchema = z.strictObject({
  summary: z.string().min(1).max(8000),
});

export function personalityOutputSchema(maxChars: number) {
  return z.strictObject({ text: z.string().min(1).max(maxChars) });
}
