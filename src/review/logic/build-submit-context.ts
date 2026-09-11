import type { ModelMessage } from "../review-ports.js";

export interface SubmitContextLimits {
  maxSubmitContextChars: number;
  maxSubmitSeedChars: number;
}

/** Rebuilds a lean submit payload so REVIEW v1 is not authored inside a fat tool conversation. */
export function buildCompactSubmitContent(
  stageContent: string,
  investigationMessages: readonly ModelMessage[],
  limits: SubmitContextLimits,
): string {
  const notes = collectInvestigationNotes(investigationMessages);
  const seed = truncateText(stageContent, limits.maxSubmitSeedChars);
  const sections = [
    "# Compact submit",
    "",
    "Investigation is finished. Write the host's REVIEW v1 DSL. Do not call tools.",
    "The host owns coverage from seed patches and recorded inspections. Omit COVERAGE unless you need to downgrade a file.",
    "",
    "## Investigation notes",
    notes ||
      "(No separate investigation notes. Use the evidence IDs already in the seed.)",
    "",
    "## Stage input",
    seed,
  ];
  const joined = sections.join("\n");
  if (joined.length <= limits.maxSubmitContextChars) return joined;
  return truncateText(joined, limits.maxSubmitContextChars);
}

export function conversationHasToolResults(
  messages: readonly ModelMessage[],
): boolean {
  return messages.some((message) => message.role === "tool");
}

function collectInvestigationNotes(messages: readonly ModelMessage[]): string {
  const notes: string[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.content.trim()) {
      notes.push(truncateText(message.content.trim(), 4000));
    }
    if (message.role === "tool") {
      notes.push(truncateText(`Tool result: ${message.content}`, 2000));
    }
  }
  return truncateText(notes.join("\n\n"), 40_000);
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const suffix = "\n[truncated for submit context]";
  return `${text.slice(0, Math.max(maxChars - suffix.length, 0))}${suffix}`;
}
