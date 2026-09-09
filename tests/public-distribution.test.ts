// Public setup assets must stay repository-neutral and ship only supported defaults.
import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { cliHelp } from "../src/cli/help.js";
import { runtimeAssetPaths } from "../src/initialize/runtime-distribution.js";

describe("public distribution", () => {
  it("ships only the generic preset", async () => {
    expect(
      await readdir(new URL("../templates/presets/", import.meta.url)),
    ).toEqual(["generic.json"]);
    expect(
      runtimeAssetPaths.filter((path) => path.startsWith("templates/presets/")),
    ).toEqual(["templates/presets/generic.json"]);
  });

  it("advertises guided setup with an automation option", () => {
    expect(cliHelp).toContain(
      "gus init [--directory DIRECTORY] [--yes] [--force]",
    );
    expect(cliHelp).not.toContain("--preset");
  });
});
