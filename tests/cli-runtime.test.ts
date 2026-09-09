// Vendoring must copy a complete versioned distribution and never trust manifest paths or symlinks.
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeRepository } from "../src/initialize/initialize-repository.js";
import { updateRuntime } from "../src/initialize/update-runtime.js";
import {
  addLegacyRuntimePreset,
  runtimeFixture,
} from "./cli-runtime-fixtures.js";

const roots: string[] = [];
async function temporaryDirectory() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "gus-vendored-runtime-")),
  );
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("vendored runtime", () => {
  it("copies every required asset and unchanged license from the actual source version", async () => {
    const source = await temporaryDirectory();
    const directory = await temporaryDirectory();
    const readDistribution = await runtimeFixture(source, "0.2.0");
    await initializeRepository(
      { directory, preset: "generic" },
      readDistribution,
    );
    expect(
      await readFile(join(directory, ".github/gus/package.json"), "utf8"),
    ).toContain('"version":"0.2.0"');
    expect(
      await readFile(
        join(directory, ".github/gus/runtime/bin/gus.mjs"),
        "utf8",
      ),
    ).toContain("Gus runtime version: 0.2.0");
    expect(await readFile(join(directory, ".github/gus/LICENSE"), "utf8")).toBe(
      await readFile(join(source, "LICENSE"), "utf8"),
    );
    expect(
      await readFile(
        join(directory, ".github/gus/runtime/THIRD_PARTY_NOTICES.txt"),
        "utf8",
      ),
    ).toContain("zod@4.5.4");
    expect(
      await readdir(join(directory, ".github/gus/templates/presets")),
    ).toEqual(["generic.json"]);
    await expect(
      readFile(join(directory, ".github/gus/node_modules")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed for modified bundled assets", async () => {
    const source = await temporaryDirectory();
    const readDistribution = await runtimeFixture(source);
    await writeFile(join(source, "prompts.json"), "tampered asset");
    await expect(readDistribution()).rejects.toThrow("integrity");
  });

  it("keeps new package sources strict even when an extra preset has a valid recorded hash", async () => {
    const source = await temporaryDirectory();
    const readDistribution = await runtimeFixture(source);
    await addLegacyRuntimePreset(source);
    await expect(readDistribution()).rejects.toThrow("asset list");
  });

  it("rejects a manifest that introduces an arbitrary copy path", async () => {
    const source = await temporaryDirectory();
    const readDistribution = await runtimeFixture(source);
    const path = join(source, "runtime/manifest.json");
    const text = await readFile(path, "utf8");
    await writeFile(
      path,
      text.replace(
        '"files":{',
        '"files":{"../outside":"' + "a".repeat(64) + '",',
      ),
    );
    await expect(readDistribution()).rejects.toThrow("asset list");
  });

  it("rejects a source asset symlink instead of copying outside the package", async () => {
    const source = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const readDistribution = await runtimeFixture(source);
    await writeFile(join(outside, "LICENSE"), "outside");
    await rm(join(source, "LICENSE"));
    await symlink(join(outside, "LICENSE"), join(source, "LICENSE"));
    await expect(readDistribution()).rejects.toThrow("symbolic link");
  });

  it("rejects a version label that disagrees with the bundled runtime", async () => {
    const source = await temporaryDirectory();
    const readDistribution = await runtimeFixture(source);
    const packagePath = join(source, "package.json");
    const original = await readFile(packagePath, "utf8");
    const changed = original.replace('"version":"0.1.0"', '"version":"0.2.0"');
    const manifestPath = join(source, "runtime/manifest.json");
    const manifest = await readFile(manifestPath, "utf8");
    await writeFile(packagePath, changed);
    await writeFile(
      manifestPath,
      manifest
        .replace('"version":"0.1.0"', '"version":"0.2.0"')
        .replace(
          createHash("sha256").update(original).digest("hex"),
          createHash("sha256").update(changed).digest("hex"),
        ),
    );
    await expect(readDistribution()).rejects.toThrow(
      "bundled Gus runtime version",
    );
  });
});

describe("runtime update", () => {
  it("refreshes only generated runtime assets while preserving policy, workflow, and custom files", async () => {
    const directory = await temporaryDirectory();
    const firstSource = await temporaryDirectory();
    const secondSource = await temporaryDirectory();
    await initializeRepository(
      { directory, preset: "generic" },
      await runtimeFixture(firstSource, "0.1.0"),
    );
    const installedRoot = join(directory, ".github/gus");
    const retiredPreset = await addLegacyRuntimePreset(installedRoot);
    const customPreset = join(
      installedRoot,
      "templates/presets/local-policy.json",
    );
    await writeFile(customPreset, "our unmanifested preset");
    const config = join(directory, "gus.config.json");
    const workflow = join(directory, ".github/workflows/gus-review.yml");
    const customPrompt = join(directory, ".gus-prompts/investigate.md");
    await mkdir(join(directory, ".gus-prompts"));
    await writeFile(config, "our custom config");
    await writeFile(workflow, "our custom workflow");
    await writeFile(customPrompt, "our custom prompt");
    await writeFile(join(directory, ".github/gus/keep.txt"), "extra user file");
    const paths = await updateRuntime(
      { directory },
      await runtimeFixture(secondSource, "0.2.0"),
    );
    expect(paths.every((path) => path.includes("/.github/gus/"))).toBe(true);
    expect(paths).toContain(retiredPreset);
    await expect(readFile(retiredPreset)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(customPreset, "utf8")).toBe(
      "our unmanifested preset",
    );
    expect(await readFile(config, "utf8")).toBe("our custom config");
    expect(await readFile(workflow, "utf8")).toBe("our custom workflow");
    expect(await readFile(customPrompt, "utf8")).toBe("our custom prompt");
    expect(
      await readFile(join(directory, ".github/gus/keep.txt"), "utf8"),
    ).toBe("extra user file");
    expect(
      await readFile(
        join(directory, ".github/gus/runtime/bin/gus.mjs"),
        "utf8",
      ),
    ).toContain("0.2.0");
  });

  it("refuses uninitialized targets without creating .github", async () => {
    const directory = await temporaryDirectory();
    await expect(
      updateRuntime(
        { directory },
        await runtimeFixture(await temporaryDirectory()),
      ),
    ).rejects.toThrow("gus init");
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects symlinked target assets before changing other runtime files", async () => {
    const directory = await temporaryDirectory();
    const source = await temporaryDirectory();
    const nextSource = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await initializeRepository(
      { directory, preset: "generic" },
      await runtimeFixture(source),
    );
    const runtime = join(directory, ".github/gus/runtime/bin/gus.mjs");
    const original = await readFile(runtime, "utf8");
    const license = join(directory, ".github/gus/LICENSE");
    await rm(license);
    await writeFile(join(outside, "LICENSE"), "outside");
    await symlink(join(outside, "LICENSE"), license);
    await expect(
      updateRuntime({ directory }, await runtimeFixture(nextSource, "0.2.0")),
    ).rejects.toThrow("symbolic link");
    expect(await readFile(runtime, "utf8")).toBe(original);
    expect(await readFile(join(outside, "LICENSE"), "utf8")).toBe("outside");
  });

  it("preserves locally edited defaults unless replacement is explicitly forced", async () => {
    const directory = await temporaryDirectory();
    const source = await temporaryDirectory();
    const nextSource = await temporaryDirectory();
    await initializeRepository(
      { directory, preset: "generic" },
      await runtimeFixture(source),
    );
    const prompts = join(directory, ".github/gus/prompts.json");
    await writeFile(prompts, "our edited bundled defaults");
    const newer = await runtimeFixture(nextSource, "0.2.0");
    await expect(updateRuntime({ directory }, newer)).rejects.toThrow(
      "integrity",
    );
    expect(await readFile(prompts, "utf8")).toBe("our edited bundled defaults");
    await updateRuntime({ directory, force: true }, newer);
    expect(await readFile(prompts, "utf8")).toBe(
      await readFile(join(nextSource, "prompts.json"), "utf8"),
    );
  });

  it("requires force before retiring a locally modified generated preset", async () => {
    const directory = await temporaryDirectory();
    await initializeRepository(
      { directory, preset: "generic" },
      await runtimeFixture(await temporaryDirectory()),
    );
    const retiredPreset = await addLegacyRuntimePreset(
      join(directory, ".github/gus"),
    );
    await writeFile(retiredPreset, "our modified generated preset");
    const newer = await runtimeFixture(await temporaryDirectory(), "0.2.0");
    await expect(updateRuntime({ directory }, newer)).rejects.toThrow(
      "integrity",
    );
    expect(await readFile(retiredPreset, "utf8")).toBe(
      "our modified generated preset",
    );
    await updateRuntime({ directory, force: true }, newer);
    await expect(readFile(retiredPreset)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([
    "templates/presets/../../outside.json",
    "templates/presets/nested/legacy-profile.json",
    "templates/presets/legacy-profile.json/child",
    "templates/presets/GENERIC.json",
    `templates/presets/${"x".repeat(65)}.json`,
    "runtime/obsolete.mjs",
  ])(
    "rejects unsafe historical manifest asset %s before updating",
    async (asset) => {
      const directory = await temporaryDirectory();
      await initializeRepository(
        { directory, preset: "generic" },
        await runtimeFixture(await temporaryDirectory()),
      );
      const runtime = join(directory, ".github/gus/runtime/bin/gus.mjs");
      const original = await readFile(runtime, "utf8");
      const manifestPath = join(directory, ".github/gus/runtime/manifest.json");
      const manifest = await readFile(manifestPath, "utf8");
      await writeFile(
        manifestPath,
        manifest.replace(
          '"files":{',
          `"files":{${JSON.stringify(asset)}:"${"a".repeat(64)}",`,
        ),
      );
      await expect(
        updateRuntime(
          { directory, force: true },
          await runtimeFixture(await temporaryDirectory(), "0.2.0"),
        ),
      ).rejects.toThrow("asset list");
      expect(await readFile(runtime, "utf8")).toBe(original);
    },
  );

  it("rejects retired-asset symlinks even when replacement is forced", async () => {
    const directory = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await initializeRepository(
      { directory, preset: "generic" },
      await runtimeFixture(await temporaryDirectory()),
    );
    const retiredPreset = await addLegacyRuntimePreset(
      join(directory, ".github/gus"),
    );
    const outsideFile = join(outside, "policy.json");
    await writeFile(outsideFile, "outside policy");
    await rm(retiredPreset);
    await symlink(outsideFile, retiredPreset);
    await expect(
      updateRuntime(
        { directory, force: true },
        await runtimeFixture(await temporaryDirectory(), "0.2.0"),
      ),
    ).rejects.toThrow("symbolic link");
    expect(await readFile(outsideFile, "utf8")).toBe("outside policy");
  });

  it("rejects inconsistent installed version metadata even when replacement is forced", async () => {
    const directory = await temporaryDirectory();
    await initializeRepository(
      { directory, preset: "generic" },
      await runtimeFixture(await temporaryDirectory()),
    );
    await addLegacyRuntimePreset(join(directory, ".github/gus"));
    const manifestPath = join(directory, ".github/gus/runtime/manifest.json");
    await writeFile(
      manifestPath,
      (await readFile(manifestPath, "utf8")).replace(
        '"version":"0.1.0"',
        '"version":"0.9.0"',
      ),
    );
    await expect(
      updateRuntime(
        { directory, force: true },
        await runtimeFixture(await temporaryDirectory(), "0.2.0"),
      ),
    ).rejects.toThrow("versions do not match");
  });

  it("restores retired presets and the original runtime if a later generated write fails", async () => {
    const directory = await temporaryDirectory();
    await initializeRepository(
      { directory, preset: "generic" },
      await runtimeFixture(await temporaryDirectory()),
    );
    const installedRoot = join(directory, ".github/gus");
    const retiredPreset = await addLegacyRuntimePreset(installedRoot);
    await chmod(retiredPreset, 0o600);
    const originalPreset = await readFile(retiredPreset, "utf8");
    const runtime = join(installedRoot, "runtime/bin/gus.mjs");
    const originalRuntime = await readFile(runtime, "utf8");
    const manifest = join(installedRoot, "runtime/manifest.json");
    const originalManifest = await readFile(manifest, "utf8");
    const newer = await runtimeFixture(await temporaryDirectory(), "0.2.0");
    await expect(
      updateRuntime({ directory }, async () => {
        const distribution = await newer();
        return {
          ...distribution,
          files: distribution.files.map((file) =>
            file.path === ".github/gus/package.json"
              ? { ...file, mode: Number.NaN }
              : file,
          ),
        };
      }),
    ).rejects.toThrow("mode");
    expect(await readFile(retiredPreset, "utf8")).toBe(originalPreset);
    expect((await lstat(retiredPreset)).mode & 0o777).toBe(0o600);
    expect(await readFile(runtime, "utf8")).toBe(originalRuntime);
    expect((await lstat(runtime)).mode & 0o777).toBe(0o755);
    expect(await readFile(manifest, "utf8")).toBe(originalManifest);
  });
});
