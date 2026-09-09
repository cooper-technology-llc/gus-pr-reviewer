import { z } from "zod";
import { evaluateGitHubEvent } from "../github/event-trigger.js";
import type {
  GitHubEventOptions,
  PreparedGitHubEvent,
} from "./application-options.js";
import { createGitHubReviewHost } from "./github-review-host.js";

const envelopeSchema = z.object({
  repository: z.object({
    full_name: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  }),
  pull_request: z.object({ number: z.number().int().positive() }).optional(),
  issue: z
    .object({
      number: z.number().int().positive(),
      pull_request: z.unknown().optional(),
    })
    .optional(),
  inputs: z
    .object({ pr: z.union([z.string(), z.number()]).optional() })
    .optional(),
});

/** Authorize an event before a workflow enters its per-PR cancellation group. */
export async function prepareGitHubEvent(
  options: GitHubEventOptions,
): Promise<PreparedGitHubEvent> {
  const envelope = envelopeSchema.safeParse(options.event);
  if (!envelope.success)
    return skipped("Event does not identify a repository and pull request.");
  const value = envelope.data;
  const fromIssue =
    value.issue?.pull_request !== undefined ? value.issue.number : undefined;
  const number =
    value.pull_request?.number ?? fromIssue ?? Number(value.inputs?.pr);
  if (!Number.isSafeInteger(number) || number < 1)
    return skipped(
      "Event is not a pull-request command.",
      value.repository.full_name,
    );
  const host = await createGitHubReviewHost({
    repository: value.repository.full_name,
    pullRequest: number,
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
    ...(options.configPath ? { configPath: options.configPath } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const eligibility = await evaluateGitHubEvent({
    event: options.event,
    eventName: options.eventName,
    config: host.config,
    client: host.client,
  });
  return { ...eligibility, repository: value.repository.full_name };
}

function skipped(reason: string, repository = ""): PreparedGitHubEvent {
  return {
    eligible: false,
    reason,
    repository,
    pullRequest: null,
    mode: "review",
    manual: false,
  };
}
