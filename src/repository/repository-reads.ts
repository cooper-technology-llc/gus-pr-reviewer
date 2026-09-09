import type { GusConfig } from "../config/config-schema.js";
import { GusError } from "../errors.js";
import type {
  FileRead,
  RepositoryCommandOptions,
} from "../review/review-ports.js";
import type { ReviewSnapshot, Revision } from "../review/review-schema.js";
import type { GitStore } from "./git-command.js";
import {
  assertReadablePath,
  decodeGitText,
  isObjectId,
  isReadablePath,
  matchesPattern,
} from "./repository-paths.js";

export interface TreeEntry {
  path: string;
  sha: string;
  mode: string;
  type: string;
}

export interface RepositoryReader {
  readFile(
    path: string,
    revision: Revision,
    startLine?: number,
    endLine?: number,
    options?: RepositoryCommandOptions,
  ): Promise<FileRead>;
  listFiles(
    pattern?: string,
    revision?: Revision,
    options?: RepositoryCommandOptions,
  ): Promise<string[]>;
  entry(
    path: string,
    revision: Revision,
    options?: RepositoryCommandOptions,
  ): Promise<TreeEntry | undefined>;
}

/** Reads immutable blobs; symlinks, submodules, binary data, and oversized files are never followed or silently clipped. */
export function createRepositoryReader(
  store: GitStore,
  snapshot: ReviewSnapshot,
  config: GusConfig,
): RepositoryReader {
  const trees = new Map<Revision, Map<string, TreeEntry>>();
  const tree = async (
    revision: Revision,
    options?: RepositoryCommandOptions,
  ) => {
    const cached = trees.get(revision);
    if (cached !== undefined) return cached;
    const entries = await readTree(
      store,
      revisionSha(snapshot, revision),
      options,
    );
    trees.set(revision, entries);
    return entries;
  };
  return {
    entry: async (path, revision, options) =>
      (await tree(revision, options)).get(path),
    listFiles: async (pattern = "**", revision = "head", options) => {
      return [...(await tree(revision, options)).values()]
        .filter(
          (entry) =>
            isRegularBlob(entry) &&
            isReadablePath(entry.path) &&
            !isExcluded(entry.path, config) &&
            matchesPattern(entry.path, pattern),
        )
        .map((entry) => entry.path)
        .sort();
    },
    readFile: async (path, revision, startLine = 1, endLine, options) => {
      assertReadablePath(path);
      if (isExcluded(path, config))
        throw new GusError(
          "PATH_DENIED",
          `The path ${path} is excluded by the review configuration.`,
        );
      const entry = (await tree(revision, options)).get(path);
      if (entry === undefined)
        throw new GusError(
          "FILE_NOT_FOUND",
          `${path} does not exist at the pinned ${revision} snapshot.`,
        );
      if (!isRegularBlob(entry))
        throw new GusError(
          "PATH_DENIED",
          `The path ${path} is a symbolic link or submodule; its target cannot be read.`,
        );
      const text = await readTextBlob(
        store,
        entry,
        config.review.maxFileBytes,
        options,
      );
      const lines = sourceLines(text);
      const range = selectSourceLines(
        lines,
        startLine,
        endLine,
        config.review.maxToolOutputChars,
      );
      return {
        path,
        revision,
        sha: revisionSha(snapshot, revision),
        ...range,
        totalLines: lines.length,
      };
    },
  };
}

export function revisionSha(
  snapshot: ReviewSnapshot,
  revision: Revision,
): string {
  switch (revision) {
    case "head":
      return snapshot.headSha;
    case "base":
      return snapshot.baseSha;
    case "parent":
      return snapshot.comparisonBaseSha;
    case "integration": {
      if (snapshot.integration.treeSha === null)
        throw new GusError(
          "SNAPSHOT_UNAVAILABLE",
          "No integration tree is available.",
        );
      return snapshot.integration.treeSha;
    }
  }
}

export function isRegularBlob(entry: TreeEntry): boolean {
  return (
    entry.type === "blob" &&
    (entry.mode === "100644" || entry.mode === "100755")
  );
}

export function isExcluded(path: string, config: GusConfig): boolean {
  return config.review.exclude.some((pattern) => matchesPattern(path, pattern));
}

export function sourceLines(text: string): string[] {
  if (text.length === 0) return [];
  return (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
}

async function readTree(
  store: GitStore,
  sha: string,
  options?: RepositoryCommandOptions,
): Promise<Map<string, TreeEntry>> {
  const output = await store.command(
    ["ls-tree", "-r", "-z", "--full-tree", sha],
    { ...options, maxBytes: 16 * 1024 * 1024 },
  );
  const entries = new Map<string, TreeEntry>();
  for (const record of decodeGitText(output.stdout).split("\0")) {
    if (record.length === 0) continue;
    const separator = record.indexOf("\t");
    const [mode, type, objectSha] = record.slice(0, separator).split(" ");
    const path = record.slice(separator + 1);
    if (
      separator < 0 ||
      mode === undefined ||
      type === undefined ||
      objectSha === undefined ||
      !isObjectId(objectSha)
    ) {
      throw new GusError("GIT_FAILED", "Git returned malformed tree metadata.");
    }
    entries.set(path, { path, sha: objectSha, mode, type });
  }
  return entries;
}

async function readTextBlob(
  store: GitStore,
  entry: TreeEntry,
  maxBytes: number,
  options?: RepositoryCommandOptions,
): Promise<string> {
  const sizeOutput = await store.command(["cat-file", "-s", entry.sha], {
    ...options,
    maxBytes: 4096,
  });
  const size = Number(sizeOutput.stdout.toString("utf8").trim());
  if (!Number.isSafeInteger(size) || size < 0)
    throw new GusError("GIT_FAILED", "Git returned an invalid blob size.");
  if (size > maxBytes)
    throw new GusError(
      "BUDGET_EXCEEDED",
      `${entry.path} is ${size} bytes, above the configured ${maxBytes}-byte file limit. No partial file was read.`,
    );
  const output = await store.command(["cat-file", "blob", entry.sha], {
    ...options,
    maxBytes: maxBytes + 4096,
  });
  if (output.stdout.includes(0))
    throw new GusError("PATH_DENIED", `${entry.path} contains binary data.`);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      output.stdout,
    );
  } catch {
    throw new GusError(
      "PATH_DENIED",
      `${entry.path} is not UTF-8 source text.`,
    );
  }
}

function selectSourceLines(
  lines: string[],
  startLine: number,
  requestedEnd: number | undefined,
  maxChars: number,
): Omit<FileRead, "path" | "revision" | "sha" | "totalLines"> {
  if (
    !Number.isInteger(startLine) ||
    startLine < 1 ||
    (requestedEnd !== undefined &&
      (!Number.isInteger(requestedEnd) || requestedEnd < startLine))
  ) {
    throw new GusError(
      "INPUT_INVALID",
      "File ranges use positive, inclusive line numbers.",
    );
  }
  if (lines.length === 0)
    return { startLine: 0, endLine: 0, text: "", truncated: false };
  if (startLine > lines.length)
    throw new GusError(
      "INPUT_INVALID",
      `The requested start line is past the file's ${lines.length} lines.`,
    );
  const maximumEnd = Math.min(requestedEnd ?? startLine + 299, lines.length);
  const selected: string[] = [];
  let charCount = 0;
  for (const line of lines.slice(startLine - 1, maximumEnd)) {
    if (charCount + line.length + 1 > maxChars) break;
    selected.push(line);
    charCount += line.length + 1;
  }
  if (selected.length === 0)
    throw new GusError(
      "BUDGET_EXCEEDED",
      "The requested source line exceeds the tool output limit; no partial source line was returned.",
    );
  const endLine = startLine + selected.length - 1;
  return {
    startLine,
    endLine,
    text: selected.join("\n"),
    truncated: endLine < lines.length,
  };
}
