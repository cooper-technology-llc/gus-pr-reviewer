import { z } from "zod";
import type { ReviewStage } from "../config/config-schema.js";

export const revisionSchema = z.enum(["head", "base", "parent", "integration"]);
export type Revision = z.infer<typeof revisionSchema>;
export const severitySchema = z.enum(["critical", "major", "minor"]);
export const riskSchema = z.enum(["low", "medium", "high"]);
export const branchAdviceSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  evidence: z.string().min(1),
  action: z.enum([
    "update-branch",
    "retarget",
    "resolve-conflicts",
    "inspect-stack",
    "none",
  ]),
});
export type BranchAdvice = z.infer<typeof branchAdviceSchema>;

export const snapshotSchema = z.strictObject({
  baseSha: z.string().min(1),
  headSha: z.string().min(1),
  mergeBaseSha: z.string().min(1),
  comparisonBaseSha: z.string().min(1),
  baseRef: z.string(),
  headRef: z.string(),
  defaultBranch: z.string(),
  defaultSha: z.string().nullable(),
  parent: z
    .strictObject({
      ref: z.string(),
      sha: z.string(),
      pullRequest: z.number().int().nullable(),
      merged: z.boolean(),
    })
    .nullable(),
  integration: z.strictObject({
    status: z.enum(["clean", "conflict", "unavailable"]),
    treeSha: z.string().nullable(),
    targetSha: z.string(),
    conflicts: z.array(z.string()),
    explanation: z.string(),
  }),
  historyRewritten: z.boolean(),
  baseChanged: z.boolean(),
  advisories: z.array(branchAdviceSchema),
});
export type ReviewSnapshot = z.infer<typeof snapshotSchema>;

export const changedFileSchema = z.strictObject({
  path: z.string(),
  previousPath: z.string().nullable(),
  status: z.enum([
    "added",
    "modified",
    "deleted",
    "renamed",
    "copied",
    "type-changed",
  ]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string(),
  binary: z.boolean(),
  excluded: z.boolean(),
  truncated: z.boolean(),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

export const evidenceSchema = z.strictObject({
  id: z.string().min(1),
  path: z.string(),
  revision: revisionSchema,
  sha: z.string(),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  text: z.string(),
  kind: z.enum(["file", "diff", "search", "history"]),
  truncated: z.boolean(),
});
export type ReviewEvidence = z.infer<typeof evidenceSchema>;

export const findingSchema = z.strictObject({
  id: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  severity: severitySchema,
  path: z.string().min(1),
  line: z.number().int().positive(),
  side: z.enum(["LEFT", "RIGHT"]).default("RIGHT"),
  trigger: z.string().min(1).max(4000),
  impact: z.string().min(1).max(4000),
  suggestion: z.string().min(1).max(4000),
  evidenceIds: z.array(z.string().min(1)).min(1).max(30),
  disposition: z.enum(["blocking", "follow-up"]).default("blocking"),
});
export type ReviewFinding = z.infer<typeof findingSchema>;

export const reconciliationSchema = z.strictObject({
  id: z.string().min(1),
  status: z.enum(["still-open", "resolved", "rejected", "unverified"]),
  reason: z.string().min(1).max(4000),
  evidenceIds: z.array(z.string()).default([]),
});
export type FindingReconciliation = z.infer<typeof reconciliationSchema>;

export const gradeSchema = z.strictObject({
  grade: z.enum(["A", "B", "C", "D", "F"]),
  reason: z.string().min(1),
});
export const adjudicationSchema = z.strictObject({
  summary: z.string().min(1).max(8000),
  risk: riskSchema,
  findings: z.array(findingSchema).max(50),
  reconciliations: z.array(reconciliationSchema).max(100),
  questions: z.array(z.string().min(1).max(2000)).max(30),
  architecture: gradeSchema.nullable().default(null),
  tests: gradeSchema.nullable().default(null),
});
export type ReviewAdjudication = z.infer<typeof adjudicationSchema>;

export const triageSchema = z.strictObject({
  summary: z.string().min(1),
  risk: riskSchema,
  questions: z.array(z.string()).max(30),
});

export const checkResultSchema = z.strictObject({
  name: z.string().min(1),
  status: z.enum(["passed", "failed", "not-run", "inconclusive"]),
  details: z.string().default(""),
  url: z.url().optional(),
  headSha: z.string().min(1),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

export const reviewStateSchema = z.strictObject({
  version: z.literal(1),
  headSha: z.string(),
  baseSha: z.string(),
  comparisonBaseSha: z.string(),
  findings: z.array(findingSchema).max(50),
  reconciliations: z.array(reconciliationSchema).max(100),
  verdict: z.enum(["ready", "changes-requested", "incomplete"]),
});
export type ReviewState = z.infer<typeof reviewStateSchema>;

export interface PriorReview {
  id: number;
  author: string;
  url: string;
  submittedAt: string;
  state: ReviewState;
  replies: Array<{
    findingId: string;
    author: string;
    body: string;
    resolved: boolean;
    threadId: string | null;
  }>;
}

export interface ReviewCoverage {
  path: string;
  status: "inspected" | "excluded" | "unreviewed" | "partial";
  reason: string;
}

export interface ReviewModelCallContext {
  stage: ReviewStage;
  model: string;
  trigger: "initial" | "tool-results" | "correction";
  policyChars: number;
}

export interface ReviewModelCallUsage extends ReviewModelCallContext {
  turn: number;
  inputChars: number;
  systemChars: number;
  seedChars: number;
  toolResultChars: number;
  toolDefinitionChars: number;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  attempts: number;
  elapsedMs: number;
  status: "completed" | "failed";
  toolNames: string[];
}

export interface ReviewUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  requests: number;
  toolCalls: number;
  elapsedMs: number;
  models: string[];
  usageComplete?: boolean;
  calls?: ReviewModelCallUsage[];
}

export interface ReviewResult {
  version: 1;
  snapshot: ReviewSnapshot;
  verdict: "ready" | "changes-requested" | "incomplete";
  summary: string;
  risk: z.infer<typeof riskSchema>;
  size: "XS" | "S" | "M" | "L" | "XL";
  findings: ReviewFinding[];
  reconciliations: FindingReconciliation[];
  questions: string[];
  architecture: z.infer<typeof gradeSchema> | null;
  tests: z.infer<typeof gradeSchema> | null;
  personality: string;
  coverage: ReviewCoverage[];
  evidence: ReviewEvidence[];
  checks: CheckResult[];
  limitations: string[];
  diagnostics?: string[];
  usage: ReviewUsage;
}
