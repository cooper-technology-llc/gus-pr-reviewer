import type { GusConfig } from "../config/config-schema.js";
import { formatFindingMarkdown } from "../reporting/format-review.js";
import type { ReviewSubject } from "../review/review-ports.js";
import type {
  ChangedFile,
  ReviewFinding,
  ReviewResult,
} from "../review/review-schema.js";

export interface InlineComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

export function selectInlineComments(
  review: ReviewResult,
  subject: ReviewSubject,
  files: ChangedFile[],
  config: GusConfig,
): InlineComment[] {
  if (review.snapshot.comparisonBaseSha !== review.snapshot.mergeBaseSha)
    return [];
  const anchors = new Map(
    files
      .filter((file) => !file.binary && !file.excluded)
      .map((file) => [file.path, commentableLines(file.patch)]),
  );
  return review.findings
    .filter((finding) =>
      anchors.get(finding.path)?.has(`${finding.side}:${finding.line}`),
    )
    .filter(
      (finding) =>
        finding.side === "LEFT" || hasHeadLineEvidence(finding, review),
    )
    .slice(0, config.github.maxInlineComments)
    .map((finding) => ({
      path: finding.path,
      line: finding.line,
      side: finding.side,
      body: formatFindingMarkdown(finding, review, subject),
    }));
}

function hasHeadLineEvidence(
  finding: ReviewFinding,
  review: ReviewResult,
): boolean {
  return review.evidence.some(
    (evidence) =>
      finding.evidenceIds.includes(evidence.id) &&
      evidence.revision === "head" &&
      evidence.sha === review.snapshot.headSha &&
      evidence.path === finding.path &&
      evidence.kind !== "history" &&
      evidence.startLine <= finding.line &&
      evidence.endLine >= finding.line,
  );
}

export function commentableLines(patch: string): Set<string> {
  const anchors = new Set<string>();
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newRemaining = hunk[4] === undefined ? 1 : Number(hunk[4]);
      continue;
    }
    if (line.startsWith("+") && newRemaining > 0) {
      anchors.add(`RIGHT:${newLine}`);
      newLine += 1;
      newRemaining -= 1;
    } else if (line.startsWith("-") && oldRemaining > 0) {
      anchors.add(`LEFT:${oldLine}`);
      oldLine += 1;
      oldRemaining -= 1;
    } else if (line.startsWith(" ") && oldRemaining > 0 && newRemaining > 0) {
      anchors.add(`LEFT:${oldLine}`);
      anchors.add(`RIGHT:${newLine}`);
      oldLine += 1;
      newLine += 1;
      oldRemaining -= 1;
      newRemaining -= 1;
    }
  }
  return anchors;
}
