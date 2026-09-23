// The Check Run reads correctly at a glance and never blocks publication.
import { describe, expect, it } from "vitest";
import {
  checkRunConclusion,
  createReviewCheckRun,
  evidenceArtifactUrl,
  workflowRunUrl,
} from "./check-run.js";
import { makeClient, makeReview, testConfig } from "./github-test-fixtures.js";
import { GitHubRequestError } from "./github-request.js";

describe("review check run", () => {
  it("maps verdict and coverage to a conclusion", () => {
    const review = makeReview();
    expect(checkRunConclusion(review)).toBe("success");
    review.coverageSummary = { ...review.coverageSummary, status: "partial" };
    expect(checkRunConclusion(review)).toBe("neutral");
    review.verdict = "changes-requested";
    expect(checkRunConclusion(review)).toBe("failure");
    review.verdict = "incomplete";
    expect(checkRunConclusion(review)).toBe("neutral");
  });

  it("derives run and artifact links only from a complete, safe Actions environment", () => {
    const environment = {
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "acme/widgets",
      GITHUB_RUN_ID: "99",
    };
    expect(workflowRunUrl(environment)).toBe(
      "https://github.com/acme/widgets/actions/runs/99",
    );
    expect(evidenceArtifactUrl(environment)).toBe(
      "https://github.com/acme/widgets/actions/runs/99#artifacts",
    );
    expect(
      workflowRunUrl({ ...environment, GITHUB_RUN_ID: undefined }),
    ).toBeNull();
    expect(
      workflowRunUrl({ ...environment, GITHUB_RUN_ID: "9; rm" }),
    ).toBeNull();
    expect(
      workflowRunUrl({
        ...environment,
        GITHUB_SERVER_URL: "javascript:alert(1)",
      }),
    ).toBeNull();
  });

  it("turns 403, 404 and other failures into notices instead of throwing", async () => {
    const cases: Array<[GitHubRequestError, string]> = [
      [new GitHubRequestError(403, false), "lacks `checks: write`"],
      [new GitHubRequestError(404, false), "lacks `checks: write`"],
      [new GitHubRequestError(500, true), "could not be created"],
    ];
    for (const [error, notice] of cases) {
      const outcome = await createReviewCheckRun({
        client: makeClient({
          createCheckRun: async () => {
            throw error;
          },
        }),
        review: makeReview(),
        headSha: "head-sha",
        config: testConfig,
        environment: {},
      });
      expect(outcome.status).toBe("skipped");
      expect(outcome.status === "skipped" ? outcome.notice : "").toContain(
        notice,
      );
    }
  });
});
