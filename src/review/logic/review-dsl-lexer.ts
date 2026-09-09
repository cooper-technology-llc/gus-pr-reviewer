export interface ReviewDslRecord {
  marker: string;
  fields: string[];
  body: string[];
  line: number;
}

export interface ReviewDslDocument {
  header: "REVIEW" | "PERSONALITY";
  records: ReviewDslRecord[];
}

export class ReviewDslError extends Error {
  constructor(message: string, line?: number) {
    super(`DSL${line === undefined ? "" : ` line ${line}`}: ${message}`);
    this.name = "ReviewDslError";
  }
}

const markers = new Set([
  "SUMMARY",
  "RISK",
  "ARCHITECTURE",
  "TESTS",
  "QUESTION",
  "FINDING",
  "TITLE",
  "TRIGGER",
  "IMPACT",
  "FIX",
  "EVIDENCE",
  "COVERAGE",
  "PRIOR",
  "CANDIDATE",
  "TAKE",
  "END",
]);

/** Removes one complete outer Markdown fence without interpreting prose escapes. */
export function unwrapReviewOutput(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  const lines = normalized.split("\n");
  const first = lines[0];
  if (first === undefined) return normalized;
  const fence = openingFence(first);
  if (fence === null) return normalized;
  const last = lines.at(-1);
  if (lines.length < 3 || last === undefined || !closesFence(last, fence)) {
    throw new ReviewDslError("The outer Markdown fence is not closed.");
  }
  return lines.slice(1, -1).join("\n").trim();
}

/** Reads complete DSL records while retaining multiline prose and fenced code verbatim. */
export function readReviewDsl(content: string): ReviewDslDocument {
  const lines = unwrapReviewOutput(content).split("\n");
  const header = documentHeader(lines[0]);
  const records: ReviewDslRecord[] = [];
  let current: ReviewDslRecord | undefined;
  let fence: string | null = null;
  let ended = false;

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const number = index + 1;
    if (ended) {
      if (line.trim())
        throw new ReviewDslError("Nothing may follow END.", number);
      continue;
    }
    if (fence !== null) {
      appendProse(current, line, number);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const escaped = escapedMarker(line);
    if (escaped !== null) {
      appendProse(current, escaped, number);
      continue;
    }
    const opened = openingFence(line);
    if (opened !== null) {
      appendProse(current, line, number);
      fence = opened;
      continue;
    }
    if (/^(?:REVIEW|PERSONALITY)\s+v\S+$/i.test(line.trim())) {
      throw new ReviewDslError("Only one document header is allowed.", number);
    }
    const record = recordHeader(line, number);
    if (record === null) {
      if (line.trim() || current !== undefined)
        appendProse(current, line, number);
      continue;
    }
    if (record.marker === "END") {
      if (record.fields.length > 0)
        throw new ReviewDslError("END takes no fields.", number);
      ended = true;
      continue;
    }
    records.push(record);
    current = record;
  }

  if (fence !== null)
    throw new ReviewDslError("A prose code fence is not closed.");
  if (!ended) throw new ReviewDslError("Missing required END terminator.");
  return { header, records };
}

function documentHeader(line: string | undefined): ReviewDslDocument["header"] {
  if (line?.trim().toUpperCase() === "REVIEW V1") return "REVIEW";
  if (line?.trim().toUpperCase() === "PERSONALITY V1") return "PERSONALITY";
  throw new ReviewDslError("Begin with REVIEW v1 or PERSONALITY v1.", 1);
}

function recordHeader(line: string, number: number): ReviewDslRecord | null {
  const trimmed = line.trim();
  const name = /^([A-Za-z][A-Za-z0-9_-]*)(?=[ \t]*\||$)/.exec(trimmed)?.[1];
  if (name === undefined) return null;
  const marker = name.toUpperCase();
  if (!markers.has(marker)) {
    if (markerShaped(trimmed))
      throw new ReviewDslError(`Unknown marker ${name}.`, number);
    return null;
  }
  const fields = splitHeaderFields(trimmed).slice(1);
  if (fields.some((field) => field.length === 0)) {
    throw new ReviewDslError(
      `${marker} contains an empty header field.`,
      number,
    );
  }
  return { marker, fields, body: [], line: number };
}

function splitHeaderFields(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const next = line[index + 1];
    if (character === "\\" && (next === "\\" || next === "|")) {
      field += next;
      index += 1;
    } else if (character === "|") {
      fields.push(field.trim());
      field = "";
    } else if (character !== undefined) {
      field += character;
    }
  }
  fields.push(field.trim());
  if (fields.at(-1) === "") fields.pop();
  return fields;
}

function appendProse(
  current: ReviewDslRecord | undefined,
  line: string,
  number: number,
): void {
  if (current === undefined)
    throw new ReviewDslError("Prose needs a record marker first.", number);
  current.body.push(line);
}

function escapedMarker(line: string): string | null {
  const match = /^([ \t]*)\\(.*)$/.exec(line);
  const prefix = match?.[1];
  const rest = match?.[2];
  if (prefix === undefined || rest === undefined || !markerShaped(rest.trim()))
    return null;
  return prefix + rest;
}

function markerShaped(line: string): boolean {
  return (
    markers.has(line.toUpperCase()) ||
    /^[A-Z][A-Z0-9_-]*$/.test(line) ||
    /^[A-Za-z][A-Za-z0-9_-]*[ \t]*\|/.test(line) ||
    /^(?:REVIEW|PERSONALITY)\s+v\S+$/i.test(line)
  );
}

function openingFence(line: string): string | null {
  return /^[ \t]*(`{3,}|~{3,})[^`~]*$/.exec(line)?.[1] ?? null;
}

function closesFence(line: string, fence: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.length >= fence.length &&
    [...trimmed].every((character) => character === fence[0])
  );
}
