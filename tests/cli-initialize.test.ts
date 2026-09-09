// Setup must create usable policy/workflows without erasing an existing repository's configuration.
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig, parseJson } from "../src/config/load-config.js";
import { exportPrompts } from "../src/initialize/export-prompts.js";
import { initializeRepository } from "../src/initialize/initialize-repository.js";
import { runtimeFixture } from "./cli-runtime-fixtures.js";

const roots: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gus-cli-init-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("repository initialization", () => {
  it("writes chosen settings and connects the matching GitHub provider secret", async () => {
    const directory = await temporaryDirectory();
    const configuration = {
      provider: {
        baseUrl: "https://models.example/v1",
        model: "review-model",
        apiKeyEnv: "MODEL_API_KEY",
      },
      contextFiles: ["README.md"],
      review: { maxTotalTokens: 50000 },
    };
    await initializeRepository(
      { directory, preset: "generic", configuration },
      await runtimeFixture(await temporaryDirectory()),
    );
    expect(
      parseJson(
        await readFile(join(directory, "gus.config.json"), "utf8"),
        "settings",
      ),
    ).toEqual(configuration);
    const workflow = await readFile(
      join(directory, ".github/workflows/gus-review.yml"),
      "utf8",
    );
    expect(workflow).toContain('"MODEL_API_KEY": ${{ secrets.MODEL_API_KEY }}');
    expect(workflow).not.toContain("OPENROUTER_API_KEY");
    expect(workflow).toContain("GITHUB_TOKEN: ${{ github.token }}");
  });

  it.each(["GITHUB_TOKEN", "PATH", "NODE_OPTIONS", "RUNNER_TEMP"])(
    "rejects reserved provider variable %s before writing",
    async (apiKeyEnv) => {
      const directory = await temporaryDirectory();
      await expect(
        initializeRepository(
          {
            directory,
            preset: "generic",
            configuration: { provider: { apiKeyEnv } },
          },
          await runtimeFixture(await temporaryDirectory()),
        ),
      ).rejects.toMatchObject({ code: "INPUT_INVALID" });
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it.each(["generic"])(
    "creates a valid %s preset with a trusted vendored workflow",
    async (preset) => {
      if (preset !== "generic") throw new Error("Unknown test preset.");
      const directory = join(await temporaryDirectory(), "a repository");
      const paths = await initializeRepository(
        {
          directory,
          preset,
        },
        await runtimeFixture(await temporaryDirectory()),
      );
      expect(paths).toHaveLength(12);
      const config = parseConfig(
        parseJson(
          await readFile(join(directory, "gus.config.json"), "utf8"),
          "preset",
        ),
      );
      expect(config.name).toBe("Gus");
      const workflow = await readFile(
        join(directory, ".github/workflows/gus-review.yml"),
        "utf8",
      );
      expect(workflow).toContain(".github/gus/runtime/bin/gus.mjs");
      expect(workflow).toContain("pull_request_target:");
      expect(workflow).toContain("needs: prepare");
      expect(workflow).toContain("trigger --event");
      expect(workflow.match(/actions\/checkout@v7/g)).toHaveLength(2);
      expect(workflow).toContain(
        "ref: refs/heads/${{ github.event.repository.default_branch }}",
      );
      expect(workflow).toContain(
        "ref: ${{ needs.prepare.outputs.runtime_sha }}",
      );
      expect(workflow).toContain("repository: ${{ github.repository }}");
      expect(workflow.match(/persist-credentials: false/g)).toHaveLength(2);
      expect(workflow).toContain("sparse-checkout: /.github/gus/");
      expect(workflow).not.toMatch(/\b(npm|npx|pnpm|yarn)\b/);
      expect(workflow).not.toContain("github.head_ref");
      expect(workflow).not.toContain("ref: ${{ github.ref }}");
      expect(config.contextFiles).toEqual([]);
    },
  );

  it("preflights all targets before creating any generated files", async () => {
    const directory = await temporaryDirectory();
    await mkdir(join(directory, ".github/workflows"), { recursive: true });
    const workflow = join(directory, ".github/workflows/gus-review.yml");
    await writeFile(workflow, "our existing workflow");
    await expect(
      initializeRepository(
        { directory, preset: "generic" },
        await runtimeFixture(await temporaryDirectory()),
      ),
    ).rejects.toThrow("already exists");
    expect(await readFile(workflow, "utf8")).toBe("our existing workflow");
    await expect(
      readFile(join(directory, "gus.config.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces only generated files when force is explicit", async () => {
    const directory = await temporaryDirectory();
    await initializeRepository(
      {
        directory,
        preset: "generic",
      },
      await runtimeFixture(await temporaryDirectory()),
    );
    await writeFile(join(directory, "keep.txt"), "ours");
    await writeFile(
      join(directory, "gus.config.json"),
      "previous configuration",
    );
    await initializeRepository(
      {
        directory,
        preset: "generic",
        force: true,
      },
      await runtimeFixture(await temporaryDirectory(), "0.1.1"),
    );
    expect(await readFile(join(directory, "keep.txt"), "utf8")).toBe("ours");
    expect(await readFile(join(directory, "gus.config.json"), "utf8")).toBe(
      await readFile(
        new URL("../templates/presets/generic.json", import.meta.url),
        "utf8",
      ),
    );
  });

  it("refuses symlinked workflow directories even with force", async () => {
    const directory = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await symlink(outside, join(directory, ".github"));
    await expect(
      initializeRepository(
        {
          directory,
          preset: "generic",
          force: true,
        },
        await runtimeFixture(await temporaryDirectory()),
      ),
    ).rejects.toThrow("symbolic link");
    expect(await readdir(outside)).toEqual([]);
    await expect(
      readFile(join(directory, "gus.config.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects incomplete distributions before writing", async () => {
    const directory = await temporaryDirectory();
    const source = await temporaryDirectory();
    const readDistribution = await runtimeFixture(source);
    await rm(join(source, "LICENSE"));
    await expect(
      initializeRepository(
        {
          directory,
          preset: "generic",
        },
        readDistribution,
      ),
    ).rejects.toThrow("missing");
    expect(await readdir(directory)).toEqual([]);
  });
});

describe("prompt export", () => {
  it("exports five editable prompts and preserves an existing customization", async () => {
    const directory = await temporaryDirectory();
    const paths = await exportPrompts(directory);
    expect(paths).toHaveLength(5);
    expect((await readdir(directory)).sort()).toEqual([
      "investigate.md",
      "personality.md",
      "report.md",
      "triage.md",
      "validate.md",
    ]);
    expect(await readFile(join(directory, "personality.md"), "utf8")).toContain(
      "Gus",
    );
    await writeFile(join(directory, "investigate.md"), "my custom prompt");
    await expect(exportPrompts(directory)).rejects.toThrow("already exists");
    expect(await readFile(join(directory, "investigate.md"), "utf8")).toBe(
      "my custom prompt",
    );
  });

  it("exports only the selected stage", async () => {
    const directory = await temporaryDirectory();
    await exportPrompts(directory, "report");
    expect(await readdir(directory)).toEqual(["report.md"]);
  });
});
