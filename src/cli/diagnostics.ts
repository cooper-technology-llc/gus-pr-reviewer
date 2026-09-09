import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import {
  applyEnvironment,
  configurationReader,
  loadConfig,
  loadPrompts,
  type Environment,
} from "../config/load-config.js";
import { GusError } from "../errors.js";

const execFileAsync = promisify(execFile);

export interface DoctorReport {
  node: { version: string; supported: boolean };
  git: { available: boolean; version: string | null };
  configuration: { source: string; valid: boolean; error: string | null };
  credentials: Array<{ name: string; present: boolean }>;
}

/** Inspect runtime availability and credential presence without contacting a provider. */
export async function inspectInstallation(
  configPath: string | undefined,
  environment: Environment,
): Promise<DoctorReport> {
  const versionParts = process.versions.node.split(".").map(Number);
  const major = versionParts[0] ?? 0;
  const minor = versionParts[1] ?? 0;
  const report: DoctorReport = {
    node: {
      version: process.versions.node,
      supported: major > 22 || (major === 22 && minor >= 14),
    },
    git: { available: false, version: null },
    configuration: {
      source: configPath
        ? resolve(configPath)
        : "working directory gus.config.json, or bundled defaults",
      valid: false,
      error: null,
    },
    credentials: [],
  };
  try {
    const git = await execFileAsync("git", ["--version"], {
      timeout: 5000,
      maxBuffer: 4096,
    });
    report.git = {
      available: true,
      version: sanitizeDiagnostic(git.stdout.trim(), environment),
    };
  } catch {
    report.git = { available: false, version: null };
  }
  try {
    const path = resolve(configPath ?? "gus.config.json");
    const reader = await configurationReader(path);
    if (configPath && (await reader(basename(path))) === null)
      throw new GusError(
        "CONFIG_INVALID",
        "The explicit configuration file does not exist.",
      );
    const config = applyEnvironment(
      await loadConfig(reader, basename(path)),
      environment,
    );
    await loadPrompts(config, reader);
    report.configuration.valid = true;
    const names = new Set([config.provider.apiKeyEnv, config.github.tokenEnv]);
    if (config.slack.enabled) names.add(config.slack.webhookEnv);
    report.credentials = [...names].map((name) => ({
      name,
      present: Boolean(environment[name]?.trim()),
    }));
  } catch (error) {
    report.configuration.error = sanitizeDiagnostic(
      error instanceof Error
        ? error.message
        : "Configuration inspection failed.",
      environment,
    );
  }
  return report;
}

/** Remove terminal controls and environment secret values from diagnostics. */
export function sanitizeDiagnostic(
  message: string,
  environment: Environment,
): string {
  let sanitized = message;
  for (const [name, value] of Object.entries(environment)) {
    if (
      value &&
      value.length >= 4 &&
      /TOKEN|SECRET|PASSWORD|API_?KEY|WEBHOOK/i.test(name)
    )
      sanitized = sanitized.split(value).join("[redacted]");
  }
  return sanitized
    .replace(/https?:\/\/[^\s/]+:[^\s/@]+@/gi, "https://[redacted]@")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .slice(0, 4000);
}
