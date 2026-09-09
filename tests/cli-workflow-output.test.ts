// Workflow output files are a command boundary: event text must never introduce keys or multiline values.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PreparedGitHubEvent } from "../src/application/application-options.js";
import {
  formatGitHubOutputs,
  writeGitHubOutputs,
} from "../src/cli/github-output.js";

const event: PreparedGitHubEvent = {
  repository: "acme/service",
  pullRequest: 42,
  eligible: true,
  reason: "reason\nmalicious=output",
  mode: "review",
  manual: true,
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("GitHub workflow outputs", () => {
  it("outputs fixed fields and discards the free-form reason", () => {
    expect(formatGitHubOutputs(event)).toBe(
      "eligible=true\nrepository=acme/service\npull_request=42\nmode=review\nmanual=true\n",
    );
  });

  it("rejects newlines in repository fields and missing eligible PRs", () => {
    expect(() =>
      formatGitHubOutputs({
        ...event,
        repository: "acme/service\neligible=true",
      }),
    ).toThrow();
    expect(() =>
      formatGitHubOutputs({ ...event, pullRequest: null }),
    ).toThrow();
    expect(() =>
      formatGitHubOutputs({ ...event, pullRequest: Infinity }),
    ).toThrow();
  });

  it("lets malformed ineligible events skip without fabricating a repository", () => {
    expect(
      formatGitHubOutputs({
        ...event,
        eligible: false,
        repository: "",
        pullRequest: null,
      }),
    ).toContain("eligible=false\nrepository=\npull_request=\n");
  });

  it("appends to the workflow file and requires its explicit path", async () => {
    const root = await mkdtemp(join(tmpdir(), "gus-cli-output-"));
    roots.push(root);
    const path = join(root, "github-output");
    await writeFile(path, "previous=value\n");
    await writeGitHubOutputs(path, event);
    expect(await readFile(path, "utf8")).toBe(
      `previous=value\n${formatGitHubOutputs(event)}`,
    );
    await expect(writeGitHubOutputs(undefined, event)).rejects.toThrow(
      "GITHUB_OUTPUT",
    );
  });
});
