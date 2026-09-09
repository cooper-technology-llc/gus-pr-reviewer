// Delivered pages, not mere tool calls, must prove complete inspection before a truncated diff can become fully reviewed.
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  configSchema,
  defaultConfig,
  type GusConfig,
} from "../config/config-schema.js";
import type { RepositorySession } from "../review/review-ports.js";
import { createGitFixture } from "./git-test-fixtures.js";
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

async function changedFile(config: GusConfig = defaultConfig) {
  const fixture = await createGitFixture();
  directories.push(fixture.directory);
  await fixture.write("change.txt", "one\ntwo\nold three\nfour\n");
  await fixture.write("deleted.txt", "deleted source\n");
  await fixture.commit("base");
  await fixture.git("checkout", "-b", "child");
  await fixture.write("change.txt", "one\ntwo\nnew three\nfour\n");
  await fixture.write("empty.txt", "");
  await fixture.git("rm", "deleted.txt");
  await fixture.commit("child");
  const session = await createRepositorySession(
    {
      path: fixture.directory,
      base: "trunk",
      head: "child",
      defaultBranch: "trunk",
    },
    { config },
  );
  sessions.push(session);
  return { session, tools: createRepositoryTools(session, config) };
}

describe("completed repository inspection", () => {
  it("requires all source pages before completing a path with an initially truncated patch", async () => {
    const { session, tools } = await changedFile(
      configSchema.parse({ review: { maxDiffCharsPerFile: 50 } }),
    );
    expect(
      session.files.find((file) => file.path === "change.txt")?.truncated,
    ).toBe(true);
    const first = await tools.execute("read_file", {
      path: "change.txt",
      startLine: 1,
      endLine: 2,
    });
    expect(first.inspectedPaths).toEqual([]);
    const duplicate = await tools.execute("read_file", {
      path: "change.txt",
      startLine: 1,
      endLine: 2,
    });
    expect(duplicate.inspectedPaths).toEqual([]);
    const rest = await tools.execute("read_file", {
      path: "change.txt",
      startLine: 3,
      endLine: 4,
    });
    expect(rest.inspectedPaths).toEqual(["change.txt"]);
  });

  it("combines delivered batches, including pages requested out of order", async () => {
    const { tools } = await changedFile();
    const last = await tools.execute("read_files", {
      files: [{ path: "change.txt", startLine: 3, endLine: 4 }],
    });
    expect(last.inspectedPaths).toEqual([]);
    const first = await tools.execute("read_files", {
      files: [{ path: "change.txt", startLine: 1, endLine: 2 }],
    });
    expect(first.inspectedPaths).toEqual(["change.txt"]);
  });

  it("does not accept an existing file's parent snapshot or metadata/search tools as current inspection", async () => {
    const { tools } = await changedFile();
    const parent = await tools.execute("read_file", {
      path: "change.txt",
      revision: "parent",
    });
    expect(parent.inspectedPaths).toEqual([]);
    expect(
      (await tools.execute("search", { query: "three", pattern: "change.txt" }))
        .inspectedPaths,
    ).toEqual([]);
    expect(
      (await tools.execute("list_files", { pattern: "change.txt" }))
        .inspectedPaths,
    ).toEqual([]);
    expect(
      (await tools.execute("history", { path: "change.txt" })).inspectedPaths,
    ).toEqual([]);
    const partialHead = await tools.execute("read_file", {
      path: "change.txt",
      startLine: 3,
      endLine: 4,
    });
    expect(partialHead.inspectedPaths).toEqual([]);
    expect(
      (
        await tools.execute("read_file", {
          path: "change.txt",
          startLine: 1,
          endLine: 2,
        })
      ).inspectedPaths,
    ).toEqual(["change.txt"]);
  });

  it("keeps head and integration source coverage separate", async () => {
    const { tools } = await changedFile();
    expect(
      (
        await tools.execute("read_file", {
          path: "change.txt",
          revision: "head",
          startLine: 1,
          endLine: 2,
        })
      ).inspectedPaths,
    ).toEqual([]);
    expect(
      (
        await tools.execute("read_file", {
          path: "change.txt",
          revision: "integration",
          startLine: 3,
          endLine: 4,
        })
      ).inspectedPaths,
    ).toEqual([]);
    expect(
      (
        await tools.execute("read_file", {
          path: "change.txt",
          revision: "head",
          startLine: 3,
          endLine: 4,
        })
      ).inspectedPaths,
    ).toEqual(["change.txt"]);
  });

  it("allows complete parent reads for deleted files and complete reads of empty files", async () => {
    const { tools } = await changedFile();
    expect(
      (
        await tools.execute("read_file", {
          path: "deleted.txt",
          revision: "parent",
        })
      ).inspectedPaths,
    ).toEqual(["deleted.txt"]);
    expect(
      (await tools.execute("read_file", { path: "empty.txt" })).inspectedPaths,
    ).toEqual(["empty.txt"]);
  });

  it("requires every patch row before completing paginated diff inspection", async () => {
    const { tools } = await changedFile();
    expect(
      (
        await tools.execute("read_diff", {
          path: "change.txt",
          startLine: 1,
          lineCount: 2,
        })
      ).inspectedPaths,
    ).toEqual([]);
    expect(
      (
        await tools.execute("read_diff", {
          path: "change.txt",
          startLine: 3,
          lineCount: 100,
        })
      ).inspectedPaths,
    ).toEqual(["change.txt"]);
  });

  it("does not retain coverage from a diff result whose serialized evidence could not fit", async () => {
    const fixture = await createGitFixture();
    directories.push(fixture.directory);
    const lines = Array.from(
      { length: 160 },
      (_, index) => `line ${index} has baseline value`,
    );
    await fixture.write("many-hunks.txt", `${lines.join("\n")}\n`);
    await fixture.commit("base");
    await fixture.git("checkout", "-b", "child");
    await fixture.write(
      "many-hunks.txt",
      `${lines.map((line, index) => (index % 8 === 0 ? line.replace("baseline", "updated") : line)).join("\n")}\n`,
    );
    await fixture.commit("many separate changes");
    const config = configSchema.parse({ review: { maxToolOutputChars: 6000 } });
    const session = await createRepositorySession(
      {
        path: fixture.directory,
        base: "trunk",
        head: "child",
        defaultBranch: "trunk",
      },
      { config },
    );
    sessions.push(session);
    const tools = createRepositoryTools(session, config);
    const clipped = await tools.execute("read_diff", {
      path: "many-hunks.txt",
      lineCount: 800,
    });
    expect(clipped.content).toContain("OUTPUT_LIMIT");
    expect(clipped.inspectedPaths).toEqual([]);
    const diff = await session.readDiff("many-hunks.txt", 1, 1000);
    for (let startLine = 2; startLine <= diff.totalLines; startLine += 10) {
      const page = await tools.execute("read_diff", {
        path: "many-hunks.txt",
        startLine,
        lineCount: 10,
      });
      expect(page.content).not.toContain("OUTPUT_LIMIT");
      expect(page.inspectedPaths).toEqual([]);
    }
    expect(
      (
        await tools.execute("read_diff", {
          path: "many-hunks.txt",
          startLine: 1,
          lineCount: 1,
        })
      ).inspectedPaths,
    ).toEqual(["many-hunks.txt"]);
  });
});
