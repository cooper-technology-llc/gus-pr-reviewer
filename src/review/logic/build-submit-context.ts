import { GusError } from "../../errors.js";
import type { ModelMessage } from "../review-ports.js";

export interface SubmitContextLimits {
  maxSubmitContextChars: number;
  maxSubmitSeedChars: number;
}

interface SubmitSection {
  name: string;
  content: unknown;
}

interface SubmitPayload {
  title: string;
  stageInput: SubmitSection[];
  investigationNotes: SubmitSection[];
  omittedSections: string[];
}

/** Keeps complete submit records and explicitly names omissions without cutting JSON or source text. */
export function buildCompactSubmitContent(
  stageContent: string,
  investigationMessages: readonly ModelMessage[],
  limits: SubmitContextLimits,
): string {
  const payload: SubmitPayload = {
    title: "Compact submit",
    stageInput: [],
    investigationNotes: [],
    omittedSections: [],
  };
  let seedChars = 0;
  for (const section of stageSections(stageContent)) {
    const size = JSON.stringify(section).length;
    if (seedChars + size > limits.maxSubmitSeedChars) {
      payload.omittedSections.push(section.name);
      continue;
    }
    payload.stageInput.push(section);
    if (
      serialize(payload, limits.maxSubmitContextChars).length >
      limits.maxSubmitContextChars
    ) {
      payload.stageInput.pop();
      payload.omittedSections.push(section.name);
    } else {
      seedChars += size;
    }
  }
  for (const section of investigationNotes(investigationMessages).reverse()) {
    payload.investigationNotes.unshift(section);
    if (
      serialize(payload, limits.maxSubmitContextChars).length >
      limits.maxSubmitContextChars
    ) {
      payload.investigationNotes.shift();
      payload.omittedSections.push(section.name);
    }
  }
  let content = serialize(payload, limits.maxSubmitContextChars);
  while (content.length > limits.maxSubmitContextChars) {
    const removed =
      payload.investigationNotes.shift() ?? payload.stageInput.pop();
    if (!removed)
      throw new GusError(
        "BUDGET_EXCEEDED",
        "The compact submit limit cannot fit a complete omission record.",
      );
    payload.omittedSections.push(removed.name);
    content = serialize(payload, limits.maxSubmitContextChars);
  }
  return content;
}

export function conversationHasToolResults(
  messages: readonly ModelMessage[],
): boolean {
  return messages.some((message) => message.role === "tool");
}

function stageSections(content: string): SubmitSection[] {
  const parsed = parseContent(content);
  if (!isRecord(parsed)) return [{ name: "stageInput", content: parsed }];
  const sections: SubmitSection[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (name === "reviewInput" && isRecord(value)) {
      for (const [field, entry] of Object.entries(value))
        sections.push({ name: `reviewInput.${field}`, content: entry });
    } else {
      sections.push({ name, content: value });
    }
  }
  return sections.sort(
    (left, right) => sectionPriority(left.name) - sectionPriority(right.name),
  );
}

function sectionPriority(name: string): number {
  if (name === "candidateAssessment" || /prior|reconcil/i.test(name)) return 0;
  if (/polic|snapshot|subject|triage|risk|severity/i.test(name)) return 1;
  return 2;
}

function investigationNotes(
  messages: readonly ModelMessage[],
): SubmitSection[] {
  const sources = new Map<string, string>();
  const notes: SubmitSection[] = [];
  for (const [index, message] of messages.entries()) {
    const parsed = parseContent(message.content);
    if (
      isRecord(parsed) &&
      parsed.format === "gus-context-v1" &&
      Array.isArray(parsed.sourceTexts)
    ) {
      for (const source of parsed.sourceTexts) {
        if (
          isRecord(source) &&
          typeof source.id === "string" &&
          typeof source.text === "string"
        )
          sources.set(source.id, source.text);
      }
    }
    if (
      (message.role === "assistant" || message.role === "tool") &&
      message.content.trim()
    )
      notes.push({
        name: `${message.role}-${index + 1}`,
        content: expandSources(parsed, sources),
      });
  }
  return notes;
}

function expandSources(value: unknown, sources: Map<string, string>): unknown {
  if (Array.isArray(value))
    return value.map((entry: unknown) => expandSources(entry, sources));
  if (!isRecord(value)) return value;
  if (typeof value.textRef === "string") {
    const text = sources.get(value.textRef);
    if (text === undefined)
      throw new GusError(
        "PROVIDER_PROTOCOL",
        "A compact submit source reference has no recorded definition.",
      );
    return text;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "sourceTexts")
      .map(([key, entry]) => [key, expandSources(entry, sources)]),
  );
}

function serialize(payload: SubmitPayload, maxChars: number): string {
  const full = JSON.stringify(payload);
  if (full.length <= maxChars || payload.omittedSections.length === 0)
    return full;
  return JSON.stringify({
    ...payload,
    omittedSections: [
      `${payload.omittedSections.length} complete sections omitted for submit limits; no partial records supplied.`,
    ],
  });
}

function parseContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
