import {
  closesFence,
  openingFence,
  reviewDslMarkers,
} from "./review-dsl-lexer.js";

export interface ReviewDslRepair {
  document: string;
  repairs: string[];
}

/**
 * Fixes only unambiguous syntax slips before parsing, and names each fix.
 * It never invents prose, reorders records, or touches prose bodies; when a
 * slip is not clearly one of the known kinds the text is left for the parser
 * to reject with a positioned error.
 */
export function repairReviewDsl(document: string): ReviewDslRepair {
  const lines = document.replace(/\r\n/g, "\n").split("\n");
  const headerIndex = lines.findIndex(isDocumentHeader);
  if (headerIndex === -1) return unchanged(document);

  const leading = lines.slice(0, headerIndex);
  const outerFence = leadingOuterFence(leading);
  const afterHeader = withoutClosingOuterFence(
    lines.slice(headerIndex + 1),
    outerFence,
  );
  const scan = scanRecords(afterHeader);
  if (scan.endIndex === -1 && !endsAfterCompleteRecord(scan)) {
    return unchanged(document);
  }

  const notes = new RepairNotes();
  noteRemovedSurroundings(notes, leading, outerFence, afterHeader, scan);

  const header = lines[headerIndex] ?? "";
  const canonicalHeader = header.trim().toUpperCase().startsWith("PERSONALITY")
    ? "PERSONALITY v1"
    : "REVIEW v1";
  if (header !== canonicalHeader) notes.add("header", headerIndex + 1);

  const body = scan.lines;
  if (scan.endIndex === -1) {
    body.push("END");
    notes.addFinalSentence("Added missing END after the last record.");
  }
  for (const fix of scan.fixes) notes.add(fix.kind, fix.line);

  const repairs = notes.sentences();
  if (repairs.length === 0) return unchanged(document);
  return { document: [canonicalHeader, ...body].join("\n"), repairs };
}

function unchanged(document: string): ReviewDslRepair {
  return { document, repairs: [] };
}

// ----- Document surroundings -----

function isDocumentHeader(line: string): boolean {
  return /^(?:REVIEW|PERSONALITY)\s+v1$/i.test(line.trim());
}

/** The fence opened directly before the header, when the model wrapped the document. */
function leadingOuterFence(leading: string[]): string | null {
  const last = leading.filter((line) => line.trim()).at(-1);
  if (last === undefined) return null;
  return openingFence(last);
}

/** Drops a closing outer fence (and blank lines after it) at the very end of the text. */
function withoutClosingOuterFence(
  lines: string[],
  outerFence: string | null,
): string[] {
  if (outerFence === null) return lines;
  const lastIndex = lastNonBlankIndex(lines);
  const last = lines[lastIndex];
  if (last === undefined || !closesFence(last, outerFence)) return lines;
  return lines.slice(0, lastIndex);
}

function lastNonBlankIndex(lines: string[]): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim()) return index;
  }
  return -1;
}

function noteRemovedSurroundings(
  notes: RepairNotes,
  leading: string[],
  outerFence: string | null,
  afterHeader: string[],
  scan: RecordScan,
): void {
  const leadingProse =
    leading.filter((line) => line.trim()).length -
    (outerFence === null ? 0 : 1);
  const trailing =
    scan.endIndex === -1 ? [] : afterHeader.slice(scan.endIndex + 1);
  const trailingFence =
    outerFence !== null &&
    trailing.some((line) => closesFence(line, outerFence));
  const trailingProse =
    trailing.filter((line) => line.trim()).length - (trailingFence ? 1 : 0);

  if (outerFence !== null)
    notes.addSentence("Removed the outer Markdown fence around the document.");
  if (leadingProse > 0)
    notes.addSentence(
      `Removed ${leadingProse} line(s) of text before the document header.`,
    );
  if (trailingProse > 0)
    notes.addSentence(`Removed ${trailingProse} line(s) of text after END.`);
}

// ----- Record scan -----

type FixKind =
  | "header"
  | "marker-case"
  | "trailing-pipe"
  | "enum-case"
  | "path-backticks"
  | "disposition"
  | "evidence-backticks"
  | "evidence-commas";

interface Fix {
  kind: FixKind;
  line: number;
}

interface LastRecord {
  marker: string;
  fields: string[];
  bodyLines: string[];
}

interface RecordScan {
  /** Lines from after the header up to (and including) END, with header fixes applied. */
  lines: string[];
  /** Index of END within the scanned lines, or -1 when END is missing. */
  endIndex: number;
  fixes: Fix[];
  last: LastRecord | null;
  openFence: boolean;
}

/** Walks the records the same way the lexer does: code fences and backslash-escaped lines stay prose. */
function scanRecords(lines: string[]): RecordScan {
  const scanned: string[] = [];
  const fixes: Fix[] = [];
  let last: LastRecord | null = null;
  let fence: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const number = index + 2;
    if (fence !== null) {
      scanned.push(line);
      last?.bodyLines.push(line);
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    const opened = openingFence(line);
    if (opened !== null || /^[ \t]*\\/.test(line)) {
      scanned.push(line);
      last?.bodyLines.push(line);
      fence = opened;
      continue;
    }
    const header = readHeader(line);
    if (header === null) {
      scanned.push(line);
      last?.bodyLines.push(line);
      continue;
    }
    const repaired = repairHeader(header);
    for (const kind of repaired.fixes) fixes.push({ kind, line: number });
    scanned.push(repaired.fixes.length > 0 ? repaired.text : line);
    if (repaired.marker === "END") {
      return { lines: scanned, endIndex: index, fixes, last, openFence: false };
    }
    last = { marker: repaired.marker, fields: repaired.fields, bodyLines: [] };
  }
  while (scanned.length > 0 && !scanned.at(-1)?.trim()) scanned.pop();
  return {
    lines: scanned,
    endIndex: -1,
    fixes,
    last,
    openFence: fence !== null,
  };
}

const headerOnlyMarkers = new Set(["EVIDENCE", "RISK"]);
const gradeMarkers = new Set(["ARCHITECTURE", "TESTS"]);
/** Prose records that may end a document; finding sections and reasoned records still need their EVIDENCE line. */
const finalProseMarkers = new Set([
  "SUMMARY",
  "QUESTION",
  "TAKE",
  "ARCHITECTURE",
  "TESTS",
]);

/**
 * END may be added only when nothing looks cut off: the last record is a
 * header-only record with no trailing text, or a record that may end a
 * document whose prose ends a sentence outside any code fence.
 */
function endsAfterCompleteRecord(scan: RecordScan): boolean {
  const last = scan.last;
  if (last === null || scan.openFence) return false;
  const prose = last.bodyLines.filter((line) => line.trim());
  const headerOnly =
    headerOnlyMarkers.has(last.marker) ||
    (gradeMarkers.has(last.marker) && last.fields[0] === "none");
  if (headerOnly) return prose.length === 0;
  if (!finalProseMarkers.has(last.marker)) return false;
  const finalLine = prose.at(-1)?.trim();
  return finalLine !== undefined && /[.!?]$/.test(finalLine);
}

// ----- Header lines -----

interface RawHeader {
  name: string;
  /** Raw field text between unescaped pipes, escapes preserved. */
  fields: string[];
  trailingPipe: boolean;
}

function readHeader(line: string): RawHeader | null {
  const trimmed = line.trim();
  const name = /^([A-Za-z][A-Za-z0-9_-]*)(?=[ \t]*\||$)/.exec(trimmed)?.[1];
  if (name === undefined || !reviewDslMarkers.has(name.toUpperCase()))
    return null;
  const parts = splitRawFields(trimmed.slice(name.length));
  const trailingPipe = parts.length > 1 && parts.at(-1) === "";
  if (trailingPipe) parts.pop();
  const [, ...fields] = parts;
  return { name, fields, trailingPipe };
}

/** Splits on unescaped pipes; the first part is whatever precedes the first pipe. */
function splitRawFields(text: string): string[] {
  const parts: string[] = [];
  let part = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (character === "\\" && (next === "\\" || next === "|")) {
      part += character + next;
      index += 1;
    } else if (character === "|") {
      parts.push(part.trim());
      part = "";
    } else if (character !== undefined) {
      part += character;
    }
  }
  parts.push(part.trim());
  return parts;
}

interface RepairedHeader {
  marker: string;
  fields: string[];
  text: string;
  fixes: FixKind[];
}

function repairHeader(header: RawHeader): RepairedHeader {
  const marker = header.name.toUpperCase();
  // An empty field inside a header is ambiguous, so the line is left for the parser to reject.
  if (header.fields.some((value) => value === ""))
    return render(marker, header.fields, []);

  const fixes: FixKind[] = [];
  if (header.name !== marker) fixes.push("marker-case");
  if (header.trailingPipe) fixes.push("trailing-pipe");
  let fields = repairEnumCase(marker, header.fields, fixes);
  fields = repairPaths(marker, fields, fixes);
  fields = repairMissingDisposition(marker, fields, fixes);
  if (marker === "EVIDENCE") fields = repairEvidenceIds(fields, fixes);
  return render(marker, fields, fixes);
}

function render(
  marker: string,
  fields: string[],
  fixes: FixKind[],
): RepairedHeader {
  return {
    marker,
    fields,
    text: [marker, ...fields].join(" | "),
    fixes,
  };
}

const enumFields: Readonly<
  Record<string, ReadonlyArray<readonly [number, readonly string[]]>>
> = {
  RISK: [[0, ["low", "medium", "high"]]],
  ARCHITECTURE: [[0, ["none", "A", "B", "C", "D", "F"]]],
  TESTS: [[0, ["none", "A", "B", "C", "D", "F"]]],
  FINDING: [
    [1, ["critical", "major", "minor"]],
    [4, ["LEFT", "RIGHT"]],
    [5, ["blocking", "follow-up"]],
  ],
  COVERAGE: [[1, ["inspected", "partial", "unreviewed"]]],
  PRIOR: [[1, ["still-open", "resolved", "rejected", "unverified"]]],
  CANDIDATE: [[1, ["confirmed", "rejected", "unverified"]]],
};

function repairEnumCase(
  marker: string,
  fields: string[],
  fixes: FixKind[],
): string[] {
  const positions = enumFields[marker];
  if (positions === undefined) return fields;
  const repaired = [...fields];
  for (const [position, values] of positions) {
    const value = repaired[position];
    if (value === undefined) continue;
    const canonical = values.find(
      (candidate) => candidate.toLowerCase() === value.toLowerCase(),
    );
    if (canonical !== undefined && canonical !== value) {
      repaired[position] = canonical;
      if (!fixes.includes("enum-case")) fixes.push("enum-case");
    }
  }
  return repaired;
}

const pathPositions: Readonly<Record<string, number>> = {
  FINDING: 2,
  COVERAGE: 0,
};

function repairPaths(
  marker: string,
  fields: string[],
  fixes: FixKind[],
): string[] {
  const position = pathPositions[marker];
  if (position === undefined) return fields;
  const value = fields[position];
  if (value === undefined) return fields;
  const unwrapped = withoutBackticks(value);
  if (unwrapped === null) return fields;
  const repaired = [...fields];
  repaired[position] = unwrapped;
  fixes.push("path-backticks");
  return repaired;
}

/** `value` → value when exactly one pair of backticks wraps nonblank text. */
function withoutBackticks(value: string): string | null {
  const match = /^`([^`]+)`$/.exec(value);
  const inner = match?.[1];
  if (inner === undefined || !inner.trim()) return null;
  return inner.trim();
}

/**
 * A FINDING with every field but the last is missing only its disposition
 * when the other fields already read as severity, line, and side.
 */
function repairMissingDisposition(
  marker: string,
  fields: string[],
  fixes: FixKind[],
): string[] {
  if (marker !== "FINDING" || fields.length !== 5) return fields;
  const severity = fields[1];
  const line = fields[3];
  const side = fields[4];
  const readsAsFinding =
    (side === "LEFT" || side === "RIGHT") &&
    line !== undefined &&
    /^[1-9]\d*$/.test(line);
  if (!readsAsFinding) return fields;
  const disposition =
    severity === "critical" || severity === "major"
      ? "blocking"
      : severity === "minor"
        ? "follow-up"
        : null;
  if (disposition === null) return fields;
  fixes.push("disposition");
  return [...fields, disposition];
}

/** Evidence IDs never contain commas, backticks, or whitespace, so these splits are unambiguous. */
function repairEvidenceIds(fields: string[], fixes: FixKind[]): string[] {
  const repaired: string[] = [];
  for (const value of fields) {
    const pieces = value.includes(",")
      ? value.split(",").map((piece) => piece.trim())
      : [value];
    if (pieces.some((piece) => piece === "")) return fields;
    if (pieces.length > 1 && !fixes.includes("evidence-commas"))
      fixes.push("evidence-commas");
    for (const piece of pieces) {
      const unwrapped = withoutBackticks(piece);
      if (unwrapped !== null && !/\s/.test(unwrapped)) {
        if (!fixes.includes("evidence-backticks"))
          fixes.push("evidence-backticks");
        repaired.push(unwrapped);
      } else repaired.push(piece);
    }
  }
  return repaired;
}

// ----- Repair sentences -----

const fixSentences: Readonly<Record<FixKind, string>> = {
  header: "Normalized the document header",
  "marker-case": "Uppercased record markers",
  "trailing-pipe": "Removed a trailing pipe from record headers",
  "enum-case": "Normalized the case of enum values",
  "path-backticks": "Removed backticks around paths",
  disposition:
    "Added the missing FINDING disposition from its severity (blocking for critical/major, follow-up for minor)",
  "evidence-backticks": "Removed backticks around EVIDENCE IDs",
  "evidence-commas": "Split comma-separated EVIDENCE IDs into pipe fields",
};

/** Collects fixes by kind so each kind becomes one sentence naming its lines. */
class RepairNotes {
  private readonly leadingSentences: string[] = [];
  private readonly trailingSentences: string[] = [];
  private readonly linesByKind = new Map<FixKind, number[]>();

  addSentence(sentence: string): void {
    this.leadingSentences.push(sentence);
  }

  /** A sentence listed after the per-kind fixes, such as the added END. */
  addFinalSentence(sentence: string): void {
    this.trailingSentences.push(sentence);
  }

  add(kind: FixKind, line: number): void {
    const lines = this.linesByKind.get(kind) ?? [];
    lines.push(line);
    this.linesByKind.set(kind, lines);
  }

  sentences(): string[] {
    const byKind = [...this.linesByKind].map(([kind, lines]) => {
      const label = lines.length === 1 ? "line" : "lines";
      return `${fixSentences[kind]} (${label} ${lines.join(", ")}).`;
    });
    return [...this.leadingSentences, ...byKind, ...this.trailingSentences];
  }
}
