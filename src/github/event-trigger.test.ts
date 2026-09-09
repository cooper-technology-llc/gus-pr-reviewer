// Command eligibility must prevent untrusted or ordinary conversation from starting paid review work.
import { describe, expect, it } from "vitest";
import { evaluateGitHubEvent } from "./event-trigger.js";
import {
  makeClient,
  makePullRequest,
  testConfig,
} from "./github-test-fixtures.js";

function comment(body: string, login = "alice", type = "User"): unknown {
  return {
    action: "created",
    issue: { number: 7, pull_request: {} },
    comment: { body, user: { login, type } },
  };
}

describe("GitHub event eligibility", () => {
  it("accepts exact combined commands for authorized inline comments", async () => {
    const result = await evaluateGitHubEvent({
      event: {
        action: "created",
        pull_request: { number: 7 },
        comment: {
          body: "@gus review issues",
          user: { login: "alice", type: "User" },
        },
      },
      eventName: "pull_request_review_comment",
      config: testConfig,
      client: makeClient(),
    });
    expect(result).toMatchObject({
      eligible: true,
      mode: "review-and-issues",
      pullRequest: 7,
      manual: true,
    });
  });
  it.each([
    "please @gus review",
    "> @gus",
    "```\n@gus\n```",
    "    @gus",
    "<!--\n@gus\n-->",
    "@gus please",
    "`@gus`",
  ])("ignores non-command content %s", async (body) => {
    expect(
      (
        await evaluateGitHubEvent({
          event: comment(body),
          eventName: "issue_comment",
          config: testConfig,
          client: makeClient(),
        })
      ).eligible,
    ).toBe(false);
  });
  it("rejects bots and users without collaborator write access", async () => {
    const input = {
      eventName: "issue_comment",
      config: testConfig,
      client: makeClient({ getPermission: async () => "read" }),
    };
    expect(
      (await evaluateGitHubEvent({ ...input, event: comment("@gus") }))
        .eligible,
    ).toBe(false);
    expect(
      (
        await evaluateGitHubEvent({
          ...input,
          client: makeClient(),
          event: comment("@gus", "bot[bot]", "Bot"),
        })
      ).eligible,
    ).toBe(false);
  });
  it("permits explicit draft review but rejects automatic draft review", async () => {
    const client = makeClient({
      getPullRequest: async () => ({ ...makePullRequest(), draft: true }),
    });
    expect(
      (
        await evaluateGitHubEvent({
          event: comment("@gus"),
          eventName: "issue_comment",
          config: testConfig,
          client,
        })
      ).eligible,
    ).toBe(true);
    expect(
      (
        await evaluateGitHubEvent({
          event: { action: "opened", pull_request: { number: 7 } },
          eventName: "pull_request",
          config: testConfig,
          client,
        })
      ).eligible,
    ).toBe(false);
  });
  it("accepts trusted target events, manual pr input, and base retargeting only", async () => {
    const common = { config: testConfig, client: makeClient() };
    expect(
      (
        await evaluateGitHubEvent({
          ...common,
          eventName: "pull_request_target",
          event: { action: "opened", pull_request: { number: 7 } },
        })
      ).eligible,
    ).toBe(true);
    expect(
      (
        await evaluateGitHubEvent({
          ...common,
          eventName: "workflow_dispatch",
          event: {
            inputs: { pr: "7" },
            sender: { login: "alice", type: "User" },
          },
        })
      ).eligible,
    ).toBe(true);
    expect(
      (
        await evaluateGitHubEvent({
          ...common,
          eventName: "pull_request_target",
          event: {
            action: "edited",
            pull_request: { number: 7 },
            changes: { base: { ref: { from: "old-base" } } },
          },
        })
      ).eligible,
    ).toBe(true);
    expect(
      (
        await evaluateGitHubEvent({
          ...common,
          eventName: "pull_request_target",
          event: { action: "edited", pull_request: { number: 7 } },
        })
      ).eligible,
    ).toBe(false);
  });
});
