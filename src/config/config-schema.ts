import { z } from "zod";

export const stageSchema = z.enum([
  "triage",
  "investigate",
  "validate",
  "report",
  "personality",
]);
export type ReviewStage = z.infer<typeof stageSchema>;

const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const promptMode = z.enum(["extend", "replace"]);
const promptOverrideSchema = z.union([
  z.strictObject({
    mode: promptMode,
    text: z.string().min(1).max(100000),
    file: z.never().optional(),
  }),
  z.strictObject({
    mode: promptMode,
    file: z.string().min(1),
    text: z.never().optional(),
  }),
]);
const stageModelSchema = z.strictObject({
  model: z.string().min(1).optional(),
  reasoningEffort: z
    .enum(["none", "minimal", "low", "medium", "high", "xhigh"])
    .optional(),
});
const positiveLimit = z.number().int().positive();

export const configSchema = z.strictObject({
  $schema: z.string().optional(),
  version: z.literal(1).default(1),
  name: z.string().min(1).max(40).default("Gus"),
  provider: z
    .strictObject({
      baseUrl: z.url().default("https://openrouter.ai/api/v1"),
      apiKeyEnv: environmentName.default("OPENROUTER_API_KEY"),
      model: z.string().min(1).default("openai/gpt-5.6-luna"),
      requestTimeoutMs: positiveLimit.max(300000).default(90000),
      retries: z.number().int().min(0).max(5).default(2),
      jsonMode: z.boolean().default(true),
      reasoningFormat: z
        .enum(["openrouter", "openai", "none"])
        .default("openrouter"),
      stages: z.partialRecord(stageSchema, stageModelSchema).default({}),
    })
    .prefault({}),
  review: z
    .strictObject({
      maxTurns: positiveLimit.max(100).default(20),
      maxToolCalls: positiveLimit.max(500).default(80),
      maxDurationMs: positiveLimit.max(3600000).default(600000),
      maxInputChars: positiveLimit.max(2000000).default(220000),
      maxOutputTokens: positiveLimit.max(64000).default(8192),
      maxTotalTokens: positiveLimit.max(2000000).default(180000),
      maxCostUsd: z.number().positive().nullable().default(null),
      maxFiles: positiveLimit.max(10000).default(500),
      maxFileBytes: positiveLimit.max(2000000).default(120000),
      maxDiffCharsPerFile: positiveLimit.max(500000).default(16000),
      maxToolOutputChars: positiveLimit.max(200000).default(32000),
      blockingSeverity: z.enum(["critical", "major", "minor"]).default("major"),
      scorecard: z.boolean().default(true),
      exclude: z
        .array(z.string().min(1))
        .default([
          "**/node_modules/**",
          "**/dist/**",
          "**/vendor/**",
          "**/package-lock.json",
          "**/yarn.lock",
          "**/pnpm-lock.yaml",
          "**/*.min.js",
          "**/*.generated.*",
        ]),
      highRiskPaths: z
        .array(z.string().min(1))
        .default([
          "**/migrations/**",
          "**/auth*/**",
          "**/*permission*",
          "**/billing/**",
          ".github/workflows/**",
        ]),
    })
    .prefault({}),
  prompts: z.partialRecord(stageSchema, promptOverrideSchema).default({}),
  contextFiles: z.array(z.string().min(1)).default([]),
  rules: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        paths: z.array(z.string().min(1)).min(1),
        forbiddenAddedText: z.string().min(1).optional(),
        companionPaths: z.array(z.string().min(1)).optional(),
        message: z.string().min(1),
        severity: z.enum(["critical", "major", "minor"]).default("major"),
      }),
    )
    .default([]),
  personality: z
    .strictObject({
      enabled: z.boolean().default(true),
      style: z.enum(["warm", "dry", "spicy"]).default("dry"),
      maxChars: positiveLimit.max(1600).default(600),
    })
    .prefault({}),
  github: z
    .strictObject({
      apiUrl: z.url().default("https://api.github.com"),
      tokenEnv: environmentName.default("GITHUB_TOKEN"),
      reviewerLogins: z
        .array(z.string().min(1))
        .default(["github-actions[bot]"]),
      allowForks: z.boolean().default(false),
      maxInlineComments: z.number().int().min(0).max(30).default(5),
      reviewCommand: z.string().min(1).default("@gus"),
      issuesCommand: z.string().min(1).default("@gus issues"),
    })
    .prefault({}),
  issues: z
    .strictObject({
      mode: z.enum(["off", "on-request", "merge-clean"]).default("off"),
      maxIssues: positiveLimit.max(20).default(3),
      labels: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
  slack: z
    .strictObject({
      enabled: z.boolean().default(false),
      webhookEnv: environmentName.default("SLACK_WEBHOOK_URL"),
    })
    .prefault({}),
});

export type GusConfig = z.infer<typeof configSchema>;
export type GusConfigInput = z.input<typeof configSchema>;
export type LoadedPrompts = Record<ReviewStage, string>;

export const defaultConfig = configSchema.parse({});
