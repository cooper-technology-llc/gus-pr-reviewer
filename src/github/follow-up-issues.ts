import { createHash } from "node:crypto";
import type { GusConfig } from "../config/config-schema.js";
import { GusError } from "../errors.js";
import { formatFindingMarkdown } from "../reporting/format-review.js";
import type { PublicationResult } from "../review/review-ports.js";
import type { ReviewFinding } from "../review/review-schema.js";
import { requireCurrentRevision } from "./current-revision.js";
import type { GitHubClient, GitHubPullRequest } from "./github-port.js";

export function followUpIssueMarker(
  subject: GitHubPullRequest,
  findingId: string,
): string {
  const identity = createHash("sha256")
    .update(`${subject.repository}\0${subject.number}\0${findingId}`)
    .digest("hex");
  return `<!-- gus-issue:v1 ${identity} -->`;
}

export async function publishFollowUpIssues(
  input: {
    client: GitHubClient;
    subject: GitHubPullRequest;
    findings: ReviewFinding[];
    config: GusConfig;
  },
  publication: PublicationResult,
): Promise<void> {
  const findings = input.findings.filter(
    (finding) => finding.disposition === "follow-up",
  );
  if (findings.length === 0) return;
  let existing = await input.client.listIssues();
  let attempted = 0;
  const seen = new Set<string>();
  for (const finding of findings) {
    if (seen.has(finding.id)) continue;
    seen.add(finding.id);
    const marker = followUpIssueMarker(input.subject, finding.id);
    const matched = existing.find((issue) => issue.body.includes(marker));
    if (matched) {
      publication.issues.push({
        number: matched.number,
        url: matched.url,
        created: false,
      });
      continue;
    }
    if (attempted >= input.config.issues.maxIssues) break;
    attempted += 1;
    await requireCurrentRevision(input.client, input.subject);
    try {
      const issue = await input.client.createIssue({
        title: `${input.config.name}: ${finding.title}`.slice(0, 200),
        body: [
          `Follow-up from [pull request #${input.subject.number}](${input.subject.url}).`,
          "",
          `Reviewed HEAD: \`${input.subject.headSha}\`. Base: \`${input.subject.baseSha}\`.`,
          "",
          formatFindingMarkdown(finding),
          "",
          marker,
        ].join("\n"),
        labels: input.config.issues.labels,
      });
      existing.push(issue);
      publication.issues.push({
        number: issue.number,
        url: issue.url,
        created: true,
      });
    } catch (error) {
      if (error instanceof GusError && error.code === "STALE_REVIEW")
        throw error;
      try {
        existing = await input.client.listIssues();
        const recovered = existing.find((issue) => issue.body.includes(marker));
        if (recovered) {
          publication.issues.push({
            number: recovered.number,
            url: recovered.url,
            created: false,
          });
          publication.errors.push(
            `Issue #${recovered.number} exists, but this run could not confirm whether its creation request succeeded.`,
          );
          publication.status = "partial";
          continue;
        }
      } catch {
        publication.errors.push(
          "Unable to confirm the outcome of follow-up issue creation.",
        );
      }
      publication.errors.push(
        `Follow-up ${finding.id} was not confirmed; creation was not retried.`,
      );
      publication.status = "partial";
      break;
    }
  }
}
