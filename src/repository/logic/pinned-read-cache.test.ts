// Exact immutable reads may be reused, but failures, changed arguments, and distinct revision provenance must still reach the repository.
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../config/config-schema.js";
import { GusError } from "../../errors.js";
import type { FileRead, RepositorySession } from "../../review/review-ports.js";
import type { Revision } from "../../review/review-schema.js";
import { reviewTestInput } from "../../review/review-test-fixtures.js";
import { createRepositoryTools } from "../repository-tools.js";

interface RecordedRead {
  path: string;
  revision: Revision;
  startLine: number;
  endLine: number | undefined;
}

describe("pinned repository read reuse", () => {
  it("reuses successful reads with normalized defaults and preserves the public result", async () => {
    const { repository, reads } = readFixture();
    const tools = createRepositoryTools(repository, defaultConfig);
    const first = await tools.execute(
      "read_file",
      { path: "src/a.ts" },
      { deadline: Date.now() + 60000 },
    );
    const second = await tools.execute("read_file", {
      startLine: 1,
      path: "src/a.ts",
      revision: "head",
    });
    expect(reads).toHaveLength(1);
    expect(second).toEqual(first);
    expect(second.inspectedPaths).toEqual(["src/a.ts"]);
    expect(second.evidence[0]).toMatchObject({
      path: "src/a.ts",
      revision: "head",
      sha: repository.snapshot.headSha,
      startLine: 1,
      endLine: 3,
    });
    expect(JSON.parse(second.content)).toMatchObject({
      text: "first\nsecond\nthird",
      totalLines: 3,
    });
  });

  it("keeps paths, ranges, revisions, and pinned snapshot identities distinct", async () => {
    const { repository, reads } = readFixture();
    const tools = createRepositoryTools(repository, defaultConfig);
    await tools.execute("read_file", { path: "src/a.ts" });
    const head = await tools.execute("read_file", {
      path: "src/a.ts",
      endLine: 2,
    });
    await tools.execute("read_file", {
      path: "src/a.ts",
      startLine: 2,
      endLine: 2,
    });
    const integration = await tools.execute("read_file", {
      path: "src/a.ts",
      revision: "integration",
      endLine: 2,
    });
    await tools.execute("read_file", { path: "src/b.ts", endLine: 2 });
    await tools.execute("read_file", {
      path: "src/a.ts",
      revision: "head",
      startLine: 1,
      endLine: 2,
    });
    expect(reads).toHaveLength(5);
    expect(head.evidence[0]?.text).toBe(integration.evidence[0]?.text);
    expect(head.evidence[0]?.id).not.toBe(integration.evidence[0]?.id);
    expect(integration.evidence[0]).toMatchObject({
      revision: "integration",
      sha: repository.snapshot.integration.treeSha,
    });

    repository.snapshot = {
      ...repository.snapshot,
      headSha: "next-pinned-head",
    };
    const moved = await tools.execute("read_file", {
      path: "src/a.ts",
      endLine: 2,
    });
    expect(reads).toHaveLength(6);
    expect(moved.evidence[0]?.sha).toBe("next-pinned-head");
    expect(moved.evidence[0]?.id).not.toBe(head.evidence[0]?.id);
  });

  it("reuses an exact successful batch but never a partially failed batch", async () => {
    const { repository, reads } = readFixture(
      (request, previous) =>
        request.path === "src/b.ts" &&
        previous.filter((read) => read.path === request.path).length === 1,
    );
    const tools = createRepositoryTools(repository, defaultConfig);
    const args = { files: [{ path: "src/a.ts" }, { path: "src/b.ts" }] };
    const partial = await tools.execute("read_files", args);
    expect(partial.evidence).toHaveLength(1);
    expect(partial.warnings).toHaveLength(1);
    const complete = await tools.execute("read_files", args);
    expect(complete.evidence).toHaveLength(2);
    expect(complete.warnings).toEqual([]);
    expect(reads).toHaveLength(4);
    const reused = await tools.execute("read_files", {
      files: [
        { path: "src/a.ts", revision: "head", startLine: 1 },
        { path: "src/b.ts", startLine: 1, revision: "head" },
      ],
    });
    expect(reads).toHaveLength(4);
    expect(reused).toEqual(complete);
  });

  it("retries failed reads and admits only the later successful result to reuse", async () => {
    const { repository, reads } = readFixture(
      (_request, previous) => previous.length === 1,
    );
    const tools = createRepositoryTools(repository, defaultConfig);
    const failed = await tools.execute("read_file", { path: "src/a.ts" });
    expect(failed.evidence).toEqual([]);
    expect(failed.warnings).toHaveLength(1);
    const recovered = await tools.execute("read_file", { path: "src/a.ts" });
    expect(recovered.evidence).toHaveLength(1);
    expect(await tools.execute("read_file", { path: "src/a.ts" })).toEqual(
      recovered,
    );
    expect(reads).toHaveLength(2);
  });

  it("honors cancellation and expired deadlines even when the requested read is cached", async () => {
    const { repository, reads } = readFixture();
    const tools = createRepositoryTools(repository, defaultConfig);
    await tools.execute("read_file", { path: "src/a.ts" });
    await expect(
      tools.execute(
        "read_file",
        { path: "src/a.ts" },
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toMatchObject({ code: "ABORTED" });
    await expect(
      tools.execute(
        "read_file",
        { path: "src/a.ts" },
        { deadline: Date.now() - 1 },
      ),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    await tools.execute("read_file", { path: "src/a.ts" });
    expect(reads).toHaveLength(1);
  });

  it("does not combine repeated partial pages into completed source coverage", async () => {
    const { repository, reads } = readFixture();
    const tools = createRepositoryTools(repository, defaultConfig);
    const first = await tools.execute("read_file", {
      path: "src/a.ts",
      endLine: 1,
    });
    const repeated = await tools.execute("read_file", {
      path: "src/a.ts",
      endLine: 1,
    });
    expect(first.inspectedPaths).toEqual([]);
    expect(repeated.inspectedPaths).toEqual([]);
    expect(reads).toHaveLength(1);
    const final = await tools.execute("read_file", {
      path: "src/a.ts",
      startLine: 2,
      endLine: 3,
    });
    expect(final.inspectedPaths).toEqual(["src/a.ts"]);
    expect(reads).toHaveLength(2);
  });

  it("does not expose a mutable cached result to later callers", async () => {
    const { repository, reads } = readFixture();
    const tools = createRepositoryTools(repository, defaultConfig);
    const first = await tools.execute("read_file", { path: "src/a.ts" });
    first.evidence.splice(0);
    first.inspectedPaths.splice(0);
    first.warnings.push("Caller-local mutation.");
    const second = await tools.execute("read_file", { path: "src/a.ts" });
    expect(reads).toHaveLength(1);
    expect(second.evidence).toHaveLength(1);
    expect(second.inspectedPaths).toEqual(["src/a.ts"]);
    expect(second.warnings).toEqual([]);
  });

  it("does not reuse search, diff, list, or history tool results", async () => {
    const { repository } = readFixture();
    let histories = 0;
    let diffs = 0;
    let lists = 0;
    repository.history = async () => {
      histories += 1;
      return "Pinned contribution history.";
    };
    repository.readDiff = async () => {
      diffs += 1;
      return {
        text: "@@ -1 +1 @@\n-first\n+second",
        truncated: false,
        totalLines: 3,
      };
    };
    repository.listFiles = async () => {
      lists += 1;
      return ["src/a.ts"];
    };
    const tools = createRepositoryTools(repository, defaultConfig);
    for (let index = 0; index < 2; index += 1) {
      await tools.execute("history", {});
      await tools.execute("read_diff", { path: "src/a.ts" });
      await tools.execute("list_files", {});
      await tools.execute("search", { query: "first" });
    }
    expect(histories).toBe(2);
    expect(diffs).toBe(2);
    expect(lists).toBe(4);
  });
});

function readFixture(
  fail?: (request: RecordedRead, previous: RecordedRead[]) => boolean,
) {
  const repository: RepositorySession = reviewTestInput().repository;
  repository.snapshot = structuredClone(repository.snapshot);
  const reads: RecordedRead[] = [];
  repository.readFile = async (
    path,
    revision,
    startLine = 1,
    endLine,
    options,
  ): Promise<FileRead> => {
    if (options?.signal?.aborted)
      throw new GusError("ABORTED", "The fixture read was cancelled.");
    if (options?.deadline !== undefined && options.deadline <= Date.now())
      throw new GusError(
        "BUDGET_EXCEEDED",
        "The fixture deadline was reached.",
      );
    const request = { path, revision, startLine, endLine };
    reads.push(request);
    if (fail?.(request, reads))
      throw new GusError(
        "FILE_NOT_FOUND",
        "The fixture source is temporarily unavailable.",
      );
    const snapshot = repository.snapshot;
    const sha =
      revision === "head"
        ? snapshot.headSha
        : revision === "integration"
          ? snapshot.integration.treeSha
          : revision === "parent"
            ? snapshot.comparisonBaseSha
            : snapshot.baseSha;
    if (sha === null) throw new Error("The fixture needs a pinned revision.");
    const lines = ["first", "second", "third"];
    const last = endLine ?? lines.length;
    return {
      path,
      revision,
      sha,
      startLine,
      endLine: last,
      text: lines.slice(startLine - 1, last).join("\n"),
      totalLines: lines.length,
      truncated: last < lines.length,
    };
  };
  return { repository, reads };
}
