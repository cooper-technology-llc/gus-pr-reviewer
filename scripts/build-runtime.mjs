import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { runtimeAssetPaths } from "../dist/initialize/runtime-distribution.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageMetadata = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
if (
  packageMetadata.name !== "gus-pr-reviewer" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageMetadata.version)
)
  throw new Error(
    "Cannot bundle Gus without valid package identity and version.",
  );
if (packageMetadata.license !== "SEE LICENSE IN LICENSE")
  throw new Error("Gus package metadata must point to its LICENSE file.");
const license = await readFile(join(root, "LICENSE"), "utf8");
if (!license.trim()) throw new Error("Gus LICENSE is missing or empty.");

const bundled = await build({
  absWorkingDir: root,
  entryPoints: ["src/cli.ts"],
  outfile: "runtime/bin/gus.mjs",
  bundle: true,
  packages: "bundle",
  platform: "node",
  format: "esm",
  target: "node22.14",
  write: false,
  metafile: true,
  sourcemap: false,
  legalComments: "inline",
  logLevel: "silent",
  banner: {
    js: `// Gus runtime version: ${packageMetadata.version}\n// Copyright (c) 2026 Cooper Technology. License: see ../../LICENSE. Third-party terms: see ../THIRD_PARTY_NOTICES.txt.`,
  },
});
if (bundled.warnings.length > 0)
  throw new Error(
    `Runtime bundling emitted warnings: ${bundled.warnings.map((warning) => warning.text).join("; ")}`,
  );
if (bundled.outputFiles.length !== 1)
  throw new Error(
    "The portable runtime must contain exactly one JavaScript bundle.",
  );
for (const output of Object.values(bundled.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (!dependency.external || !isBuiltin(dependency.path))
      throw new Error(
        `Runtime is not standalone: unresolved dependency ${dependency.path}`,
      );
  }
}

const packages = new Map();
for (const input of Object.keys(bundled.metafile.inputs)) {
  const packageRoot = findDependencyRoot(resolve(root, input));
  if (packageRoot === null || packages.has(packageRoot)) continue;
  packages.set(packageRoot, await readThirdPartyLicense(packageRoot));
}
if (packages.size === 0)
  throw new Error(
    "No bundled third-party packages were recorded; inspect the runtime bundle.",
  );
const thirdParties = [...packages.values()].sort((first, second) =>
  `${first.name}@${first.version}`.localeCompare(
    `${second.name}@${second.version}`,
  ),
);
const notices = [
  "Third-party software included in the Gus runtime",
  "",
  "The following components remain available under their original license terms.",
  "Gus's license does not replace or restrict these third-party licenses.",
  "",
  ...thirdParties.map(
    (dependency) =>
      `${"=".repeat(72)}\n${dependency.name}@${dependency.version}\nLicense: ${dependency.license}\n\n${dependency.text}`,
  ),
  "",
].join("\n");

const runtime = bundled.outputFiles[0];
if (!runtime) throw new Error("Gus runtime output is missing.");
const generated = new Map([
  ["runtime/bin/gus.mjs", runtime.text],
  ["runtime/THIRD_PARTY_NOTICES.txt", notices],
]);
const files = {};
for (const path of runtimeAssetPaths) {
  const text =
    generated.get(path) ?? (await readFile(join(root, path), "utf8"));
  if (!text.trim())
    throw new Error(`Required Gus runtime asset is empty: ${path}`);
  files[path] = createHash("sha256").update(text).digest("hex");
}
const manifest = {
  format: 1,
  package: packageMetadata.name,
  version: packageMetadata.version,
  files,
  dependencies: thirdParties.map(({ name, version, license: licenseName }) => ({
    name,
    version,
    license: licenseName,
  })),
};
generated.set(
  "runtime/manifest.json",
  `${JSON.stringify(manifest, null, 2)}\n`,
);
for (const [path, text] of generated) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text, "utf8");
}
await chmod(join(root, "runtime/bin/gus.mjs"), 0o755);
process.stdout.write(
  `Bundled Gus ${packageMetadata.version} with ${thirdParties.length} third-party license records.\n`,
);

function findDependencyRoot(path) {
  const marker = `${sep}node_modules${sep}`;
  const index = path.lastIndexOf(marker);
  if (index < 0) return null;
  const directory = path.slice(0, index + marker.length);
  const segments = path.slice(index + marker.length).split(sep);
  const first = segments[0];
  if (!first) throw new Error(`Cannot identify bundled package for ${path}`);
  if (!first.startsWith("@")) return join(directory, first);
  const second = segments[1];
  if (!second)
    throw new Error(`Cannot identify scoped bundled package for ${path}`);
  return join(directory, first, second);
}

async function readThirdPartyLicense(packageRoot) {
  const metadata = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  if (
    typeof metadata.name !== "string" ||
    typeof metadata.version !== "string" ||
    typeof metadata.license !== "string" ||
    !metadata.license.trim()
  )
    throw new Error(
      `Bundled dependency metadata lacks a license identity: ${packageRoot}`,
    );
  const entries = (await readdir(packageRoot)).sort();
  const licenses = entries.filter((name) =>
    /^licen[sc]e(?:[._-].*)?$/i.test(name),
  );
  if (licenses.length === 0)
    throw new Error(
      `Bundled dependency ${metadata.name}@${metadata.version} has no license text.`,
    );
  const notices = entries.filter((name) => /^notice(?:[._-].*)?$/i.test(name));
  const texts = [];
  for (const name of [...licenses, ...notices]) {
    const text = await readFile(join(packageRoot, name), "utf8");
    if (!text.trim())
      throw new Error(
        `Bundled dependency license/notice is empty: ${metadata.name}/${name}`,
      );
    texts.push(`${name}\n\n${text}`);
  }
  return {
    name: metadata.name,
    version: metadata.version,
    license: metadata.license,
    text: texts.join("\n\n"),
  };
}
