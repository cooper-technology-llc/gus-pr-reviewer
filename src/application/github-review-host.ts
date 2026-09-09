import { basename } from "node:path";
import { defaultConfig, type GusConfig } from "../config/config-schema.js";
import {
  applyEnvironment,
  configurationReader,
  loadConfig,
  parseConfig,
  type Environment,
  type ReadConfigurationFile,
} from "../config/load-config.js";
import { GusError } from "../errors.js";
import { createGitHubClient } from "../github/github-client.js";
import type {
  GitHubClient,
  GitHubPullRequest,
  GitHubRepository,
} from "../github/github-port.js";
import type { PullRequestReviewOptions } from "./application-options.js";
import type { createReviewDeadline } from "./review-deadline.js";

export interface GitHubReviewHost {
  client: GitHubClient;
  repository: GitHubRepository;
  subject: GitHubPullRequest;
  config: GusConfig;
  environment: Environment;
  token: string;
  readConfigurationFile: ReadConfigurationFile;
}

/** Bootstrap GitHub from host settings, then read repository policy at its target SHA. */
export async function createGitHubReviewHost(
  options: PullRequestReviewOptions,
  deadline?: ReturnType<typeof createReviewDeadline>,
): Promise<GitHubReviewHost> {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) {
    throw new GusError("INPUT_INVALID", "Repository must be OWNER/REPOSITORY.");
  }
  if (!Number.isSafeInteger(options.pullRequest) || options.pullRequest < 1) {
    throw new GusError(
      "INPUT_INVALID",
      "Pull request number must be a positive integer.",
    );
  }
  const environment = options.environment ?? process.env;
  const local = options.configPath
    ? await loadExplicitConfiguration(options.configPath)
    : null;
  const initialConfig = options.config ?? local?.config ?? defaultConfig;
  deadline?.setDuration(initialConfig.review.maxDurationMs);
  const apiUrl =
    options.apiUrl ??
    environment["GITHUB_API_URL"] ??
    initialConfig.github.apiUrl;
  const initialToken = resolveGitHubToken(initialConfig, environment);
  const initialClient = createGitHubClient({
    repository: options.repository,
    token: initialToken,
    apiUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const [repository, subject] = await Promise.all([
    initialClient.getRepository(),
    initialClient.getPullRequest(options.pullRequest),
  ]);
  const readConfigurationFile =
    local?.readText ??
    ((path: string) => initialClient.getFile(path, subject.baseSha));
  const repositoryConfig =
    options.config ??
    local?.config ??
    (await loadConfig(readConfigurationFile));
  const config = applyEnvironment(
    parseConfig({
      ...repositoryConfig,
      github: { ...repositoryConfig.github, apiUrl },
    }),
    environment,
  );
  deadline?.setDuration(config.review.maxDurationMs);
  const token = resolveGitHubToken(config, environment);
  const client =
    token === initialToken
      ? initialClient
      : createGitHubClient({
          repository: options.repository,
          token,
          apiUrl,
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
  return {
    client,
    repository,
    subject,
    config,
    environment,
    token,
    readConfigurationFile,
  };
}

export async function loadExplicitConfiguration(
  path: string,
): Promise<{ config: GusConfig; readText: ReadConfigurationFile }> {
  const readText = await configurationReader(path);
  if ((await readText(basename(path))) === null)
    throw new GusError(
      "CONFIG_INVALID",
      `Configuration file does not exist: ${path}`,
    );
  return { config: await loadConfig(readText, basename(path)), readText };
}

export function resolveGitHubToken(
  config: GusConfig,
  environment: Environment,
): string {
  const token = environment[config.github.tokenEnv] ?? environment["GH_TOKEN"];
  if (!token?.trim())
    throw new GusError(
      "CONFIG_INVALID",
      `Set ${config.github.tokenEnv} to a GitHub token with repository read access.`,
    );
  return token;
}
