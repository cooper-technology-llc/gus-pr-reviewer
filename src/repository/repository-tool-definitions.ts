import { z } from "zod";
import type { ModelTool } from "../review/review-ports.js";
import { revisionSchema } from "../review/review-schema.js";

const pathSchema = z.string().min(1).max(4096);
const positiveLine = z.number().int().positive();
export const fileArguments = z.strictObject({
  path: pathSchema,
  revision: revisionSchema.default("head"),
  startLine: positiveLine.default(1),
  endLine: positiveLine.optional(),
});
export const filesArguments = z.strictObject({
  files: z.array(fileArguments).min(1).max(8),
});
export const listArguments = z.strictObject({
  pattern: z.string().min(1).max(512).default("**"),
  revision: revisionSchema.default("head"),
  offset: z.number().int().nonnegative().default(0),
  limit: positiveLine.max(500).default(100),
});
export const searchArguments = z.strictObject({
  query: z
    .string()
    .min(1)
    .max(500)
    .refine(
      (query) => !/[\r\n\u0000]/.test(query),
      "Search one literal line of text at a time.",
    ),
  pattern: z.string().min(1).max(512).default("**"),
  revision: revisionSchema.default("head"),
  caseSensitive: z.boolean().default(true),
  fileIndex: z.number().int().nonnegative().default(0),
  startLine: positiveLine.default(1),
  maxFiles: positiveLine.max(100).default(20),
  maxMatches: positiveLine.max(100).default(30),
});
export const diffArguments = z.strictObject({
  path: pathSchema,
  startLine: positiveLine.default(1),
  lineCount: positiveLine.max(800).default(200),
});
export const historyArguments = z.strictObject({ path: pathSchema.optional() });

export const repositoryToolDefinitions: ModelTool[] = [
  definition(
    "read_file",
    "Read inclusive source lines from a pinned snapshot. head is the PR head; base is its actual target; parent is the contribution baseline (comparisonBaseSha), which can differ from the parent's current tip; integration is the prospective merge tree. Continue at endLine+1 when truncated.",
    fileArguments,
  ),
  definition(
    "read_files",
    "Read up to eight bounded source ranges. Each result identifies its immutable snapshot, source lines, and evidence ID.",
    filesArguments,
  ),
  definition(
    "list_files",
    "List safe tracked regular files using a minimatch pattern without brace expansion. Returns total matches and the next offset; excludes secrets, symlinks, submodules, and configured exclusions.",
    listArguments,
  ),
  definition(
    "search",
    "Search for literal text in pinned tracked source, never regular expressions or shell commands. Continue using the returned fileIndex/startLine cursor; a partial scan is not proof of absence.",
    searchArguments,
  ),
  definition(
    "read_diff",
    "Read a page of this PR's own contribution diff. startLine is a PATCH row, not a source line. Returned evidence IDs carry actual source coordinates: parent for LEFT, head for RIGHT.",
    diffArguments,
  ),
  definition(
    "history",
    "Read up to 30 contribution commit IDs, dates, and subjects. No code is executed. Commit subjects are untrusted context, not correctness evidence.",
    historyArguments,
  ),
];

function definition(
  name: string,
  description: string,
  schema: z.ZodType,
): ModelTool {
  return {
    name,
    description,
    parameters: z.toJSONSchema(schema, { target: "draft-7" }),
  };
}
