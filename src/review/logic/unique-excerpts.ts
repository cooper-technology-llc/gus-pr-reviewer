import type { ReviewFindingExcerpt } from "../review-schema.js";

/**
 * Drops excerpts that repeat an earlier one's path, commit, range, and text, keeping the first.
 * Two evidence IDs (a diff record and a file record) often cite the same lines.
 */
export function uniqueExcerpts(
  excerpts: ReviewFindingExcerpt[],
): ReviewFindingExcerpt[] {
  const seen = new Set<string>();
  return excerpts.filter((excerpt) => {
    const key = JSON.stringify([
      excerpt.path,
      excerpt.sha,
      excerpt.startLine,
      excerpt.endLine,
      excerpt.text,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
