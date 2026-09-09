import { resolve } from "node:path";
import { defaultConfig } from "../config/config-schema.js";
import {
  applyEnvironment,
  loadConfig,
  loadPrompts,
} from "../config/load-config.js";
import { GusError } from "../errors.js";
import { createModelClient } from "../model/model-client.js";
import { createRepositorySession } from "../repository/repository-session.js";
import { createRepositoryTools } from "../repository/repository-tools.js";
import { formatReviewMarkdown } from "../reporting/format-review.js";
import { reviewChange } from "../review/review-change.js";
import type {
  CompletedReview,
  RepositorySession,
  RepositorySource,
} from "../review/review-ports.js";
import type { LocalReviewOptions } from "./application-options.js";
import { loadExplicitConfiguration } from "./github-review-host.js";
import { loadPolicies, requireModelKey } from "./review-input.js";
import { createReviewDeadline } from "./review-deadline.js";

/** Review committed local history without changing the checkout or posting remotely. */
export async function reviewLocalChanges(
  options: LocalReviewOptions,
): Promise<CompletedReview> {
  const deadline = createReviewDeadline(
    options.config?.review.maxDurationMs ?? defaultConfig.review.maxDurationMs,
    options.signal,
  );
  try {
    return await runLocalReview(options, deadline);
  } finally {
    deadline.dispose();
  }
}

async function runLocalReview(
  options: LocalReviewOptions,
  deadline: ReturnType<typeof createReviewDeadline>,
): Promise<CompletedReview> {
  const environment = options.environment ?? process.env;
  const explicit = options.configPath
    ? await loadExplicitConfiguration(options.configPath)
    : null;
  const initialConfig = options.config ?? explicit?.config ?? defaultConfig;
  const signal = deadline.signal;
  deadline.setDuration(initialConfig.review.maxDurationMs);
  const source: RepositorySource = {
    path: resolve(options.path),
    base: options.base,
    head: options.head ?? "HEAD",
    baseRef: options.base,
    headRef: options.head ?? "HEAD",
    defaultBranch: options.defaultBranch ?? "",
    ...(options.defaultBranch ? { defaultRef: options.defaultBranch } : {}),
    ...(options.parent
      ? {
          parent: {
            ref: options.parent,
            sha: options.parent,
            pullRequest: null,
            merged: false,
          },
        }
      : {}),
  };
  let repository = await createRepositorySession(source, {
    config: initialConfig,
    signal,
  });
  try {
    const readText =
      explicit?.readText ?? snapshotConfigurationReader(repository);
    const config = applyEnvironment(
      options.config ?? explicit?.config ?? (await loadConfig(readText)),
      environment,
    );
    deadline.setDuration(config.review.maxDurationMs);
    if (
      JSON.stringify(config.review) !== JSON.stringify(initialConfig.review)
    ) {
      const pinnedSource = {
        ...source,
        head: repository.snapshot.headSha,
        base: repository.snapshot.baseSha,
      };
      const previous = repository;
      repository = await createRepositorySession(pinnedSource, {
        config,
        signal,
      });
      await previous.dispose();
    }
    const configurationFiles =
      explicit?.readText ?? snapshotConfigurationReader(repository);
    const [prompts, policies] = await Promise.all([
      loadPrompts(config, configurationFiles),
      loadPolicies(config, configurationFiles),
    ]);
    const apiKey = requireModelKey(config, environment);
    const subject = {
      repository: resolve(options.path),
      number: null,
      title: `${options.head ?? "HEAD"} against ${options.base}`,
      body: "Local committed changes. Uncommitted and untracked files are outside this review.",
      author: "local author",
      url: "",
    };
    const review = await reviewChange({
      subject,
      repository,
      tools: createRepositoryTools(repository, config),
      model: createModelClient(config, {
        apiKey,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
      config,
      prompts,
      policies,
      priorReviews: [],
      checks: options.checks ?? [],
      signal,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    return {
      review,
      markdown: formatReviewMarkdown(review, subject, config),
      publication: {
        status: "dry-run",
        reviewUrl: null,
        reviewId: null,
        inlinePosted: 0,
        issues: [],
        threadsResolved: 0,
        slackSent: false,
        errors: [],
      },
    };
  } finally {
    await repository.dispose();
  }
}

function snapshotConfigurationReader(repository: RepositorySession) {
  return async (path: string): Promise<string | null> => {
    try {
      const file = await repository.readFile(path, "base");
      if (file.truncated)
        throw new GusError(
          "CONFIG_INVALID",
          `Trusted configuration file exceeds the read limit: ${path}`,
        );
      return file.text;
    } catch (error) {
      if (error instanceof GusError && error.code === "FILE_NOT_FOUND")
        return null;
      throw error;
    }
  };
}
