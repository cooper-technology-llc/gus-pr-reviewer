import type { z } from "zod";
import { GusError } from "../errors.js";
import type {
  RepositoryCommandOptions,
  RepositorySession,
  ToolExecution,
} from "../review/review-ports.js";
import type { ReviewEvidence } from "../review/review-schema.js";
import { identifyEvidence, toolResult } from "./repository-evidence.js";
import type { searchArguments } from "./repository-tool-definitions.js";

interface SearchMatch {
  path: string;
  line: number;
  text: string;
  evidenceId: string;
}

/** Returns a resumable literal search; skipped or unscanned source is always disclosed. */
export async function searchRepository(
  repository: RepositorySession,
  request: z.infer<typeof searchArguments>,
  maxChars: number,
  options?: RepositoryCommandOptions,
): Promise<ToolExecution> {
  const files = await repository.listFiles(
    request.pattern,
    request.revision,
    options,
  );
  const evidence: ReviewEvidence[] = [];
  const matches: SearchMatch[] = [];
  const inspectedPaths: string[] = [];
  const warnings: string[] = [];
  const needle = request.caseSensitive
    ? request.query
    : request.query.toLowerCase();
  let fileIndex = request.fileIndex;
  let nextLine = request.startLine;
  let filesRead = 0;
  let contentSize = 1000;
  let stop = false;
  while (fileIndex < files.length && filesRead < request.maxFiles && !stop) {
    const path = files[fileIndex];
    if (path === undefined) break;
    try {
      const file = await repository.readFile(
        path,
        request.revision,
        nextLine,
        nextLine + 299,
        options,
      );
      filesRead += 1;
      inspectedPaths.push(path);
      const lines = file.text.length === 0 ? [] : file.text.split("\n");
      for (const [offset, text] of lines.entries()) {
        const line = file.startLine + offset;
        nextLine = line + 1;
        if (
          !(request.caseSensitive ? text : text.toLowerCase()).includes(needle)
        )
          continue;
        const record = identifyEvidence({
          path,
          revision: file.revision,
          sha: file.sha,
          startLine: line,
          endLine: line,
          text,
          kind: "search",
          truncated: false,
        });
        const match: SearchMatch = { path, line, text, evidenceId: record.id };
        const matchSize = JSON.stringify(match).length + 1;
        if (contentSize + matchSize > maxChars) {
          nextLine = line;
          stop = true;
          warnings.push(
            "Search output reached the configured limit. Continue with the returned cursor; use read_file if one matching line cannot fit.",
          );
          break;
        }
        matches.push(match);
        evidence.push(record);
        contentSize += matchSize;
        if (matches.length >= request.maxMatches) {
          stop = true;
          break;
        }
      }
      if (nextLine > file.totalLines || file.totalLines === 0) {
        fileIndex += 1;
        nextLine = 1;
      } else stop = true;
    } catch (error) {
      if (
        !(error instanceof GusError) ||
        error.code === "ABORTED" ||
        (options?.deadline !== undefined && options.deadline <= Date.now())
      )
        throw error;
      warnings.push(`${path}: ${error.message}`);
      fileIndex += 1;
      nextLine = 1;
      filesRead += 1;
    }
  }
  const truncated = fileIndex < files.length;
  return toolResult(
    {
      query: request.query,
      revision: request.revision,
      matches,
      filesMatchedPattern: files.length,
      filesRead,
      truncated,
      nextCursor: truncated ? { fileIndex, startLine: nextLine } : null,
      explanation:
        truncated || warnings.length > 0
          ? "This was a partial search; no match is not proof of absence."
          : "All readable files matching this pattern were searched from the requested cursor.",
      warnings,
    },
    evidence,
    inspectedPaths,
    warnings,
    maxChars,
  );
}
