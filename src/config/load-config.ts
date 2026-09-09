import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { GusError } from "../errors.js";
import {
  configSchema,
  type GusConfig,
  type LoadedPrompts,
  type ReviewStage,
} from "./config-schema.js";

export type ReadConfigurationFile = (path: string) => Promise<string | null>;
export type Environment = Readonly<Record<string, string | undefined>>;

/** Parse declarative configuration without executing repository JavaScript. */
export function parseConfig(value: unknown): GusConfig {
  const parsed = configSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "config"}: ${issue.message}`,
    );
    throw new GusError("CONFIG_INVALID", issues.join("\n"));
  }
  return parsed.data;
}

/** Load config and prompt files using the host's trusted file reader. */
export async function loadConfig(
  readText: ReadConfigurationFile,
  path = "gus.config.json",
): Promise<GusConfig> {
  const text = await readText(path);
  return text === null ? parseConfig({}) : parseConfig(parseJson(text, path));
}

export function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new GusError("CONFIG_INVALID", `${label} must contain valid JSON.`);
  }
}

/** Only explicit configuration files are read from the working filesystem. */
export async function configurationReader(
  configPath: string,
): Promise<ReadConfigurationFile> {
  const root = await realpath(dirname(resolve(configPath)));
  return async (path) => {
    const candidate = resolve(root, path);
    const lexical = relative(root, candidate);
    if (lexical.startsWith("..") || isAbsolute(lexical)) {
      throw new GusError(
        "CONFIG_INVALID",
        "Configuration files must stay inside their configuration directory.",
      );
    }
    try {
      const resolved = await realpath(candidate);
      const contained = relative(root, resolved);
      if (contained.startsWith("..") || isAbsolute(contained)) {
        throw new GusError(
          "CONFIG_INVALID",
          "Configuration symlinks cannot leave their directory.",
        );
      }
      const text = await readFile(resolved, "utf8");
      if (Buffer.byteLength(text) > 200000)
        throw new GusError(
          "CONFIG_INVALID",
          `Configuration file is too large: ${path}`,
        );
      return text;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }
  };
}

export function applyEnvironment(
  config: GusConfig,
  environment: Environment,
): GusConfig {
  return parseConfig({
    ...config,
    provider: {
      ...config.provider,
      ...(environment["GUS_MODEL"] ? { model: environment["GUS_MODEL"] } : {}),
      ...(environment["GUS_PROVIDER_URL"]
        ? { baseUrl: environment["GUS_PROVIDER_URL"] }
        : {}),
    },
  });
}

const bundledPromptsSchema = z.strictObject({
  triage: z.string().min(1),
  investigate: z.string().min(1),
  validate: z.string().min(1),
  report: z.string().min(1),
});

export async function loadBundledPrompts(): Promise<LoadedPrompts> {
  const text = await readFile(
    new URL("../../prompts.json", import.meta.url),
    "utf8",
  );
  const prompts = bundledPromptsSchema.parse(
    parseJson(text, "bundled prompts"),
  );
  return { ...prompts, personality: defaultPersonality };
}

/** A replacement removes all bundled stage guidance, including default voice. */
export async function loadPrompts(
  config: GusConfig,
  readText: ReadConfigurationFile,
): Promise<LoadedPrompts> {
  const bundled = await loadBundledPrompts();
  const stages: ReviewStage[] = [
    "triage",
    "investigate",
    "validate",
    "report",
    "personality",
  ];
  const loaded = { ...bundled };
  for (const stage of stages) {
    let defaultText = bundled[stage];
    if (stage === "personality")
      defaultText += `\n\nRequested style: ${personalityStyles[config.personality.style]}`;
    const override = config.prompts[stage];
    if (!override) {
      loaded[stage] = defaultText;
      continue;
    }
    const replacement =
      override.text ?? (override.file ? await readText(override.file) : null);
    if (!replacement?.trim())
      throw new GusError(
        "CONFIG_INVALID",
        `The ${stage} prompt override is missing or empty.`,
      );
    loaded[stage] =
      override.mode === "replace"
        ? replacement
        : `${defaultText}\n\n${replacement}`;
  }
  return loaded;
}

const personalityStyles = {
  warm: "Friendly, encouraging, and lightly playful; recognize specific care without exaggerated praise.",
  dry: "Dry wit from a dependable senior teammate. One memorable observation, then let the findings speak.",
  snarky:
    "Wry, mildly sarcastic teasing of demonstrated code problems, never the author. Keep the humor appropriate for a workplace code review and proportional to the evidence.",
};

const defaultPersonality = `You are Gus, the team's sharp-eyed PR reviewer. Write a short reaction with professional humor about the code, using only the finalized review facts supplied by the host. Your technical judgment is already complete. Match the reaction to what actually happened: appreciate a thoughtful simplification, celebrate specific test care, make a dry observation about tricky code, or give a playful jab at a confirmed defect. When a review has taken several rounds, a little relief humor can fit. High risk calls for grounded humor, not a victory parade. Keep the humor appropriate for a workplace code review and directed at the code, never the author. Avoid generic flattery, personal insults, claims about tests or deployments that did not happen, and unsupported statements about who wrote the code. Do not add findings, alter the verdict, recommend merging, or mention anyone other than the supplied author. Keep it to one brief plain-text paragraph. Follow the host's output contract.`;
