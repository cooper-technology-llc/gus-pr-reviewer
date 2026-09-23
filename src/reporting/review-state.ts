import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  reviewStateSchema,
  type ReviewResult,
  type ReviewState,
} from "../review/review-schema.js";

/**
 * One hidden comment carries both the state blob and the report identity:
 * `<!-- gus-review:v1 <base64 state> gus-report:v1 <sha256> -->`.
 * Reviews posted before 0.1.8 used a separate `<!-- gus-report:v1 … -->` comment.
 * Their state still parses; their identity does not, and it could never match a new report.
 */
const STATE_PATTERN =
  /<!-- gus-review:v1 ([A-Za-z0-9+/]+={0,2})(?: gus-report:v1 [a-f0-9]{64})? -->/g;
const HIDDEN_COMMENT_PATTERN =
  /<!-- gus-review:v1 ([A-Za-z0-9+/]+={0,2}) gus-report:v1 ([a-f0-9]{64}) -->/g;
const FINDING_PATTERN = /<!-- gus-finding:v1 ([A-Za-z0-9+/]+={0,2}) -->/;
/** The run-specific links line stays out of the identity so a rerun still recognizes its own report. */
const LINKS_LINE_PATTERN = /^\[(?:details|evidence json)\]\(.*$/gm;

/** Excerpts are display-only and re-derivable, so they stay out of the hidden state to keep it small. */
export function stateFromReview(review: ReviewResult): ReviewState {
  return reviewStateSchema.parse({
    version: 1,
    headSha: review.snapshot.headSha,
    baseSha: review.snapshot.baseSha,
    comparisonBaseSha: review.snapshot.comparisonBaseSha,
    findings: review.findings.map((finding) => ({ ...finding, excerpts: [] })),
    reconciliations: review.reconciliations,
    verdict: review.verdict,
  });
}

/** Appends the single hidden comment (state plus report identity) to the visible report. */
export function addHiddenReviewComment(
  visible: string,
  state: ReviewState,
): string {
  const content = visible.trimEnd();
  const encoded = Buffer.from(JSON.stringify(state)).toString("base64");
  const identity = reportIdentity(content, encoded);
  return `${content}\n\n<!-- gus-review:v1 ${encoded} gus-report:v1 ${identity} -->`;
}

/** Returns the whole hidden state comment so it can be carried onto a superseded review. */
export function findHiddenStateComment(body: string): string | null {
  const markers = [...body.matchAll(STATE_PATTERN)];
  if (markers.length !== 1) return null;
  return markers[0]?.[0] ?? null;
}

export function parseReviewState(body: string): ReviewState | null {
  const markers = [...body.matchAll(STATE_PATTERN)];
  if (markers.length !== 1) return null;
  const encoded = markers[0]?.[1];
  if (!encoded || encoded.length > 100_000) return null;
  try {
    const decoded = decodeBase64(encoded);
    if (decoded === null) return null;
    const value: unknown = JSON.parse(decoded);
    const parsed = reviewStateSchema.safeParse(value);
    if (!parsed.success || !parsed.data.headSha || !parsed.data.baseSha)
      return null;
    if (
      new Set(parsed.data.findings.map((finding) => finding.id)).size !==
      parsed.data.findings.length
    )
      return null;
    if (
      new Set(parsed.data.reconciliations.map((resolution) => resolution.id))
        .size !== parsed.data.reconciliations.length
    )
      return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function readReportIdentity(body: string): string | null {
  const matches = [...body.matchAll(HIDDEN_COMMENT_PATTERN)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const encoded = match?.[1];
  const identity = match?.[2];
  if (!match || !encoded || !identity) return null;
  const content = body.replace(match[0], "").trimEnd();
  return reportIdentity(content, encoded) === identity ? identity : null;
}

function reportIdentity(content: string, encodedState: string): string {
  const stableContent = content
    .replace(LINKS_LINE_PATTERN, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return createHash("sha256")
    .update(`${stableContent}\n${encodedState}`)
    .digest("hex");
}

export function formatFindingMarker(id: string): string {
  return `<!-- gus-finding:v1 ${Buffer.from(id).toString("base64")} -->`;
}
export function parseFindingMarker(body: string): string | null {
  const encoded = FINDING_PATTERN.exec(body)?.[1];
  if (!encoded || encoded.length > 200) return null;
  return decodeBase64(encoded);
}

function decodeBase64(value: string): string | null {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(value, "base64"),
    );
  } catch {
    return null;
  }
}
