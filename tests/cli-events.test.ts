// Event authorization must decide the action before a model or publication operation can start.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PreparedGitHubEvent,
  PullRequestReviewOptions,
} from "../src/application/application-options.js";
import { runCli, type CliDependencies } from "../src/cli/run-cli.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function eventPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gus-cli-event-"));
  roots.push(root);
  const path = join(root, "event.json");
  await writeFile(path, "{}");
  return path;
}

function event(
  mode: PreparedGitHubEvent["mode"],
  eligible = true,
): PreparedGitHubEvent {
  return {
    repository: "acme/service",
    pullRequest: 42,
    eligible,
    reason: eligible ? "Authorized." : "Ordinary discussion.",
    mode,
    manual: true,
  };
}

describe("event dispatch", () => {
  it.each(["review", "issues", "review-and-issues"])(
    "routes authorized %s events to the correct action",
    async (mode) => {
      if (
        mode !== "review" &&
        mode !== "issues" &&
        mode !== "review-and-issues"
      )
        throw new Error("Unexpected mode.");
      const path = await eventPath();
      const reviewCalls: PullRequestReviewOptions[] = [];
      const issueCalls: PullRequestReviewOptions[] = [];
      const dependencies: Partial<CliDependencies> = {
        environment: { GITHUB_EVENT_NAME: "issue_comment" },
        stdout: () => undefined,
        stderr: () => undefined,
        prepareGitHubEvent: async () => event(mode),
        reviewPullRequest: async (options) => {
          reviewCalls.push(options);
          throw new Error("Reached review entrypoint.");
        },
        filePullRequestIssues: async (options) => {
          issueCalls.push(options);
          throw new Error("Reached issue entrypoint.");
        },
      };
      expect(
        await runCli(["review", "--event", path, "--publish"], dependencies),
      ).toBe(2);
      if (mode === "issues") {
        expect(issueCalls[0]).toMatchObject({ publish: true, pullRequest: 42 });
        expect(reviewCalls).toEqual([]);
      } else {
        expect(reviewCalls[0]).toMatchObject({
          publish: true,
          requestedIssues: mode === "review-and-issues",
        });
        expect(issueCalls).toEqual([]);
      }
    },
  );

  it("skips rejected events without invoking review or issues", async () => {
    const path = await eventPath();
    const stdout: string[] = [];
    let externalCalls = 0;
    const unexpected = async (): Promise<never> => {
      externalCalls += 1;
      throw new Error("Unexpected external operation.");
    };
    const code = await runCli(["review", "--event", path, "--publish"], {
      environment: { GITHUB_EVENT_NAME: "issue_comment" },
      stdout: (text) => {
        stdout.push(text);
      },
      stderr: () => undefined,
      prepareGitHubEvent: async () => event("review", false),
      reviewPullRequest: unexpected,
      filePullRequestIssues: unexpected,
    });
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("skipped");
    expect(externalCalls).toBe(0);
  });
});
