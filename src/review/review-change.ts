import { Buffer } from "node:buffer";
import { GusError } from "../errors.js";
import {
  buildCoverage,
  isBlocking,
  needsIntegrationEvidence,
  normalizeFindingIds,
  priorFindingLedger,
  summarizeCoverage,
  unverifiedPriorFindings,
  validateAnalysisEvidence,
  validateCandidateResolutions,
} from "./logic/adjudicate-review.js";
import { addEvidence, seedDiffEvidence } from "./logic/review-evidence.js";
import { buildValidationInput } from "./logic/build-validation-input.js";
import {
  attachFindingExcerpts,
  prefetchTruncatedPatches,
} from "./host-repository-reads.js";
import { ReviewBudget } from "./review-budget.js";
import type { ReviewInput } from "./review-ports.js";
import type { ReviewResult } from "./review-schema.js";
import {
  buildReviewSeed,
  changeSize,
  deterministicRisk,
  highestRisk,
} from "./review-seed.js";
import {
  type Analysis,
  analysisSchema,
  personalityOutputSchema,
  reportNarrativeSchema,
  stageTriageSchema,
  validationSchema,
} from "./stage-schemas.js";
import {
  type ReviewEvidenceState,
  runStructuredStage,
} from "./structured-stage.js";

/** Reviews a pinned change through evidence collection, validation, reporting, and optional voice. */
export async function reviewChange(input: ReviewInput): Promise<ReviewResult> {
  const budget = new ReviewBudget(
    input.config,
    input.now ?? Date.now,
    input.signal,
  );
  const prior = priorFindingLedger(input.priorReviews);
  const state: ReviewEvidenceState = {
    evidence: new Map(),
    inspectedPaths: new Set(),
    limitations: [],
    notices: [],
  };
  const skipReason = oversizedReviewReason(input, prior.length);
  if (skipReason !== null) return skippedReview(input, budget, skipReason);
  const result = initialReview(input, budget, prior);
  let assessmentApplied = false;
  let attemptedCoverage: Analysis["coverage"] = [];
  try {
    const seededEvidence = seedDiffEvidence(
      input.repository.files,
      input.repository.snapshot,
    );
    addEvidence(state.evidence, seededEvidence, input.repository.snapshot);
    await prefetchTruncatedPatches(input, budget, state);
    const seed = buildReviewSeed(input, seededEvidence, prior);
    const reviewSource: unknown = JSON.parse(seed);
    const triage = await runStructuredStage({
      input,
      stage: "triage",
      schema: stageTriageSchema,
      content: seed,
      budget,
      state,
    });
    result.risk = highestRisk(result.risk, triage.risk);
    const investigation = await runStructuredStage({
      input,
      stage: "investigate",
      schema: analysisSchema,
      content: JSON.stringify({
        reviewInput: reviewSource,
        triage,
        deterministicRiskFloor: result.risk,
        blockingSeverity: input.config.review.blockingSeverity,
      }),
      budget,
      state,
      reserveTokens: () =>
        Buffer.byteLength(
          buildValidationInput({
            reviewSource,
            triage,
            candidateAssessment: {
              summary: triage.summary,
              risk: triage.risk,
              findings: [],
              reconciliations: [],
              questions: triage.questions,
              architecture: null,
              tests: null,
              coverage: [],
            },
            evidence: state.evidence.values(),
            blockingSeverity: input.config.review.blockingSeverity,
          }),
          "utf8",
        ) +
        input.config.review.maxOutputTokens * 3,
    });
    const validation = await runStructuredStage({
      input,
      stage: "validate",
      schema: validationSchema,
      content: buildValidationInput({
        reviewSource,
        triage,
        candidateAssessment: investigation,
        evidence: state.evidence.values(),
        blockingSeverity: input.config.review.blockingSeverity,
      }),
      budget,
      state,
      validate: (analysis) => {
        attemptedCoverage = analysis.coverage.filter(
          (claim) => claim.status !== "inspected",
        );
        return [
          ...validateAnalysisEvidence(
            analysis,
            state.evidence,
            input.repository.snapshot,
            prior,
            input.repository.files,
            input.config,
          ),
          ...validateCandidateResolutions(
            investigation,
            analysis,
            state.evidence,
            input.repository.snapshot,
          ),
        ];
      },
    });
    for (const candidate of validation.candidateResolutions) {
      if (candidate.status === "unverified")
        state.limitations.push(
          `Candidate ${candidate.id} remains unverified: ${candidate.reason}`,
        );
    }
    applyValidatedAssessment(result, validation, input, state, prior);
    assessmentApplied = true;
    await attachFindingExcerpts(result.findings, input, budget, state);
    const report = await runStructuredStage({
      input,
      stage: "report",
      schema: reportNarrativeSchema,
      content: JSON.stringify(frozenReviewFacts(result)),
      budget,
      state,
      validate: (draft) => narrativeErrors(draft.summary),
    });
    result.summary = report.summary;
  } catch (error) {
    if (assessmentApplied) {
      state.notices.push(
        "Report prose was unavailable; the validated assessment summary was retained.",
      );
      state.notices.push(describeReviewFailure(error));
    } else {
      result.verdict = "incomplete";
      result.architecture = null;
      result.tests = null;
      result.coverage = buildCoverage(
        input.repository.files,
        attemptedCoverage,
        state.inspectedPaths,
      );
      result.summary =
        "The review stopped before a complete assessment. Coverage records seeded patches and repository inspections the host already collected.";
      state.limitations.push(describeReviewFailure(error));
    }
  }
  result.coverageSummary = summarizeCoverage(result.coverage);
  result.evidence = [...state.evidence.values()];
  result.limitations = [
    ...new Set([...result.limitations, ...state.limitations]),
  ];
  if (input.config.personality.enabled && result.verdict !== "incomplete") {
    await addPersonality(result, input, budget, state);
  }
  result.diagnostics = [
    ...new Set([...(result.diagnostics ?? []), ...state.notices]),
  ];
  result.usage = budget.usage();
  return result;
}

function initialReview(
  input: ReviewInput,
  budget: ReviewBudget,
  prior: ReturnType<typeof priorFindingLedger>,
): ReviewResult {
  return {
    version: 1,
    snapshot: {
      ...input.repository.snapshot,
      advisories: input.advisories ?? input.repository.snapshot.advisories,
    },
    verdict: "incomplete",
    summary: "The review did not complete an assessment of the pinned change.",
    risk: deterministicRisk(input),
    size: changeSize(input),
    findings: [],
    reconciliations: unverifiedPriorFindings(prior),
    questions: [],
    architecture: null,
    tests: null,
    personality: "",
    coverage: buildCoverage(input.repository.files, [], new Set()),
    coverageSummary: summarizeCoverage([]),
    evidence: [],
    checks: input.checks,
    limitations: [],
    diagnostics: [...input.repository.omissions],
    usage: budget.usage(),
  };
}

function applyValidatedAssessment(
  result: ReviewResult,
  analysis: Analysis,
  input: ReviewInput,
  state: ReviewEvidenceState,
  prior: ReturnType<typeof priorFindingLedger>,
): void {
  result.summary = analysis.summary;
  result.risk = highestRisk(result.risk, analysis.risk);
  result.findings = normalizeFindingIds(analysis.findings, prior, input.config);
  result.reconciliations = analysis.reconciliations;
  result.questions = analysis.questions;
  result.coverage = buildCoverage(
    input.repository.files,
    analysis.coverage,
    state.inspectedPaths,
  );
  result.limitations.push(...assessmentLimitations(input, state));
  const failedChecks = input.checks.some(
    (check) =>
      check.headSha === input.repository.snapshot.headSha &&
      check.status === "failed",
  );
  const hasBlockingFinding = result.findings.some((finding) =>
    isBlocking(finding, input.config),
  );
  result.verdict =
    hasBlockingFinding || failedChecks ? "changes-requested" : "ready";
  if (input.config.review.scorecard) {
    result.architecture = analysis.architecture;
    result.tests = analysis.tests;
  }
}

/**
 * Real limitations only: tool failures, unverified candidates, integration
 * problems, and checks on another head. Coverage, questions, and unverified
 * prior findings are rendered from their own fields and never repeated here.
 * None of these affect the verdict.
 */
function assessmentLimitations(
  input: ReviewInput,
  state: ReviewEvidenceState,
): string[] {
  const limitations = [...state.limitations];
  const snapshot = input.repository.snapshot;
  if (snapshot.integration.status === "conflict")
    limitations.push(
      "The prospective integration has conflicts; merged behavior could not be reviewed.",
    );
  if (
    needsIntegrationEvidence(snapshot) &&
    (snapshot.integration.status !== "clean" ||
      snapshot.integration.treeSha === null)
  )
    limitations.push(
      "Current target or history changes require a prospective integration snapshot that was unavailable.",
    );
  if (input.checks.some((check) => check.headSha !== snapshot.headSha))
    limitations.push(
      "Some supplied checks belong to another head revision and cannot verify this change.",
    );
  return limitations;
}

const maxPriorFindings = 100;

function oversizedReviewReason(
  input: ReviewInput,
  priorFindingCount: number,
): string | null {
  const fileCount = input.repository.files.length;
  const maxFiles = input.config.review.maxFiles;
  if (fileCount > maxFiles)
    return `Skipped: ${fileCount} changed files exceed maxFiles (${maxFiles}). Split the change or raise the limit, then rerun with @gus.`;
  if (priorFindingCount > maxPriorFindings)
    return `Skipped: ${priorFindingCount} prior findings exceed the reconciliation limit (${maxPriorFindings}). Resolve or dismiss earlier findings, then rerun with @gus.`;
  return null;
}

/** A one-paragraph result for changes too large to review; the publisher posts it as a short comment. */
function skippedReview(
  input: ReviewInput,
  budget: ReviewBudget,
  summary: string,
): ReviewResult {
  return {
    version: 1,
    snapshot: {
      ...input.repository.snapshot,
      advisories: input.advisories ?? input.repository.snapshot.advisories,
    },
    verdict: "incomplete",
    summary,
    risk: deterministicRisk(input),
    size: changeSize(input),
    findings: [],
    reconciliations: [],
    questions: [],
    architecture: null,
    tests: null,
    personality: "",
    coverage: [],
    coverageSummary: {
      status: "partial",
      inspected: 0,
      partial: 0,
      unreviewed: 0,
      excluded: 0,
      notApplicable: 0,
    },
    evidence: [],
    checks: input.checks,
    limitations: [],
    diagnostics: [summary],
    usage: budget.usage(),
  };
}

function frozenReviewFacts(result: ReviewResult) {
  return {
    headSha: result.snapshot.headSha,
    baseSha: result.snapshot.baseSha,
    comparisonBaseSha: result.snapshot.comparisonBaseSha,
    verdict: result.verdict,
    summary: result.summary,
    risk: result.risk,
    size: result.size,
    findings: result.findings,
    reconciliations: result.reconciliations,
    architecture: result.architecture,
    tests: result.tests,
    checks: result.checks,
    coverage: result.coverage,
    coverageSummary: result.coverageSummary,
    limitations: result.limitations,
    branchAdvice: result.snapshot.advisories.filter(
      (advisory) => advisory.action !== "none",
    ),
  };
}

async function addPersonality(
  result: ReviewResult,
  input: ReviewInput,
  budget: ReviewBudget,
  state: ReviewEvidenceState,
): Promise<void> {
  try {
    const copy = await runStructuredStage({
      input,
      stage: "personality",
      schema: personalityOutputSchema(input.config.personality.maxChars),
      content: JSON.stringify({
        author: input.subject.author,
        reviewer: input.config.name,
        facts: frozenReviewFacts(result),
      }),
      budget,
      state,
      maxOutputTokens: Math.min(
        input.config.review.maxOutputTokens,
        input.config.personality.maxChars + 64,
      ),
      validate: (draft) => narrativeErrors(draft.text),
    });
    result.personality = copy.text;
  } catch {
    state.notices.push(
      "Optional reviewer voice was omitted because it was unavailable or failed its output contract.",
    );
  }
}

function narrativeErrors(text: string): string[] {
  const outcomeClaim =
    /\b(?:ready to merge|safe to (?:merge|deploy)|merge (?:it|this|now)|approved|tests? (?:all )?(?:pass(?:ed)?|green)|CI (?:passes|passed|is green)|no (?:bugs|defects|issues)|production.ready)\b/i;
  return outcomeClaim.test(text)
    ? [
        "Narrative cannot add merge/deployment decisions or verification claims; the host renders those frozen facts.",
      ]
    : [];
}

function describeReviewFailure(error: unknown): string {
  if (error instanceof GusError) return error.message;
  return "An unexpected review operation failed before all required stages completed.";
}
