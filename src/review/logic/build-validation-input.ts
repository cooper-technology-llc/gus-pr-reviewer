import type { ReviewEvidence } from "../review-schema.js";
import type { Analysis } from "../stage-schemas.js";

interface ValidationInput {
  reviewSource: unknown;
  triage: unknown;
  candidateAssessment: Analysis;
  evidence: Iterable<ReviewEvidence>;
  blockingSeverity: string;
}

/** Carries exact cited source into validation without replaying unrelated patches or discoveries. */
export function buildValidationInput(input: ValidationInput): string {
  const evidence = [...input.evidence];
  const citedIds = new Set(
    [
      ...input.candidateAssessment.findings,
      ...input.candidateAssessment.reconciliations,
      ...input.candidateAssessment.coverage,
    ].flatMap((entry) => entry.evidenceIds),
  );
  const citedEvidence = evidence.filter((entry) => citedIds.has(entry.id));
  return JSON.stringify({
    reviewInput: manifestWithoutPatches(input.reviewSource),
    triage: input.triage,
    candidateAssessment: input.candidateAssessment,
    evidenceIndex: evidence.map(({ text, ...metadata }) => metadata),
    evidenceToReinspect: citedEvidence.map(({ text, ...metadata }) => metadata),
    blockingSeverity: input.blockingSeverity,
    evidenceAccess:
      "The evidence index preserves recorded provenance without replaying source text. Candidate evidence is identified separately and must be independently retrieved with the pinned repository tools before resolving the candidate; an index entry alone does not prove a claim. Inspect other source and counterevidence as needed.",
  });
}

function manifestWithoutPatches(reviewSource: unknown): unknown {
  if (
    reviewSource === null ||
    typeof reviewSource !== "object" ||
    !("changedFiles" in reviewSource) ||
    !Array.isArray(reviewSource.changedFiles)
  )
    return reviewSource;
  return {
    ...reviewSource,
    changedFiles: reviewSource.changedFiles.map((file: unknown) => {
      if (file === null || typeof file !== "object") return file;
      return Object.fromEntries(
        Object.entries(file).filter(([key]) => key !== "patch"),
      );
    }),
  };
}
