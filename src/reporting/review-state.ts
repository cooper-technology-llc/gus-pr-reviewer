import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  reviewStateSchema,
  type ReviewResult,
  type ReviewState,
} from "../review/review-schema.js";

const STATE_PATTERN = /<!-- gus-review:v1 ([A-Za-z0-9+/]+={0,2}) -->/g;
const REPORT_PATTERN = /<!-- gus-report:v1 ([a-f0-9]{64}) -->/g;
const FINDING_PATTERN = /<!-- gus-finding:v1 ([A-Za-z0-9+/]+={0,2}) -->/;

export function stateFromReview(review: ReviewResult): ReviewState {
  return reviewStateSchema.parse({
    version: 1,
    headSha: review.snapshot.headSha,
    baseSha: review.snapshot.baseSha,
    comparisonBaseSha: review.snapshot.comparisonBaseSha,
    findings: review.findings,
    reconciliations: review.reconciliations,
    verdict: review.verdict,
  });
}

export function formatReviewState(state: ReviewState): string {
  return `<!-- gus-review:v1 ${Buffer.from(JSON.stringify(state)).toString("base64")} -->`;
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

export function addReportIdentity(body: string): string {
  const content = body.replace(REPORT_PATTERN, "").trimEnd();
  return `${content}\n\n<!-- gus-report:v1 ${createHash("sha256").update(content).digest("hex")} -->`;
}

export function readReportIdentity(body: string): string | null {
  const matches = [...body.matchAll(REPORT_PATTERN)];
  if (matches.length !== 1) return null;
  const identity = matches[0]?.[1];
  const content = body.replace(REPORT_PATTERN, "").trimEnd();
  return identity &&
    createHash("sha256").update(content).digest("hex") === identity
    ? identity
    : null;
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
