import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadRuntimeDistribution } from "../src/initialize/runtime-distribution.js";

export async function runtimeFixture(root: string, version = "0.1.0") {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "gus-pr-reviewer",
      version,
      type: "module",
      license: "SEE LICENSE IN LICENSE",
    }),
    "runtime/bin/gus.mjs": `#!/usr/bin/env node\n// Gus runtime version: ${version}\nprocess.stdout.write("fixture-runtime");\n`,
    "runtime/THIRD_PARTY_NOTICES.txt":
      "zod@4.5.4\nMIT License\nOriginal third-party terms remain applicable.\n",
    "prompts.json": await readFile(
      new URL("../prompts.json", import.meta.url),
      "utf8",
    ),
    "gus.config.schema.json": "{}\n",
    LICENSE: await readFile(new URL("../LICENSE", import.meta.url), "utf8"),
    "docs/licensing.md": await readFile(
      new URL("../docs/licensing.md", import.meta.url),
      "utf8",
    ),
    "templates/gus-review.yml": await readFile(
      new URL("../templates/gus-review.yml", import.meta.url),
      "utf8",
    ),
  };
  for (const preset of ["generic"])
    files[`templates/presets/${preset}.json`] = await readFile(
      new URL(`../templates/presets/${preset}.json`, import.meta.url),
      "utf8",
    );
  const hashes: Record<string, string> = {};
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
    hashes[path] = createHash("sha256").update(text).digest("hex");
  }
  await writeFile(
    join(root, "runtime/manifest.json"),
    JSON.stringify({
      format: 1,
      package: "gus-pr-reviewer",
      version,
      files: hashes,
      dependencies: [{ name: "zod", version: "4.5.4", license: "MIT" }],
    }),
  );
  return () => loadRuntimeDistribution(pathToFileURL(`${root}/`));
}

export async function addLegacyRuntimePreset(root: string): Promise<string> {
  const path = "templates/presets/legacy-profile.json";
  const text = JSON.stringify({ version: 1, name: "Legacy review profile" });
  const manifestPath = join(root, "runtime/manifest.json");
  const manifest = z
    .looseObject({ files: z.record(z.string(), z.string()) })
    .parse(JSON.parse(await readFile(manifestPath, "utf8")));
  manifest.files[path] = createHash("sha256").update(text).digest("hex");
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
  await writeFile(manifestPath, JSON.stringify(manifest));
  return join(root, path);
}
