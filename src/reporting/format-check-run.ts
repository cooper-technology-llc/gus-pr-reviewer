import type { ReviewFinding, ReviewResult } from "../review/review-schema.js";
import { formatModelUsage } from "./logic/format-model-usage.js";
import { formatInlineProse, formatProse } from "./logic/format-prose.js";
import {
  escapeCode,
  escapeMarkdown,
  safeUrl,
  shortSha,
} from "./logic/markdown-text.js";
import {
  reviewHeadline,
  reviewNotes,
  type ReviewLinks,
} from "./logic/review-headline.js";

export const CHECK_RUN_TEXT_LIMIT = 65_000;
export const CHECK_RUN_ANNOTATION_LIMIT = 50;
const CHECK_RUN_SUMMARY_LIMIT = 65_000;
const ANNOTATION_MESSAGE_LIMIT = 4_000;
const ANNOTATION_TITLE_LIMIT = 255;

export interface CheckRunAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "failure" | "warning" | "notice";
  title: string;
  message: string;
}

export interface CheckRunOutput {
  title: string;
  summary: string;
  text: string;
  annotations: CheckRunAnnotation[];
}

/** The Check Run page: the long form of everything the short PR comment leaves out. */
export function formatCheckRunOutput(
  review: ReviewResult,
  links: ReviewLinks = {},
  name: string = "Gus",
  notices: string[] = [],
): CheckRunOutput {
  return {
    title: reviewHeadline(name, review),
    summary: clip(formatSummary(review, links), CHECK_RUN_SUMMARY_LIMIT),
    text: clip(formatText(review, notices), CHECK_RUN_TEXT_LIMIT),
    annotations: formatAnnotations(review.findings),
  };
}

function formatSummary(review: ReviewResult, links: ReviewLinks): string {
  const lines = [formatProse(review.summary), "", ...reviewNotes(review)];
  if (links.artifactUrl)
    lines.push("", `[Evidence JSON](${safeUrl(links.artifactUrl)})`);
  return lines.join("\n").trim();
}

/** Publication notices sit with diagnostics: facts about the run, not about the code. */
function formatText(review: ReviewResult, notices: string[]): string {
  const sections = [
    formatVerdict(review),
    formatFindingList(review),
    formatCoverage(review),
    formatChecks(review),
    formatList("Limitations", review.limitations),
    formatList("Diagnostics", [...(review.diagnostics ?? []), ...notices]),
    formatList("Open questions", review.questions),
    formatReconciliations(review),
    formatBranchAdvice(review),
    formatUsage(review),
  ];
  return sections
    .filter((section) => section.length > 0)
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n");
}

function formatVerdict(review: ReviewResult): string {
  const { snapshot } = review;
  const lines = [
    "## Verdict",
    "",
    `**${review.verdict}** · risk ${review.risk} · size ${review.size}`,
    "",
    `- Head: \`${escapeCode(snapshot.headSha)}\``,
    `- Base: \`${escapeCode(snapshot.baseSha)}\``,
    `- Comparison: \`${escapeCode(snapshot.comparisonBaseSha)}\``,
    `- Integration: **${snapshot.integration.status}**`,
  ];
  if (review.architecture)
    lines.push(
      `- Architecture: **${review.architecture.grade}** — ${formatInlineProse(review.architecture.reason)}`,
    );
  if (review.tests)
    lines.push(
      `- Tests: **${review.tests.grade}** — ${formatInlineProse(review.tests.reason)}`,
    );
  return lines.join("\n");
}

function formatFindingList(review: ReviewResult): string {
  if (review.findings.length === 0) return "";
  return [
    "## Findings",
    "",
    ...review.findings.map(
      (finding) =>
        `- **${finding.severity.toUpperCase()}** · ${formatInlineProse(finding.title)} · \`${escapeCode(finding.path)}:${finding.line}\` · ${finding.disposition} · \`${escapeCode(finding.id)}\``,
    ),
  ].join("\n");
}

function formatCoverage(review: ReviewResult): string {
  const summary = review.coverageSummary;
  const lines = [
    "## Coverage",
    "",
    `${summary.status === "full" ? "Full" : "Partial"}: ${summary.inspected} inspected, ${summary.partial} partial, ${summary.unreviewed} unreviewed, ${summary.excluded} excluded, ${summary.notApplicable} not applicable.`,
  ];
  const gaps = review.coverage.filter((file) => file.status !== "inspected");
  if (gaps.length > 0)
    lines.push(
      "",
      "| File | Status | Reason |",
      "| --- | --- | --- |",
      ...gaps.map(
        (file) =>
          `| \`${escapeCode(file.path)}\` | ${file.status} | ${escapeMarkdown(file.reason).replace(/\|/g, "\\|")} |`,
      ),
    );
  const inspected = review.coverage.filter(
    (file) => file.status === "inspected",
  );
  if (inspected.length > 0)
    lines.push(
      "",
      `<details><summary>${inspected.length} inspected files</summary>`,
      "",
      ...inspected.map((file) => `- \`${escapeCode(file.path)}\``),
      "",
      "</details>",
    );
  return lines.join("\n");
}

function formatChecks(review: ReviewResult): string {
  const lines = ["## Verification", ""];
  if (review.checks.length === 0)
    lines.push("No executed check results were supplied.");
  for (const check of review.checks) {
    const status =
      check.headSha === review.snapshot.headSha
        ? check.status
        : `inconclusive (ran on \`${escapeCode(shortSha(check.headSha))}\`)`;
    lines.push(
      `- **${escapeMarkdown(check.name)}: ${status}** — ${formatInlineProse(check.details)}${check.url ? ` [Evidence](${safeUrl(check.url)})` : ""}`,
    );
  }
  return lines.join("\n");
}

function formatList(title: string, items: string[]): string {
  if (items.length === 0) return "";
  return [
    `## ${title}`,
    "",
    ...items.map((item) => `- ${formatInlineProse(item)}`),
  ].join("\n");
}

function formatReconciliations(review: ReviewResult): string {
  if (review.reconciliations.length === 0) return "";
  return [
    "## Previous findings",
    "",
    ...review.reconciliations.map(
      (resolution) =>
        `- \`${escapeCode(resolution.id)}\`: **${resolution.status}** — ${formatInlineProse(resolution.reason)}${resolution.evidenceIds.length ? ` Evidence: ${resolution.evidenceIds.map((id) => `\`${escapeCode(id)}\``).join(", ")}.` : ""}`,
    ),
  ].join("\n");
}

function formatBranchAdvice(review: ReviewResult): string {
  const advice = review.snapshot.advisories.filter(
    (advisory) => advisory.action !== "none",
  );
  if (advice.length === 0) return "";
  return [
    "## Branch advice",
    "",
    ...advice.map(
      (advisory) =>
        `- ${formatInlineProse(advisory.message)} ${formatInlineProse(advisory.evidence)} Action: ${advisory.action}.`,
    ),
  ].join("\n");
}

function formatUsage(review: ReviewResult): string {
  const { usage } = review;
  const accounting =
    usage.usageComplete === false
      ? "Token accounting is incomplete."
      : `${usage.inputTokens} input / ${usage.outputTokens} output tokens.`;
  const cost =
    usage.costUsd === null
      ? "Cost unavailable."
      : `Reported cost: $${usage.costUsd.toFixed(4)}${usage.usageComplete === false ? " (partial accounting)" : ""}.`;
  return [
    "## Usage",
    "",
    `Models: ${usage.models.map((model) => `\`${escapeCode(model)}\``).join(", ") || "none"}. ${usage.requests} requests, ${usage.toolCalls} tool calls. ${accounting} ${cost}`,
    "",
    ...formatModelUsage(usage.calls ?? []),
  ].join("\n");
}

/** One annotation per head-side finding; base-side lines do not exist in the head files GitHub annotates. */
function formatAnnotations(findings: ReviewFinding[]): CheckRunAnnotation[] {
  return findings
    .filter((finding) => finding.side === "RIGHT" && finding.line > 0)
    .slice(0, CHECK_RUN_ANNOTATION_LIMIT)
    .map((finding) => ({
      path: finding.path,
      start_line: finding.line,
      end_line: finding.line,
      annotation_level: finding.severity === "minor" ? "warning" : "failure",
      title: clip(
        `${finding.severity.toUpperCase()} · ${finding.title}`,
        ANNOTATION_TITLE_LIMIT,
      ),
      message: clip(
        `${finding.trigger}\n\nImpact: ${finding.impact}\n\nFix: ${finding.suggestion}`,
        ANNOTATION_MESSAGE_LIMIT,
      ),
    }));
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const markerReserve = 100;
  const kept = Math.max(0, limit - markerReserve);
  return `${text.slice(0, kept)}\n\n… [truncated ${text.length - kept} chars; see the evidence JSON artifact]`;
}
