import { GusError } from "../../errors.js";
import type {
  RepositoryCommandOptions,
  ToolExecution,
} from "../../review/review-ports.js";
import type { ReviewSnapshot, Revision } from "../../review/review-schema.js";

interface SourceRange {
  path: string;
  revision: Revision;
  startLine: number;
  endLine?: number | undefined;
}

type ReadTool = "read_file" | "read_files";

interface PinnedReadCache {
  run(
    tool: ReadTool,
    ranges: SourceRange[],
    read: () => Promise<ToolExecution>,
    options?: RepositoryCommandOptions,
  ): Promise<ToolExecution>;
}

/** Reuses only successful exact read operations tied to immutable revisions, with fresh admission checks on every call. */
export function createPinnedReadCache(dependencies: {
  snapshot: () => ReviewSnapshot;
  now: () => number;
}): PinnedReadCache {
  const results = new Map<string, ToolExecution>();
  return {
    async run(tool, ranges, read, options) {
      requireActiveRead(options, dependencies.now());
      const snapshot = dependencies.snapshot();
      const key = readKey(tool, ranges, snapshot);
      const previous = results.get(key);
      if (previous !== undefined) return copyExecution(previous);
      const result = await read();
      requireActiveRead(options, dependencies.now());
      if (successfulRead(result, ranges, snapshot))
        results.set(key, copyExecution(result));
      return result;
    },
  };
}

function readKey(
  tool: ReadTool,
  ranges: SourceRange[],
  snapshot: ReviewSnapshot,
): string {
  return JSON.stringify([
    tool,
    ranges.map((range) => [
      range.path,
      range.revision,
      revisionSha(snapshot, range.revision),
      range.startLine,
      range.endLine ?? null,
    ]),
  ]);
}

function successfulRead(
  result: ToolExecution,
  ranges: SourceRange[],
  snapshot: ReviewSnapshot,
): boolean {
  return (
    result.warnings.length === 0 &&
    result.evidence.length === ranges.length &&
    result.evidence.every((evidence, index) => {
      const range = ranges[index];
      return (
        range !== undefined &&
        evidence.kind === "file" &&
        evidence.path === range.path &&
        evidence.revision === range.revision &&
        evidence.sha === revisionSha(snapshot, range.revision)
      );
    })
  );
}

function revisionSha(
  snapshot: ReviewSnapshot,
  revision: Revision,
): string | null {
  switch (revision) {
    case "head":
      return snapshot.headSha;
    case "base":
      return snapshot.baseSha;
    case "parent":
      return snapshot.comparisonBaseSha;
    case "integration":
      return snapshot.integration.treeSha;
  }
}

function copyExecution(execution: ToolExecution): ToolExecution {
  return {
    content: execution.content,
    evidence: execution.evidence.map((entry) => ({ ...entry })),
    inspectedPaths: [...execution.inspectedPaths],
    warnings: [...execution.warnings],
  };
}

function requireActiveRead(
  options: RepositoryCommandOptions | undefined,
  now: number,
): void {
  if (options?.signal?.aborted)
    throw new GusError("ABORTED", "The repository read was cancelled.");
  if (options?.deadline !== undefined && now >= options.deadline)
    throw new GusError(
      "BUDGET_EXCEEDED",
      "The repository read deadline was reached.",
    );
}
