import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseJson } from "../config/load-config.js";
import { GusError } from "../errors.js";
import type { GeneratedFile } from "./write-generated-files.js";

export const runtimeAssetPaths = [
  "runtime/bin/gus.mjs",
  "runtime/THIRD_PARTY_NOTICES.txt",
  "package.json",
  "prompts.json",
  "gus.config.schema.json",
  "LICENSE",
  "docs/licensing.md",
  "templates/gus-review.yml",
  "templates/presets/generic.json",
];

const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const manifestSchema = z.strictObject({
  format: z.literal(1),
  package: z.literal("gus-pr-reviewer"),
  version: versionSchema,
  files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  dependencies: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        version: z.string().min(1),
        license: z.string().min(1),
      }),
    )
    .min(1),
});
const packageSchema = z.object({
  name: z.literal("gus-pr-reviewer"),
  version: versionSchema,
  license: z.literal("SEE LICENSE IN LICENSE"),
});

export interface RuntimeDistribution {
  version: string;
  files: GeneratedFile[];
  assetText(path: string): string;
}
export type ReadRuntimeDistribution = () => Promise<RuntimeDistribution>;

/** Read only the fixed distribution assets, verifying their version and generated integrity records. */
export async function loadRuntimeDistribution(
  packageRoot = new URL("../../", import.meta.url),
  verifyIntegrity = true,
): Promise<RuntimeDistribution> {
  return readRuntimeDistribution(packageRoot, verifyIntegrity, false);
}

/** Read an installed runtime while accepting bounded preset assets retired by a newer distribution. */
export async function loadInstalledRuntimeDistribution(
  packageRoot: URL,
  verifyIntegrity = true,
): Promise<RuntimeDistribution> {
  return readRuntimeDistribution(packageRoot, verifyIntegrity, true);
}

async function readRuntimeDistribution(
  packageRoot: URL,
  verifyIntegrity: boolean,
  allowHistoricalPresets: boolean,
): Promise<RuntimeDistribution> {
  const manifestText = await readAsset(packageRoot, "runtime/manifest.json");
  const parsed = manifestSchema.safeParse(
    parseJson(manifestText, "Gus runtime manifest"),
  );
  if (!parsed.success)
    throw new GusError(
      "CONFIG_INVALID",
      "The Gus runtime manifest is invalid. Rebuild or reinstall Gus.",
    );
  const manifest = parsed.data;
  const assetPaths = Object.keys(manifest.files);
  const additionalPaths = assetPaths.filter(
    (path) => !runtimeAssetPaths.includes(path),
  );
  if (
    !runtimeAssetPaths.every((path) => Object.hasOwn(manifest.files, path)) ||
    new Set(assetPaths.map((path) => path.toLowerCase())).size !==
      assetPaths.length ||
    additionalPaths.length > 128 ||
    additionalPaths.some(
      (path) =>
        !allowHistoricalPresets ||
        !/^templates\/presets\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.json$/.test(
          path,
        ),
    )
  )
    throw new GusError(
      "CONFIG_INVALID",
      "The Gus runtime manifest asset list does not match the fixed distribution.",
    );
  const distributionPaths = [...runtimeAssetPaths, ...additionalPaths.sort()];
  const textByPath = new Map<string, string>();
  for (const path of distributionPaths) {
    const text = await readAsset(packageRoot, path);
    if (
      verifyIntegrity &&
      createHash("sha256").update(text).digest("hex") !== manifest.files[path]
    )
      throw new GusError(
        "CONFIG_INVALID",
        `Gus runtime integrity mismatch for ${path}. Generated files have changed; preserve your changes before replacing the runtime.`,
      );
    textByPath.set(path, text);
  }
  const assetText = (path: string): string => {
    const text = textByPath.get(path);
    if (text === undefined)
      throw new GusError(
        "CONFIG_INVALID",
        `Gus distribution asset is not available: ${path}`,
      );
    return text;
  };
  const packageMetadata = packageSchema.safeParse(
    parseJson(assetText("package.json"), "Gus runtime package.json"),
  );
  if (
    !packageMetadata.success ||
    packageMetadata.data.version !== manifest.version
  )
    throw new GusError(
      "CONFIG_INVALID",
      "Gus runtime and package versions do not match. Rebuild or reinstall Gus.",
    );
  if (
    verifyIntegrity &&
    !assetText("runtime/bin/gus.mjs")
      .slice(0, 512)
      .split("\n")
      .includes(`// Gus runtime version: ${manifest.version}`)
  )
    throw new GusError(
      "CONFIG_INVALID",
      "The bundled Gus runtime version does not match its manifest.",
    );
  return {
    version: manifest.version,
    assetText,
    files: [
      ...distributionPaths.map((path) => ({
        path: `.github/gus/${path}`,
        text: assetText(path),
        ...(path === "runtime/bin/gus.mjs" ? { mode: 0o755 } : {}),
      })),
      { path: ".github/gus/runtime/manifest.json", text: manifestText },
    ],
  };
}

async function readAsset(root: URL, path: string): Promise<string> {
  let candidate = fileURLToPath(root);
  for (const segment of path.split("/")) {
    candidate = resolve(candidate, segment);
    try {
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink())
        throw new GusError(
          "PATH_DENIED",
          "Gus runtime assets cannot traverse a symbolic link.",
        );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        throw new GusError(
          "CONFIG_INVALID",
          `Gus runtime asset is missing: ${path}. Run npm run build in a source checkout, or reinstall a complete package.`,
        );
      throw error;
    }
  }
  const file = new URL(path, root);
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.size > 20000000)
    throw new GusError(
      "CONFIG_INVALID",
      `Gus runtime asset is not a bounded regular file: ${path}`,
    );
  return readFile(file, "utf8");
}
