import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { PreparedGitHubEvent } from "../application/application-options.js";
import type {
  CompletedReview,
  PublicationResult,
} from "../review/review-ports.js";
import type { OutputFormat } from "./parse-arguments.js";

export type WriteStdout = (text: string) => void;

export async function writeCommandOutput(
  text: string,
  path: string | undefined,
  stdout: WriteStdout,
): Promise<void> {
  const output = text.endsWith("\n") ? text : `${text}\n`;
  if (!path) {
    stdout(
      output.replace(
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
        "",
      ),
    );
    return;
  }
  const absolutePath = resolve(path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, output, "utf8");
}

/**
 * With publishing, the exit code reports only whether a review reached the PR:
 * 0 when one is there (any verdict), 2 when nothing was published.
 * Without publishing (dry-run): ready 0, changes-requested 1, incomplete 2.
 */
export function reviewExitCode(completed: CompletedReview): number {
  const status = completed.publication.status;
  if (status !== "dry-run")
    return status === "published" || status === "already-published" ? 0 : 2;
  switch (completed.review.verdict) {
    case "ready":
      return 0;
    case "changes-requested":
      return 1;
    case "incomplete":
      return 2;
  }
}

export function publicationExitCode(publication: PublicationResult): number {
  return publication.status === "partial" ||
    publication.status === "stale" ||
    publication.errors.length > 0
    ? 2
    : 0;
}

export function formatReviewOutput(
  completed: CompletedReview,
  format: OutputFormat,
): string {
  return format === "json"
    ? JSON.stringify(completed, null, 2)
    : completed.markdown;
}

export function formatPublicationOutput(
  publication: PublicationResult,
  format: OutputFormat,
): string {
  if (format === "json") return JSON.stringify(publication, null, 2);
  const lines = [`Gus issue publication: ${publication.status}`];
  for (const issue of publication.issues)
    lines.push(
      `- ${issue.created ? "Created" : "Existing"} issue #${issue.number}: ${issue.url}`,
    );
  if (publication.issues.length === 0) lines.push("No issues were created.");
  for (const error of publication.errors) lines.push(`- ${error}`);
  for (const notice of publication.notices) lines.push(`- Notice: ${notice}`);
  return lines.join("\n");
}

export function formatSkippedOutput(
  event: PreparedGitHubEvent,
  format: OutputFormat,
): string {
  return format === "json"
    ? JSON.stringify({ status: "skipped", ...event }, null, 2)
    : `Gus skipped this event: ${event.reason}`;
}
