import { GusError } from "../errors.js";
import {
  buildCoverage,
  isBlocking,
  needsIntegrationEvidence,
  normalizeFindingIds,
  priorFindingLedger,
  unverifiedPriorFindings,
  validateAnalysisEvidence,
  validateCandidateResolutions,
} from "./logic/adjudicate-review.js";
import { addEvidence, seedDiffEvidence } from "./logic/review-evidence.js";
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
  const result = initialReview(input, budget, prior);
  let assessmentApplied = false;
  try {
    if (prior.length > 100)
      throw new GusError(
        "BUDGET_EXCEEDED",
        "More than 100 prior findings require reconciliation; the review scope must be narrowed.",
      );
    if (input.repository.files.length > input.config.review.maxFiles)
      throw new GusError(
        "BUDGET_EXCEEDED",
        "The changed file count exceeds maxFiles; the review did not silently omit files.",
      );
    const seededEvidence = seedDiffEvidence(
      input.repository.files,
      input.repository.snapshot,
    );
    addEvidence(state.evidence, seededEvidence, input.repository.snapshot);
    const seedIds = new Set(seededEvidence.map((entry) => entry.id));
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
    });
    const validation = await runStructuredStage({
      input,
      stage: "validate",
      schema: validationSchema,
      content: JSON.stringify({
        reviewInput: reviewSource,
        triage,
        candidateAssessment: investigation,
        additionalEvidence: [...state.evidence.values()].filter(
          (entry) => !seedIds.has(entry.id),
        ),
        blockingSeverity: input.config.review.blockingSeverity,
      }),
      budget,
      state,
      validate: (analysis) => [
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
      ],
    });
    for (const candidate of validation.candidateResolutions) {
      if (candidate.status === "unverified")
        state.limitations.push(
          `Candidate ${candidate.id} remains unverified: ${candidate.reason}`,
        );
    }
    applyValidatedAssessment(result, validation, input, state, prior);
    assessmentApplied = true;
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
    result.verdict = "incomplete";
    result.architecture = null;
    result.tests = null;
    if (!assessmentApplied) {
      result.coverage = buildCoverage(
        input.repository.files,
        [],
        state.inspectedPaths,
      );
      result.summary =
        "The review stopped before a complete assessment. Coverage records seeded patches and repository inspections the host already collected.";
    }
    state.limitations.push(describeReviewFailure(error));
  }
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
  const limitations = assessmentLimitations(result, input, state);
  result.limitations.push(...limitations);
  const failedChecks = input.checks.some(
    (check) =>
      check.headSha === input.repository.snapshot.headSha &&
      check.status === "failed",
  );
  result.verdict =
    limitations.length > 0
      ? "incomplete"
      : result.findings.some((finding) => isBlocking(finding, input.config)) ||
          failedChecks
        ? "changes-requested"
        : "ready";
  if (result.verdict !== "incomplete" && input.config.review.scorecard) {
    result.architecture = analysis.architecture;
    result.tests = analysis.tests;
  }
}

function assessmentLimitations(
  result: ReviewResult,
  input: ReviewInput,
  state: ReviewEvidenceState,
): string[] {
  const limitations = [...state.limitations];
  for (const coverage of result.coverage) {
    if (coverage.status === "unreviewed" || coverage.status === "partial")
      limitations.push(`${coverage.path}: ${coverage.reason}`);
  }
  if (result.questions.length > 0)
    limitations.push(
      "The validated assessment still has unanswered review questions.",
    );
  if (result.reconciliations.some((entry) => entry.status === "unverified"))
    limitations.push(
      "At least one prior finding could not be revalidated at the pinned revisions.",
    );
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
