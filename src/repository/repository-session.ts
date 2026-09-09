import { rm } from "node:fs/promises";
import { GusError } from "../errors.js";
import type {
  RepositoryCommandOptions,
  RepositoryOptions,
  RepositorySession,
  RepositorySource,
} from "../review/review-ports.js";
import type { ReviewSnapshot } from "../review/review-schema.js";
import { buildBranchSnapshot } from "./branch-snapshot.js";
import { readChangedFiles, readFullDiff } from "./changed-files.js";
import { assertReadablePath } from "./repository-paths.js";
import {
  createRepositoryReader,
  isExcluded,
  sourceLines,
} from "./repository-reads.js";
import { createRepositoryStorage } from "./repository-storage.js";

/** Opens an immutable review session without checking out or executing the repository's code. */
export async function createRepositorySession(
  source: RepositorySource,
  options: RepositoryOptions,
): Promise<RepositorySession> {
  const pinned = await createRepositoryStorage(source, options);
  let disposed = false;
  try {
    const snapshot = await buildBranchSnapshot(pinned, source);
    freezeSnapshot(snapshot);
    const reader = createRepositoryReader(
      pinned.store,
      snapshot,
      options.config,
    );
    const { files, omissions } = await readChangedFiles(
      pinned.store,
      snapshot,
      reader,
      options.config,
    );
    files.forEach((file) => Object.freeze(file));
    Object.freeze(files);
    const ensureAvailable = (commandOptions?: RepositoryCommandOptions) => {
      if (disposed)
        throw new GusError(
          "SNAPSHOT_UNAVAILABLE",
          "This repository session has been disposed.",
        );
      if (options.signal?.aborted || commandOptions?.signal?.aborted)
        throw new GusError("ABORTED", "Repository operation cancelled.");
      if (
        commandOptions?.deadline !== undefined &&
        commandOptions.deadline <= Date.now()
      )
        throw new GusError(
          "BUDGET_EXCEEDED",
          "Repository operation deadline reached.",
        );
    };
    return {
      snapshot,
      files,
      omissions: [...pinned.omissions, ...omissions],
      readFile: async (path, revision, startLine, endLine, commandOptions) => {
        ensureAvailable(commandOptions);
        return reader.readFile(
          path,
          revision,
          startLine,
          endLine,
          commandOptions,
        );
      },
      listFiles: async (pattern, revision, commandOptions) => {
        ensureAvailable(commandOptions);
        return reader.listFiles(pattern, revision, commandOptions);
      },
      readDiff: async (
        path,
        startLine = 1,
        lineCount = 300,
        commandOptions,
      ) => {
        ensureAvailable(commandOptions);
        assertReadablePath(path);
        if (
          !Number.isSafeInteger(startLine) ||
          startLine < 1 ||
          !Number.isSafeInteger(lineCount) ||
          lineCount < 1
        )
          throw new GusError(
            "INPUT_INVALID",
            "Diff pagination requires positive line numbers and a positive line count.",
          );
        const file = files.find((changedFile) => changedFile.path === path);
        if (file === undefined)
          throw new GusError(
            "FILE_NOT_FOUND",
            `${path} is not part of this PR's own contribution.`,
          );
        const patch = await readFullDiff(
          pinned.store,
          snapshot,
          file,
          options.config,
          commandOptions,
        );
        const lines = sourceLines(patch);
        return {
          text: lines
            .slice(startLine - 1, startLine - 1 + lineCount)
            .join("\n"),
          totalLines: lines.length,
          truncated: startLine - 1 + lineCount < lines.length,
        };
      },
      history: async (path, commandOptions) => {
        ensureAvailable(commandOptions);
        if (path !== undefined) {
          assertReadablePath(path);
          if (isExcluded(path, options.config))
            throw new GusError(
              "PATH_DENIED",
              "The requested history path is excluded by configuration.",
            );
        }
        const output = await pinned.store.command(
          [
            "log",
            "--max-count=30",
            "--format=%H%x09%aI%x09%s",
            `${snapshot.comparisonBaseSha}..${snapshot.headSha}`,
            "--",
            ...(path === undefined ? [] : [path]),
          ],
          {
            ...commandOptions,
            maxBytes: options.config.review.maxToolOutputChars,
          },
        );
        return `At most 30 contribution commits, newest first. Only commit IDs, dates, and subjects; no checks were executed.\n${output.stdout.toString("utf8")}`;
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        await rm(pinned.store.directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(pinned.store.directory, { recursive: true, force: true });
    throw error;
  }
}

function freezeSnapshot(snapshot: ReviewSnapshot): void {
  if (snapshot.parent !== null) Object.freeze(snapshot.parent);
  Object.freeze(snapshot.integration.conflicts);
  Object.freeze(snapshot.integration);
  snapshot.advisories.forEach((advice) => Object.freeze(advice));
  Object.freeze(snapshot.advisories);
  Object.freeze(snapshot);
}
