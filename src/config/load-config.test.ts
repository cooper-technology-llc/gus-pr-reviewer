// These tests protect complete prompt replacement and the trusted configuration boundary.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEnvironment,
  configurationReader,
  loadConfig,
  loadPrompts,
  parseConfig,
} from "./load-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("portable configuration", () => {
  it("uses generic defaults without requiring a repository configuration file", async () => {
    const config = await loadConfig(async () => null);
    expect(config.name).toBe("Gus");
    expect(config.github.allowForks).toBe(false);
    expect(config.personality.enabled).toBe(true);
    expect(config.issues.mode).toBe("off");
    expect(config.contextFiles).toEqual([]);
  });

  it("rejects executable or unknown configuration fields", () => {
    expect(() =>
      parseConfig({ provider: { apiKey: "never-accept-inline-credentials" } }),
    ).toThrow();
    expect(() => parseConfig({ review: { maxTurns: 0 } })).toThrow();
    expect(() =>
      parseConfig({
        prompts: {
          report: { mode: "replace", file: "report.md", text: "two sources" },
        },
      }),
    ).toThrow();
  });

  it("entirely replaces the personality instead of appending hidden style instructions", async () => {
    const config = parseConfig({
      personality: { style: "snarky" },
      prompts: {
        personality: { mode: "replace", text: "Speak like a quiet librarian." },
      },
    });
    const prompts = await loadPrompts(config, async () => null);
    expect(prompts.personality).toBe("Speak like a quiet librarian.");
  });

  it("extends only stages explicitly configured to extend", async () => {
    const config = parseConfig({
      prompts: {
        investigate: { mode: "replace", file: "investigate.md" },
        report: {
          mode: "extend",
          text: "Use the supplied severity vocabulary.",
        },
      },
    });
    const prompts = await loadPrompts(config, async (path) =>
      path === "investigate.md" ? "Inspect only the requested behavior." : null,
    );
    expect(prompts.investigate).toBe("Inspect only the requested behavior.");
    expect(prompts.report).toContain("You are Gus");
    expect(prompts.report).toContain("Use the supplied severity vocabulary.");
    expect(prompts.triage).not.toContain(
      "Use the supplied severity vocabulary.",
    );
  });

  it("fails when an explicitly selected prompt is missing", async () => {
    const config = parseConfig({
      prompts: { validate: { mode: "replace", file: "missing.md" } },
    });
    await expect(loadPrompts(config, async () => null)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("uses model environment overrides without changing the provider credential field", () => {
    const config = applyEnvironment(parseConfig({}), {
      GUS_MODEL: "my/model",
      OPENROUTER_API_KEY: "private-value",
    });
    expect(config.provider.model).toBe("my/model");
    expect(JSON.stringify(config)).not.toContain("private-value");
  });

  it("blocks sibling directory traversal and symlink escapes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gus-config-"));
    temporaryDirectories.push(directory);
    const root = join(directory, "config");
    const sibling = join(directory, "config-other");
    await mkdir(root);
    await mkdir(sibling);
    await writeFile(join(root, "gus.config.json"), "{}");
    await writeFile(
      join(sibling, "private.txt"),
      "outside configuration boundary",
    );
    await symlink(join(sibling, "private.txt"), join(root, "escaped.txt"));
    const reader = await configurationReader(join(root, "gus.config.json"));
    await expect(reader("../config-other/private.txt")).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    await expect(reader("escaped.txt")).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    await expect(reader("gus.config.json")).resolves.toBe("{}");
  });
});
