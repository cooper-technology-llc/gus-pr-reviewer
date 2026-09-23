import type { ReviewResult } from "../../review/review-schema.js";
import { formatInlineProse } from "./format-prose.js";
import { escapeMarkdown, plural } from "./markdown-text.js";

/** Links the comment points to; each is omitted when the run could not determine it. */
export interface ReviewLinks {
  checkRunUrl?: string | null;
  artifactUrl?: string | null;
}

export function verdictLabel(verdict: ReviewResult["verdict"]): string {
  if (verdict === "ready") return "ready";
  if (verdict === "changes-requested") return "changes requested";
  return "incomplete";
}

/** "coverage 61/63": inspected over reviewable files (excluded and not-applicable files are not reviewable). */
export function coverageFraction(review: ReviewResult): string | null {
  const summary = review.coverageSummary;
  const reviewable = summary.inspected + summary.partial + summary.unreviewed;
  if (reviewable === 0) return null;
  return `coverage ${summary.inspected}/${reviewable}`;
}

/** `Gus · changes requested · 2 findings · coverage 61/63`, without emphasis. */
export function reviewHeadline(name: string, review: ReviewResult): string {
  const parts = [
    escapeMarkdown(name),
    verdictLabel(review.verdict),
    plural(review.findings.length, "finding"),
  ];
  const coverage = coverageFraction(review);
  if (coverage) parts.push(coverage);
  return parts.join(" · ");
}

/** The one-line notes the comment keeps from coverage and limitations. */
export function reviewNotes(review: ReviewResult): string[] {
  const notes: string[] = [];
  const summary = review.coverageSummary;
  const notFullyRead = summary.partial + summary.unreviewed;
  if (summary.status === "partial" && notFullyRead > 0)
    notes.push(
      `Coverage partial: ${plural(notFullyRead, "file")} not fully read (see details).`,
    );
  const [first, ...rest] = review.limitations;
  if (first !== undefined)
    notes.push(
      `Limits: ${formatInlineProse(first)}${rest.length > 0 ? ` and ${rest.length} more` : ""}`,
    );
  if (review.questions.length > 0)
    notes.push(
      `${plural(review.questions.length, "open question")} (see details).`,
    );
  return notes;
}
