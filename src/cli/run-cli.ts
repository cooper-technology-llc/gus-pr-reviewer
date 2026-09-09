import type {
  CommonReviewOptions,
  GitHubEventOptions,
  LocalReviewOptions,
  PreparedGitHubEvent,
  PullRequestReviewOptions,
} from "../application/application-options.js";
import { filePullRequestIssues } from "../application/file-pull-request-issues.js";
import { prepareGitHubEvent } from "../application/github-event.js";
import { reviewLocalChanges } from "../application/review-local-changes.js";
import { reviewPullRequest } from "../application/review-pull-request.js";
import {
  loadBundledPrompts,
  parseConfig,
  type Environment,
} from "../config/load-config.js";
import { GusError } from "../errors.js";
import { exportPrompts } from "../initialize/export-prompts.js";
import {
  initializeRepository,
  type InitializeOptions,
} from "../initialize/initialize-repository.js";
import { updateRuntime } from "../initialize/update-runtime.js";
import type {
  CompletedReview,
  PublicationResult,
} from "../review/review-ports.js";
import { inspectInstallation, sanitizeDiagnostic } from "./diagnostics.js";
import { writeGitHubOutputs } from "./github-output.js";
import { cliHelp } from "./help.js";
import { readPackageVersion } from "./package-version.js";
import { parseCliArguments, type CliCommand } from "./parse-arguments.js";
import { readChecks, readJsonInput } from "./read-input.js";
import {
  createSetupQuestions,
  setupConfiguration,
  type SetupQuestions,
} from "./setup-configuration.js";
import {
  formatPublicationOutput,
  formatReviewOutput,
  formatSkippedOutput,
  publicationExitCode,
  reviewExitCode,
  writeCommandOutput,
  type WriteStdout,
} from "./write-command-output.js";

export interface CliDependencies {
  reviewPullRequest(
    options: PullRequestReviewOptions,
  ): Promise<CompletedReview>;
  reviewLocalChanges(options: LocalReviewOptions): Promise<CompletedReview>;
  prepareGitHubEvent(options: GitHubEventOptions): Promise<PreparedGitHubEvent>;
  filePullRequestIssues(
    options: PullRequestReviewOptions,
  ): Promise<PublicationResult>;
  version(): Promise<string>;
  initializeRepository(options: InitializeOptions): Promise<string[]>;
  isInteractive(): boolean;
  createSetupQuestions(): SetupQuestions;
  stdout: WriteStdout;
  stderr: WriteStdout;
  environment: Environment;
}

/** Dispatch a validated CLI command with explicit publication and honest exit status. */
export async function runCli(
  args: string[],
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const dependencies: CliDependencies = {
    reviewPullRequest,
    reviewLocalChanges,
    prepareGitHubEvent,
    filePullRequestIssues,
    version: readPackageVersion,
    initializeRepository,
    isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    createSetupQuestions,
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    environment: process.env,
    ...overrides,
  };
  const controller = new AbortController();
  const interrupt = () => {
    controller.abort();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    return await dispatchCommand(
      parseCliArguments(args),
      dependencies,
      controller.signal,
    );
  } catch (error) {
    const code = error instanceof GusError ? error.code : "COMMAND_FAILED";
    const message =
      error instanceof Error
        ? error.message
        : "Gus could not complete this command.";
    dependencies.stderr(
      `Gus ${code}: ${sanitizeDiagnostic(message, dependencies.environment)}\n`,
    );
    return 2;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

async function dispatchCommand(
  command: CliCommand,
  dependencies: CliDependencies,
  signal: AbortSignal,
): Promise<number> {
  switch (command.command) {
    case "help":
      dependencies.stdout(cliHelp);
      return 0;
    case "version":
      dependencies.stdout(`${await dependencies.version()}\n`);
      return 0;
    case "init": {
      const configuration = await setupConfiguration({
        directory: command.directory,
        yes: command.yes,
        interactive: dependencies.isInteractive(),
        signal,
        createQuestions: dependencies.createSetupQuestions,
        write: dependencies.stdout,
      });
      const configured = parseConfig(configuration);
      if (signal.aborted)
        throw new GusError(
          "ABORTED",
          "Setup cancelled; no files were written.",
        );
      const paths = await dependencies.initializeRepository({
        ...command,
        configuration,
      });
      dependencies.stdout(
        `Gus is configured. Created:\n${paths.map((path) => `- ${path}`).join("\n")}\n\nAdd the ${configured.provider.apiKeyEnv} GitHub Actions secret (the key value stays outside these files). Review gus.config.json and the workflow, then commit them with .github/gus to your default branch. GitHub jobs use this copy without npm.\nCustomize full prompts with gus prompts --export .gus-prompts.\n`,
      );
      return 0;
    }
    case "update": {
      const paths = await updateRuntime(command);
      dependencies.stdout(
        `Updated generated Gus runtime assets:\n${paths.map((path) => `- ${path}`).join("\n")}\n\nReview and commit these changes. Repository configuration, workflow, and custom prompt files outside .github/gus are preserved.\n`,
      );
      return 0;
    }
    case "prompts": {
      if (command.exportDirectory) {
        const paths = await exportPrompts(
          command.exportDirectory,
          command.stage,
        );
        dependencies.stdout(`${paths.join("\n")}\n`);
      } else {
        const prompts = await loadBundledPrompts();
        dependencies.stdout(
          `${command.stage ? prompts[command.stage] : JSON.stringify(prompts, null, 2)}\n`,
        );
      }
      return 0;
    }
    case "doctor": {
      const report = await inspectInstallation(
        command.configPath,
        dependencies.environment,
      );
      dependencies.stdout(`${JSON.stringify(report, null, 2)}\n`);
      return report.node.supported &&
        report.git.available &&
        report.configuration.valid
        ? 0
        : 2;
    }
    case "trigger": {
      const prepared = await prepareEvent(command, dependencies, signal);
      if (command.githubOutput)
        await writeGitHubOutputs(
          dependencies.environment["GITHUB_OUTPUT"],
          prepared,
        );
      dependencies.stdout(`${JSON.stringify(prepared, null, 2)}\n`);
      return 0;
    }
    case "issues": {
      const publication = await dependencies.filePullRequestIssues({
        repository: command.repository,
        pullRequest: command.pullRequest,
        publish: command.publish,
        ...commonOptions(command, dependencies, signal),
        ...apiOptions(command, dependencies.environment),
      });
      await writeCommandOutput(
        formatPublicationOutput(publication, command.format),
        command.outputPath,
        dependencies.stdout,
      );
      return publicationExitCode(publication);
    }
    case "review-event":
      return reviewEvent(command, dependencies, signal);
    case "review-pr":
    case "review-local": {
      const common = await reviewOptions(command, dependencies, signal);
      const completed =
        command.command === "review-pr"
          ? await dependencies.reviewPullRequest({
              repository: command.repository,
              pullRequest: command.pullRequest,
              publish: command.publish,
              ...common,
              ...apiOptions(command, dependencies.environment),
            })
          : await dependencies.reviewLocalChanges({
              path: command.path,
              base: command.base,
              ...(command.head === undefined ? {} : { head: command.head }),
              ...(command.defaultBranch === undefined
                ? {}
                : { defaultBranch: command.defaultBranch }),
              ...common,
            });
      await writeCommandOutput(
        formatReviewOutput(completed, command.format),
        command.outputPath,
        dependencies.stdout,
      );
      return reviewExitCode(completed);
    }
  }
}

async function reviewEvent(
  command: Extract<CliCommand, { command: "review-event" }>,
  dependencies: CliDependencies,
  signal: AbortSignal,
): Promise<number> {
  const prepared = await prepareEvent(command, dependencies, signal);
  if (!prepared.eligible || prepared.pullRequest === null) {
    await writeCommandOutput(
      formatSkippedOutput(prepared, command.format),
      command.outputPath,
      dependencies.stdout,
    );
    return 0;
  }
  const options: PullRequestReviewOptions = {
    repository: prepared.repository,
    pullRequest: prepared.pullRequest,
    publish: command.publish,
    requestedIssues: prepared.mode === "review-and-issues",
    ...(await reviewOptions(command, dependencies, signal)),
    ...apiOptions(command, dependencies.environment),
  };
  if (prepared.mode === "issues") {
    const publication = await dependencies.filePullRequestIssues(options);
    await writeCommandOutput(
      formatPublicationOutput(publication, command.format),
      command.outputPath,
      dependencies.stdout,
    );
    return publicationExitCode(publication);
  }
  const completed = await dependencies.reviewPullRequest(options);
  await writeCommandOutput(
    formatReviewOutput(completed, command.format),
    command.outputPath,
    dependencies.stdout,
  );
  return reviewExitCode(completed);
}

async function prepareEvent(
  command: { eventPath: string; configPath?: string; apiUrl?: string },
  dependencies: CliDependencies,
  signal: AbortSignal,
): Promise<PreparedGitHubEvent> {
  const eventName = dependencies.environment["GITHUB_EVENT_NAME"];
  if (!eventName?.trim())
    throw new GusError(
      "INPUT_INVALID",
      "Event commands require GITHUB_EVENT_NAME.",
    );
  return dependencies.prepareGitHubEvent({
    event: await readJsonInput(command.eventPath, "GitHub event"),
    eventName,
    ...commonOptions(command, dependencies, signal),
    ...apiOptions(command, dependencies.environment),
  });
}

function commonOptions(
  command: { configPath?: string },
  dependencies: CliDependencies,
  signal: AbortSignal,
): CommonReviewOptions {
  return {
    environment: dependencies.environment,
    signal,
    ...(command.configPath === undefined
      ? {}
      : { configPath: command.configPath }),
  };
}

function apiOptions(
  command: { apiUrl?: string },
  environment: Environment,
): { apiUrl?: string } {
  const apiUrl = command.apiUrl ?? environment["GITHUB_API_URL"];
  return apiUrl ? { apiUrl } : {};
}

async function reviewOptions(
  command: { configPath?: string; parent?: string; checksPath?: string },
  dependencies: CliDependencies,
  signal: AbortSignal,
): Promise<CommonReviewOptions> {
  return {
    ...commonOptions(command, dependencies, signal),
    ...(command.parent === undefined ? {} : { parent: command.parent }),
    ...(command.checksPath === undefined
      ? {}
      : { checks: await readChecks(command.checksPath) }),
    onProgress: (event) => {
      dependencies.stderr(
        `Gus ${event.stage}: ${sanitizeDiagnostic(event.message, dependencies.environment)}\n`,
      );
    },
  };
}
