import { z } from "zod";
import type { GusConfig } from "../config/config-schema.js";
import type { GitHubClient } from "./github-port.js";

const actorSchema = z.object({
  login: z.string().min(1),
  type: z.string().optional(),
});
const eventSchema = z.object({
  action: z.string().optional(),
  sender: actorSchema.optional(),
  changes: z.object({ base: z.unknown().optional() }).optional(),
  issue: z
    .object({
      number: z.number().int().positive(),
      pull_request: z.unknown().optional(),
    })
    .optional(),
  pull_request: z.object({ number: z.number().int().positive() }).optional(),
  comment: z.object({ body: z.string(), user: actorSchema }).optional(),
  inputs: z
    .object({
      pr: z.union([z.string(), z.number()]).optional(),
      pr_number: z.union([z.string(), z.number()]).optional(),
      pull_request: z.union([z.string(), z.number()]).optional(),
      mode: z.string().optional(),
    })
    .optional(),
});

export interface GitHubEventEligibility {
  eligible: boolean;
  reason: string;
  mode: "review" | "issues" | "review-and-issues";
  pullRequest: number | null;
  manual: boolean;
}

/** Filters commands and authenticates the actor before an eligible run enters PR concurrency. */
export async function evaluateGitHubEvent(input: {
  event: unknown;
  eventName: string;
  config: GusConfig;
  client: GitHubClient;
}): Promise<GitHubEventEligibility> {
  const result: GitHubEventEligibility = {
    eligible: false,
    reason: "Unsupported GitHub event.",
    mode: "review",
    pullRequest: null,
    manual: false,
  };
  const parsed = eventSchema.safeParse(input.event);
  if (!parsed.success) return { ...result, reason: "Malformed GitHub event." };
  const event = parsed.data;
  let actor: z.infer<typeof actorSchema> | undefined;
  if (
    input.eventName === "issue_comment" ||
    input.eventName === "pull_request_review_comment"
  ) {
    result.manual = true;
    if (event.action !== "created" || !event.comment)
      return {
        ...result,
        reason: "Only newly created command comments are eligible.",
      };
    if (
      input.eventName === "issue_comment" &&
      event.issue?.pull_request === undefined
    )
      return { ...result, reason: "Comment is not on a pull request." };
    const mode = parseCommentCommands(event.comment.body, input.config);
    if (mode === null)
      return {
        ...result,
        reason: "Comment contains no supported full-line command.",
      };
    result.mode = mode;
    result.pullRequest =
      input.eventName === "issue_comment"
        ? (event.issue?.number ?? null)
        : (event.pull_request?.number ?? null);
    actor = event.comment.user;
  } else if (input.eventName === "workflow_dispatch") {
    result.manual = true;
    actor = event.sender;
    const number =
      event.inputs?.pr ?? event.inputs?.pr_number ?? event.inputs?.pull_request;
    result.pullRequest = parsePullRequestNumber(number);
    const mode = event.inputs?.mode;
    if (
      mode !== undefined &&
      !["review", "issues", "review-and-issues"].includes(mode)
    )
      return { ...result, reason: "Unsupported manual review mode." };
    if (mode === "issues" || mode === "review-and-issues") result.mode = mode;
  } else if (
    input.eventName === "pull_request" ||
    input.eventName === "pull_request_target"
  ) {
    const retargeted =
      event.action === "edited" && event.changes?.base !== undefined;
    if (
      !retargeted &&
      (!event.action ||
        !["opened", "synchronize", "reopened", "ready_for_review"].includes(
          event.action,
        ))
    )
      return {
        ...result,
        reason: "Pull request action does not require review.",
      };
    result.pullRequest = event.pull_request?.number ?? null;
  } else return result;

  if (result.pullRequest === null)
    return { ...result, reason: "A valid pull request number is required." };
  if (result.manual) {
    if (
      !actor ||
      actor.type?.toLowerCase() === "bot" ||
      actor.login.toLowerCase().endsWith("[bot]")
    )
      return {
        ...result,
        reason: "Bot or missing actors cannot request review actions.",
      };
    try {
      const permission = await input.client.getPermission(actor.login);
      if (!["write", "maintain", "admin"].includes(permission.toLowerCase()))
        return {
          ...result,
          reason: "The actor requires repository write access.",
        };
    } catch {
      return {
        ...result,
        reason: "Repository permission could not be verified.",
      };
    }
  }
  try {
    const pullRequest = await input.client.getPullRequest(result.pullRequest);
    if (pullRequest.state !== "open" || pullRequest.merged)
      return { ...result, reason: "Pull request is no longer open." };
    if (pullRequest.isFork && !input.config.github.allowForks)
      return { ...result, reason: "Fork pull requests are disabled." };
    if (pullRequest.draft && !result.manual)
      return { ...result, reason: "Automatic draft reviews are disabled." };
  } catch {
    return { ...result, reason: "Pull request could not be verified." };
  }
  return { ...result, eligible: true, reason: "Eligible review request." };
}

export function parseCommentCommands(
  body: string,
  config: GusConfig,
): GitHubEventEligibility["mode"] | null {
  let review = false;
  let issues = false;
  let fence: string | null = null;
  let htmlComment = false;
  const reviewCommand = config.github.reviewCommand.trim().toLowerCase();
  const issuesCommand = config.github.issuesCommand.trim().toLowerCase();
  for (const rawLine of body.replace(/\r\n/g, "\n").split("\n")) {
    const fenceStart = /^ {0,3}(`{3,}|~{3,})/.exec(rawLine)?.[1];
    if (fenceStart) {
      if (fence === null) fence = fenceStart;
      else if (fenceStart[0] === fence[0] && fenceStart.length >= fence.length)
        fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (rawLine.includes("<!--")) htmlComment = true;
    if (htmlComment) {
      if (rawLine.includes("-->")) htmlComment = false;
      continue;
    }
    if (/^(?: {4}|\t)/.test(rawLine)) continue;
    const line = rawLine.trim().toLowerCase();
    if (line.startsWith(">")) continue;
    if (line === reviewCommand || line === `${reviewCommand} review`)
      review = true;
    if (line === issuesCommand) issues = true;
    if (line === `${reviewCommand} review issues`) {
      review = true;
      issues = true;
    }
  }
  return review && issues
    ? "review-and-issues"
    : review
      ? "review"
      : issues
        ? "issues"
        : null;
}

function parsePullRequestNumber(
  value: string | number | undefined,
): number | null {
  if (typeof value === "string" && !/^[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
