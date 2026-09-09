import { defaultConfig } from "../config/config-schema.js";
import type { ReviewResult } from "../review/review-schema.js";
import type { GitHubClient, GitHubPullRequest } from "./github-port.js";

export const testConfig = defaultConfig;

export function makePullRequest(): GitHubPullRequest {
  return {
    repository: "acme/widgets",
    number: 7,
    title: "Correct widget updates",
    body: "A focused change.",
    author: "alice",
    url: "https://github.com/acme/widgets/pull/7",
    state: "open",
    draft: false,
    isFork: false,
    baseRef: "main",
    baseSha: "base-sha",
    headRef: "fix/widgets",
    headSha: "head-sha",
    headCloneUrl: "https://github.com/acme/widgets.git",
    headOwner: "acme",
    merged: false,
  };
}

export function makeReview(): ReviewResult {
  return {
    version: 1,
    snapshot: {
      baseSha: "base-sha",
      headSha: "head-sha",
      mergeBaseSha: "base-sha",
      comparisonBaseSha: "base-sha",
      baseRef: "main",
      headRef: "fix/widgets",
      defaultBranch: "main",
      defaultSha: "base-sha",
      parent: null,
      integration: {
        status: "clean",
        treeSha: "tree-sha",
        targetSha: "base-sha",
        conflicts: [],
        explanation: "Clean merge.",
      },
      historyRewritten: false,
      baseChanged: false,
      advisories: [],
    },
    verdict: "ready",
    summary: "Widget updates preserve existing values.",
    risk: "low",
    size: "S",
    findings: [],
    reconciliations: [],
    questions: [],
    architecture: { grade: "A", reason: "Bounded changes." },
    tests: { grade: "B", reason: "Relevant behavior covered." },
    personality: "A tidy home for widget updates.",
    coverage: [
      {
        path: "widget.ts",
        status: "inspected",
        reason: "Read changed behavior.",
      },
    ],
    evidence: [
      {
        id: "e1",
        path: "widget.ts",
        revision: "head",
        sha: "head-sha",
        startLine: 1,
        endLine: 1,
        text: "return value;",
        kind: "file",
        truncated: false,
      },
    ],
    checks: [],
    limitations: [],
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      costUsd: null,
      requests: 1,
      toolCalls: 1,
      elapsedMs: 100,
      models: ["example/model"],
    },
  };
}

export function makeClient(
  overrides: Partial<GitHubClient> = {},
): GitHubClient {
  return {
    getRepository: async () => ({
      owner: "acme",
      name: "widgets",
      defaultBranch: "main",
      defaultSha: "base-sha",
      cloneUrl: "https://github.com/acme/widgets.git",
      url: "https://github.com/acme/widgets",
    }),
    getPullRequest: async () => makePullRequest(),
    getAuthenticatedLogin: async () => "gus[bot]",
    getPermission: async () => "write",
    getFile: async () => null,
    listPullRequests: async () => [],
    listReviews: async () => [],
    listThreads: async () => [],
    listIssues: async () => [],
    createReview: async () => ({
      id: 1,
      url: "https://github.com/acme/widgets/pull/7#pullrequestreview-1",
    }),
    createIssue: async () => ({
      number: 2,
      title: "Follow-up",
      body: "",
      url: "https://github.com/acme/widgets/issues/2",
    }),
    resolveThread: async () => undefined,
    ...overrides,
  };
}
