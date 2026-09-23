// Publication must reflect actual external writes, preserve revision identity, and keep dry runs inert.
import { describe, expect, it, vi } from "vitest";
import { configSchema } from "../config/config-schema.js";
import type { ReviewFinding } from "../review/review-schema.js";
import { formatReviewMarkdown } from "../reporting/format-review.js";
import {
  parseReviewState,
  readReportIdentity,
} from "../reporting/review-state.js";
import type { GitHubClient } from "./github-port.js";
import { GitHubRequestError } from "./github-request.js";
import { publicationExitCode } from "../cli/write-command-output.js";
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
      excerpts: [],
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
        excerpts: [],
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
        excerpts: [],
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

describe("check run and superseded reviews", () => {
  const actionsEnvironment = {
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "acme/widgets",
    GITHUB_RUN_ID: "99",
  };

  it("creates the Gus review check run first and links it from the posted comment", async () => {
    const order: string[] = [];
    const createCheckRun = vi.fn<GitHubClient["createCheckRun"]>(async () => {
      order.push("check-run");
      return { id: 11, url: "https://github.com/acme/widgets/runs/11" };
    });
    const createReview = vi.fn<GitHubClient["createReview"]>(async () => {
      order.push("review");
      return { id: 12, url: "https://github.com/acme/widgets/pull/7#r-12" };
    });
    const subject = makePullRequest();
    const review = makeReview();
    const markdown = formatReviewMarkdown(review, subject, testConfig);

    const result = await publishReview({
      client: makeClient({ createCheckRun, createReview }),
      subject,
      review,
      markdown,
      changedFiles: [],
      priorReviews: [],
      config: testConfig,
      publish: true,
      environment: actionsEnvironment,
    });

    expect(result.status).toBe("published");
    expect(result.errors).toEqual([]);
    expect(order).toEqual(["check-run", "review"]);
    expect(createCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Gus review",
        headSha: "head-sha",
        conclusion: "success",
        detailsUrl: "https://github.com/acme/widgets/actions/runs/99",
      }),
    );
    const body = createReview.mock.calls[0]?.[1].body ?? "";
    expect(body).toContain(
      "[details](https://github.com/acme/widgets/runs/11) · [evidence json](https://github.com/acme/widgets/actions/runs/99#artifacts)",
    );
    expect(readReportIdentity(body)).toBe(readReportIdentity(markdown));
  });

  it("still posts the review when the token lacks checks: write", async () => {
    const createReview = vi.fn(makeClient().createReview);
    const subject = makePullRequest();
    const review = makeReview();

    const result = await publishReview({
      client: makeClient({
        createReview,
        createCheckRun: async () => {
          throw new GitHubRequestError(403, false);
        },
      }),
      subject,
      review,
      markdown: formatReviewMarkdown(review, subject, testConfig),
      changedFiles: [],
      priorReviews: [],
      config: testConfig,
      publish: true,
      environment: {},
    });

    expect(result.status).toBe("published");
    expect(result.reviewId).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.notices).toEqual([
      "Check run skipped: the token lacks `checks: write`; the review was still posted.",
    ]);
    expect(publicationExitCode(result)).toBe(0);
    const body = createReview.mock.calls[0]?.[1].body ?? "";
    expect(body).not.toContain("[details]");
    expect(body).not.toContain("[evidence json]");
  });

  it("marks the earlier Gus review superseded and keeps its hidden state", async () => {
    const subject = makePullRequest();
    const earlier = makeReview();
    earlier.snapshot.headSha = "old-head-sha";
    earlier.summary = "An earlier revision.";
    const earlierBody = formatReviewMarkdown(earlier, subject, testConfig);
    const updateReview = vi.fn<GitHubClient["updateReview"]>(
      async () => undefined,
    );
    const alreadySuperseded = `Superseded by [this review](https://github.com/r/4) at \`abc1234\`.\n\n${earlierBody.slice(earlierBody.indexOf("<!-- gus-review:v1"))}`;
    const client = makeClient({
      updateReview,
      createReview: async () => ({
        id: 20,
        url: "https://github.com/acme/widgets/pull/7#r-20",
      }),
      listReviews: async () => [
        {
          id: 5,
          author: "gus[bot]",
          body: earlierBody,
          commitId: "old-head-sha",
          url: "https://github.com/acme/widgets/pull/7#r-5",
          submittedAt: "2026-01-02",
        },
        {
          id: 4,
          author: "gus[bot]",
          body: alreadySuperseded,
          commitId: "old-head-sha",
          url: "https://github.com/acme/widgets/pull/7#r-4",
          submittedAt: "2026-01-01",
        },
      ],
    });
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
      environment: {},
    });

    expect(result.status).toBe("published");
    expect(updateReview).toHaveBeenCalledTimes(1);
    const [number, reviewId, body] = updateReview.mock.calls[0] ?? [];
    expect(number).toBe(7);
    expect(reviewId).toBe(5);
    expect(body).toMatch(
      /^Superseded by \[this review\]\(https:\/\/github\.com\/acme\/widgets\/pull\/7#r-20\) at `head-sh`\.\n\n<!-- gus-review:v1 /,
    );
    expect(parseReviewState(body ?? "")).toEqual(parseReviewState(earlierBody));
    const history = await readPriorReviews(
      makeClient({
        listReviews: async () => [
          {
            id: 5,
            author: "gus[bot]",
            body: body ?? "",
            commitId: "old-head-sha",
            url: "https://github.com/acme/widgets/pull/7#r-5",
            submittedAt: "2026-01-02",
          },
        ],
      }),
      7,
      testConfig,
    );
    expect(history.map((prior) => prior.state.headSha)).toEqual([
      "old-head-sha",
    ]);
  });

  it("records a failed supersede edit as a notice, not an error", async () => {
    const subject = makePullRequest();
    const earlier = makeReview();
    earlier.snapshot.headSha = "old-head-sha";
    const review = makeReview();

    const result = await publishReview({
      client: makeClient({
        updateReview: async () => {
          throw new GitHubRequestError(403, false);
        },
        listReviews: async () => [
          {
            id: 5,
            author: "gus[bot]",
            body: formatReviewMarkdown(earlier, subject, testConfig),
            commitId: "old-head-sha",
            url: "https://github.com/acme/widgets/pull/7#r-5",
            submittedAt: "2026-01-02",
          },
        ],
      }),
      subject,
      review,
      markdown: formatReviewMarkdown(review, subject, testConfig),
      changedFiles: [],
      priorReviews: [],
      config: testConfig,
      publish: true,
      environment: {},
    });

    expect(result.status).toBe("published");
    expect(result.errors).toEqual([]);
    expect(result.notices).toEqual([
      "Could not mark 1 earlier review as superseded; the new review was still posted.",
    ]);
  });

  it("does not create a check run or supersede anything for an already-published report", async () => {
    const subject = makePullRequest();
    const review = makeReview();
    const markdown = formatReviewMarkdown(review, subject, testConfig);
    const createCheckRun = vi.fn(makeClient().createCheckRun);
    const updateReview = vi.fn(makeClient().updateReview);

    const result = await publishReview({
      client: makeClient({
        createCheckRun,
        updateReview,
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
      }),
      subject,
      review,
      markdown,
      changedFiles: [],
      priorReviews: [],
      config: testConfig,
      publish: true,
      environment: {},
    });

    expect(result.status).toBe("already-published");
    expect(createCheckRun).not.toHaveBeenCalled();
    expect(updateReview).not.toHaveBeenCalled();
  });
});
