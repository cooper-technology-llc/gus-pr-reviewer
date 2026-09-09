import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { defaultConfig, type GusConfigInput } from "../config/config-schema.js";
import { parseConfig } from "../config/load-config.js";
import { GusError } from "../errors.js";
import { assertProviderEnvironmentName } from "../initialize/provider-environment.js";
import { assertReadablePath } from "../repository/repository-paths.js";

export interface SetupQuestions {
  ask(prompt: string, signal: AbortSignal): Promise<string | null>;
  close(): void;
}

export interface SetupConfigurationOptions {
  directory: string;
  yes: boolean;
  interactive: boolean;
  signal: AbortSignal;
  createQuestions(): SetupQuestions;
  write(text: string): void;
}

/** Collect validated setup choices before any configuration or runtime files are written. */
export async function setupConfiguration(
  options: SetupConfigurationOptions,
): Promise<GusConfigInput> {
  ensureActive(options.signal);
  const guidance = await discoverGuidance(options.directory);
  if (options.yes || !options.interactive)
    return makeConfiguration(
      defaultConfig.provider.baseUrl,
      defaultConfig.provider.model,
      defaultConfig.provider.apiKeyEnv,
      defaultConfig.personality.style,
      guidance,
      defaultConfig.review.maxTotalTokens,
    );
  const questions = options.createQuestions();
  try {
    options.write(
      "Let's set Gus up for this repository. Enter uses the displayed default. Ctrl+C or 'cancel' stops without writing files.\n",
    );
    const ask = <T>(
      label: string,
      parse: (answer: string) => T | Promise<T>,
      fallback?: string,
    ) => askValidated(questions, options, label, parse, fallback);
    const baseUrl = await ask(
      "Compatible provider API base URL",
      providerUrl,
      defaultConfig.provider.baseUrl,
    );
    const usesDefaultProvider =
      baseUrl === defaultConfig.provider.baseUrl.replace(/\/$/, "");
    const model = await ask(
      "Model identifier",
      modelIdentifier,
      usesDefaultProvider ? defaultConfig.provider.model : undefined,
    );
    const apiKeyEnv = await ask(
      "API key environment variable NAME (never the secret value)",
      apiKeyEnvironmentName,
      usesDefaultProvider ? defaultConfig.provider.apiKeyEnv : "MODEL_API_KEY",
    );
    const personality = await ask(
      "Gus's voice: dry, warm, snarky, or off",
      personalityChoice,
      defaultConfig.personality.style,
    );
    const suggested =
      guidance.length > 0
        ? ` Suggested: ${guidance.join(", ")}.`
        : " No common root guidance files were found.";
    const contextFiles = await ask(
      `Repository guidance paths, comma-separated; blank means none.${suggested}`,
      (answer) => validateGuidancePaths(options.directory, answer),
    );
    const maxTotalTokens = await ask(
      "Maximum total tokens per review (1–2000000)",
      tokenBudget,
      String(defaultConfig.review.maxTotalTokens),
    );
    ensureActive(options.signal);
    return makeConfiguration(
      baseUrl,
      model,
      apiKeyEnv,
      personality,
      contextFiles,
      maxTotalTokens,
    );
  } finally {
    questions.close();
  }
}

/** Use native readline only for an interactive init; EOF and interrupts cancel pending questions. */
export function createSetupQuestions(): SetupQuestions {
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  const closed = new AbortController();
  reader.once("close", () => {
    closed.abort();
  });
  reader.on("SIGINT", () => {
    closed.abort();
    reader.close();
  });
  return {
    async ask(prompt, signal) {
      const active = AbortSignal.any([signal, closed.signal]);
      if (active.aborted) return null;
      try {
        return await reader.question(prompt, { signal: active });
      } catch (error) {
        if (active.aborted) return null;
        throw error;
      }
    },
    close: () => {
      reader.close();
    },
  };
}

async function askValidated<T>(
  questions: SetupQuestions,
  options: SetupConfigurationOptions,
  label: string,
  parse: (answer: string) => T | Promise<T>,
  fallback?: string,
): Promise<T> {
  while (true) {
    ensureActive(options.signal);
    const answer = await questions.ask(
      `${label}${fallback === undefined ? "" : ` [${fallback}]`}: `,
      options.signal,
    );
    if (answer === null || answer.trim().toLowerCase() === "cancel")
      throw new GusError("ABORTED", "Setup cancelled; no files were written.");
    ensureActive(options.signal);
    try {
      return await parse(answer.trim() || fallback || "");
    } catch (error) {
      if (
        !(error instanceof GusError) ||
        !["INPUT_INVALID", "PATH_DENIED"].includes(error.code)
      )
        throw error;
      options.write(`${error.message}\n`);
    }
  }
}

function makeConfiguration(
  baseUrl: string,
  model: string,
  apiKeyEnv: string,
  personality: "dry" | "warm" | "snarky" | "off",
  contextFiles: string[],
  maxTotalTokens: number,
): GusConfigInput {
  const configuration: GusConfigInput = {
    version: 1,
    provider: {
      baseUrl,
      model,
      apiKeyEnv,
      reasoningFormat:
        baseUrl === defaultConfig.provider.baseUrl.replace(/\/$/, "")
          ? "openrouter"
          : "none",
    },
    personality: {
      enabled: personality !== "off",
      style: personality === "off" ? "dry" : personality,
    },
    contextFiles,
    review: { maxTotalTokens },
  };
  parseConfig(configuration);
  return configuration;
}

function providerUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /[\u0000-\u0020\u007f]/.test(value)
    )
      throw new Error("Invalid URL.");
    return value.replace(/\/$/, "");
  } catch {
    throw new GusError(
      "INPUT_INVALID",
      "Use an HTTP(S) provider API base URL without credentials, query parameters, or a fragment.",
    );
  }
}

function modelIdentifier(value: string): string {
  if (!value || value.length > 200 || /[\u0000-\u0020\u007f]/.test(value))
    throw new GusError(
      "INPUT_INVALID",
      "Enter a nonempty model identifier without whitespace or control characters.",
    );
  return value;
}

function apiKeyEnvironmentName(value: string): string {
  if (/^(?:sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-)/i.test(value))
    throw new GusError(
      "INPUT_INVALID",
      "Enter an environment variable name such as MODEL_API_KEY; never enter the secret value.",
    );
  assertProviderEnvironmentName(value);
  return value;
}

function personalityChoice(value: string): "dry" | "warm" | "snarky" | "off" {
  if (
    value === "dry" ||
    value === "warm" ||
    value === "snarky" ||
    value === "off"
  )
    return value;
  throw new GusError("INPUT_INVALID", "Choose dry, warm, snarky, or off.");
}

function tokenBudget(value: string): number {
  const number = Number(value);
  if (
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(number) ||
    number > 2000000
  )
    throw new GusError(
      "INPUT_INVALID",
      "Enter a whole token budget from 1 to 2000000.",
    );
  return number;
}

async function discoverGuidance(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const path of ["README.md", "CONTRIBUTING.md", "AGENTS.md"]) {
    try {
      await validateGuidancePath(directory, path);
      found.push(path);
    } catch (error) {
      if (
        error instanceof GusError &&
        ["INPUT_INVALID", "PATH_DENIED"].includes(error.code)
      )
        continue;
      throw error;
    }
  }
  return found;
}

async function validateGuidancePaths(
  directory: string,
  value: string,
): Promise<string[]> {
  if (value === "") return [];
  const paths = [...new Set(value.split(",").map((path) => path.trim()))];
  for (const path of paths) await validateGuidancePath(directory, path);
  return paths;
}

async function validateGuidancePath(
  directory: string,
  path: string,
): Promise<void> {
  assertReadablePath(path);
  try {
    const root = await realpath(resolve(directory));
    let candidate = root;
    for (const segment of path.split("/")) {
      candidate = resolve(candidate, segment);
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink())
        throw new GusError(
          "PATH_DENIED",
          "Guidance paths cannot traverse symbolic links.",
        );
    }
    const resolved = await realpath(candidate);
    const within = relative(root, resolved);
    if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))
      throw new GusError(
        "PATH_DENIED",
        "Guidance must stay inside the selected repository.",
      );
    if (!(await lstat(resolved)).isFile())
      throw new GusError(
        "INPUT_INVALID",
        "Choose an existing guidance file, not a directory.",
      );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new GusError(
        "INPUT_INVALID",
        "A selected guidance file does not exist. Enter an existing relative path or leave guidance empty.",
      );
    throw error;
  }
}

function ensureActive(signal: AbortSignal): void {
  if (signal.aborted)
    throw new GusError("ABORTED", "Setup cancelled; no files were written.");
}
