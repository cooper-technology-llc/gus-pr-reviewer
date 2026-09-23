import type { GusConfig } from "../config/config-schema.js";
import type { ReviewSubject } from "../review/review-ports.js";
import type {
  ReviewFinding,
  ReviewFindingExcerpt,
  ReviewResult,
} from "../review/review-schema.js";
import { uniqueExcerpts } from "../review/logic/unique-excerpts.js";
import { formatInlineProse, formatProse } from "./logic/format-prose.js";
import {
  blobUrl,
  escapeCode,
  escapeMarkdown,
  fencedBlock,
  safeUrl,
  shortSha,
} from "./logic/markdown-text.js";
import {
  reviewHeadline,
  reviewNotes,
  type ReviewLinks,
} from "./logic/review-headline.js";
import {
  addHiddenReviewComment,
  formatFindingMarker,
  stateFromReview,
} from "./review-state.js";

export type { ReviewLinks } from "./logic/review-headline.js";

const EXCERPT_MAX_LINES = 12;
const SUMMARY_MAX_SENTENCES = 3;

/**
 * Renders the short PR comment: verdict line, findings with evidence, summary, take, links,
 * and one hidden state comment. Everything else lives on the Check Run page and in the JSON.
 */
export function formatReviewMarkdown(
  review: ReviewResult,
  subject: ReviewSubject,
  config: GusConfig,
  links: ReviewLinks = {},
): string {
  const sections = [`**${reviewHeadline(config.name, review)}**`];
  const notes = reviewNotes(review);
  if (notes.length > 0) sections.push(notes.join("\n"));
  for (const finding of review.findings)
    sections.push(formatCommentFinding(finding, review, subject));
  const previous = formatPreviousFindings(review);
  if (previous) sections.push(previous);
  sections.push(formatProse(firstSentences(review.summary)));
  const take = review.personality.replace(/\s+/g, " ").trim();
  if (config.personality.enabled && take)
    sections.push(`> ${formatInlineProse(take)}`);
  const linksLine = formatLinksLine(links);
  if (linksLine) sections.push(linksLine);
  return addHiddenReviewComment(sections.join("\n\n"), stateFromReview(review));
}

function formatCommentFinding(
  finding: ReviewFinding,
  review: ReviewResult,
  subject: ReviewSubject,
): string {
  const sha =
    finding.side === "LEFT" ? review.snapshot.baseSha : review.snapshot.headSha;
  const location = `\`${escapeCode(finding.path)}:${finding.line}\``;
  const url = blobUrl(subject, sha, finding.path, finding.line);
  const lines = [
    `#### ${finding.severity.toUpperCase()} · ${formatInlineProse(finding.title)}`,
    `${url ? `[${location}](${safeUrl(url)})` : location} · ${finding.disposition}`,
    `**Trigger:** ${formatProse(finding.trigger)}`,
    `**Impact:** ${formatProse(finding.impact)}`,
    `**Fix:** ${formatProse(finding.suggestion)}`,
  ];
  const excerpts = findingExcerpts(finding, review);
  if (excerpts.length > 0) lines.push(formatEvidenceDetails(excerpts, subject));
  return lines.join("\n\n");
}

/** Host-attached excerpts, or the cited evidence clipped the same way for reviews that predate them. */
function findingExcerpts(
  finding: ReviewFinding,
  review: ReviewResult,
): ReviewFindingExcerpt[] {
  if (finding.excerpts.length > 0) return uniqueExcerpts(finding.excerpts);
  const cited = finding.evidenceIds.flatMap((id) => {
    const evidence = review.evidence.find((entry) => entry.id === id);
    if (!evidence || !evidence.text.trim()) return [];
    return [
      {
        evidenceId: evidence.id,
        path: evidence.path,
        revision: evidence.revision,
        sha: evidence.sha,
        startLine: evidence.startLine,
        endLine: evidence.endLine,
        text: evidence.text
          .split("\n")
          .slice(0, EXCERPT_MAX_LINES)
          .join("\n")
          .trimEnd(),
      },
    ];
  });
  return uniqueExcerpts(cited);
}

function formatEvidenceDetails(
  excerpts: ReviewFindingExcerpt[],
  subject: ReviewSubject,
): string {
  const blocks = excerpts.map((excerpt) => {
    const range =
      excerpt.endLine > excerpt.startLine
        ? `${excerpt.startLine}-${excerpt.endLine}`
        : `${excerpt.startLine}`;
    const where =
      excerpt.revision === "integration"
        ? "prospective integration"
        : shortSha(excerpt.sha);
    const label = `\`${escapeCode(excerpt.path)}:${range} @ ${escapeCode(where)}\``;
    const url =
      excerpt.revision === "integration"
        ? null
        : blobUrl(
            subject,
            excerpt.sha,
            excerpt.path,
            excerpt.startLine,
            excerpt.endLine,
          );
    const heading = url ? `[${label}](${safeUrl(url)})` : label;
    return `${heading}\n\n${fencedBlock(excerpt.text)}`;
  });
  return [
    `<details><summary>Evidence (${excerpts.length})</summary>`,
    ...blocks,
    "</details>",
  ].join("\n\n");
}

function formatPreviousFindings(review: ReviewResult): string | null {
  if (review.reconciliations.length === 0) return null;
  const rows = review.reconciliations.map(
    (resolution) =>
      `- \`${escapeCode(resolution.id)}\`: **${resolution.status}** — ${formatInlineProse(firstSentences(resolution.reason, 1))}`,
  );
  return [
    `<details><summary>Previous findings (${review.reconciliations.length})</summary>`,
    rows.join("\n"),
    "</details>",
  ].join("\n\n");
}

function formatLinksLine(links: ReviewLinks): string | null {
  const parts: string[] = [];
  if (links.checkRunUrl) parts.push(`[details](${safeUrl(links.checkRunUrl)})`);
  if (links.artifactUrl)
    parts.push(`[evidence json](${safeUrl(links.artifactUrl)})`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function firstSentences(
  text: string,
  limit: number = SUMMARY_MAX_SENTENCES,
): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const sentences = normalized.split(/(?<=[.!?])\s+(?=[A-Z0-9`"'(])/);
  return sentences.slice(0, limit).join(" ");
}

/** Full finding body for inline comments and follow-up issues, with its thread marker. */
export function formatFindingMarkdown(
  finding: ReviewFinding,
  review?: ReviewResult,
  subject?: ReviewSubject,
): string {
  const location = `\`${escapeCode(finding.path)}:${finding.line} (${finding.side})\``;
  const lines = [
    `#### ${finding.severity.toUpperCase()} · ${formatInlineProse(finding.title)}`,
    "",
    `${location} · **${finding.disposition}** · \`${escapeCode(finding.id)}\``,
    "",
    `**Trigger:** ${formatProse(finding.trigger)}`,
    "",
    `**Impact:** ${formatProse(finding.impact)}`,
    "",
    `**Suggested change:** ${formatProse(finding.suggestion)}`,
    "",
    `**Evidence:** ${finding.evidenceIds.map((id) => formatEvidenceLink(id, review, subject)).join(", ")}`,
    "",
    formatFindingMarker(finding.id),
  ];
  return lines.join("\n");
}

function formatEvidenceLink(
  id: string,
  review?: ReviewResult,
  subject?: ReviewSubject,
): string {
  const evidence = review?.evidence.find((entry) => entry.id === id);
  if (evidence?.revision === "integration") {
    const endLine =
      evidence.endLine === evidence.startLine ? "" : `-${evidence.endLine}`;
    return `\`${escapeCode(id)}\` (prospective integration, \`${escapeCode(evidence.path)}:${evidence.startLine}${endLine}\`)`;
  }
  const url = evidence
    ? blobUrl(subject, evidence.sha, evidence.path, evidence.startLine)
    : null;
  return url ? `[${escapeMarkdown(id)}](${url})` : `\`${escapeCode(id)}\``;
}
