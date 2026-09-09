import { readFile } from "node:fs/promises";
import { z } from "zod";
import { parseJson } from "../config/load-config.js";

/** Resolve the installed version for help output and an exactly pinned workflow. */
export async function readPackageVersion(): Promise<string> {
  const packageJson = await readFile(
    new URL("../../package.json", import.meta.url),
    "utf8",
  ).catch(() =>
    readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  return z
    .object({
      version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    })
    .parse(parseJson(packageJson, "package.json")).version;
}
