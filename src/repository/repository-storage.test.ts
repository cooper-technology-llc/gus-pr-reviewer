// Candidate discovery must scale with GitHub metadata without fetching unrelated branches or inventing review limitations.
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../config/config-schema.js";
import { GusError } from "../errors.js";
import type { RepositorySource } from "../review/review-ports.js";
import * as gitCommands from "./git-command.js";
import type { GitOutput, GitStore } from "./git-command.js";
import { createGitFixture } from "./git-test-fixtures.js";
import { createRepositorySession } from "./repository-session.js";
import { createRepositoryStorage } from "./repository-storage.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function unrelatedCandidates(
  count: number,
): NonNullable<RepositorySource["parentCandidates"]> {
  return Array.from({ length: count }, (_, index) => ({
    ref: `unrelated-${index}`,
    sha: (index + 1000).toString(16).padStart(40, "0"),
    pullRequest: index + 1000,
    merged: false,
  }));
}

describe("stack candidate storage", () => {
  it("accepts more than 50 unrelated candidates while detecting one reachable stack parent", async () => {
    const fixture = await createGitFixture();
    directories.push(fixture.directory);
    await fixture.write("base.txt", "base\n");
    await fixture.commit("base");
    await fixture.git("checkout", "-b", "parent");
    await fixture.write("parent.txt", "parent\n");
    const parentSha = await fixture.commit("parent");
    await fixture.git("checkout", "-b", "child");
    await fixture.write("child.txt", "child\n");
    await fixture.commit("child");
    const session = await createRepositorySession(
      {
        path: fixture.directory,
        base: "trunk",
        baseRef: "trunk",
        head: "child",
        defaultBranch: "trunk",
        parentCandidates: [
          ...unrelatedCandidates(100),
          { ref: "parent", sha: parentSha, pullRequest: 10, merged: false },
        ],
      },
      { config: defaultConfig },
    );
    try {
      expect(session.snapshot.parent?.sha).toBe(parentSha);
      expect(session.files.map((file) => file.path)).toEqual(["child.txt"]);
      expect(session.omissions).toEqual([]);
    } finally {
      await session.dispose();
    }
  });

  it("never fetches unrelated candidate tips, even at the 5,000-candidate metadata ceiling", async () => {
    const baseSha = "a".repeat(40);
    const headSha = "b".repeat(40);
    const parentSha = "c".repeat(40);
    const command = mockTransport(baseSha, headSha, parentSha);
    const repository = await createRepositoryStorage(
      {
        remoteUrl: "https://github.com/example/project.git",
        base: baseSha,
        baseRef: "trunk",
        head: headSha,
        defaultBranch: "trunk",
        parentCandidates: [
          ...unrelatedCandidates(4999),
          { ref: "parent", sha: parentSha, pullRequest: 10, merged: false },
        ],
      },
      { config: defaultConfig },
    );
    directories.push(repository.store.directory);
    expect(
      command.mock.calls
        .filter(([argumentsList]) => argumentsList[0] === "fetch")
        .map(([argumentsList]) => argumentsList.at(-1)),
    ).toEqual([
      `${baseSha}:refs/gus/base`,
      `${headSha}:refs/gus/head`,
      "trunk:refs/gus/default",
    ]);
    expect(repository.candidates).toEqual([
      { ref: "parent", sha: parentSha, pullRequest: 10, merged: false },
    ]);
    expect(repository.omissions).toEqual([]);
    expect(
      command.mock.calls.filter(
        ([argumentsList]) => argumentsList[0] === "rev-list",
      ),
    ).toHaveLength(1);
  });

  it("can fetch the declared base branch's missing tip and the explicit parent", async () => {
    const baseSha = "a".repeat(40);
    const headSha = "b".repeat(40);
    const parentSha = "c".repeat(40);
    const advancedSha = "d".repeat(40);
    const explicitSha = "e".repeat(40);
    const command = mockTransport(baseSha, headSha, parentSha);
    const repository = await createRepositoryStorage(
      {
        remoteUrl: "https://github.com/example/project.git",
        base: baseSha,
        baseRef: "declared",
        head: headSha,
        defaultBranch: "trunk",
        parent: {
          ref: "explicit",
          sha: explicitSha,
          pullRequest: null,
          merged: false,
        },
        parentCandidates: [
          ...unrelatedCandidates(100),
          { ref: "declared", sha: advancedSha, pullRequest: 20, merged: false },
        ],
      },
      { config: defaultConfig },
    );
    directories.push(repository.store.directory);
    const fetches = command.mock.calls
      .filter(([argumentsList]) => argumentsList[0] === "fetch")
      .map(([argumentsList]) => argumentsList.at(-1));
    expect(fetches).toContain(`${advancedSha}:refs/gus/declared-parent-0`);
    expect(fetches).toContain(`${explicitSha}:refs/gus/parent`);
    expect(fetches).toHaveLength(5);
    expect(repository.parent?.sha).toBe(explicitSha);
    expect(repository.candidates).toEqual([
      { ref: "declared", sha: advancedSha, pullRequest: 20, merged: false },
    ]);
  });
});

function mockTransport(baseSha: string, headSha: string, parentSha: string) {
  const refs = new Map<string, string>();
  const commits = new Set<string>();
  const output = (stdout = ""): GitOutput => ({
    stdout: Buffer.from(stdout),
    stderr: "",
    exitCode: 0,
  });
  const command = vi.fn<GitStore["command"]>(async (argumentsList) => {
    if (argumentsList[0] === "init") return output();
    if (argumentsList[0] === "fetch") {
      const refspec = argumentsList.at(-1) ?? "";
      const [revision, ref] = refspec.split(":");
      if (revision === undefined || ref === undefined)
        throw new Error("Fixture expected a refspec.");
      const sha = revision === "trunk" ? baseSha : revision;
      refs.set(ref, sha);
      commits.add(sha);
      if (sha === headSha) commits.add(parentSha);
      return output();
    }
    if (argumentsList[0] === "rev-parse") {
      const revision = (argumentsList.at(-1) ?? "").replace("^{commit}", "");
      const sha =
        refs.get(revision) ?? (commits.has(revision) ? revision : undefined);
      if (sha === undefined)
        throw new GusError("GIT_FAILED", "Fixture commit is absent.");
      return output(`${sha}\n`);
    }
    if (argumentsList[0] === "rev-list")
      return output(`${[...commits].join("\n")}\n`);
    throw new Error(`Unexpected fixture command ${argumentsList[0]}.`);
  });
  vi.spyOn(gitCommands, "createGitStore").mockImplementation((directory) => ({
    directory,
    command,
  }));
  return command;
}
