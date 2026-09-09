import { createHash } from "node:crypto";
import { GusError } from "../../errors.js";
import {
  evidenceSchema,
  type ChangedFile,
  type ReviewEvidence,
  type ReviewSnapshot,
  type Revision,
} from "../review-schema.js";

export function expectedRevisionSha(
  snapshot: ReviewSnapshot,
  revision: Revision,
): string | null {
  switch (revision) {
    case "head":
      return snapshot.headSha;
    case "base":
      return snapshot.baseSha;
    case "parent":
      return snapshot.comparisonBaseSha;
    case "integration":
      return snapshot.integration.treeSha;
  }
}

export function isCurrentEvidence(
  evidence: ReviewEvidence,
  snapshot: ReviewSnapshot,
): boolean {
  return (
    (evidence.revision === "head" || evidence.revision === "integration") &&
    evidence.sha === expectedRevisionSha(snapshot, evidence.revision)
  );
}

export function addEvidence(
  stored: Map<string, ReviewEvidence>,
  incoming: ReviewEvidence[],
  snapshot: ReviewSnapshot,
): void {
  for (const raw of incoming) {
    const parsed = evidenceSchema.safeParse(raw);
    if (
      !parsed.success ||
      parsed.data.endLine < parsed.data.startLine ||
      parsed.data.sha !== expectedRevisionSha(snapshot, parsed.data.revision)
    ) {
      throw new GusError(
        "PROVIDER_PROTOCOL",
        "Repository evidence has invalid coordinates or does not match the pinned snapshot.",
      );
    }
    const evidence = parsed.data;
    const previous = stored.get(evidence.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(evidence)) {
      throw new GusError(
        "PROVIDER_PROTOCOL",
        "A repository tool reused an evidence identifier for different content.",
      );
    }
    stored.set(evidence.id, evidence);
  }
}

export function seedDiffEvidence(
  files: ChangedFile[],
  snapshot: ReviewSnapshot,
): ReviewEvidence[] {
  return files
    .filter((file) => !file.excluded && !file.binary)
    .flatMap((file) => evidenceForFile(file, snapshot));
}

function evidenceForFile(
  file: ChangedFile,
  snapshot: ReviewSnapshot,
): ReviewEvidence[] {
  const evidence: ReviewEvidence[] = [];
  const hunks = file.patch.split(/(?=^@@ )/m);
  for (const hunk of hunks) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunk);
    if (!header?.[1] || !header[3]) continue;
    const parentLines: Array<{ line: number; text: string }> = [];
    const headLines: Array<{ line: number; text: string }> = [];
    let parentLine = Number(header[1]);
    let headLine = Number(header[3]);
    for (const line of hunk.split("\n").slice(1)) {
      if (line.startsWith(" ") || line.startsWith("-"))
        parentLines.push({ line: parentLine++, text: line.slice(1) });
      if (line.startsWith(" ") || line.startsWith("+"))
        headLines.push({ line: headLine++, text: line.slice(1) });
    }
    if (parentLines.length > 0)
      evidence.push(
        makeDiffEvidence(
          file.previousPath ?? file.path,
          "parent",
          snapshot.comparisonBaseSha,
          parentLines,
          file.truncated,
        ),
      );
    if (headLines.length > 0)
      evidence.push(
        makeDiffEvidence(
          file.path,
          "head",
          snapshot.headSha,
          headLines,
          file.truncated,
        ),
      );
  }
  if (file.status === "deleted" || evidence.length === 0) {
    const text = `Pinned change metadata: ${file.status}; ${file.additions} added lines; ${file.deletions} deleted lines${file.previousPath ? `; previous path ${file.previousPath}` : ""}.`;
    evidence.push({
      id: evidenceId(snapshot.headSha, file.path, text),
      path: file.path,
      revision: "head",
      sha: snapshot.headSha,
      startLine: 0,
      endLine: 0,
      text,
      kind: "diff",
      truncated: file.truncated,
    });
  }
  return evidence;
}

function makeDiffEvidence(
  path: string,
  revision: Revision,
  sha: string,
  lines: Array<{ line: number; text: string }>,
  truncated: boolean,
): ReviewEvidence {
  const text = lines.map((line) => `${line.line}: ${line.text}`).join("\n");
  return {
    id: evidenceId(sha, path, text),
    path,
    revision,
    sha,
    startLine: lines[0]?.line ?? 0,
    endLine: lines.at(-1)?.line ?? 0,
    text,
    kind: "diff",
    truncated,
  };
}

function evidenceId(sha: string, path: string, text: string): string {
  return `diff-${createHash("sha256")
    .update(JSON.stringify([sha, path, text]))
    .digest("hex")
    .slice(0, 24)}`;
}
