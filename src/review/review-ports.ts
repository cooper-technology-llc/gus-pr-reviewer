import type {
  GusConfig,
  LoadedPrompts,
  ReviewStage,
} from "../config/config-schema.js";
import type {
  BranchAdvice,
  ChangedFile,
  CheckResult,
  PriorReview,
  ReviewEvidence,
  ReviewResult,
  ReviewSnapshot,
  Revision,
} from "./review-schema.js";

export interface ModelTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface ModelToolCall {
  id: string;
  name: string;
  arguments: unknown;
}
export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ModelToolCall[];
  toolCallId?: string;
}
export interface ModelRequest {
  stage: ReviewStage;
  model: string;
  messages: ModelMessage[];
  tools: ModelTool[];
  maxOutputTokens: number;
  deadline: number;
  signal?: AbortSignal;
  jsonMode: boolean;
  reasoningEffort?: string;
}
export interface ModelCompletion {
  content: string;
  toolCalls: ModelToolCall[];
  finishReason: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  model: string;
  requestAttempts?: number;
  usageAvailable?: boolean;
}
export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelCompletion>;
}

export interface FileRead {
  path: string;
  revision: Revision;
  sha: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
  truncated: boolean;
}
export interface RepositorySession {
  snapshot: ReviewSnapshot;
  files: ChangedFile[];
  omissions: string[];
  readFile(
    path: string,
    revision: Revision,
    startLine?: number,
    endLine?: number,
    options?: RepositoryCommandOptions,
  ): Promise<FileRead>;
  listFiles(
    pattern?: string,
    revision?: Revision,
    options?: RepositoryCommandOptions,
  ): Promise<string[]>;
  readDiff(
    path: string,
    startLine?: number,
    lineCount?: number,
    options?: RepositoryCommandOptions,
  ): Promise<{ text: string; truncated: boolean; totalLines: number }>;
  history(path?: string, options?: RepositoryCommandOptions): Promise<string>;
  dispose(): Promise<void>;
}
export interface RepositorySource {
  path?: string;
  remoteUrl?: string;
  token?: string;
  base: string;
  head: string;
  baseRef?: string;
  headRef?: string;
  defaultBranch: string;
  defaultRef?: string;
  parent?: {
    ref: string;
    sha: string;
    pullRequest: number | null;
    merged: boolean;
  };
  parentCandidates?: Array<{
    ref: string;
    sha: string;
    pullRequest: number | null;
    merged: boolean;
  }>;
  headRemoteUrl?: string;
  previousHeadSha?: string;
  previousBaseSha?: string;
}
export interface RepositoryOptions {
  config: GusConfig;
  signal?: AbortSignal;
}
export interface RepositoryCommandOptions {
  signal?: AbortSignal;
  deadline?: number;
}
export interface ToolExecution {
  content: string;
  evidence: ReviewEvidence[];
  inspectedPaths: string[];
  warnings: string[];
}
export interface RepositoryTools {
  definitions: ModelTool[];
  execute(
    name: string,
    argumentsValue: unknown,
    options?: RepositoryCommandOptions,
  ): Promise<ToolExecution>;
}

export interface ReviewSubject {
  repository: string;
  number: number | null;
  title: string;
  body: string;
  author: string;
  url: string;
}
export interface ReviewInput {
  subject: ReviewSubject;
  repository: RepositorySession;
  tools: RepositoryTools;
  model: ModelClient;
  config: GusConfig;
  prompts: LoadedPrompts;
  policies: Array<{ path: string; text: string }>;
  priorReviews: PriorReview[];
  checks: CheckResult[];
  advisories?: BranchAdvice[];
  signal?: AbortSignal;
  now?: () => number;
  onProgress?: (event: { stage: ReviewStage; message: string }) => void;
}

export interface PublicationResult {
  status: "dry-run" | "published" | "already-published" | "partial" | "stale";
  reviewUrl: string | null;
  reviewId: number | null;
  inlinePosted: number;
  issues: Array<{ number: number; url: string; created: boolean }>;
  threadsResolved: number;
  slackSent: boolean;
  errors: string[];
}
export interface CompletedReview {
  review: ReviewResult;
  markdown: string;
  publication: PublicationResult;
}
