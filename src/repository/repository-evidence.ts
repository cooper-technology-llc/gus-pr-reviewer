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

export function toolResult(
  value: unknown,
  evidence: ReviewEvidence[],
  inspectedPaths: string[],
  warnings: string[],
  maxChars: number,
): ToolExecution {
  const content = JSON.stringify(value);
  const result = {
    content,
    evidence,
    inspectedPaths: [...new Set(inspectedPaths)],
    warnings,
  };
  if (JSON.stringify(result).length <= maxChars) return result;
  const warning =
    "Tool output exceeded the configured limit. Request a smaller page or source range; this result provides no source evidence.";
  const limited: ToolExecution = {
    content: JSON.stringify({
      error: "OUTPUT_LIMIT",
      truncated: true,
      message: warning,
    }),
    evidence: [],
    inspectedPaths: [],
    warnings: [...warnings, warning],
  };
  if (JSON.stringify(limited).length <= maxChars) return limited;
  return { ...limited, warnings: [warning] };
}
