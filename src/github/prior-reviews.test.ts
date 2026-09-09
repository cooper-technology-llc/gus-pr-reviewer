// History state is trusted by author and schema, while same-HEAD reruns and human replies remain visible.
import { describe, expect, it } from "vitest";
import { formatReviewMarkdown } from "../reporting/format-review.js";
import { formatFindingMarker } from "../reporting/review-state.js";
import {
  makeClient,
  makePullRequest,
  makeReview,
  testConfig,
} from "./github-test-fixtures.js";
import { readPriorReviews } from "./prior-reviews.js";

describe("trusted prior reviews", () => {
  it("ignores copied markers from another author and preserves same-head trusted reruns", async () => {
    const body = formatReviewMarkdown(
      makeReview(),
      makePullRequest(),
      testConfig,
    );
    const client = makeClient({
      listReviews: async () => [
        {
          id: 1,
          author: "outsider",
          body,
          commitId: "head-sha",
          url: "https://github.com/1",
          submittedAt: "2026-01-01",
        },
        {
          id: 2,
          author: "gus[bot]",
          body,
          commitId: "head-sha",
          url: "https://github.com/2",
          submittedAt: "2026-01-02",
        },
        {
          id: 3,
          author: "gus[bot]",
          body,
          commitId: "other-sha",
          url: "https://github.com/3",
          submittedAt: "2026-01-03",
        },
      ],
    });
    expect(
      (await readPriorReviews(client, 7, testConfig)).map(
        (review) => review.id,
      ),
    ).toEqual([2]);
  });
  it("attaches replies and resolution state only to authenticated finding roots", async () => {
    const review = makeReview();
    review.findings = [
      {
        id: "f1",
        title: "Persist updates",
        severity: "major",
        path: "widget.ts",
        line: 1,
        side: "RIGHT",
        trigger: "An update is submitted.",
        impact: "It is lost.",
        suggestion: "Persist it.",
        evidenceIds: ["e1"],
        disposition: "blocking",
      },
    ];
    const client = makeClient({
      listReviews: async () => [
        {
          id: 2,
          author: "gus[bot]",
          body: formatReviewMarkdown(review, makePullRequest(), testConfig),
          commitId: "head-sha",
          url: "https://github.com/2",
          submittedAt: "2026-01-02",
        },
      ],
      listThreads: async () => [
        {
          id: "trusted",
          resolved: true,
          comments: [
            {
              author: "gus[bot]",
              body: formatFindingMarker("f1"),
              reviewId: 2,
            },
            {
              author: "alice",
              body: "The update is now persisted.",
              reviewId: null,
            },
          ],
        },
        {
          id: "spoofed",
          resolved: false,
          comments: [
            {
              author: "outsider",
              body: formatFindingMarker("f1"),
              reviewId: 2,
            },
          ],
        },
      ],
    });
    const prior = await readPriorReviews(client, 7, testConfig);
    expect(prior[0]?.replies).toHaveLength(2);
    expect(prior[0]?.replies[1]).toMatchObject({
      author: "alice",
      resolved: true,
      threadId: "trusted",
    });
  });
});
