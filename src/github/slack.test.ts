// Notifications describe confirmed delivery and cannot turn untrusted text into Slack mentions.
import { describe, expect, it, vi } from "vitest";
import { configSchema } from "../config/config-schema.js";
import type { PublicationResult } from "../review/review-ports.js";
import { makePullRequest } from "./github-test-fixtures.js";
import { notifyPublication } from "./slack.js";

describe("publication notifications", () => {
  it("does not send a notification after the application deadline expires", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const publication: PublicationResult = {
      status: "published",
      reviewId: 1,
      reviewUrl: "https://github.com/review/1",
      inlinePosted: 0,
      issues: [],
      threadsResolved: 0,
      slackSent: false,
      errors: [],
    };
    await notifyPublication({
      subject: makePullRequest(),
      config: configSchema.parse({ slack: { enabled: true } }),
      publication,
      webhook: "https://hooks.slack.com/fixture",
      fetch,
      signal: AbortSignal.abort(),
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(publication.slackSent).toBe(false);
    expect(publication.status).toBe("partial");
  });

  it("escapes mention syntax and reports partial counts without provider or webhook details", async () => {
    let body = "";
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      body = typeof init?.body === "string" ? init.body : "";
      return new Response("ok");
    };
    const publication: PublicationResult = {
      status: "partial",
      reviewId: 1,
      reviewUrl: "https://github.com/review/1",
      inlinePosted: 0,
      issues: [],
      threadsResolved: 0,
      slackSent: false,
      errors: ["safe failure"],
    };
    await notifyPublication({
      subject: { ...makePullRequest(), title: "<!channel> @here a finding" },
      config: configSchema.parse({ slack: { enabled: true } }),
      publication,
      webhook: "https://hooks.slack.com/private-secret",
      fetch,
    });
    expect(body).not.toContain("<!channel>");
    expect(body).not.toContain("@here");
    expect(body).not.toContain("private-secret");
    expect(body).toContain("0 inline comments");
    expect(publication.slackSent).toBe(true);
  });
});
