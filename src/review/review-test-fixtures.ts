import { configSchema } from "../config/config-schema.js";
import type {
  ModelCompletion,
  ModelRequest,
  ReviewInput,
  ToolExecution,
} from "./review-ports.js";
import {
  snapshotSchema,
  type ChangedFile,
  type ReviewEvidence,
  type ReviewFinding,
} from "./review-schema.js";
import type { Analysis } from "./stage-schemas.js";
import { seedDiffEvidence } from "./logic/review-evidence.js";

export const testSnapshot = snapshotSchema.parse({
  baseSha: "base-1",
  headSha: "head-1",
  mergeBaseSha: "base-1",
  comparisonBaseSha: "base-1",
  baseRef: "main",
  headRef: "feature",
  defaultBranch: "main",
  defaultSha: "base-1",
  parent: null,
  integration: {
    status: "clean",
    treeSha: "merge-1",
    targetSha: "base-1",
    conflicts: [],
    explanation: "Merged in an isolated snapshot.",
  },
  historyRewritten: false,
  baseChanged: false,
  advisories: [],
});
export const testFile: ChangedFile = {
  path: "src/a.ts",
  previousPath: null,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
  binary: false,
  excluded: false,
  truncated: false,
};
export const testEvidence = seedDiffEvidence([testFile], testSnapshot);

export function headEvidence(): ReviewEvidence {
  const entry = testEvidence.find((evidence) => evidence.revision === "head");
  if (!entry) throw new Error("The fixture requires head evidence.");
  return entry;
}

export function parentEvidence(): ReviewEvidence {
  const entry = testEvidence.find((evidence) => evidence.revision === "parent");
  if (!entry) throw new Error("The fixture requires comparison evidence.");
  return entry;
}

export function testFinding(
  overrides: Partial<ReviewFinding> = {},
): ReviewFinding {
  return {
    id: "candidate-1",
    title: "Value change breaks the one-unit contract",
    severity: "major",
    path: testFile.path,
    line: 1,
    side: "RIGHT",
    trigger: "A caller expects the documented one-unit value.",
    impact: "The caller receives two units.",
    suggestion: "Preserve the documented value or update all callers.",
    evidenceIds: [headEvidence().id],
    disposition: "blocking",
    ...overrides,
  };
}

export function testAnalysis(findings: ReviewFinding[] = []): Analysis {
  return {
    summary: "The change updates the exported value.",
    risk: "low",
    findings,
    reconciliations: [],
    questions: [],
    architecture: {
      grade: "A",
      reason: "The change stays within its existing module.",
    },
    tests: {
      grade: "B",
      reason:
        "The assessment is static; the exported value is explicit in the patch.",
    },
    coverage: [
      {
        path: testFile.path,
        status: "inspected",
        evidenceIds: [headEvidence().id],
        reason: "The complete changed line was inspected.",
      },
    ],
  };
}

export function jsonCompletion(value: unknown): ModelCompletion {
  return {
    content: JSON.stringify(value),
    toolCalls: [],
    finishReason: "stop",
    inputTokens: 11,
    outputTokens: 7,
    costUsd: 0.01,
    model: "test-model",
  };
}

export function toolCompletion(
  id: string,
  name: string,
  path: string,
): ModelCompletion {
  return {
    ...jsonCompletion(null),
    content: "",
    toolCalls: [{ id, name, arguments: { path } }],
    finishReason: "tool_calls",
  };
}

export function answerStage(
  request: ModelRequest,
  analysis = testAnalysis(),
): ModelCompletion {
  switch (request.stage) {
    case "triage":
      return jsonCompletion({
        summary: analysis.summary,
        risk: "low",
        questions: [],
      });
    case "investigate":
      return jsonCompletion(analysis);
    case "validate":
      return jsonCompletion({
        ...analysis,
        candidateResolutions: analysis.findings.map((finding) => ({
          id: finding.id,
          status: "confirmed",
          reason: "The current patch confirms the candidate.",
          evidenceIds: finding.evidenceIds,
        })),
      });
    case "report":
      return jsonCompletion({
        summary:
          "The patch changes the exported value and its caller contract.",
      });
    case "personality":
      return jsonCompletion({
        text: "That exported value is carrying a surprisingly large amount of responsibility.",
      });
  }
}

export function fileExecution(
  id: string,
  path: string,
  text: string,
): ToolExecution {
  return {
    content: `Read ${path}.`,
    inspectedPaths: [path],
    warnings: [],
    evidence: [
      {
        id,
        path,
        revision: "head",
        sha: testSnapshot.headSha,
        startLine: 1,
        endLine: 1,
        text,
        kind: "file",
        truncated: false,
      },
    ],
  };
}

export function reviewTestInput(
  overrides: Partial<ReviewInput> = {},
): ReviewInput {
  return {
    subject: {
      repository: "owner/example",
      number: 7,
      title: "Change value",
      body: "",
      author: "developer",
      url: "https://example.test/pr/7",
    },
    repository: {
      snapshot: testSnapshot,
      files: [testFile],
      omissions: [],
      readFile: async () => {
        throw new Error("Tests use the repository tools port.");
      },
      listFiles: async () => [testFile.path],
      readDiff: async () => ({
        text: testFile.patch,
        truncated: false,
        totalLines: 3,
      }),
      history: async () => "Fixture history",
      dispose: async () => undefined,
    },
    tools: {
      definitions: [
        {
          name: "read_file",
          description: "Read a pinned source file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
      execute: async () =>
        fileExecution("file-1", testFile.path, "export const value = 2;"),
    },
    model: { complete: async (request) => answerStage(request) },
    config: configSchema.parse({
      provider: { model: "test-model" },
      personality: { enabled: false },
    }),
    prompts: {
      triage: "Triage supplied evidence.",
      investigate: "Investigate supplied evidence.",
      validate: "Validate supplied evidence.",
      report: "Describe the supplied facts.",
      personality: "Use a dry, friendly sentence.",
    },
    policies: [],
    priorReviews: [],
    checks: [],
    ...overrides,
  };
}
