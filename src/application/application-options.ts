import type { GusConfig } from "../config/config-schema.js";
import type { Environment } from "../config/load-config.js";
import type { CheckResult } from "../review/review-schema.js";
import type { ReviewInput } from "../review/review-ports.js";

export interface CommonReviewOptions {
  config?: GusConfig;
  configPath?: string;
  parent?: string;
  checks?: CheckResult[];
  environment?: Environment;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  onProgress?: ReviewInput["onProgress"];
}
export interface PullRequestReviewOptions extends CommonReviewOptions {
  repository: string;
  pullRequest: number;
  apiUrl?: string;
  publish?: boolean;
  requestedIssues?: boolean;
}
export interface LocalReviewOptions extends CommonReviewOptions {
  path: string;
  base: string;
  head?: string;
  defaultBranch?: string;
}
export interface GitHubEventOptions {
  event: unknown;
  eventName: string;
  environment?: Environment;
  apiUrl?: string;
  configPath?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}
export interface PreparedGitHubEvent {
  repository: string;
  pullRequest: number | null;
  eligible: boolean;
  reason: string;
  mode: "review" | "issues" | "review-and-issues";
  manual: boolean;
}
