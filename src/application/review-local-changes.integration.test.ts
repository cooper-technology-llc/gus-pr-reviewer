// Exercise a complete application review against real committed Git history and a simulated provider.
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createGitFixture } from "../repository/git-test-fixtures.js";
import type { Analysis } from "../review/stage-schemas.js";
import { reviewLocalChanges } from "./review-local-changes.js";

const temporaryDirectories: string[] = [];
const providerRequestSchema = z.object({
  model: z.string(),
  messages: z.array(z.object({ role: z.string(), content: z.string() })),
});
const seedSchema = z.object({
  changedFiles: z.array(z.object({ path: z.string(), excluded: z.boolean() })),
  diffEvidence: z.array(z.object({ id: z.string(), path: z.string() })),
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("local review application", () => {
  it("uses committed target policy through every stage and preserves the working checkout", async () => {
    const fixture = await createGitFixture();
    temporaryDirectories.push(fixture.directory);
    const trustedConfig = {
      name: "Base Gus",
      contextFiles: ["AGENTS.md"],
      provider: { model: "fixture/model", apiKeyEnv: "FIXTURE_KEY" },
      prompts: {
        personality: {
          mode: "replace",
          text: "A quiet librarian who appreciates explicit exports.",
        },
      },
    };
    await fixture.write("gus.config.json", JSON.stringify(trustedConfig));
    await fixture.write(
      "AGENTS.md",
      "BASE_POLICY: preserve documented caller behavior.",
    );
    await fixture.write("src/value.ts", "export const value = 1;\n");
    await fixture.write("package-lock.json", '{"lockfileVersion": 2}\n');
    const base = await fixture.commit("Create trusted target");
    await fixture.git("checkout", "--quiet", "-b", "feature");
    await fixture.write(
      "gus.config.json",
      JSON.stringify({ provider: { apiKeyEnv: "UNTRUSTED_KEY" } }),
    );
    await fixture.write("src/value.ts", "export const value = 2;\n");
    await fixture.write("package-lock.json", '{"lockfileVersion": 3}\n');
    const head = await fixture.commit(
      "Change exported value and propose configuration",
    );
    await fixture.write(
      "uncommitted.txt",
      "Keep this author's file exactly as it is.\n",
    );
    const originalStatus = await fixture.git("status", "--porcelain");
    const requests: z.infer<typeof providerRequestSchema>[] = [];
    let assessment: Analysis | undefined;

    const providerFetch: typeof globalThis.fetch = async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer fixture-key",
      );
      if (typeof init?.body !== "string")
        throw new Error("Expected a serialized provider request.");
      const request = providerRequestSchema.parse(JSON.parse(init.body));
      requests.push(request);
      const step = requests.length;
      let output: unknown;
      if (step === 1)
        output = {
          summary: "The exported value and proposed configuration changed.",
          risk: "low",
          questions: [],
        };
      else if (step === 2) {
        const userMessage = request.messages.find(
          (message) => message.role === "user",
        );
        if (!userMessage) throw new Error("Expected the investigation input.");
        const input = z
          .object({
            format: z.literal("gus-context-v1"),
            sourceTexts: z.array(
              z.object({ id: z.string(), text: z.string() }),
            ),
            payload: z.object({ reviewInput: seedSchema }),
          })
          .parse(JSON.parse(userMessage.content));
        assessment = assessFixture(input.payload.reviewInput);
        output = assessment;
      } else if (step === 3 && assessment)
        output = { ...assessment, candidateResolutions: [] };
      else if (step === 4)
        output = {
          summary:
            "The exported value and configuration proposal are localized changes.",
        };
      else if (step === 5)
        output = {
          text: "The export is small enough to shelve without a ladder.",
        };
      else
        throw new Error(
          "The application unexpectedly requested another provider turn.",
        );
      return new Response(
        JSON.stringify({
          model: "fixture/model",
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: JSON.stringify(output) },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    };

    const completed = await reviewLocalChanges({
      path: fixture.directory,
      base: "trunk",
      defaultBranch: "trunk",
      environment: { FIXTURE_KEY: "fixture-key" },
      fetch: providerFetch,
    });

    expect(completed.review.verdict).toBe("ready");
    expect(completed.review.snapshot).toMatchObject({
      baseSha: base,
      headSha: head,
      comparisonBaseSha: base,
    });
    expect(completed.review.coverage.map((entry) => entry.path)).toEqual([
      "gus.config.json",
      "package-lock.json",
      "src/value.ts",
    ]);
    expect(
      completed.review.coverage.find(
        (entry) => entry.path === "package-lock.json",
      )?.status,
    ).toBe("excluded");
    expect(
      completed.review.coverage.every(
        (entry) => entry.status === "inspected" || entry.status === "excluded",
      ),
    ).toBe(true);
    expect(
      completed.review.limitations.some((notice) =>
        notice.includes("package-lock.json"),
      ),
    ).toBe(true);
    expect(completed.publication.status).toBe("dry-run");
    expect(completed.markdown).toContain("Base Gus review");
    expect(completed.review.personality).toContain("shelve without a ladder");
    expect(requests).toHaveLength(5);
    expect(requests.every((request) => request.model === "fixture/model")).toBe(
      true,
    );
    expect(
      requests[0]?.messages.some((message) =>
        message.content.includes("BASE_POLICY"),
      ),
    ).toBe(true);
    expect(requests[4]?.messages[0]?.content).toBe(
      trustedConfig.prompts.personality.text,
    );
    expect(await fixture.git("status", "--porcelain")).toBe(originalStatus);
    expect(await fixture.git("rev-parse", "HEAD")).toBe(head);
    expect(
      await readFile(join(fixture.directory, "uncommitted.txt"), "utf8"),
    ).toBe("Keep this author's file exactly as it is.\n");
  });
});

function assessFixture(seed: z.infer<typeof seedSchema>): Analysis {
  return {
    summary:
      "The fixture changes an export and proposes new reviewer configuration.",
    risk: "low",
    findings: [],
    reconciliations: [],
    questions: [],
    architecture: null,
    tests: null,
    coverage: seed.changedFiles
      .filter((file) => !file.excluded)
      .map((file) => ({
        path: file.path,
        status: "inspected",
        reason: "The complete fixture diff was assessed.",
        evidenceIds: seed.diffEvidence
          .filter((evidence) => evidence.path === file.path)
          .map((evidence) => evidence.id),
      })),
  };
}
