import type { GusConfig } from "../config/config-schema.js";
import type { ReviewSubject } from "../review/review-ports.js";
import type { ReviewFinding, ReviewResult } from "../review/review-schema.js";
import { formatModelUsage } from "./logic/format-model-usage.js";
import {
  addReportIdentity,
  formatFindingMarker,
  formatReviewState,
  stateFromReview,
} from "./review-state.js";

/** Renders all findings and verification limits, independently of inline publication or personality. */
export function formatReviewMarkdown(
  review: ReviewResult,
  subject: ReviewSubject,
  config: GusConfig,
): string {
  const verdict =
    review.verdict === "ready"
      ? "No blocking findings identified"
      : review.verdict === "changes-requested"
        ? "Changes requested by the reviewer"
        : "Review incomplete";
  const sections = [
    `## ${escapeMarkdown(config.name)} review`,
    "",
    `**${verdict}**`,
    "",
    escapeMarkdown(review.summary),
    "",
    `Reviewed HEAD \`${escapeCode(review.snapshot.headSha)}\` against base \`${escapeCode(review.snapshot.baseSha)}\`.`,
    `Comparison: \`${escapeCode(review.snapshot.comparisonBaseSha)}\`. Integration: **${review.snapshot.integration.status}**.`,
    "",
  ];

  if (review.verdict !== "incomplete" && config.review.scorecard) {
    sections.push(
      "### Scorecard",
      "",
      "| Size | Architecture | Tests | Risk |",
      "| --- | --- | --- | --- |",
      `| ${review.size} | ${review.architecture?.grade ?? "Not graded"} | ${review.tests?.grade ?? "Not graded"} | ${review.risk} |`,
      "",
    );
    if (review.architecture)
      sections.push(
        `Architecture: ${escapeMarkdown(review.architecture.reason)}`,
        "",
      );
    if (review.tests)
      sections.push(`Tests: ${escapeMarkdown(review.tests.reason)}`, "");
  }
  if (review.verdict === "incomplete")
    sections.push(
      "No approval or merge-readiness conclusion is issued for an incomplete review.",
      "",
    );

  sections.push("### Findings", "");
  if (review.findings.length === 0)
    sections.push(
      review.verdict === "incomplete"
        ? "No validated findings are available from this incomplete review."
        : "No findings.",
      "",
    );
  for (const finding of review.findings)
    sections.push(formatFindingMarkdown(finding, review, subject), "");

  if (review.reconciliations.length > 0) {
    sections.push("### Previous findings", "");
    for (const resolution of review.reconciliations)
      sections.push(
        `- \`${escapeCode(resolution.id)}\`: **${resolution.status}** — ${escapeMarkdown(resolution.reason)}${resolution.evidenceIds.length ? ` Evidence: ${resolution.evidenceIds.map((id) => `\`${escapeCode(id)}\``).join(", ")}.` : ""}`,
      );
    sections.push("");
  }
  if (review.snapshot.advisories.length > 0) {
    sections.push("### Branch advice", "");
    for (const advisory of review.snapshot.advisories)
      sections.push(
        `- ${escapeMarkdown(advisory.message)} ${escapeMarkdown(advisory.evidence)} Action: ${advisory.action}.`,
      );
    sections.push("");
  }
  if (review.questions.length > 0)
    sections.push(
      "### Open questions",
      "",
      ...review.questions.map((question) => `- ${escapeMarkdown(question)}`),
      "",
    );

  sections.push("### Verification", "");
  if (review.checks.length === 0)
    sections.push(
      "No executed check results were supplied. Source review does not establish passing CI or deployed behavior.",
    );
  for (const check of review.checks) {
    const status =
      check.headSha === review.snapshot.headSha
        ? check.status
        : "inconclusive (different HEAD)";
    sections.push(
      `- **${escapeMarkdown(check.name)}: ${status}** — ${escapeMarkdown(check.details)}${check.url ? ` [Evidence](${safeUrl(check.url)})` : ""}`,
    );
  }
  sections.push("");
  const counts = { inspected: 0, partial: 0, excluded: 0, unreviewed: 0 };
  for (const file of review.coverage) counts[file.status] += 1;
  sections.push(
    `Coverage: ${counts.inspected} inspected, ${counts.partial} partial, ${counts.excluded} excluded, ${counts.unreviewed} unreviewed.`,
    "",
  );
  for (const file of review.coverage.filter(
    (entry) => entry.status !== "inspected",
  ))
    sections.push(
      `- \`${escapeCode(file.path)}\` — ${file.status}: ${escapeMarkdown(file.reason)}`,
    );
  if (review.limitations.length > 0)
    sections.push(
      "",
      "### Limitations",
      "",
      ...review.limitations.map(
        (limitation) => `- ${escapeMarkdown(limitation)}`,
      ),
    );

  if (config.personality.enabled && review.personality.trim())
    sections.push(
      "",
      `### ${escapeMarkdown(config.name)}'s take`,
      "",
      `> ${escapeMarkdown(review.personality.replace(/\s+/g, " ").trim())}`,
    );
  const usage = review.usage;
  const accounting =
    usage.usageComplete === false
      ? "Token accounting is incomplete."
      : `${usage.inputTokens} input / ${usage.outputTokens} output tokens.`;
  const cost =
    usage.costUsd === null
      ? "Cost unavailable."
      : `Reported cost: $${usage.costUsd.toFixed(4)}${usage.usageComplete === false ? " (partial accounting)" : ""}.`;
  sections.push(
    "",
    "---",
    "",
    `Models: ${usage.models.map((model) => `\`${escapeCode(model)}\``).join(", ") || "none"}. ${usage.requests} requests, ${usage.toolCalls} tool calls. ${accounting} ${cost}`,
    "",
    ...formatModelUsage(usage.calls ?? []),
    "",
    formatReviewState(stateFromReview(review)),
  );
  return addReportIdentity(
    sections
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

export function formatFindingMarkdown(
  finding: ReviewFinding,
  review?: ReviewResult,
  subject?: ReviewSubject,
): string {
  const location = `\`${escapeCode(finding.path)}:${finding.line} (${finding.side})\``;
  const lines = [
    `#### ${finding.severity.toUpperCase()} · ${escapeMarkdown(finding.title)}`,
    "",
    `${location} · **${finding.disposition}** · \`${escapeCode(finding.id)}\``,
    "",
    `**Trigger:** ${escapeMarkdown(finding.trigger)}`,
    "",
    `**Impact:** ${escapeMarkdown(finding.impact)}`,
    "",
    `**Suggested change:** ${escapeMarkdown(finding.suggestion)}`,
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
  if (!evidence || !subject?.url || !subject.repository)
    return `\`${escapeCode(id)}\``;
  try {
    const origin = new URL(subject.url).origin;
    const filePath = evidence.path.split("/").map(encodeURIComponent).join("/");
    return `[${escapeMarkdown(id)}](${origin}/${subject.repository}/blob/${encodeURIComponent(evidence.sha)}/${filePath}#L${evidence.startLine})`;
  } catch {
    return `\`${escapeCode(id)}\``;
  }
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href.replace(/\(/g, "%28").replace(/\)/g, "%29")
      : "#";
  } catch {
    return "#";
  }
}
function escapeCode(value: string): string {
  return value.replace(/`/g, "'").replace(/[\r\n]/g, " ");
}
function escapeMarkdown(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "@\u200b")
    .replace(/([\\`*_[\]])/g, "\\$1");
}
