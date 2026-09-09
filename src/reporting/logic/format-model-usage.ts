import type { ReviewStage } from "../../config/config-schema.js";
import type { ReviewModelCallUsage } from "../../review/review-schema.js";

const stages: ReviewStage[] = [
  "triage",
  "investigate",
  "validate",
  "report",
  "personality",
];

/** Summarizes provider accounting by stage while keeping unknown totals explicit. */
export function formatModelUsage(calls: ReviewModelCallUsage[]): string[] {
  if (calls.length === 0) return [];
  const rows = stages.flatMap((stage) => {
    const stageCalls = calls.filter((call) => call.stage === stage);
    if (stageCalls.length === 0) return [];
    const attempts = stageCalls.reduce((sum, call) => sum + call.attempts, 0);
    const tools = stageCalls.reduce(
      (sum, call) => sum + call.toolNames.length,
      0,
    );
    const elapsedMs = stageCalls.reduce((sum, call) => sum + call.elapsedMs, 0);
    const inputTokens = sumKnown(stageCalls.map((call) => call.inputTokens));
    const outputTokens = sumKnown(stageCalls.map((call) => call.outputTokens));
    const costUsd = sumKnown(stageCalls.map((call) => call.costUsd));
    const cost = costUsd === null ? "Unknown" : `$${costUsd.toFixed(4)}`;
    return [
      `| ${stage} | ${stageCalls.length} | ${attempts} | ${tools} | ${inputTokens ?? "Unknown"} | ${outputTokens ?? "Unknown"} | ${cost} | ${(elapsedMs / 1000).toFixed(2)}s |`,
    ];
  });
  const sections = [
    "<details>",
    "<summary>Model usage by stage</summary>",
    "",
    "| Stage | Calls | Attempts | Tools | Input tokens | Output tokens | Cost | Time |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "Attempts include provider retries. Tools counts model-requested invocations.",
  ];
  const failedCalls = calls.filter((call) => call.status === "failed").length;
  if (failedCalls > 0)
    sections.push(
      "",
      `${failedCalls} failed call${failedCalls === 1 ? "" : "s"}.`,
    );
  if (
    calls.some(
      (call) =>
        call.inputTokens === null ||
        call.outputTokens === null ||
        call.costUsd === null,
    )
  )
    sections.push(
      "",
      "Unknown totals include at least one call without provider accounting.",
    );
  sections.push("", "</details>");
  return sections;
}

function sumKnown(values: Array<number | null>): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null || !Number.isFinite(value) || value < 0) return null;
    total += value;
  }
  return Number.isFinite(total) ? total : null;
}
