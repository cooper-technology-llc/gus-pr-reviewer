import type { GusConfig } from "../config/config-schema.js";
import type {
  PublicationResult,
  ReviewSubject,
} from "../review/review-ports.js";

export async function notifyPublication(input: {
  subject: ReviewSubject;
  config: GusConfig;
  publication: PublicationResult;
  webhook?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<void> {
  const result = input.publication;
  if (
    !input.config.slack.enabled ||
    !input.webhook ||
    result.status === "dry-run" ||
    result.status === "already-published" ||
    result.status === "stale"
  )
    return;
  let webhook: URL;
  try {
    webhook = new URL(input.webhook);
  } catch {
    result.errors.push("Slack webhook URL is invalid.");
    result.status = "partial";
    return;
  }
  if (webhook.protocol !== "https:" || webhook.username || webhook.password) {
    result.errors.push("Slack webhook requires HTTPS without URL credentials.");
    result.status = "partial";
    return;
  }
  const issuesCreated = result.issues.filter((issue) => issue.created).length;
  const text = [
    `${escapeSlack(input.config.name)} review ${result.status}: ${escapeSlack(input.subject.repository)}#${input.subject.number ?? "local"}`,
    escapeSlack(input.subject.title),
    result.reviewId === null
      ? "Review publication was not confirmed."
      : "Review publication confirmed.",
    `${result.inlinePosted} inline comments confirmed; ${issuesCreated} issues created; ${result.threadsResolved} threads resolved.`,
    result.errors.length > 0
      ? `${result.errors.length} publication problem(s); inspect the run output.`
      : "",
    safeSlackLink(result.reviewUrl ?? input.subject.url),
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const timeout = AbortSignal.timeout(15_000);
    const signal = input.signal
      ? AbortSignal.any([input.signal, timeout])
      : timeout;
    signal.throwIfAborted();
    const response = await (input.fetch ?? globalThis.fetch)(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
      redirect: "error",
    });
    if (!response.ok) {
      result.errors.push(
        `Slack notification failed with HTTP ${response.status}.`,
      );
      result.status = "partial";
      return;
    }
    result.slackSent = true;
  } catch {
    result.errors.push(
      "Slack notification was not confirmed; it was not retried.",
    );
    result.status = "partial";
  }
}

function escapeSlack(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/@/g, "@\u200b");
}
function safeSlackLink(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? `<${url.href.replace(/[<>|]/g, "")}|View review>`
      : "";
  } catch {
    return "";
  }
}
