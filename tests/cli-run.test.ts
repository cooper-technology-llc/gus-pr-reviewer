// Command execution must preserve the publication boundary, honest exit status, and safe diagnostics.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  LocalReviewOptions,
  PullRequestReviewOptions,
} from "../src/application/application-options.js";
import { readPackageVersion } from "../src/cli/package-version.js";
import { runCli, type CliDependencies } from "../src/cli/run-cli.js";
import { GusError } from "../src/errors.js";
import type {
  CompletedReview,
  PublicationResult,
} from "../src/review/review-ports.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gus-cli-run-"));
  roots.push(root);
  return root;
}

function publication(
  status: PublicationResult["status"] = "dry-run",
): PublicationResult {
  return {
    status,
    reviewUrl: null,
    reviewId: null,
    inlinePosted: 0,
    issues: [],
    threadsResolved: 0,
    slackSent: false,
    errors: [],
  };
}

function completed(
  verdict: CompletedReview["review"]["verdict"] = "ready",
  status: PublicationResult["status"] = "dry-run",
): CompletedReview {
  return {
    markdown: "Gus inspected this change.",
    publication: publication(status),
    review: {
      version: 1,
      snapshot: {
        baseSha: "base",
        headSha: "head",
        mergeBaseSha: "base",
        comparisonBaseSha: "base",
        baseRef: "main",
        headRef: "feature",
        defaultBranch: "main",
        defaultSha: "base",
        parent: null,
        integration: {
          status: "clean",
          treeSha: "tree",
          targetSha: "base",
          conflicts: [],
          explanation: "No textual conflict.",
        },
        historyRewritten: false,
        baseChanged: false,
        advisories: [],
      },
      verdict,
      summary: "Reviewed.",
      risk: "low",
      size: "S",
      findings: [],
      reconciliations: [],
      questions: [],
      architecture: null,
      tests: null,
      personality: "",
      coverage: [],
      evidence: [],
      checks: [],
      limitations: [],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        costUsd: null,
        requests: 1,
        toolCalls: 1,
        elapsedMs: 1,
        models: ["fixture"],
      },
    },
  };
}

function capture(overrides: Partial<CliDependencies> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected external operation.");
  };
  const dependencies: CliDependencies = {
    reviewPullRequest: unexpected,
    reviewLocalChanges: unexpected,
    filePullRequestIssues: unexpected,
    prepareGitHubEvent: unexpected,
    version: async () => "0.1.0",
    initializeRepository: unexpected,
    isInteractive: () => false,
    createSetupQuestions: () => {
      throw new Error("Unexpected setup prompt.");
    },
    stdout: (text) => {
      stdout.push(text);
    },
    stderr: (text) => {
      stderr.push(text);
    },
    environment: {},
    ...overrides,
  };
  return { stdout, stderr, dependencies };
}

describe("CLI dispatch", () => {
  it("prints help, package version, and five prompts without external operations", async () => {
    const captured = capture();
    expect(await runCli(["--help"], captured.dependencies)).toBe(0);
    expect(captured.stdout.join("")).toContain("Gus");
    captured.stdout.length = 0;
    expect(await runCli(["--version"], captured.dependencies)).toBe(0);
    expect(captured.stdout.join("")).toBe("0.1.0\n");
    captured.stdout.length = 0;
    expect(await runCli(["prompts"], captured.dependencies)).toBe(0);
    expect(captured.stdout.join("")).toContain('"personality"');
    expect(await readPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("passes checks and publication only when requested, preserving host precedence", async () => {
    const root = await temporaryDirectory();
    const checks = join(root, "checks.json");
    await writeFile(
      checks,
      JSON.stringify([{ name: "unit", status: "passed", headSha: "head" }]),
    );
    const calls: PullRequestReviewOptions[] = [];
    const captured = capture({
      environment: { GITHUB_API_URL: "https://env.example/api/v3" },
      reviewPullRequest: async (options) => {
        calls.push(options);
        return completed();
      },
    });
    expect(
      await runCli(
        ["review", "--repo", "acme/service", "--pr", "42", "--checks", checks],
        captured.dependencies,
      ),
    ).toBe(0);
    expect(calls[0]).toMatchObject({
      publish: false,
      apiUrl: "https://env.example/api/v3",
      checks: [
        { name: "unit", status: "passed", headSha: "head", details: "" },
      ],
    });
    expect(
      await runCli(
        [
          "review",
          "--repo",
          "acme/service",
          "--pr",
          "42",
          "--publish",
          "--api-url",
          "https://explicit.example/api/v3",
        ],
        captured.dependencies,
      ),
    ).toBe(0);
    expect(calls[1]).toMatchObject({
      publish: true,
      apiUrl: "https://explicit.example/api/v3",
    });
  });

  it("passes the local default branch and head without publishing", async () => {
    const calls: LocalReviewOptions[] = [];
    const captured = capture({
      reviewLocalChanges: async (options) => {
        calls.push(options);
        return completed();
      },
    });
    expect(
      await runCli(
        [
          "review",
          "--path",
          ".",
          "--base",
          "feature/parent",
          "--head",
          "feature/child",
          "--default-branch",
          "trunk",
        ],
        captured.dependencies,
      ),
    ).toBe(0);
    expect(calls[0]).toMatchObject({
      base: "feature/parent",
      head: "feature/child",
      defaultBranch: "trunk",
    });
    expect(calls[0]).not.toHaveProperty("publish");
  });

  it.each([
    { verdict: "ready", expected: 0 },
    { verdict: "changes-requested", expected: 1 },
    { verdict: "incomplete", expected: 2 },
  ])("returns $expected for $verdict", async ({ verdict, expected }) => {
    if (
      verdict !== "ready" &&
      verdict !== "changes-requested" &&
      verdict !== "incomplete"
    )
      throw new Error("Unexpected verdict.");
    const captured = capture({
      reviewPullRequest: async () => completed(verdict),
    });
    expect(
      await runCli(
        ["review", "--repo", "acme/service", "--pr", "42"],
        captured.dependencies,
      ),
    ).toBe(expected);
  });

  it.each(["partial", "stale"])(
    "reports %s publication as exit 2 even for a ready review",
    async (status) => {
      if (status !== "partial" && status !== "stale")
        throw new Error("Unexpected publication status.");
      const captured = capture({
        reviewPullRequest: async () => completed("ready", status),
      });
      expect(
        await runCli(
          ["review", "--repo", "acme/service", "--pr", "42", "--publish"],
          captured.dependencies,
        ),
      ).toBe(2);
    },
  );

  it("writes a JSON artifact and keeps stdout clean", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "nested output", "review.json");
    const captured = capture({ reviewPullRequest: async () => completed() });
    expect(
      await runCli(
        [
          "review",
          "--repo",
          "acme/service",
          "--pr",
          "42",
          "--format",
          "json",
          "--output",
          path,
        ],
        captured.dependencies,
      ),
    ).toBe(0);
    expect(captured.stdout).toEqual([]);
    expect(await readFile(path, "utf8")).toContain('"verdict": "ready"');
  });

  it("rejects malformed checks before starting review", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "checks.json");
    await writeFile(path, '[{"name":"tests","status":"passed"}]');
    const captured = capture();
    expect(
      await runCli(
        ["review", "--repo", "acme/service", "--pr", "42", "--checks", path],
        captured.dependencies,
      ),
    ).toBe(2);
    expect(captured.stderr.join("")).toContain("headSha");
    expect(captured.stderr.join("")).not.toContain("Unexpected external");
  });

  it("reports sanitized transport failures as exit 2", async () => {
    const captured = capture({
      environment: { OPENROUTER_API_KEY: "provider-secret" },
      reviewPullRequest: async () => {
        throw new GusError(
          "PROVIDER_ERROR",
          "Could not use provider-secret\u001b[31m\nTry later",
        );
      },
    });
    expect(
      await runCli(
        ["review", "--repo", "acme/service", "--pr", "42"],
        captured.dependencies,
      ),
    ).toBe(2);
    expect(captured.stderr.join("")).toContain("[redacted]");
    expect(captured.stderr.join("")).not.toContain("provider-secret");
    expect(captured.stderr.join("")).not.toContain("\u001b");
  });
});
