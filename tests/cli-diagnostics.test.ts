// Installation diagnostics must report availability without exposing credentials or making paid calls.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sanitizeDiagnostic } from "../src/cli/diagnostics.js";
import { runCli } from "../src/cli/run-cli.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("diagnostic privacy", () => {
  it("redacts bearer credentials and control characters", () => {
    expect(
      sanitizeDiagnostic("Bearer abc123\u001b[31m\nsecret-token", {
        GITHUB_TOKEN: "secret-token",
      }),
    ).toBe("Bearer [redacted] [redacted]");
  });

  it("doctor prints credential presence without secret values or network operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "gus-cli-doctor-"));
    roots.push(root);
    const config = join(root, "gus.config.json");
    await writeFile(
      config,
      JSON.stringify({ provider: { apiKeyEnv: "MY_MODEL_SECRET" } }),
    );
    const stdout: string[] = [];
    await runCli(["doctor", "--config", config], {
      environment: { MY_MODEL_SECRET: "must-not-be-printed" },
      stdout: (text) => {
        stdout.push(text);
      },
      stderr: () => undefined,
    });
    expect(stdout.join("")).toContain('"name": "MY_MODEL_SECRET"');
    expect(stdout.join("")).toContain('"present": true');
    expect(stdout.join("")).not.toContain("must-not-be-printed");
  });
});
