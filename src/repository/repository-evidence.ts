import { createHash } from "node:crypto";
import type { FileRead, ToolExecution } from "../review/review-ports.js";
import type {
  ChangedFile,
  ReviewEvidence,
  ReviewSnapshot,
} from "../review/review-schema.js";

/** Evidence IDs bind exact returned text to its immutable revision and source coordinates. */
export function identifyEvidence(
  evidence: Omit<ReviewEvidence, "id">,
): ReviewEvidence {
  const digest = createHash("sha256")
    .update(JSON.stringify(evidence))
    .digest("hex")
    .slice(0, 16);
  return {
    id: `${evidence.kind}:${evidence.sha}:${encodeURIComponent(evidence.path)}:${evidence.startLine}-${evidence.endLine}:${digest}`,
    ...evidence,
  };
}

export function fileEvidence(file: FileRead): ReviewEvidence {
  return identifyEvidence({
    path: file.path,
    revision: file.revision,
    sha: file.sha,
    startLine: file.startLine,
    endLine: file.endLine,
    text: file.text,
    kind: "file",
    truncated: file.truncated,
  });
}

/** Parses hunk coordinates before selecting a patch page, preserving LEFT/RIGHT source locations. */
export function diffEvidence(
  patch: string,
  file: ChangedFile,
  snapshot: ReviewSnapshot,
  startRow: number,
  rowCount: number,
  truncated: boolean,
): ReviewEvidence[] {
  const records: ReviewEvidence[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let oldSource: Array<{ line: number; text: string }> = [];
  let newSource: Array<{ line: number; text: string }> = [];
  const flush = () => {
    for (const [revision, source] of [
      ["parent", oldSource],
      ["head", newSource],
    ] satisfies Array<
      ["parent" | "head", Array<{ line: number; text: string }>]
    >) {
      const first = source[0];
      const last = source.at(-1);
      if (first === undefined || last === undefined) continue;
      records.push(
        identifyEvidence({
          path:
            revision === "parent"
              ? (file.previousPath ?? file.path)
              : file.path,
          revision,
          sha:
            revision === "parent"
              ? snapshot.comparisonBaseSha
              : snapshot.headSha,
          startLine: first.line,
          endLine: last.line,
          text: source.map((line) => line.text).join("\n"),
          kind: "diff",
          truncated,
        }),
      );
    }
    oldSource = [];
    newSource = [];
  };
  for (const [index, row] of patch.split("\n").entries()) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (header !== null) {
      flush();
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      continue;
    }
    if (row.startsWith("diff --git ")) {
      flush();
      inHunk = false;
    }
    if (!inHunk || row.startsWith("\\")) continue;
    const visible = index + 1 >= startRow && index + 1 < startRow + rowCount;
    if (row.startsWith(" ") || row.startsWith("-")) {
      if (visible) oldSource.push({ line: oldLine, text: row.slice(1) });
      oldLine += 1;
    }
    if (row.startsWith(" ") || row.startsWith("+")) {
      if (visible) newSource.push({ line: newLine, text: row.slice(1) });
      newLine += 1;
    }
  }
  flush();
  return records;
}

/** Builds a tool result and, when it would exceed maxChars, clips it to fit instead of discarding it. Never throws for size. */
export function toolResult(
  value: unknown,
  evidence: ReviewEvidence[],
  inspectedPaths: string[],
  warnings: string[],
  maxChars: number,
): ToolExecution {
  const full: ToolExecution = {
    content: JSON.stringify(value),
    evidence,
    inspectedPaths: [...new Set(inspectedPaths)],
    warnings,
  };
  return fitsEnvelope(full, maxChars) ? full : clipToFit(full, maxChars);
}

function fitsEnvelope(execution: ToolExecution, maxChars: number): boolean {
  return JSON.stringify(execution).length <= maxChars;
}

/**
 * Keeps as much of an over-budget tool result's content as fits the
 * configured output limit, with a trailing marker naming how much was cut.
 * Evidence can no longer be trusted to describe content it no longer sits
 * beside once the envelope must be cut, so it is dropped along with it.
 */
function clipToFit(execution: ToolExecution, maxChars: number): ToolExecution {
  const clipped = largestFittingClip(execution, maxChars);
  if (clipped !== null) return clipped;
  // Even an empty content string does not fit alongside inspectedPaths and
  // warnings; drop those too and keep only the truncation marker.
  return {
    content: truncationMarker(execution.content.length),
    evidence: [],
    inspectedPaths: [],
    warnings: [],
    truncated: { droppedChars: execution.content.length },
  };
}

/** Binary-searches the largest content prefix (plus marker) that fits maxChars; null when none does. */
function largestFittingClip(
  execution: ToolExecution,
  maxChars: number,
): ToolExecution | null {
  let low = 0;
  let high = execution.content.length;
  let fitting: ToolExecution | null = null;
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const candidate = clippedExecution(execution, keep);
    if (fitsEnvelope(candidate, maxChars)) {
      fitting = candidate;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }
  return fitting;
}

const EVIDENCE_DROPPED_WARNING =
  "Evidence for this result was dropped to fit maxToolOutputChars; request a narrower range for verifiable evidence.";

function clippedExecution(
  execution: ToolExecution,
  keep: number,
): ToolExecution {
  const droppedChars = execution.content.length - keep;
  const base = { evidence: [], inspectedPaths: execution.inspectedPaths };
  if (droppedChars <= 0)
    return {
      ...base,
      content: execution.content,
      warnings: [...execution.warnings, EVIDENCE_DROPPED_WARNING],
    };
  return {
    ...base,
    content: execution.content.slice(0, keep) + truncationMarker(droppedChars),
    warnings: execution.warnings,
    truncated: { droppedChars },
  };
}

function truncationMarker(droppedChars: number): string {
  return `\n… [truncated ${droppedChars} chars; request a narrower range]`;
}
