import { parseConfig, parseJson } from "../config/load-config.js";
import type { GusConfigInput } from "../config/config-schema.js";
import { assertProviderEnvironmentName } from "./provider-environment.js";
import {
  loadRuntimeDistribution,
  type ReadRuntimeDistribution,
} from "./runtime-distribution.js";
import { writeGeneratedFiles } from "./write-generated-files.js";

export type Preset = "generic";

export interface InitializeOptions {
  directory: string;
  preset: Preset;
  force?: boolean;
  configuration?: GusConfigInput;
}

/** Vendor a complete runtime with editable policy and a trusted workflow. */
export async function initializeRepository(
  options: InitializeOptions,
  readDistribution: ReadRuntimeDistribution = loadRuntimeDistribution,
): Promise<string[]> {
  const distribution = await readDistribution();
  const configuration = options.configuration
    ? `${JSON.stringify(options.configuration, null, 2)}\n`
    : distribution.assetText(`templates/presets/${options.preset}.json`);
  const parsed = parseConfig(
    parseJson(configuration, "Gus setup configuration"),
  );
  assertProviderEnvironmentName(parsed.provider.apiKeyEnv);
  const workflow = distribution
    .assetText("templates/gus-review.yml")
    .replace(
      "OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}",
      `${JSON.stringify(parsed.provider.apiKeyEnv)}: \${{ secrets.${parsed.provider.apiKeyEnv} }}`,
    );
  return writeGeneratedFiles(
    options.directory,
    [
      { path: "gus.config.json", text: configuration },
      {
        path: ".github/workflows/gus-review.yml",
        text: workflow,
      },
      ...distribution.files,
    ],
    options.force ?? false,
  );
}
