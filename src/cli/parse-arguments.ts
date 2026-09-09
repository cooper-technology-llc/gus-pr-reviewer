import { parseArgs, type ParseArgsConfig } from "node:util";
import { stageSchema, type ReviewStage } from "../config/config-schema.js";
import { GusError } from "../errors.js";
import type { Preset } from "../initialize/initialize-repository.js";

export type OutputFormat = "markdown" | "json";
interface ReviewFlags {
  configPath?: string;
  apiUrl?: string;
  parent?: string;
  checksPath?: string;
  outputPath?: string;
  format: OutputFormat;
}
export type CliCommand =
  | { command: "help" | "version" }
  | ({
      command: "review-pr";
      repository: string;
      pullRequest: number;
      publish: boolean;
    } & ReviewFlags)
  | ({
      command: "review-local";
      path: string;
      base: string;
      head?: string;
      defaultBranch?: string;
    } & ReviewFlags)
  | ({
      command: "review-event";
      eventPath: string;
      publish: boolean;
    } & ReviewFlags)
  | {
      command: "issues";
      repository: string;
      pullRequest: number;
      publish: boolean;
      configPath?: string;
      apiUrl?: string;
      outputPath?: string;
      format: OutputFormat;
    }
  | {
      command: "trigger";
      eventPath: string;
      githubOutput: boolean;
      configPath?: string;
      apiUrl?: string;
    }
  | {
      command: "init";
      directory: string;
      preset: Preset;
      force: boolean;
      yes: boolean;
    }
  | { command: "update"; directory: string; force: boolean }
  | { command: "prompts"; stage?: ReviewStage; exportDirectory?: string }
  | { command: "doctor"; configPath?: string };

const flagDefinitions = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  repo: { type: "string" },
  pr: { type: "string" },
  publish: { type: "boolean" },
  config: { type: "string" },
  "api-url": { type: "string" },
  parent: { type: "string" },
  checks: { type: "string" },
  output: { type: "string" },
  format: { type: "string" },
  path: { type: "string" },
  base: { type: "string" },
  head: { type: "string" },
  "default-branch": { type: "string" },
  event: { type: "string" },
  "github-output": { type: "boolean" },
  directory: { type: "string" },
  preset: { type: "string" },
  force: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  stage: { type: "string" },
  export: { type: "string" },
} satisfies NonNullable<ParseArgsConfig["options"]>;

function parseFlags(args: string[]) {
  try {
    return parseArgs({
      args,
      options: flagDefinitions,
      strict: true,
      allowPositionals: true,
      tokens: true,
    });
  } catch (error) {
    throw new GusError(
      "INPUT_INVALID",
      error instanceof Error ? error.message : "Invalid command arguments.",
    );
  }
}
type Flags = ReturnType<typeof parseFlags>["values"];

/** Validate command combinations before opening files, contacting providers, or publishing. */
export function parseCliArguments(args: string[]): CliCommand {
  const parsed = parseFlags(args);
  const flags = parsed.values;
  const used = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    if (used.has(token.name))
      invalid(`--${token.name} may only be provided once.`);
    used.add(token.name);
  }
  if (flags.help || parsed.positionals[0] === "help" || args.length === 0)
    return { command: "help" };
  if (flags.version) return { command: "version" };
  if (parsed.positionals.length !== 1)
    invalid("Provide exactly one command. Run gus --help for usage.");
  const command = parsed.positionals[0];
  switch (command) {
    case "review":
      assertAllowed(used, [
        "repo",
        "pr",
        "publish",
        "config",
        "api-url",
        "parent",
        "checks",
        "output",
        "format",
        "path",
        "base",
        "head",
        "default-branch",
        "event",
      ]);
      return reviewCommand(flags);
    case "issues":
      assertAllowed(used, [
        "repo",
        "pr",
        "publish",
        "config",
        "api-url",
        "output",
        "format",
      ]);
      return {
        command,
        ...pullRequestFlags(flags),
        publish: flags.publish ?? false,
        ...configFlag(flags),
        ...apiFlag(flags),
        ...outputFlags(flags),
      };
    case "trigger":
      assertAllowed(used, ["event", "github-output", "config", "api-url"]);
      return {
        command,
        eventPath: required(flags.event, "--event"),
        githubOutput: flags["github-output"] ?? false,
        ...configFlag(flags),
        ...apiFlag(flags),
      };
    case "init":
      assertAllowed(used, ["directory", "preset", "force", "yes"]);
      return {
        command,
        directory:
          flags.directory === undefined
            ? "."
            : required(flags.directory, "--directory"),
        preset: parsePreset(flags.preset),
        force: flags.force ?? false,
        yes: flags.yes ?? false,
      };
    case "update":
      assertAllowed(used, ["directory", "force"]);
      return {
        command,
        directory:
          flags.directory === undefined
            ? "."
            : required(flags.directory, "--directory"),
        force: flags.force ?? false,
      };
    case "prompts":
      assertAllowed(used, ["stage", "export"]);
      return {
        command,
        ...(flags.stage === undefined
          ? {}
          : { stage: parseStage(flags.stage) }),
        ...(flags.export === undefined
          ? {}
          : { exportDirectory: required(flags.export, "--export") }),
      };
    case "doctor":
      assertAllowed(used, ["config"]);
      return { command, ...configFlag(flags) };
    default:
      return invalid(
        `Unknown command: ${command ?? "(missing)"}. Run gus --help for usage.`,
      );
  }
}

function reviewCommand(flags: Flags): CliCommand {
  const common = {
    ...configFlag(flags),
    ...apiFlag(flags),
    ...outputFlags(flags),
    ...(flags.parent === undefined
      ? {}
      : { parent: required(flags.parent, "--parent") }),
    ...(flags.checks === undefined
      ? {}
      : { checksPath: required(flags.checks, "--checks") }),
  };
  if (flags.event !== undefined) {
    if (
      [
        flags.repo,
        flags.pr,
        flags.path,
        flags.base,
        flags.head,
        flags["default-branch"],
      ].some((value) => value !== undefined)
    )
      invalid(
        "--event cannot be combined with --repo, --pr, --path, --base, --head, or --default-branch.",
      );
    return {
      command: "review-event",
      eventPath: required(flags.event, "--event"),
      publish: flags.publish ?? false,
      ...common,
    };
  }
  if (flags.path !== undefined) {
    if (flags.repo !== undefined || flags.pr !== undefined)
      invalid("Choose a local --path or a GitHub --repo and --pr.");
    if (flags.publish)
      invalid(
        "Local reviews cannot publish. Use --repo and --pr to publish a GitHub review.",
      );
    if (flags["api-url"] !== undefined)
      invalid("--api-url applies only to GitHub commands.");
    return {
      command: "review-local",
      path: required(flags.path, "--path"),
      base: required(flags.base, "--base"),
      ...(flags.head === undefined
        ? {}
        : { head: required(flags.head, "--head") }),
      ...(flags["default-branch"] === undefined
        ? {}
        : {
            defaultBranch: required(
              flags["default-branch"],
              "--default-branch",
            ),
          }),
      ...common,
    };
  }
  if (
    flags.base !== undefined ||
    flags.head !== undefined ||
    flags["default-branch"] !== undefined
  )
    invalid("--base, --head, and --default-branch require a local --path.");
  return {
    command: "review-pr",
    ...pullRequestFlags(flags),
    publish: flags.publish ?? false,
    ...common,
  };
}

function pullRequestFlags(flags: Flags) {
  const repository = required(flags.repo, "--repo");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    invalid("--repo must be OWNER/REPO.");
  const number = required(flags.pr, "--pr");
  if (!/^[1-9][0-9]*$/.test(number) || !Number.isSafeInteger(Number(number)))
    invalid("--pr must be a positive whole number.");
  return { repository, pullRequest: Number(number) };
}

function configFlag(flags: Flags) {
  return flags.config === undefined
    ? {}
    : { configPath: required(flags.config, "--config") };
}

function apiFlag(flags: Flags): { apiUrl?: string } {
  if (flags["api-url"] === undefined) return {};
  const value = required(flags["api-url"], "--api-url");
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      invalid(
        "--api-url must be an HTTP(S) API URL without credentials, query, or fragment.",
      );
    return { apiUrl: value };
  } catch {
    return invalid(
      "--api-url must be an HTTP(S) API URL without credentials, query, or fragment.",
    );
  }
}

function outputFlags(flags: Flags): {
  format: OutputFormat;
  outputPath?: string;
} {
  const format = flags.format ?? "markdown";
  if (format !== "markdown" && format !== "json")
    invalid("--format must be markdown or json.");
  return {
    format,
    ...(flags.output === undefined
      ? {}
      : { outputPath: required(flags.output, "--output") }),
  };
}

function parsePreset(value: string | undefined): Preset {
  if (value === undefined || value === "generic") return "generic";
  return invalid(
    "--preset must be generic. Use gus init to configure your repository.",
  );
}

function parseStage(value: string): ReviewStage {
  const parsed = stageSchema.safeParse(value);
  if (!parsed.success)
    return invalid(
      "--stage must be triage, investigate, validate, report, or personality.",
    );
  return parsed.data;
}

function required(value: string | undefined, flag: string): string {
  if (!value?.trim()) return invalid(`${flag} requires a nonempty value.`);
  return value;
}

function assertAllowed(used: Set<string>, allowed: string[]): void {
  for (const name of used)
    if (!allowed.includes(name))
      invalid(`--${name} is not supported by this command.`);
}

function invalid(message: string): never {
  throw new GusError("INPUT_INVALID", message);
}
