import type { GusConfig } from "../config/config-schema.js";
import type {
  Environment,
  ReadConfigurationFile,
} from "../config/load-config.js";
import { GusError } from "../errors.js";

export async function loadPolicies(
  config: GusConfig,
  readText: ReadConfigurationFile,
): Promise<Array<{ path: string; text: string }>> {
  const policies: Array<{ path: string; text: string }> = [];
  for (const path of config.contextFiles) {
    const text = await readText(path);
    if (text?.trim()) policies.push({ path, text });
  }
  return policies;
}

export function requireModelKey(
  config: GusConfig,
  environment: Environment,
): string {
  const apiKey = environment[config.provider.apiKeyEnv];
  if (!apiKey?.trim())
    throw new GusError(
      "CONFIG_INVALID",
      `Set ${config.provider.apiKeyEnv} to your model provider API key.`,
    );
  return apiKey;
}
