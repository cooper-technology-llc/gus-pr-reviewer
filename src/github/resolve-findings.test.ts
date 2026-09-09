// Thread closure requires current evidence and a trusted matching finding, independent of model omission.
import { describe, expect, it, vi } from "vitest";
import {
  formatFindingMarker,
  stateFromReview,
} from "../reporting/review-state.js";
import type { PublicationResult } from "../review/review-ports.js";
import {
  makeClient,
  makePullRequest,
  makeReview,
  testConfig,
} from "./github-test-fixtures.js";
import { resolveEvidencedFindings } from "./resolve-findings.js";

describe("evidenced thread resolution", () => {
  it("resolves only a matching trusted finding with evidence at the reviewed HEAD", async () => {
    const review = makeReview();
    const previous = makeReview();
    previous.findings = [
      {
        id: "f1",
        title: "Persist updates",
        severity: "major",
        path: "widget.ts",
        line: 1,
        side: "RIGHT",
        trigger: "An update.",
        impact: "It is lost.",
        suggestion: "Persist it.",
        evidenceIds: ["e1"],
        disposition: "blocking",
      },
    ];
    previous.findings.push({
      id: "f2",
      title: "Keep old values",
      severity: "major",
      path: "widget.ts",
      line: 2,
      side: "RIGHT",
      trigger: "An omitted input.",
      impact: "A value is discarded.",
      suggestion: "Retain it.",
      evidenceIds: ["e1"],
      disposition: "blocking",
    });
    review.reconciliations = [
      {
        id: "f1",
        status: "resolved",
        reason: "Updates are persisted.",
        evidenceIds: ["e1"],
      },
      {
        id: "f2",
        status: "resolved",
        reason: "Assumed fixed.",
        evidenceIds: [],
      },
    ];
    const resolveThread = vi.fn(makeClient().resolveThread);
    const client = makeClient({
      resolveThread,
      listThreads: async () => [
        {
          id: "trusted",
          resolved: false,
          comments: [
            {
              author: "gus[bot]",
              body: formatFindingMarker("f1"),
              reviewId: 4,
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
              reviewId: 4,
            },
          ],
        },
        {
          id: "unproven",
          resolved: false,
          comments: [
            {
              author: "gus[bot]",
              body: formatFindingMarker("f2"),
              reviewId: 4,
            },
          ],
        },
      ],
    });
    const publication: PublicationResult = {
      status: "published",
      reviewUrl: null,
      reviewId: null,
      inlinePosted: 0,
      issues: [],
      threadsResolved: 0,
      slackSent: false,
      errors: [],
    };
    await resolveEvidencedFindings(
      {
        client,
        subject: makePullRequest(),
        review,
        config: testConfig,
        priorReviews: [
          {
            id: 4,
            author: "gus[bot]",
            url: "https://github.com/review/4",
            submittedAt: "2026-01-01",
            state: stateFromReview(previous),
            replies: [],
          },
        ],
      },
      publication,
    );
    expect(resolveThread).toHaveBeenCalledExactlyOnceWith("trusted");
    expect(publication.threadsResolved).toBe(1);
  });
});
