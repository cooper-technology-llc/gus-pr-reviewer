// Real tracked blobs prove the tools preserve source coordinates, disclose partial reads, and refuse secret or executable filesystem paths.
import { lstat, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  configSchema,
  defaultConfig,
  type GusConfig,
} from "../config/config-schema.js";
import type { RepositorySession } from "../review/review-ports.js";
import { createGitFixture, type GitFixture } from "./git-test-fixtures.js";
import { createRepositorySession } from "./repository-session.js";
import { createRepositoryTools } from "./repository-tools.js";

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
  return repository;
}

async function sessionFor(
  repository: GitFixture,
  config: GusConfig = defaultConfig,
): Promise<RepositorySession> {
  const session = await createRepositorySession(
    {
      path: repository.directory,
      base: "trunk",
      head: "child",
      defaultBranch: "trunk",
    },
    { config },
  );
  sessions.push(session);
  return session;
}

describe("repository reads and evidence", () => {
  it("preserves spaces, renames, deletions, and binary metadata", async () => {
    const repository = await fixture();
    await repository.write("old name.txt", "same\n");
    await repository.write("remove me.txt", "remove\n");
    await repository.commit("base");
    await repository.git("checkout", "-b", "child");
    await repository.git("mv", "old name.txt", "new name.txt");
    await repository.git("rm", "remove me.txt");
    await repository.write("binary.dat", Uint8Array.from([0, 1, 2, 255]));
    await repository.commit("rename and delete");
    const session = await sessionFor(repository);
    expect(
      session.files.find((file) => file.path === "new name.txt"),
    ).toMatchObject({ status: "renamed", previousPath: "old name.txt" });
    expect(
      session.files.find((file) => file.path === "remove me.txt"),
    ).toMatchObject({ status: "deleted", deletions: 1 });
    expect(
      session.files.find((file) => file.path === "binary.dat"),
    ).toMatchObject({ binary: true, patch: "" });
    expect((await session.readFile("new name.txt", "head")).text).toBe("same");
    await expect(
      session.readFile("remove me.txt", "head"),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    expect((await session.readFile("remove me.txt", "parent")).text).toBe(
      "remove",
    );
  });

  it("uses actual old and new source lines in diff evidence, including pages starting inside hunks", async () => {
    const repository = await fixture();
    await repository.write("check.ts", "first\nold value\nthird\n");
    await repository.commit("base");
    await repository.git("checkout", "-b", "child");
    await repository.write("check.ts", "first\nnew value\nthird\n");
    await repository.commit("change value");
    const session = await sessionFor(repository);
    const tools = createRepositoryTools(session, defaultConfig);
    const full = await session.readDiff("check.ts", 1, 1000);
    const patchRows = full.text.split("\n");
    const oldRow = patchRows.indexOf("-old value") + 1;
    const result = await tools.execute("read_diff", {
      path: "check.ts",
      startLine: oldRow,
      lineCount: 2,
    });
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          revision: "parent",
          sha: session.snapshot.comparisonBaseSha,
          startLine: 2,
          endLine: 2,
          text: "old value",
        }),
        expect.objectContaining({
          revision: "head",
          sha: session.snapshot.headSha,
          startLine: 2,
          endLine: 2,
          text: "new value",
        }),
      ]),
    );
    expect(
      result.evidence.every((record) => record.id.includes(record.sha)),
    ).toBe(true);
  });

  it("reads copied commit objects after the author's worktree and branch move", async () => {
    const repository = await fixture();
    await repository.write("file.txt", "base\n");
    await repository.commit("base");
    await repository.git("checkout", "-b", "child");
    await repository.write("file.txt", "reviewed\n");
    const head = await repository.commit("reviewed head");
    const session = await sessionFor(repository);
    await repository.write("file.txt", "later\n");
    await repository.commit("later head");
    const file = await session.readFile("file.txt", "head");
    expect(file.text).toBe("reviewed");
    expect(file.sha).toBe(head);
  });

  it("refuses tracked credentials, symlinks, traversal, and untracked local source", async () => {
    const repository = await fixture();
    await repository.write("ordinary.txt", "base\n");
    await repository.commit("base");
    await repository.git("checkout", "-b", "child");
    await repository.write(".env", "TOKEN=never-send-this\n");
    await repository.write(
      ".npmrc",
      "//registry.npmjs.org/:_authToken=never-send-this\n",
    );
    await repository.write("private.key", "private-key-material\n");
    await symlink(
      join(repository.directory, ".env"),
      join(repository.directory, "leak.txt"),
    );
    await repository.commit("sensitive paths");
    await repository.write("untracked.txt", "not a reviewed blob\n");
    const session = await sessionFor(repository);
    for (const path of [
      ".env",
      ".npmrc",
      "private.key",
      "leak.txt",
      "../sibling/file.txt",
      "ordinary.txt/../../sibling/file.txt",
    ]) {
      await expect(session.readFile(path, "head")).rejects.toMatchObject({
        code: "PATH_DENIED",
      });
    }
    await expect(
      session.readFile("untracked.txt", "head"),
    ).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    expect((await session.listFiles()).includes("leak.txt")).toBe(false);
    expect(JSON.stringify(session.files)).not.toContain("never-send-this");
    expect(
      session.files.every((file) => file.excluded && file.patch === ""),
    ).toBe(true);
  });

  it("does not execute source configuration, custom merge drivers, or text converters", async () => {
    const repository = await fixture();
    await repository.write("file.txt", "base\n");
    await repository.write(
      ".gitattributes",
      "*.txt merge=tripwire diff=tripwire\n",
    );
    await repository.commit("base");
    await repository.git("checkout", "-b", "child");
    await repository.write("file.txt", "child\n");
    await repository.commit("child");
    await repository.git("checkout", "trunk");
    await repository.write("file.txt", "target\n");
    await repository.commit("target");
    const marker = join(repository.directory, "executed-marker");
    const script = join(repository.directory, "untrusted-driver.sh");
    await repository.write(
      "untrusted-driver.sh",
      `#!/bin/sh\ntouch '${marker}'\nexit 1\n`,
    );
    await repository.git("config", "merge.tripwire.driver", `sh '${script}'`);
    await repository.git("config", "diff.tripwire.textconv", `sh '${script}'`);
    const session = await sessionFor(repository);
    expect(session.snapshot.integration.status).toBe("conflict");
    await session.readDiff("file.txt");
    expect(await lstat(marker).catch(() => undefined)).toBeUndefined();
  });

  it("paginates source without clipping a line or claiming a partial read is complete", async () => {
    const repository = await fixture();
    await repository.write("base.txt", "base\n");
    await repository.commit("base");
    await repository.git("checkout", "-b", "child");
    await repository.write(
      "long.txt",
      Array.from(
        { length: 100 },
        (_, index) => `line ${index + 1}: ${"x".repeat(60)}`,
      ).join("\n"),
    );
    await repository.commit("long source");
    const config = configSchema.parse({ review: { maxToolOutputChars: 2500 } });
    const session = await sessionFor(repository, config);
    const result = await createRepositoryTools(session, config).execute(
      "read_file",
      { path: "long.txt", endLine: 100 },
    );
    const output = z
      .object({
        text: z.string(),
        startLine: z.number(),
        endLine: z.number(),
        totalLines: z.number(),
        truncated: z.boolean(),
        nextLine: z.number(),
      })
      .parse(JSON.parse(result.content));
    expect(result.content.length).toBeLessThanOrEqual(2500);
    expect(output.truncated).toBe(true);
    expect(output.totalLines).toBe(100);
    expect(output.nextLine).toBe(output.endLine + 1);
    expect(output.text.split("\n").length).toBe(
      output.endLine - output.startLine + 1,
    );
    expect(
      output.text.split("\n").every((line) => line.endsWith("x".repeat(60))),
    ).toBe(true);
  });

  it("literal search has a resumable cursor and cannot be turned into a regular expression", async () => {
    const repository = await fixture();
    await repository.write("base.txt", "base\n");
    await repository.commit("base");
    await repository.git("checkout", "-b", "child");
    await repository.write("one.txt", "needle.* literal\nneedle.* again\n");
    await repository.write("two.txt", "needle-other\nneedle.* last\n");
    await repository.commit("search source");
    const session = await sessionFor(repository);
    const tools = createRepositoryTools(session, defaultConfig);
    const page = await tools.execute("search", {
      query: "needle.*",
      pattern: "*.txt",
      maxMatches: 1,
    });
    expect(page.evidence).toHaveLength(1);
    expect(page.evidence[0]).toMatchObject({
      path: "one.txt",
      startLine: 1,
      text: "needle.* literal",
    });
    const output = z
      .object({
        truncated: z.boolean(),
        nextCursor: z.object({ fileIndex: z.number(), startLine: z.number() }),
      })
      .parse(JSON.parse(page.content));
    expect(output.truncated).toBe(true);
    const next = await tools.execute("search", {
      query: "needle.*",
      pattern: "*.txt",
      ...output.nextCursor,
    });
    expect(next.evidence.map((record) => record.text)).toEqual([
      "needle.* again",
      "needle.* last",
    ]);
  });

  it("keeps all metadata when the initial changed-file budget is smaller than the diff", async () => {
    const repository = await fixture();
    await repository.write("base.txt", "base\n");
    await repository.commit("base");
    await repository.git("checkout", "-b", "child");
    for (const path of ["a.txt", "b.txt", "c.txt"])
      await repository.write(path, "change\n");
    await repository.commit("three files");
    const config = configSchema.parse({ review: { maxFiles: 1 } });
    const session = await sessionFor(repository, config);
    expect(session.files).toHaveLength(3);
    expect(session.files.filter((file) => file.truncated)).toHaveLength(2);
    expect(
      session.omissions.filter((message) =>
        message.includes("changed-file budget"),
      ),
    ).toHaveLength(2);
  });

  it("validates tool arguments and honors cancellation and deadlines", async () => {
    const repository = await fixture();
    await repository.write("base.txt", "base\n");
    await repository.commit("base");
    await repository.git("checkout", "-b", "child");
    await repository.write("child.txt", "child\n");
    await repository.commit("child");
    const session = await sessionFor(repository);
    const tools = createRepositoryTools(session, defaultConfig);
    const invalid = await tools.execute("read_file", {
      path: "child.txt",
      revision: "HEAD~1",
    });
    expect(invalid.evidence).toEqual([]);
    expect(invalid.content).toContain("INPUT_INVALID");
    await expect(
      tools.execute(
        "read_file",
        { path: "child.txt" },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toMatchObject({ code: "ABORTED" });
    await expect(
      session.history(undefined, { deadline: Date.now() - 1 }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await expect(
      createRepositorySession(
        {
          path: repository.directory,
          base: "trunk; touch danger",
          head: "child",
          defaultBranch: "trunk",
        },
        { config: defaultConfig },
      ),
    ).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });
});
