import type { GusConfig } from "../config/config-schema.js";
import type { CheckRunOutput } from "../reporting/format-check-run.js";
import type { ReviewSubject } from "../review/review-ports.js";
import type {
  ChangedFile,
  PriorReview,
  ReviewResult,
} from "../review/review-schema.js";

export interface GitHubRepository {
  owner: string;
  name: string;
  defaultBranch: string;
  defaultSha: string;
  cloneUrl: string;
  url: string;
}
export interface GitHubPullRequest extends ReviewSubject {
  number: number;
  state: "open" | "closed";
  draft: boolean;
  isFork: boolean;
  baseRef: string;
  baseSha: string;
  headRef: string;
  headSha: string;
  headCloneUrl: string;
  headOwner: string;
  merged: boolean;
}
export interface GitHubReviewRecord {
  id: number;
  author: string;
  body: string;
  commitId: string;
  url: string;
  submittedAt: string;
}
export interface GitHubThread {
  id: string;
  resolved: boolean;
  comments: Array<{ body: string; author: string; reviewId: number | null }>;
}
export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
}
export interface GitHubCheckRunInput {
  name: string;
  headSha: string;
  conclusion: "success" | "failure" | "neutral";
  detailsUrl?: string;
  output: CheckRunOutput;
}
export interface GitHubClient {
  getRepository(): Promise<GitHubRepository>;
  getPullRequest(number: number): Promise<GitHubPullRequest>;
  getAuthenticatedLogin(): Promise<string | null>;
  getPermission(login: string): Promise<string>;
  getFile(path: string, ref: string): Promise<string | null>;
  listPullRequests(options?: {
    state?: "open" | "closed" | "all";
    head?: string;
  }): Promise<GitHubPullRequest[]>;
  listReviews(number: number): Promise<GitHubReviewRecord[]>;
  listThreads(number: number): Promise<GitHubThread[]>;
  listIssues(): Promise<GitHubIssue[]>;
  createReview(
    number: number,
    input: {
      body: string;
      commitId: string;
      comments: Array<{
        path: string;
        line: number;
        side: "LEFT" | "RIGHT";
        body: string;
      }>;
    },
  ): Promise<{ id: number; url: string }>;
  /** Replaces a submitted review's body (used to mark an earlier review superseded). */
  updateReview(number: number, reviewId: number, body: string): Promise<void>;
  createCheckRun(
    input: GitHubCheckRunInput,
  ): Promise<{ id: number; url: string }>;
  createIssue(input: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<GitHubIssue>;
  resolveThread(id: string): Promise<void>;
}
export interface GitHubClientOptions {
  repository: string;
  token: string;
  apiUrl?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}
export interface PublishReviewInput {
  client: GitHubClient;
  subject: GitHubPullRequest;
  review: ReviewResult;
  markdown: string;
  changedFiles: ChangedFile[];
  priorReviews: PriorReview[];
  config: GusConfig;
  publish: boolean;
  requestedIssues?: boolean;
  /** Actions run variables (GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID); defaults to process.env. */
  environment?: Record<string, string | undefined>;
  slackWebhook?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}
