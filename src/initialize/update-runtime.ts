import { lstat, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { GusError } from "../errors.js";
import {
  loadInstalledRuntimeDistribution,
  loadRuntimeDistribution,
  type ReadRuntimeDistribution,
} from "./runtime-distribution.js";
import { writeGeneratedFiles } from "./write-generated-files.js";

export interface UpdateRuntimeOptions {
  directory: string;
  force?: boolean;
}

/** Replace generated runtime assets from this installed Gus version without changing team policy or workflow. */
export async function updateRuntime(
  options: UpdateRuntimeOptions,
  readDistribution: ReadRuntimeDistribution = loadRuntimeDistribution,
): Promise<string[]> {
  const root = await requireInitializedRuntime(options.directory);
  const installed = await loadInstalledRuntimeDistribution(
    pathToFileURL(`${resolve(root, ".github/gus")}${sep}`),
    options.force !== true,
  );
  const distribution = await readDistribution();
  const currentPaths = new Set(distribution.files.map((file) => file.path));
  const retiredPaths = installed.files
    .filter((file) => !currentPaths.has(file.path))
    .map((file) => file.path);
  return writeGeneratedFiles(root, distribution.files, true, retiredPaths);
}

async function requireInitializedRuntime(directory: string): Promise<string> {
  try {
    const root = await realpath(resolve(directory));
    for (const path of [
      ".github",
      ".github/gus",
      ".github/gus/runtime",
      ".github/gus/runtime/manifest.json",
    ]) {
      const metadata = await lstat(resolve(root, path));
      if (metadata.isSymbolicLink())
        throw new GusError(
          "PATH_DENIED",
          "Gus runtime updates cannot traverse a symbolic link.",
        );
    }
    return root;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new GusError(
        "INPUT_INVALID",
        "No initialized Gus runtime was found. Run gus init first.",
      );
    throw error;
  }
}
