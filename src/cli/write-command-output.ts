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

export function reviewExitCode(completed: CompletedReview): number {
  if (
    publicationExitCode(completed.publication) === 2 ||
    completed.review.verdict === "incomplete"
  )
    return 2;
  return completed.review.verdict === "changes-requested" ? 1 : 0;
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
