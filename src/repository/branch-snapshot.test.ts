// Real Git histories prove contribution attribution survives stacking, upstream changes, and rewritten commit identities.
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../config/config-schema.js";
import type {
  RepositorySession,
  RepositorySource,
} from "../review/review-ports.js";
import { createGitFixture, type GitFixture } from "./git-test-fixtures.js";
import { createRepositorySession } from "./repository-session.js";

const directories: string[] = [];
const sessions: RepositorySession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<GitFixture> {
  const repository = await createGitFixture();
  directories.push(repository.directory);
  await repository.write("base.txt", "base\n");
  await repository.commit("base");
  return repository;
}

async function review(
  repository: GitFixture,
  overrides: Partial<RepositorySource> = {},
): Promise<RepositorySession> {
  const session = await createRepositorySession(
    {
      path: repository.directory,
      base: "trunk",
      head: "child",
      defaultBranch: "trunk",
      baseRef: "trunk",
      headRef: "child",
      ...overrides,
    },
    { config: defaultConfig },
  );
  sessions.push(session);
  return session;
}

async function stack(repository: GitFixture): Promise<string> {
  await repository.git("checkout", "-b", "parent");
  await repository.write("parent.txt", "parent one\n");
  const parentSha = await repository.commit("parent contribution");
  await repository.git("checkout", "-b", "child");
  await repository.write("child.txt", "child only\n");
  await repository.commit("child contribution");
  return parentSha;
}

describe("pinned branch contribution", () => {
  it("isolates B from unmerged A while showing the actual target's combined integration", async () => {
    const repository = await fixture();
    const parentSha = await stack(repository);
    const branchBefore = await repository.git("symbolic-ref", "HEAD");
    const session = await review(repository, {
      parentCandidates: [
        { ref: "parent", sha: parentSha, pullRequest: 10, merged: false },
      ],
    });
    expect(session.files.map((file) => file.path)).toEqual(["child.txt"]);
    expect(session.snapshot.parent?.sha).toBe(parentSha);
    expect(session.snapshot.comparisonBaseSha).toBe(parentSha);
    expect(
      session.snapshot.advisories.some(
        (advice) => advice.code === "stack-target-mismatch",
      ),
    ).toBe(true);
    expect((await session.readFile("parent.txt", "integration")).text).toBe(
      "parent one",
    );
    expect(await repository.git("symbolic-ref", "HEAD")).toBe(branchBefore);
    expect(await repository.git("status", "--porcelain")).toBe("");
  });

  it("uses the declared parent even when its tip advanced beyond the child's branch point", async () => {
    const repository = await fixture();
    const oldParent = await stack(repository);
    await repository.git("checkout", "parent");
    await repository.write("parent.txt", "parent two\n");
    const parentSha = await repository.commit("advance parent");
    const session = await review(repository, {
      base: "parent",
      baseRef: "parent",
      parentCandidates: [
        { ref: "parent", sha: parentSha, pullRequest: 10, merged: false },
      ],
    });
    expect(session.files.map((file) => file.path)).toEqual(["child.txt"]);
    expect(session.snapshot.parent?.sha).toBe(parentSha);
    expect(session.snapshot.comparisonBaseSha).toBe(oldParent);
    expect((await session.readFile("parent.txt", "parent")).text).toBe(
      "parent one",
    );
    expect((await session.readFile("parent.txt", "base")).text).toBe(
      "parent two",
    );
    expect((await session.readFile("parent.txt", "integration")).text).toBe(
      "parent two",
    );
    expect(
      session.snapshot.advisories.some(
        (advice) => advice.code === "stack-parent-advanced",
      ),
    ).toBe(true);
  });

  it("handles a normally merged parent without repeating its contribution", async () => {
    const repository = await fixture();
    const parentSha = await stack(repository);
    await repository.git("checkout", "trunk");
    await repository.git("merge", "--no-ff", "parent", "-m", "merge parent");
    const session = await review(repository, {
      parentCandidates: [
        { ref: "parent", sha: parentSha, pullRequest: 10, merged: true },
      ],
    });
    expect(session.files.map((file) => file.path)).toEqual(["child.txt"]);
    expect(session.snapshot.parent).toBeNull();
    expect(session.snapshot.integration.status).toBe("clean");
  });

  it("attributes only the child after a squash merge and advises restacking without declaring semantic equivalence", async () => {
    const repository = await fixture();
    const parentSha = await stack(repository);
    await repository.git("checkout", "trunk");
    await repository.git("merge", "--squash", "parent");
    await repository.commit("squash parent");
    const session = await review(repository, {
      parentCandidates: [
        { ref: "parent", sha: parentSha, pullRequest: 10, merged: true },
      ],
    });
    expect(session.files.map((file) => file.path)).toEqual(["child.txt"]);
    expect(session.snapshot.comparisonBaseSha).toBe(parentSha);
    expect(
      session.snapshot.advisories.find(
        (advice) => advice.code === "merged-stack-parent",
      )?.evidence,
    ).toContain("does not prove");
    expect(session.snapshot.integration.status).toBe("clean");
  });

  it("preserves the effective diff after rebase and invalidates the previous review's history context", async () => {
    const repository = await fixture();
    const previousBaseSha = await repository.git("rev-parse", "trunk");
    await repository.git("checkout", "-b", "child");
    await repository.write("child.txt", "stable contribution\n");
    const previousHeadSha = await repository.commit("child");
    const before = await review(repository);
    await repository.git("checkout", "trunk");
    await repository.write("upstream.txt", "upstream\n");
    await repository.commit("upstream");
    await repository.git("checkout", "child");
    await repository.git("rebase", "trunk");
    const after = await review(repository, {
      previousHeadSha,
      previousBaseSha,
    });
    expect(
      after.files.map((file) => ({ path: file.path, patch: file.patch })),
    ).toEqual(
      before.files.map((file) => ({ path: file.path, patch: file.patch })),
    );
    expect(after.snapshot.historyRewritten).toBe(true);
    expect(after.snapshot.baseChanged).toBe(true);
    expect(after.snapshot.headSha).not.toBe(previousHeadSha);
    expect((await before.readFile("child.txt", "head")).sha).toBe(
      previousHeadSha,
    );
  });

  it("distinguishes stale head code from an upstream fix present in the prospective merge", async () => {
    const repository = await fixture();
    await repository.write("calculation.ts", "export const total = 0;\n");
    await repository.commit("old calculation");
    await repository.git("checkout", "-b", "child");
    await repository.write("child.txt", "unrelated feature\n");
    await repository.commit("feature");
    await repository.git("checkout", "trunk");
    await repository.write("calculation.ts", "export const total = 1;\n");
    await repository.commit("fix calculation upstream");
    const session = await review(repository);
    expect(session.files.map((file) => file.path)).toEqual(["child.txt"]);
    expect((await session.readFile("calculation.ts", "head")).text).toContain(
      "= 0",
    );
    expect(
      (await session.readFile("calculation.ts", "integration")).text,
    ).toContain("= 1");
    expect(session.snapshot.advisories).toEqual([]);
  });

  it("records actual conflicts rather than presenting the conflicted tree as successful integration", async () => {
    const repository = await fixture();
    await repository.git("checkout", "-b", "child");
    await repository.write("base.txt", "child edit\n");
    await repository.commit("child edit");
    await repository.git("checkout", "trunk");
    await repository.write("base.txt", "target edit\n");
    await repository.commit("target edit");
    const session = await review(repository);
    expect(session.snapshot.integration.status).toBe("conflict");
    expect(session.snapshot.integration.conflicts).toContain("base.txt");
    expect(
      session.snapshot.advisories.some(
        (advice) => advice.action === "resolve-conflicts",
      ),
    ).toBe(true);
  });

  it("resolves an explicit parent branch ref to an immutable SHA", async () => {
    const repository = await fixture();
    const parentSha = await stack(repository);
    const session = await review(repository, {
      parent: {
        ref: "parent",
        sha: "parent",
        pullRequest: null,
        merged: false,
      },
    });
    expect(session.snapshot.parent?.sha).toBe(parentSha);
    expect(session.snapshot.comparisonBaseSha).toBe(parentSha);
  });

  it("marks a retargeted PR's old review baseline stale", async () => {
    const repository = await fixture();
    const parentSha = await stack(repository);
    const previousBaseSha = await repository.git("rev-parse", "trunk");
    const session = await review(repository, {
      base: "parent",
      baseRef: "parent",
      previousBaseSha,
    });
    expect(session.snapshot.baseChanged).toBe(true);
    expect(session.snapshot.baseSha).toBe(parentSha);
    expect(session.files.map((file) => file.path)).toEqual(["child.txt"]);
  });

  it("discovers the observed remote default and leaves it unknown when no default is declared", async () => {
    const repository = await fixture();
    await stack(repository);
    const unknown = await review(repository, { defaultBranch: "" });
    expect(unknown.snapshot.defaultBranch).toBe("");
    expect(unknown.snapshot.defaultSha).toBeNull();
    await repository.git(
      "update-ref",
      "refs/remotes/origin/trunk",
      await repository.git("rev-parse", "trunk"),
    );
    await repository.git(
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/trunk",
    );
    const discovered = await review(repository, { defaultBranch: "" });
    expect(discovered.snapshot.defaultBranch).toBe("trunk");
    expect(discovered.snapshot.defaultSha).toBe(
      await repository.git("rev-parse", "trunk"),
    );
  });

  it("does not invent a parent when independent merged branches make the stack ambiguous", async () => {
    const repository = await fixture();
    await repository.git("checkout", "-b", "left");
    await repository.write("left.txt", "left\n");
    const left = await repository.commit("left");
    await repository.git("checkout", "trunk");
    await repository.git("checkout", "-b", "right");
    await repository.write("right.txt", "right\n");
    const right = await repository.commit("right");
    await repository.git("checkout", "-b", "child");
    await repository.git("merge", "--no-ff", "left", "-m", "combine branches");
    await repository.write("child.txt", "child\n");
    await repository.commit("child");
    const session = await review(repository, {
      parentCandidates: [
        { ref: "left", sha: left, pullRequest: 1, merged: false },
        { ref: "right", sha: right, pullRequest: 2, merged: false },
      ],
    });
    expect(session.snapshot.parent).toBeNull();
    expect(
      session.snapshot.advisories.some(
        (advice) => advice.code === "ambiguous-stack-parent",
      ),
    ).toBe(true);
    expect(session.files.map((file) => file.path)).toEqual([
      "child.txt",
      "left.txt",
      "right.txt",
    ]);
  });

  it("treats a replacement branch head as rewritten history even without a rebase", async () => {
    const repository = await fixture();
    await repository.git("checkout", "-b", "child");
    await repository.write("first.txt", "original\n");
    const previousHeadSha = await repository.commit("original child");
    await repository.git("checkout", "trunk");
    await repository.git("branch", "--force", "child", "trunk");
    await repository.git("checkout", "child");
    await repository.write("replacement.txt", "replacement\n");
    await repository.commit("replacement child");
    const session = await review(repository, { previousHeadSha });
    expect(session.snapshot.historyRewritten).toBe(true);
    expect(session.files.map((file) => file.path)).toEqual(["replacement.txt"]);
  });
});
