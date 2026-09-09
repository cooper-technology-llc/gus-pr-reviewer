// Guided setup must configure a real installation without storing secrets, hanging in automation, or leaving partial files on cancellation.
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
import { runCli, type CliDependencies } from "../src/cli/run-cli.js";
import {
  setupConfiguration,
  type SetupQuestions,
} from "../src/cli/setup-configuration.js";
import { initializeRepository } from "../src/initialize/initialize-repository.js";
import { runtimeFixture } from "./cli-runtime-fixtures.js";

const roots: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gus-guided-setup-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function scriptedQuestions(answers: Array<string | null>) {
  const pending = [...answers];
  const prompts: string[] = [];
  let closed = false;
  const questions: SetupQuestions = {
    ask: async (prompt) => {
      prompts.push(prompt);
      return pending.shift() ?? null;
    },
    close: () => {
      closed = true;
    },
  };
  return { questions, prompts, wasClosed: () => closed };
}

async function setupCapture(answers: Array<string | null>, interactive = true) {
  const source = await temporaryDirectory();
  const readDistribution = await runtimeFixture(source);
  const scripted = scriptedQuestions(answers);
  const stdout: string[] = [];
  const stderr: string[] = [];
  let initializations = 0;
  const dependencies: Partial<CliDependencies> = {
    environment: {},
    stdout: (text) => {
      stdout.push(text);
    },
    stderr: (text) => {
      stderr.push(text);
    },
    isInteractive: () => interactive,
    createSetupQuestions: () => scripted.questions,
    initializeRepository: async (options) => {
      initializations += 1;
      return initializeRepository(options, readDistribution);
    },
  };
  return {
    dependencies,
    scripted,
    stdout,
    stderr,
    initializationCount: () => initializations,
  };
}

describe("guided init", () => {
  it("writes the selected provider, key name, voice, guidance, and budget into a real installation", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "README.md"), "Project guidance.");
    await mkdir(join(directory, "docs"));
    await writeFile(join(directory, "docs/review.md"), "Review guidance.");
    const captured = await setupCapture([
      "https://models.example/v1",
      "team/model",
      "TEAM_REVIEW_API_KEY",
      "warm",
      "README.md, docs/review.md",
      "90000",
    ]);
    expect(
      await runCli(["init", "--directory", directory], captured.dependencies),
    ).toBe(0);
    const config = parseConfig(
      parseJson(
        await readFile(join(directory, "gus.config.json"), "utf8"),
        "config",
      ),
    );
    expect(config.provider).toMatchObject({
      baseUrl: "https://models.example/v1",
      model: "team/model",
      apiKeyEnv: "TEAM_REVIEW_API_KEY",
      reasoningFormat: "none",
    });
    expect(config.personality).toMatchObject({ enabled: true, style: "warm" });
    expect(config.contextFiles).toEqual(["README.md", "docs/review.md"]);
    expect(config.review.maxTotalTokens).toBe(90000);
    const workflow = await readFile(
      join(directory, ".github/workflows/gus-review.yml"),
      "utf8",
    );
    expect(workflow).toContain("secrets.TEAM_REVIEW_API_KEY");
    expect(workflow).not.toContain("secrets.OPENROUTER_API_KEY");
    expect(captured.stdout.join("")).toContain(
      "Add the TEAM_REVIEW_API_KEY GitHub Actions secret",
    );
    expect(captured.scripted.prompts).toHaveLength(6);
    expect(captured.scripted.wasClosed()).toBe(true);
  });

  it("accepts empty guidance and personality off", async () => {
    const directory = await temporaryDirectory();
    await writeFile(join(directory, "README.md"), "Suggested, but optional.");
    const captured = await setupCapture(["", "", "", "off", "", ""]);
    expect(
      await runCli(["init", "--directory", directory], captured.dependencies),
    ).toBe(0);
    const config = parseConfig(
      parseJson(
        await readFile(join(directory, "gus.config.json"), "utf8"),
        "config",
      ),
    );
    expect(config.contextFiles).toEqual([]);
    expect(config.personality.enabled).toBe(false);
    expect(config.provider.reasoningFormat).toBe("openrouter");
    expect(captured.scripted.prompts[4]).toContain("Suggested: README.md");
  });

  it("allows corrections in place and never saves or reports an entered credential value", async () => {
    const directory = await temporaryDirectory();
    const secretValue = "sk-actual-secret-value";
    const captured = await setupCapture([
      "file:///tmp/provider",
      "https://models.example/v1",
      "model with spaces",
      "team/model",
      secretValue,
      "GITHUB_TOKEN",
      "NODE_OPTIONS",
      "MODEL_API_KEY",
      "loud",
      "spicy",
      "",
      "0",
      "2000001",
      "2.5",
      "75000",
    ]);
    expect(
      await runCli(["init", "--directory", directory], captured.dependencies),
    ).toBe(0);
    const text = await readFile(join(directory, "gus.config.json"), "utf8");
    const config = parseConfig(parseJson(text, "config"));
    expect(config.provider.apiKeyEnv).toBe("MODEL_API_KEY");
    expect(config.review.maxTotalTokens).toBe(75000);
    expect(config.personality.style).toBe("spicy");
    expect(text).not.toContain(secretValue);
    expect(captured.stdout.join("")).not.toContain(secretValue);
    expect(captured.stderr.join("")).not.toContain(secretValue);
    expect(captured.initializationCount()).toBe(1);
  });

  it.each([null, "cancel"])(
    "cancels without writing after %s input",
    async (answer) => {
      const directory = await temporaryDirectory();
      const captured = await setupCapture(["", "", answer]);
      expect(
        await runCli(["init", "--directory", directory], captured.dependencies),
      ).toBe(2);
      expect(captured.initializationCount()).toBe(0);
      expect(await readdir(directory)).toEqual([]);
      expect(captured.scripted.wasClosed()).toBe(true);
      expect(captured.stderr.join("")).toContain("Setup cancelled");
    },
  );

  it("preserves existing setup files when overwrite was not requested", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, "gus.config.json"),
      "existing custom configuration",
    );
    const captured = await setupCapture(["", "", "", "", "", ""]);
    expect(
      await runCli(["init", "--directory", directory], captured.dependencies),
    ).toBe(2);
    expect(await readFile(join(directory, "gus.config.json"), "utf8")).toBe(
      "existing custom configuration",
    );
    expect(await readdir(directory)).toEqual(["gus.config.json"]);
  });
});

describe("setup guidance validation", () => {
  it.each([
    "../outside.md",
    "/outside.md",
    ".env",
    "credentials.json",
    ".git/config",
    "docs",
    "missing.md",
    "alias.md",
  ])(
    "rejects unsafe or unavailable guidance %s before writing",
    async (guidance) => {
      const directory = await temporaryDirectory();
      await mkdir(join(directory, "docs"));
      await writeFile(join(directory, "README.md"), "Guidance.");
      await writeFile(join(directory, ".env"), "secret material");
      await writeFile(join(directory, "credentials.json"), "secret material");
      await symlink(join(directory, "README.md"), join(directory, "alias.md"));
      const captured = await setupCapture(["", "", "", "", guidance, null]);
      expect(
        await runCli(["init", "--directory", directory], captured.dependencies),
      ).toBe(2);
      expect(captured.initializationCount()).toBe(0);
      await expect(
        readFile(join(directory, "gus.config.json")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(captured.stdout.join("")).not.toContain("secret material");
    },
  );

  it("handles an abort while a question is active without returning a configuration", async () => {
    const directory = await temporaryDirectory();
    const controller = new AbortController();
    let closed = false;
    await expect(
      setupConfiguration({
        directory,
        yes: false,
        interactive: true,
        signal: controller.signal,
        createQuestions: () => ({
          ask: async () => {
            controller.abort();
            return "";
          },
          close: () => {
            closed = true;
          },
        }),
        write: () => undefined,
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(closed).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });
});

describe("noninteractive init", () => {
  it.each([true, false])(
    "uses only existing safe root guidance without prompting when interactive=%s",
    async (interactive) => {
      const directory = await temporaryDirectory();
      await writeFile(join(directory, "README.md"), "Readme guidance.");
      await writeFile(join(directory, "AGENTS.md"), "Agent guidance.");
      await writeFile(
        join(directory, "custom-policy.md"),
        "Not automatically selected.",
      );
      await symlink(
        join(directory, "README.md"),
        join(directory, "CONTRIBUTING.md"),
      );
      const captured = await setupCapture([], interactive);
      const args = [
        "init",
        "--directory",
        directory,
        ...(interactive ? ["--yes"] : []),
      ];
      expect(await runCli(args, captured.dependencies)).toBe(0);
      expect(captured.scripted.prompts).toEqual([]);
      const config = parseConfig(
        parseJson(
          await readFile(join(directory, "gus.config.json"), "utf8"),
          "config",
        ),
      );
      expect(config.contextFiles).toEqual(["README.md", "AGENTS.md"]);
    },
  );

  it("works for a missing target directory without opening an input session", async () => {
    const directory = join(await temporaryDirectory(), "new repository");
    const captured = await setupCapture([], false);
    expect(
      await runCli(["init", "--directory", directory], captured.dependencies),
    ).toBe(0);
    expect(captured.scripted.prompts).toEqual([]);
    const config = parseConfig(
      parseJson(
        await readFile(join(directory, "gus.config.json"), "utf8"),
        "config",
      ),
    );
    expect(config.contextFiles).toEqual([]);
  });
});
