import { z } from "zod";
import type { GusConfig } from "../config/config-schema.js";
import { GusError } from "../errors.js";
import type {
  FileRead,
  RepositoryCommandOptions,
  RepositorySession,
  RepositoryTools,
  ToolExecution,
} from "../review/review-ports.js";
import {
  createInspectionCoverage,
  type InspectionCoverage,
} from "./logic/inspection-coverage.js";
import { fitSourcePages } from "./logic/fit-source-pages.js";
import {
  diffEvidence,
  fileEvidence,
  identifyEvidence,
  toolResult,
} from "./repository-evidence.js";
import { sourceLines } from "./repository-reads.js";
import { searchRepository } from "./repository-search.js";
import {
  diffArguments,
  fileArguments,
  filesArguments,
  historyArguments,
  listArguments,
  repositoryToolDefinitions,
  searchArguments,
} from "./repository-tool-definitions.js";

/** Exposes only validated, bounded reads from a session's pinned snapshots. */
export function createRepositoryTools(
  repository: RepositorySession,
  config: GusConfig,
): RepositoryTools {
  const maxChars = config.review.maxToolOutputChars;
  const coverage = createInspectionCoverage();
  return {
    definitions: repositoryToolDefinitions,
    execute: async (name, argumentsValue, options) => {
      try {
        switch (name) {
          case "read_file":
            return await readFileTool(
              repository,
              fileArguments.parse(argumentsValue),
              maxChars,
              coverage,
              options,
            );
          case "read_files":
            return await readFilesTool(
              repository,
              filesArguments.parse(argumentsValue),
              maxChars,
              coverage,
              options,
            );
          case "list_files":
            return await listFilesTool(
              repository,
              listArguments.parse(argumentsValue),
              maxChars,
              options,
            );
          case "search":
            return {
              ...(await searchRepository(
                repository,
                searchArguments.parse(argumentsValue),
                maxChars,
                options,
              )),
              inspectedPaths: [],
            };
          case "read_diff":
            return await readDiffTool(
              repository,
              diffArguments.parse(argumentsValue),
              maxChars,
              coverage,
              options,
            );
          case "history":
            return await historyTool(
              repository,
              historyArguments.parse(argumentsValue),
              maxChars,
              options,
            );
          default:
            throw new GusError(
              "INPUT_INVALID",
              `Unknown repository tool ${name}.`,
            );
        }
      } catch (error) {
        if (
          error instanceof GusError &&
          (error.code === "ABORTED" ||
            (options?.deadline !== undefined && options.deadline <= Date.now()))
        )
          throw error;
        const message =
          error instanceof z.ZodError
            ? error.issues
                .map(
                  (issue) =>
                    `${issue.path.join(".") || "arguments"}: ${issue.message}`,
                )
                .join("; ")
            : error instanceof Error
              ? error.message
              : "Repository tool failed.";
        return toolResult(
          {
            error: error instanceof GusError ? error.code : "INPUT_INVALID",
            message,
          },
          [],
          [],
          [message],
          maxChars,
        );
      }
    },
  };
}

async function readFileTool(
  repository: RepositorySession,
  request: z.infer<typeof fileArguments>,
  maxChars: number,
  coverage: InspectionCoverage,
  options?: RepositoryCommandOptions,
): Promise<ToolExecution> {
  const file = await repository.readFile(
    request.path,
    request.revision,
    request.startLine,
    request.endLine,
    options,
  );
  const pages = fitSourcePages([file], (candidates) => {
    const candidate = candidates[0] ?? file;
    const { payload, evidence } = filePage(candidate);
    return (
      toolResult(payload, [evidence], [candidate.path], [], maxChars)
        .content === JSON.stringify(payload)
    );
  });
  const bounded = pages?.[0] ?? file;
  const { payload, evidence } = filePage(bounded);
  const result = toolResult(payload, [evidence], [bounded.path], [], maxChars);
  result.inspectedPaths = [];
  if (
    pages !== null &&
    result.content === JSON.stringify(payload) &&
    recordSourceCoverage(repository, bounded, coverage)
  )
    result.inspectedPaths.push(file.path);
  return result;
}

async function readFilesTool(
  repository: RepositorySession,
  request: z.infer<typeof filesArguments>,
  maxChars: number,
  coverage: InspectionCoverage,
  options?: RepositoryCommandOptions,
): Promise<ToolExecution> {
  const files: FileRead[] = [];
  const warnings: string[] = [];
  for (const range of request.files) {
    try {
      files.push(
        await repository.readFile(
          range.path,
          range.revision,
          range.startLine,
          range.endLine,
          options,
        ),
      );
    } catch (error) {
      if (
        !(error instanceof GusError) ||
        error.code === "ABORTED" ||
        (options?.deadline !== undefined && options.deadline <= Date.now())
      )
        throw error;
      warnings.push(`${range.path}: ${error.message}`);
    }
  }
  const reservedPaths = [...new Set(files.map((file) => file.path))];
  const pages = fitSourcePages(files, (candidates) => {
    const { payload, evidence } = filePages(candidates, warnings);
    return (
      toolResult(payload, evidence, reservedPaths, warnings, maxChars)
        .content === JSON.stringify(payload)
    );
  });
  const { payload, evidence } = filePages(pages ?? files, warnings);
  const execution = toolResult(
    payload,
    evidence,
    reservedPaths,
    warnings,
    maxChars,
  );
  execution.inspectedPaths = [];
  if (pages !== null && execution.content === JSON.stringify(payload)) {
    for (const file of pages) {
      if (
        recordSourceCoverage(repository, file, coverage) &&
        !execution.inspectedPaths.includes(file.path)
      )
        execution.inspectedPaths.push(file.path);
    }
  }
  return execution;
}

async function listFilesTool(
  repository: RepositorySession,
  request: z.infer<typeof listArguments>,
  maxChars: number,
  options?: RepositoryCommandOptions,
): Promise<ToolExecution> {
  const files = await repository.listFiles(
    request.pattern,
    request.revision,
    options,
  );
  let page = files.slice(request.offset, request.offset + request.limit);
  while (page.length > 0 && JSON.stringify(page).length > maxChars - 500)
    page = page.slice(0, -1);
  const nextOffset = request.offset + page.length;
  return toolResult(
    {
      paths: page,
      total: files.length,
      offset: request.offset,
      truncated: nextOffset < files.length,
      nextOffset: nextOffset < files.length ? nextOffset : null,
    },
    [],
    [],
    [],
    maxChars,
  );
}

async function readDiffTool(
  repository: RepositorySession,
  request: z.infer<typeof diffArguments>,
  maxChars: number,
  coverage: InspectionCoverage,
  options?: RepositoryCommandOptions,
): Promise<ToolExecution> {
  const diff = await repository.readDiff(
    request.path,
    1,
    Number.MAX_SAFE_INTEGER,
    options,
  );
  const file = repository.files.find(
    (changedFile) => changedFile.path === request.path,
  );
  if (file === undefined)
    throw new GusError(
      "FILE_NOT_FOUND",
      "This file is not in the contribution diff.",
    );
  const rows = sourceLines(diff.text);
  let selected = rows.slice(
    request.startLine - 1,
    request.startLine - 1 + request.lineCount,
  );
  while (
    selected.length > 0 &&
    JSON.stringify(selected.join("\n")).length > maxChars / 2
  )
    selected = selected.slice(0, -1);
  if (selected.length === 0 && request.startLine <= rows.length)
    throw new GusError(
      "BUDGET_EXCEEDED",
      "A patch row exceeds the tool output limit; no partial row was returned.",
    );
  const truncated = request.startLine - 1 + selected.length < rows.length;
  const evidence = diffEvidence(
    diff.text,
    file,
    repository.snapshot,
    request.startLine,
    selected.length,
    truncated,
  );
  const references = evidence.map(
    ({ id, path, revision, sha, startLine, endLine }) => ({
      id,
      path,
      revision,
      sha,
      startLine,
      endLine,
    }),
  );
  const payload = {
    path: file.path,
    patch: selected.join("\n"),
    patchStartLine: request.startLine,
    totalPatchLines: diff.totalLines,
    truncated,
    nextLine: truncated ? request.startLine + selected.length : null,
    evidence: references,
    explanation:
      "Patch rows are pagination coordinates. Cite source line ranges from the evidence records, with parent for LEFT and head for RIGHT.",
  };
  const result = toolResult(payload, evidence, [file.path], [], maxChars);
  result.inspectedPaths = [];
  if (
    result.content === JSON.stringify(payload) &&
    coverage.record({
      path: file.path,
      snapshot: `diff:${repository.snapshot.comparisonBaseSha}:${repository.snapshot.headSha}`,
      startLine: request.startLine,
      endLine: request.startLine + selected.length - 1,
      totalLines: diff.totalLines,
    })
  )
    result.inspectedPaths.push(file.path);
  return result;
}

function recordSourceCoverage(
  repository: RepositorySession,
  file: FileRead,
  coverage: InspectionCoverage,
): boolean {
  const changedFile = repository.files.find(
    (candidate) => candidate.path === file.path,
  );
  const currentSource =
    file.revision === "head" || file.revision === "integration";
  const deletedSource =
    file.revision === "parent" && changedFile?.status === "deleted";
  if (!currentSource && !deletedSource) return false;
  return coverage.record({
    path: file.path,
    snapshot: `source:${file.revision}:${file.sha}`,
    startLine: file.startLine,
    endLine: file.endLine,
    totalLines: file.totalLines,
  });
}

async function historyTool(
  repository: RepositorySession,
  request: z.infer<typeof historyArguments>,
  maxChars: number,
  options?: RepositoryCommandOptions,
): Promise<ToolExecution> {
  const text = await repository.history(request.path, options);
  const evidence = identifyEvidence({
    path: request.path ?? "",
    revision: "head",
    sha: repository.snapshot.headSha,
    startLine: 0,
    endLine: 0,
    text,
    kind: "history",
    truncated: true,
  });
  return toolResult(
    { text, evidenceId: evidence.id, maxCommits: 30, truncated: true },
    [evidence],
    [],
    [],
    maxChars,
  );
}

function filePage(file: FileRead) {
  const evidence = fileEvidence(file);
  return {
    payload: {
      ...file,
      evidenceId: evidence.id,
      nextLine: file.truncated ? file.endLine + 1 : null,
    },
    evidence,
  };
}

function filePages(files: FileRead[], warnings: string[]) {
  const pages = files.map((file) => ({ file, ...filePage(file) }));
  return {
    payload: {
      results: pages.map(({ file, evidence, payload }) => ({
        file,
        evidenceId: evidence.id,
        nextLine: payload.nextLine,
      })),
      warnings,
    },
    evidence: pages.map((page) => page.evidence),
  };
}
