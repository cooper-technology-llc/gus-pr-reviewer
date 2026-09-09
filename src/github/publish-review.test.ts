// Publication must reflect actual external writes, preserve revision identity, and keep dry runs inert.
import { describe, expect, it, vi } from "vitest";
import { configSchema } from "../config/config-schema.js";
import type { ReviewFinding } from "../review/review-schema.js";
import { formatReviewMarkdown } from "../reporting/format-review.js";
import {
  makeClient,
  makePullRequest,
  makeReview,
  testConfig,
} from "./github-test-fixtures.js";
import { fileReviewIssues, publishReview } from "./publish-review.js";
import { readPriorReviews } from "./prior-reviews.js";
import { followUpIssueMarker } from "./follow-up-issues.js";

describe("review publication", () => {
  it("makes no external mutations in every dry-run mode", async () => {
    const createReview = vi.fn(makeClient().createReview);
    const createIssue = vi.fn(makeClient().createIssue);
    const resolveThread = vi.fn(makeClient().resolveThread);
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = makeClient({ createReview, createIssue, resolveThread });
    const subject = makePullRequest();
    const review = makeReview();
    const config = configSchema.parse({
      slack: { enabled: true },
      issues: { mode: "merge-clean" },
    });
    const result = await publishReview({
      client,
      subject,
      review,
      markdown: formatReviewMarkdown(review, subject, config),
      changedFiles: [],
      priorReviews: [],
      config,
      publish: false,
      requestedIssues: true,
      slackWebhook: "https://hooks.slack.com/private",
      fetch,
    });
    expect(result.status).toBe("dry-run");
    expect(
      (
        await fileReviewIssues({
          client,
          subject,
          priorReviews: [],
          config,
          publish: false,
          slackWebhook: "https://hooks.slack.com/private",
          fetch,
        })
      ).status,
    ).toBe("dry-run");
    expect(createReview).not.toHaveBeenCalled();
    expect(createIssue).not.toHaveBeenCalled();
    expect(resolveThread).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a base advance even when HEAD stayed unchanged", async () => {
    const createReview = vi.fn(makeClient().createReview);
    const client = makeClient({
      createReview,
      getPullRequest: async () => ({
        ...makePullRequest(),
        baseSha: "new-base",
      }),
    });
    const subject = makePullRequest();
    const review = makeReview();
    const result = await publishReview({
      client,
      subject,
      review,
      markdown: formatReviewMarkdown(review, subject, testConfig),
      changedFiles: [],
      priorReviews: [],
      config: testConfig,
      publish: true,
    });
    expect(result.status).toBe("stale");
    expect(createReview).not.toHaveBeenCalled();
  });
  it("deduplicates an identical report but permits changed findings on the same HEAD", async () => {
    const subject = makePullRequest();
    const review = makeReview();
    const markdown = formatReviewMarkdown(review, subject, testConfig);
    const createReview = vi.fn(makeClient().createReview);
    const client = makeClient({
      createReview,
      listReviews: async () => [
        {
          id: 9,
          author: "gus[bot]",
          body: markdown,
          commitId: "head-sha",
          url: "https://github.com/review/9",
          submittedAt: "2026-01-01",
        },
      ],
    });
    const input = {
      client,
      subject,
      review,
      markdown,
      changedFiles: [],
      priorReviews: [],
      config: testConfig,
      publish: true,
    };
    expect((await publishReview(input)).status).toBe("already-published");
    const changed = {
      ...review,
      summary: "A newly inspected edge case changes the conclusion.",
    };
    expect(
      (
        await publishReview({
          ...input,
          review: changed,
          markdown: formatReviewMarkdown(changed, subject, testConfig),
        })
      ).status,
    ).toBe("published");
    expect(createReview).toHaveBeenCalledTimes(1);
  });
  it("never blindly retries an ambiguous review POST", async () => {
    const subject = makePullRequest();
    const review = makeReview();
    const createReview = vi.fn(async () => {
      throw new Error("unknown transport outcome");
    });
    const result = await publishReview({
      client: makeClient({ createReview }),
      subject,
      review,
      markdown: formatReviewMarkdown(review, subject, testConfig),
      changedFiles: [],
      priorReviews: [],
      config: testConfig,
      publish: true,
    });
    expect(result.status).toBe("partial");
    expect(result.reviewId).toBeNull();
    expect(result.inlinePosted).toBe(0);
    expect(createReview).toHaveBeenCalledTimes(1);
  });
  it("uses the same issue cap for replay", async () => {
    const subject = makePullRequest();
    const review = makeReview();
    review.findings = [1, 2, 3].map((number): ReviewFinding => ({
      id: `f${number}`,
      title: `Follow-up ${number}`,
      severity: "minor",
      path: "widget.ts",
      line: number,
      side: "RIGHT",
      trigger: "An uncommon input.",
      impact: "Incorrect display.",
      suggestion: "Handle the input.",
      evidenceIds: ["e1"],
      disposition: "follow-up",
    }));
    const body = formatReviewMarkdown(review, subject, testConfig);
    const createIssue = vi.fn(makeClient().createIssue);
    const client = makeClient({
      createIssue,
      listReviews: async () => [
        {
          id: 1,
          author: "gus[bot]",
          body,
          commitId: "head-sha",
          url: "https://github.com/review/1",
          submittedAt: "2026-01-01",
        },
      ],
    });
    const config = configSchema.parse({ issues: { maxIssues: 1 } });
    const priorReviews = await readPriorReviews(client, 7, config);
    await fileReviewIssues({
      client,
      subject,
      priorReviews,
      config,
      publish: true,
    });
    expect(createIssue).toHaveBeenCalledTimes(1);
  });
  it("reuses a previously closed issue without creating a replacement", async () => {
    const subject = makePullRequest();
    const review = makeReview();
    review.findings = [
      {
        id: "f1",
        title: "Follow-up",
        severity: "minor",
        path: "widget.ts",
        line: 1,
        side: "RIGHT",
        trigger: "An uncommon input.",
        impact: "Incorrect display.",
        suggestion: "Handle the input.",
        evidenceIds: ["e1"],
        disposition: "follow-up",
      },
    ];
    const createIssue = vi.fn(makeClient().createIssue);
    const client = makeClient({
      createIssue,
      listIssues: async () => [
        {
          number: 8,
          title: "Closed follow-up",
          body: followUpIssueMarker(subject, "f1"),
          url: "https://github.com/issue/8",
        },
      ],
    });
    const result = await publishReview({
      client,
      subject,
      review,
      markdown: formatReviewMarkdown(review, subject, testConfig),
      changedFiles: [],
      priorReviews: [],
      config: testConfig,
      publish: true,
      requestedIssues: true,
    });
    expect(result.issues).toEqual([
      { number: 8, url: "https://github.com/issue/8", created: false },
    ]);
    expect(createIssue).not.toHaveBeenCalled();
  });
  it("stops further actions when the base changes after a confirmed review write", async () => {
    const subject = makePullRequest();
    const review = makeReview();
    review.findings = [
      {
        id: "f1",
        title: "Follow-up",
        severity: "minor",
        path: "widget.ts",
        line: 1,
        side: "RIGHT",
        trigger: "An uncommon input.",
        impact: "Incorrect display.",
        suggestion: "Handle the input.",
        evidenceIds: ["e1"],
        disposition: "follow-up",
      },
    ];
    let posted = false;
    const createIssue = vi.fn(makeClient().createIssue);
    const client = makeClient({
      createIssue,
      createReview: async () => {
        posted = true;
        return { id: 5, url: "https://github.com/review/5" };
      },
      getPullRequest: async () => ({
        ...subject,
        baseSha: posted ? "advanced-base" : subject.baseSha,
      }),
    });
    const result = await publishReview({
      client,
      subject,
      review,
      markdown: formatReviewMarkdown(review, subject, testConfig),
      changedFiles: [],
      priorReviews: [],
      config: testConfig,
      publish: true,
      requestedIssues: true,
    });
    expect(result.status).toBe("partial");
    expect(result.reviewId).toBe(5);
    expect(createIssue).not.toHaveBeenCalled();
  });
});
