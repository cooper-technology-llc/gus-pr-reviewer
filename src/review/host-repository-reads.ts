import { Buffer } from "node:buffer";
import { z } from "zod";

import { GusError } from "../errors.js";
import { uniqueExcerpts } from "./logic/unique-excerpts.js";
import { ReviewBudget } from "./review-budget.js";
import type { ReviewInput, ToolExecution } from "./review-ports.js";
import type {
  ReviewEvidence,
  ReviewFinding,
  ReviewFindingExcerpt,
} from "./review-schema.js";
import {
  recordToolExecution,
  type ReviewEvidenceState,
} from "./structured-stage.js";

// Host reads go through the same repository executor as model tools, but they
// never enter the model conversation and never count against maxToolCalls.

/** Total tool output the host may spend paging truncated patches before triage. */
export const hostPrefetchByteLimit = 2_000_000;
/** Longest excerpt attached to a finding, in source lines. */
export const excerptMaxLines = 12;
const diffPageLines = 800;

const diffPageSchema = z.object({
  nextLine: z.number().int().positive().nullable(),
});

/**
 * Pages every truncated, reviewable patch from line 1 so coverage never
 * depends on the model asking. Files the budget cannot reach stay partial.
 */
export async function prefetchTruncatedPatches(
  input: ReviewInput,
  budget: ReviewBudget,
  state: ReviewEvidenceState,
): Promise<void> {
  let spentBytes = 0;
  for (const file of input.repository.files) {
    if (!file.truncated || file.excluded || file.binary) continue;
    let startLine: number | null = 1;
    while (startLine !== null) {
      if (spentBytes >= hostPrefetchByteLimit) {
        state.notices.push(
          `Host patch prefetch stopped at its ${hostPrefetchByteLimit}-byte budget; remaining truncated files stay partial.`,
        );
        return;
      }
      let execution: ToolExecution;
      try {
        execution = await executeHostRead(input, budget, "read_diff", {
          path: file.path,
          startLine,
          lineCount: diffPageLines,
        });
        recordToolExecution(input, state, execution);
      } catch (error) {
        if (stopsHostReads(error)) throw error;
        state.notices.push(
          `Host patch prefetch for ${file.path} failed; the file stays partial.`,
        );
        break;
      }
      spentBytes += Buffer.byteLength(execution.content, "utf8");
      const nextLine = nextDiffLine(execution.content);
      startLine = nextLine !== null && nextLine > startLine ? nextLine : null;
    }
  }
}

/**
 * Re-reads each range a validated finding cites at its pinned revision and
 * attaches the text. A failed read attaches nothing and leaves a notice.
 */
export async function attachFindingExcerpts(
  findings: ReviewFinding[],
  input: ReviewInput,
  budget: ReviewBudget,
  state: ReviewEvidenceState,
): Promise<void> {
  for (const finding of findings) {
    const excerpts: ReviewFindingExcerpt[] = [];
    for (const evidenceId of finding.evidenceIds) {
      const cited = state.evidence.get(evidenceId);
      if (cited === undefined || !hasSourceRange(cited)) continue;
      try {
        excerpts.push(
          await readExcerpt(evidenceId, cited, finding, input, budget, state),
        );
      } catch (error) {
        state.notices.push(
          `Evidence ${evidenceId} could not be re-read for its excerpt; the finding keeps its evidence ID.`,
        );
        if (stopsHostReads(error)) {
          finding.excerpts = uniqueExcerpts(excerpts);
          return;
        }
      }
    }
    finding.excerpts = uniqueExcerpts(excerpts);
  }
}

async function readExcerpt(
  evidenceId: string,
  cited: ReviewEvidence,
  finding: ReviewFinding,
  input: ReviewInput,
  budget: ReviewBudget,
  state: ReviewEvidenceState,
): Promise<ReviewFindingExcerpt> {
  const range = excerptRange(cited, finding);
  const execution = await executeHostRead(input, budget, "read_file", {
    path: cited.path,
    revision: cited.revision,
    startLine: range.startLine,
    endLine: range.endLine,
  });
  const read = execution.evidence.find(
    (entry) =>
      entry.kind === "file" &&
      entry.path === cited.path &&
      entry.revision === cited.revision &&
      entry.sha === cited.sha,
  );
  if (read === undefined)
    throw new GusError(
      "FILE_NOT_FOUND",
      "The pinned re-read returned no matching source evidence.",
    );
  recordToolExecution(input, state, execution);
  return {
    evidenceId,
    path: read.path,
    revision: read.revision,
    sha: read.sha,
    startLine: read.startLine,
    endLine: read.endLine,
    text: trimExcerptText(read.text),
  };
}

/** At most excerptMaxLines of the cited range, centered on the finding line when it falls inside. */
export function excerptRange(
  cited: Pick<ReviewEvidence, "path" | "startLine" | "endLine">,
  finding: Pick<ReviewFinding, "path" | "line">,
): { startLine: number; endLine: number } {
  const length = cited.endLine - cited.startLine + 1;
  if (length <= excerptMaxLines)
    return { startLine: cited.startLine, endLine: cited.endLine };
  const findingInside =
    finding.path === cited.path &&
    finding.line >= cited.startLine &&
    finding.line <= cited.endLine;
  const center = findingInside
    ? finding.line
    : cited.startLine + Math.floor(length / 2);
  const earliest = cited.startLine;
  const latest = cited.endLine - excerptMaxLines + 1;
  const startLine = Math.min(
    latest,
    Math.max(earliest, center - Math.floor((excerptMaxLines - 1) / 2)),
  );
  return { startLine, endLine: startLine + excerptMaxLines - 1 };
}

function trimExcerptText(text: string): string {
  return text
    .split("\n")
    .slice(0, excerptMaxLines)
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
}

function hasSourceRange(evidence: ReviewEvidence): boolean {
  return evidence.kind !== "history" && evidence.startLine >= 1;
}

function nextDiffLine(content: string): number | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  const page = diffPageSchema.safeParse(value);
  return page.success ? page.data.nextLine : null;
}

async function executeHostRead(
  input: ReviewInput,
  budget: ReviewBudget,
  name: "read_diff" | "read_file",
  argumentsValue: Record<string, unknown>,
): Promise<ToolExecution> {
  return budget.withinDeadline((signal) =>
    input.tools.execute(name, argumentsValue, {
      signal,
      deadline: budget.deadline,
    }),
  );
}

function stopsHostReads(error: unknown): boolean {
  return (
    error instanceof GusError &&
    (error.code === "ABORTED" || error.code === "BUDGET_EXCEEDED")
  );
}
