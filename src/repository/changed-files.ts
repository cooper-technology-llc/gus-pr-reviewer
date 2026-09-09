import type { GusConfig } from "../config/config-schema.js";
import { GusError } from "../errors.js";
import type { RepositoryCommandOptions } from "../review/review-ports.js";
import type { ChangedFile, ReviewSnapshot } from "../review/review-schema.js";
import type { GitStore } from "./git-command.js";
import {
  assertReadablePath,
  decodeGitText,
  isReadablePath,
} from "./repository-paths.js";
import {
  isExcluded,
  isRegularBlob,
  type RepositoryReader,
} from "./repository-reads.js";

const diffOptions = [
  "--no-ext-diff",
  "--no-textconv",
  "--ignore-submodules=none",
  "--find-renames",
  "--find-copies",
];

/** Keeps full change metadata even when a file's source cannot fit the review budget. */
export async function readChangedFiles(
  store: GitStore,
  snapshot: ReviewSnapshot,
  reader: RepositoryReader,
  config: GusConfig,
): Promise<{ files: ChangedFile[]; omissions: string[] }> {
  const range = [snapshot.comparisonBaseSha, snapshot.headSha];
  const namesOutput = await store.command(
    ["diff", ...diffOptions, "--name-status", "-z", ...range, "--"],
    { maxBytes: 16 * 1024 * 1024 },
  );
  const statsOutput = await store.command(
    ["diff", ...diffOptions, "--numstat", "-z", ...range, "--"],
    { maxBytes: 16 * 1024 * 1024 },
  );
  const changes = parseNames(decodeGitText(namesOutput.stdout));
  const statistics = parseStatistics(decodeGitText(statsOutput.stdout));
  const files: ChangedFile[] = [];
  const omissions: string[] = [];
  for (const [index, change] of changes.entries()) {
    const stats = statistics.get(change.path);
    if (stats === undefined)
      throw new GusError(
        "GIT_FAILED",
        "Git change metadata and statistics disagree.",
      );
    const file: ChangedFile = {
      ...change,
      ...stats,
      patch: "",
      excluded: false,
      truncated: false,
    };
    const paths =
      change.previousPath === null
        ? [change.path]
        : [change.path, change.previousPath];
    file.excluded = paths.some(
      (path) => !isReadablePath(path) || isExcluded(path, config),
    );
    const headEntry = await reader.entry(change.path, "head");
    const oldEntry = await reader.entry(
      change.previousPath ?? change.path,
      "parent",
    );
    if (
      (headEntry !== undefined && !isRegularBlob(headEntry)) ||
      (oldEntry !== undefined && !isRegularBlob(oldEntry))
    )
      file.excluded = true;
    if (file.excluded || file.binary) {
      omissions.push(
        `${file.path}: ${file.excluded ? "excluded path, secret material, symbolic link, or submodule" : "binary content"}; metadata only.`,
      );
    } else if (index >= config.review.maxFiles) {
      file.truncated = true;
      omissions.push(
        `${file.path}: source omitted because the changed-file budget is ${config.review.maxFiles}.`,
      );
    } else {
      try {
        const patch = await readFullDiff(store, snapshot, file, config);
        file.patch = trimPatch(patch, config.review.maxDiffCharsPerFile);
        file.truncated = file.patch.length < patch.length;
        if (file.truncated)
          omissions.push(
            `${file.path}: initial patch is incomplete; use read_diff pagination to inspect the remainder.`,
          );
      } catch (error) {
        if (error instanceof GusError && error.code === "PATH_DENIED") {
          file.binary = true;
          omissions.push(`${file.path}: non-UTF-8 content; metadata only.`);
          files.push(file);
          continue;
        }
        if (!(error instanceof GusError) || error.code !== "BUDGET_EXCEEDED")
          throw error;
        file.truncated = true;
        omissions.push(
          `${file.path}: full patch exceeded the bounded Git output limit; no partial patch was returned.`,
        );
      }
    }
    files.push(file);
  }
  return { files, omissions };
}

export async function readFullDiff(
  store: GitStore,
  snapshot: ReviewSnapshot,
  file: ChangedFile,
  config: GusConfig,
  options?: RepositoryCommandOptions,
): Promise<string> {
  assertReadablePath(file.path);
  if (file.previousPath !== null) assertReadablePath(file.previousPath);
  if (file.excluded || file.binary)
    throw new GusError(
      "PATH_DENIED",
      "Source diffs are unavailable for excluded, symbolic, submodule, or binary files.",
    );
  const paths =
    file.previousPath === null ? [file.path] : [file.previousPath, file.path];
  const output = await store.command(
    [
      "diff",
      ...diffOptions,
      "--unified=3",
      snapshot.comparisonBaseSha,
      snapshot.headSha,
      "--",
      ...paths,
    ],
    { ...options, maxBytes: Math.max(config.review.maxFileBytes * 4, 64000) },
  );
  return decodeGitText(output.stdout);
}

function trimPatch(patch: string, maxChars: number): string {
  if (patch.length <= maxChars) return patch;
  const lastNewline = patch.lastIndexOf("\n", maxChars);
  return lastNewline < 0 ? "" : patch.slice(0, lastNewline + 1);
}

function parseNames(
  value: string,
): Array<Pick<ChangedFile, "path" | "previousPath" | "status">> {
  const fields = value.split("\0");
  const changes: Array<Pick<ChangedFile, "path" | "previousPath" | "status">> =
    [];
  let index = 0;
  while (index < fields.length) {
    const statusText = fields[index++];
    if (statusText === "") break;
    const firstPath = fields[index++];
    if (
      statusText === undefined ||
      firstPath === undefined ||
      firstPath.length === 0
    )
      throw new GusError("GIT_FAILED", "Malformed Git path metadata.");
    const status = changeStatus(statusText);
    if (status === "renamed" || status === "copied") {
      const path = fields[index++];
      if (path === undefined || path.length === 0)
        throw new GusError(
          "GIT_FAILED",
          "A renamed file has no destination path.",
        );
      changes.push({ path, previousPath: firstPath, status });
    } else changes.push({ path: firstPath, previousPath: null, status });
  }
  return changes;
}

function changeStatus(value: string): ChangedFile["status"] {
  switch (value[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "M":
      return "modified";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    default:
      throw new GusError(
        "GIT_FAILED",
        `Unsupported Git change status ${value}.`,
      );
  }
}

function parseStatistics(
  value: string,
): Map<string, Pick<ChangedFile, "additions" | "deletions" | "binary">> {
  const records = value.split("\0");
  const stats = new Map<
    string,
    Pick<ChangedFile, "additions" | "deletions" | "binary">
  >();
  let index = 0;
  while (index < records.length) {
    const record = records[index++];
    if (record === "") break;
    if (record === undefined)
      throw new GusError("GIT_FAILED", "Malformed Git line statistics.");
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0)
      throw new GusError("GIT_FAILED", "Malformed Git line statistics.");
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    let path = record.slice(secondTab + 1);
    if (path.length === 0) {
      index += 1;
      path = records[index++] ?? "";
    }
    const binary = added === "-" && deleted === "-";
    const additions = binary ? 0 : Number(added);
    const deletions = binary ? 0 : Number(deleted);
    if (
      path.length === 0 ||
      !Number.isSafeInteger(additions) ||
      additions < 0 ||
      !Number.isSafeInteger(deletions) ||
      deletions < 0
    ) {
      throw new GusError("GIT_FAILED", "Git returned invalid line counts.");
    }
    stats.set(path, { additions, deletions, binary });
  }
  return stats;
}
