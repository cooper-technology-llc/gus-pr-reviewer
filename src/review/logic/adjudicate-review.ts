import { createHash } from "node:crypto";

import type { GusConfig } from "../../config/config-schema.js";
import type {
  ChangedFile,
  FindingReconciliation,
  PriorReview,
  ReviewCoverage,
  ReviewEvidence,
  ReviewFinding,
  ReviewSnapshot,
} from "../review-schema.js";
import type { Analysis, CoverageClaim, Validation } from "../stage-schemas.js";
import { isCurrentEvidence } from "./review-evidence.js";

export interface PriorFinding {
  finding: ReviewFinding;
  previousHeadSha: string;
  previousVerdict: string;
}

export function priorFindingLedger(reviews: PriorReview[]): PriorFinding[] {
  const entries = new Map<string, PriorFinding>();
  for (const review of [...reviews].sort(
    (first, second) =>
      first.submittedAt.localeCompare(second.submittedAt) ||
      first.id - second.id,
  )) {
    for (const finding of review.state.findings) {
      entries.set(finding.id, {
        finding,
        previousHeadSha: review.state.headSha,
        previousVerdict: review.state.verdict,
      });
    }
    for (const reconciliation of review.state.reconciliations) {
      if (
        reconciliation.status === "resolved" ||
        reconciliation.status === "rejected"
      )
        entries.delete(reconciliation.id);
    }
  }
  return [...entries.values()];
}

export function needsIntegrationEvidence(snapshot: ReviewSnapshot): boolean {
  return (
    snapshot.baseSha !== snapshot.mergeBaseSha ||
    snapshot.baseChanged ||
    snapshot.historyRewritten
  );
}

export function validateAnalysisEvidence(
  analysis: Analysis,
  evidence: Map<string, ReviewEvidence>,
  snapshot: ReviewSnapshot,
  prior: PriorFinding[],
  files: ChangedFile[],
  config: GusConfig,
): string[] {
  const errors: string[] = [];
  const findingIds = new Set<string>();
  const conceptIds = new Set<string>();
  for (const finding of analysis.findings) {
    if (findingIds.has(finding.id))
      errors.push(`Duplicate finding ID ${finding.id}.`);
    findingIds.add(finding.id);
    const conceptId = stableFindingId(finding);
    if (conceptIds.has(conceptId))
      errors.push(
        `Finding ${finding.id} duplicates a finding for the same path and issue title.`,
      );
    conceptIds.add(conceptId);
    const original = prior.find(
      (entry) => entry.finding.id === finding.id,
    )?.finding;
    const currentPath =
      files.find((file) => file.previousPath === original?.path)?.path ??
      original?.path;
    if (
      original &&
      finding.path !== original.path &&
      finding.path !== currentPath
    )
      errors.push(
        `Prior finding ID ${finding.id} cannot be reused for an unrelated path.`,
      );
    const citations = resolveCitations(
      finding.evidenceIds,
      evidence,
      errors,
      `Finding ${finding.id}`,
    );
    if (
      !citations.some((entry) => supportsLocation(entry, finding, snapshot))
    ) {
      errors.push(
        `Finding ${finding.id} needs an actual evidence ID with matching path, line, side and pinned revision.`,
      );
    }
    if (
      finding.side === "LEFT" &&
      !citations.some(
        (entry) =>
          isCurrentEvidence(entry, snapshot) &&
          entry.startLine > 0 &&
          (entry.kind === "file" || entry.kind === "search"),
      )
    ) {
      errors.push(
        `Removed-line finding ${finding.id} needs fresh caller or integration evidence confirming the present consequence.`,
      );
    }
    if (
      isBlocking(finding, config) &&
      needsIntegrationEvidence(snapshot) &&
      !citations.some(
        (entry) =>
          entry.revision === "integration" &&
          isCurrentEvidence(entry, snapshot),
      )
    ) {
      errors.push(
        `Finding ${finding.id} needs prospective integration evidence because the target or history changed; otherwise leave the concern unresolved.`,
      );
    }
  }
  validateReconciliations(analysis, evidence, snapshot, prior, files, errors);
  validateCoverageClaims(analysis.coverage, files, evidence, snapshot, errors);
  return errors;
}

export function validateCandidateResolutions(
  investigation: Analysis,
  validation: Validation,
  evidence: Map<string, ReviewEvidence>,
  snapshot: ReviewSnapshot,
): string[] {
  const errors: string[] = [];
  const candidates = new Map(
    investigation.findings.map((finding) => [finding.id, finding]),
  );
  const seen = new Set<string>();
  for (const resolution of validation.candidateResolutions) {
    if (!candidates.has(resolution.id) || seen.has(resolution.id))
      errors.push(
        `Candidate resolution ${resolution.id} is unknown or duplicated.`,
      );
    seen.add(resolution.id);
    const citations = resolveCitations(
      resolution.evidenceIds,
      evidence,
      errors,
      `Candidate ${resolution.id}`,
    );
    const currentFinding = validation.findings.find(
      (finding) => finding.id === resolution.id,
    );
    if (resolution.status === "confirmed" && !currentFinding)
      errors.push(
        `Confirmed candidate ${resolution.id} is missing its final finding.`,
      );
    if (resolution.status !== "confirmed" && currentFinding)
      errors.push(
        `Candidate ${resolution.id} cannot be both a final finding and rejected or unverified.`,
      );
    if (
      resolution.status !== "unverified" &&
      !citations.some((entry) => isCurrentEvidence(entry, snapshot))
    )
      errors.push(
        `Candidate ${resolution.id} needs actual current-revision evidence for its disposition.`,
      );
  }
  for (const id of candidates.keys())
    if (!seen.has(id))
      errors.push(
        `Candidate ${id} was silently dropped. Confirm, reject with evidence, or mark unverified.`,
      );
  return errors;
}

function supportsLocation(
  evidence: ReviewEvidence,
  finding: ReviewFinding,
  snapshot: ReviewSnapshot,
): boolean {
  if (
    evidence.path !== finding.path ||
    finding.line < evidence.startLine ||
    finding.line > evidence.endLine ||
    evidence.kind === "history"
  )
    return false;
  if (finding.side === "LEFT")
    return (
      evidence.revision === "parent" &&
      evidence.sha === snapshot.comparisonBaseSha
    );
  return isCurrentEvidence(evidence, snapshot);
}

function resolveCitations(
  ids: string[],
  evidence: Map<string, ReviewEvidence>,
  errors: string[],
  label: string,
): ReviewEvidence[] {
  const citations: ReviewEvidence[] = [];
  for (const id of ids) {
    const entry = evidence.get(id);
    if (entry) citations.push(entry);
    else errors.push(`${label} references unknown evidence ID ${id}.`);
  }
  return citations;
}

function validateReconciliations(
  analysis: Analysis,
  evidence: Map<string, ReviewEvidence>,
  snapshot: ReviewSnapshot,
  prior: PriorFinding[],
  files: ChangedFile[],
  errors: string[],
): void {
  const expected = new Map(
    prior.map((entry) => [entry.finding.id, entry.finding]),
  );
  const seen = new Set<string>();
  for (const reconciliation of analysis.reconciliations) {
    const original = expected.get(reconciliation.id);
    if (!original || seen.has(reconciliation.id))
      errors.push(
        `Reconciliation ${reconciliation.id} is unknown or duplicated.`,
      );
    seen.add(reconciliation.id);
    const citations = resolveCitations(
      reconciliation.evidenceIds,
      evidence,
      errors,
      `Reconciliation ${reconciliation.id}`,
    );
    if (reconciliation.status === "unverified") continue;
    const currentPath =
      files.find((file) => file.previousPath === original?.path)?.path ??
      original?.path;
    if (
      !citations.some(
        (entry) =>
          isCurrentEvidence(entry, snapshot) && entry.path === currentPath,
      )
    ) {
      errors.push(
        `Reconciliation ${reconciliation.id} needs fresh current-revision evidence for the affected path; previous verdicts are not evidence.`,
      );
    }
    if (
      reconciliation.status === "still-open" &&
      !analysis.findings.some((finding) => finding.id === reconciliation.id)
    ) {
      errors.push(
        `Still-open prior finding ${reconciliation.id} must be re-established as a current evidence-backed finding with the same ID.`,
      );
    }
    if (
      reconciliation.status !== "still-open" &&
      analysis.findings.some((finding) => finding.id === reconciliation.id)
    ) {
      errors.push(
        `Prior finding ${reconciliation.id} cannot be resolved or rejected and also remain a current finding.`,
      );
    }
  }
  for (const id of expected.keys())
    if (!seen.has(id))
      errors.push(
        `Prior finding ${id} has not been reconciled. Use unverified with a reason if current proof is unavailable.`,
      );
}

function validateCoverageClaims(
  claims: CoverageClaim[],
  files: ChangedFile[],
  evidence: Map<string, ReviewEvidence>,
  snapshot: ReviewSnapshot,
  errors: string[],
): void {
  const paths = new Set(
    files.filter((file) => !file.excluded).map((file) => file.path),
  );
  const seen = new Set<string>();
  for (const claim of claims) {
    if (!paths.has(claim.path) || seen.has(claim.path))
      errors.push(
        `Coverage path ${claim.path} is outside the review scope or duplicated.`,
      );
    seen.add(claim.path);
    const citations = resolveCitations(
      claim.evidenceIds,
      evidence,
      errors,
      `Coverage ${claim.path}`,
    );
    if (
      claim.status === "inspected" &&
      !citations.some(
        (entry) =>
          entry.path === claim.path &&
          (isCurrentEvidence(entry, snapshot) || entry.revision === "parent"),
      )
    ) {
      errors.push(
        `Inspected coverage for ${claim.path} needs actual evidence for this file.`,
      );
    }
  }
}

export function normalizeFindingIds(
  findings: ReviewFinding[],
  prior: PriorFinding[],
  config: GusConfig,
): ReviewFinding[] {
  const existing = new Map(
    prior.map((entry) => [entry.finding.id, entry.finding]),
  );
  return findings.map((finding) => ({
    ...finding,
    id: existing.has(finding.id) ? finding.id : stableFindingId(finding),
    disposition: isBlocking(finding, config) ? "blocking" : finding.disposition,
  }));
}

export function stableFindingId(
  finding: Pick<ReviewFinding, "title" | "path">,
): string {
  const title = finding.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  return `gus-${createHash("sha256")
    .update(JSON.stringify([finding.path, title]))
    .digest("hex")
    .slice(0, 24)}`;
}

export function isBlocking(
  finding: Pick<ReviewFinding, "severity" | "disposition">,
  config: GusConfig,
): boolean {
  const rank = { critical: 3, major: 2, minor: 1 };
  return rank[finding.severity] >= rank[config.review.blockingSeverity];
}

export function buildCoverage(
  files: ChangedFile[],
  claims: CoverageClaim[],
  inspectedPaths: Set<string>,
): ReviewCoverage[] {
  return files.map((file) => {
    if (file.excluded)
      return {
        path: file.path,
        status: "excluded",
        reason: "Excluded by the configured review scope.",
      };
    const claim = claims.find((entry) => entry.path === file.path);
    if (file.binary)
      return {
        path: file.path,
        status: "unreviewed",
        reason: "Binary content is unavailable to the text reviewer.",
      };
    if (!claim) {
      if (inspectedPaths.has(file.path))
        return {
          path: file.path,
          status: "inspected",
          reason: "The host recorded a repository inspection for this file.",
        };
      if (!file.truncated && file.patch.length > 0)
        return {
          path: file.path,
          status: "inspected",
          reason: "The host supplied the complete seed patch for this file.",
        };
      return {
        path: file.path,
        status: file.truncated ? "partial" : "unreviewed",
        reason: file.truncated
          ? "The patch was truncated and a complete file read was not recorded."
          : "The review did not complete an evidence-backed assessment for this file.",
      };
    }
    if (file.truncated && !inspectedPaths.has(file.path))
      return {
        path: file.path,
        status: "partial",
        reason:
          "The patch was truncated and a complete file read was not recorded.",
      };
    return { path: file.path, status: claim.status, reason: claim.reason };
  });
}

export function unverifiedPriorFindings(
  prior: PriorFinding[],
): FindingReconciliation[] {
  return prior.map((entry) => ({
    id: entry.finding.id,
    status: "unverified",
    reason:
      "The current review did not complete revalidation at the pinned revisions.",
    evidenceIds: [],
  }));
}
