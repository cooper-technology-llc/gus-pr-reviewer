// Model context must reuse source text without losing fresh-stage definitions, revision provenance, or host validation.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { reviewChange } from "./review-change.js";
import type {
  ModelMessage,
  ModelRequest,
  ToolExecution,
} from "./review-ports.js";
import {
  answerStage,
  jsonCompletion,
  reviewTestInput,
  testAnalysis,
  testFinding,
  testSnapshot,
} from "./review-test-fixtures.js";

const sourceMarker = "SOURCE_CONTEXT_ONCE_4281";
const sourceText = `export const value = 2; // ${sourceMarker}`;
const textReferenceSchema = z.object({ textRef: z.string() });
const projectedEvidenceSchema = z.object({
  id: z.string(),
  path: z.string(),
  revision: z.string(),
  sha: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  kind: z.string(),
  truncated: z.boolean(),
  text: textReferenceSchema,
});
const contextEnvelopeSchema = z.object({
  format: z.literal("gus-context-v1"),
  sourceTexts: z.array(z.object({ id: z.string(), text: z.string() })),
  payload: z.unknown(),
  evidence: z.array(projectedEvidenceSchema).optional(),
  inspectedPaths: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
});
interface CapturedRequest {
  stage: ModelRequest["stage"];
  messages: ModelMessage[];
}

describe("review source context", () => {
  it("sends identical source once in each stage transcript while preserving every revision and a validated finding", async () => {
    const input = reviewTestInput();
    input.repository.snapshot = {
      ...input.repository.snapshot,
      baseChanged: true,
    };
    const requests: CapturedRequest[] = [];
    const turns = new Map<string, number>();
    const analysis = testAnalysis([
      testFinding({ evidenceIds: ["head-source", "integration-source"] }),
    ]);
    input.tools.execute = async (_name, args) => {
      const request = z
        .object({ revision: z.enum(["head", "integration"]) })
        .parse(args);
      return sourceExecution(request.revision);
    };
    input.model = {
      complete: async (request) => {
        requests.push({
          stage: request.stage,
          messages: request.messages.map((message) => ({ ...message })),
        });
        const turn = (turns.get(request.stage) ?? 0) + 1;
        turns.set(request.stage, turn);
        if (request.stage === "investigate" && turn <= 3)
          return readCompletion(
            `${request.stage}-${turn}`,
            turn === 3 ? "integration" : "head",
          );
        if (request.stage === "validate" && turn === 1)
          return readCompletion("validate-1", "head");
        return answerStage(request, analysis);
      },
    };

    const result = await reviewChange(input);
    expect(result.verdict).toBe("changes-requested");
    expect(result.findings[0]).toMatchObject({
      path: "src/a.ts",
      line: 1,
      evidenceIds: ["head-source", "integration-source"],
    });
    expect(result.coverage[0]?.status).toBe("inspected");
    expect(
      result.evidence.filter((entry) => entry.id.endsWith("-source")),
    ).toEqual([
      sourceExecution("head").evidence[0],
      sourceExecution("integration").evidence[0],
    ]);

    const inspectionRequests = requests.filter(
      (request) =>
        request.stage === "validate" ||
        request.messages.some((message) => message.role === "tool"),
    );
    expect(inspectionRequests).toHaveLength(5);
    for (const request of inspectionRequests) {
      expect(
        occurrences(JSON.stringify(request.messages), sourceMarker),
        request.stage,
      ).toBe(1);
      expectReferencesResolved(request.messages);
    }

    const investigation = requireRequest(requests, "investigate", true);
    const toolMessages = investigation.messages.filter(
      (message) => message.role === "tool",
    );
    const firstTool = parseEnvelope(toolMessages[0]);
    const repeatedTool = parseEnvelope(toolMessages[1]);
    expect(firstTool.payload).toBeTypeOf("object");
    expect(firstTool.sourceTexts).toEqual([
      { id: expect.any(String), text: sourceText },
    ]);
    expect(repeatedTool.sourceTexts).toEqual([]);
    expect(repeatedTool.evidence).toEqual(firstTool.evidence);
    expect(repeatedTool.inspectedPaths).toEqual(["src/a.ts"]);

    const validation = requireRequest(requests, "validate");
    const validationContext = parseEnvelope(
      validation.messages.find((message) => message.role === "user"),
    );
    expect(
      validationContext.sourceTexts.filter(
        (entry) => entry.text === sourceText,
      ),
    ).toHaveLength(1);
    const payload = z
      .object({ additionalEvidence: z.array(projectedEvidenceSchema) })
      .parse(validationContext.payload);
    expect(payload.additionalEvidence).toEqual([
      expect.objectContaining({
        id: "head-source",
        revision: "head",
        sha: testSnapshot.headSha,
        path: "src/a.ts",
        startLine: 1,
        endLine: 1,
        truncated: false,
      }),
      expect.objectContaining({
        id: "integration-source",
        revision: "integration",
        sha: testSnapshot.integration.treeSha,
        path: "src/a.ts",
        startLine: 1,
        endLine: 1,
        truncated: false,
      }),
    ]);
    expect(payload.additionalEvidence[0]?.text).toEqual(
      payload.additionalEvidence[1]?.text,
    );
  });

  it("keeps identical source separate from proof that another revision was inspected", async () => {
    const input = reviewTestInput();
    input.repository.snapshot = {
      ...input.repository.snapshot,
      baseChanged: true,
    };
    const analysis = testAnalysis([
      testFinding({ evidenceIds: ["head-source", "integration-source"] }),
    ]);
    let reads = 0;
    input.tools.execute = async () => sourceExecution("head");
    input.model = {
      complete: async (request) => {
        if (request.stage === "investigate" && reads++ === 0)
          return readCompletion("head-only", "head");
        return answerStage(request, analysis);
      },
    };
    const result = await reviewChange(input);
    expect(result.verdict).toBe("incomplete");
    expect(result.findings).toEqual([]);
    expect(
      result.evidence.some((entry) => entry.id === "integration-source"),
    ).toBe(false);
  });

  it("retains complete unreferenced validation evidence rather than selecting only candidate citations", async () => {
    const input = reviewTestInput();
    const requests: CapturedRequest[] = [];
    let read = false;
    input.tools.execute = async () => sourceExecution("head");
    input.model = {
      complete: async (request) => {
        requests.push({
          stage: request.stage,
          messages: request.messages.map((message) => ({ ...message })),
        });
        if (request.stage === "investigate" && !read) {
          read = true;
          return readCompletion("supporting-read", "head");
        }
        return answerStage(request);
      },
    };
    const result = await reviewChange(input);
    expect(result.verdict).toBe("ready");
    const validation = requireRequest(requests, "validate");
    const context = parseEnvelope(
      validation.messages.find((message) => message.role === "user"),
    );
    const payload = z
      .object({ additionalEvidence: z.array(projectedEvidenceSchema) })
      .parse(context.payload);
    expect(payload.additionalEvidence.map((entry) => entry.id)).toEqual([
      "head-source",
    ]);
    expect(context.sourceTexts.some((entry) => entry.text === sourceText)).toBe(
      true,
    );
    expectReferencesResolved(validation.messages);
  });
});

function sourceExecution(revision: "head" | "integration"): ToolExecution {
  const sha =
    revision === "head"
      ? testSnapshot.headSha
      : testSnapshot.integration.treeSha;
  if (sha === null)
    throw new Error("The fixture needs an integration snapshot.");
  const evidence = {
    id: `${revision}-source`,
    path: "src/a.ts",
    revision,
    sha,
    startLine: 1,
    endLine: 1,
    text: sourceText,
    kind: "file",
    truncated: false,
  } satisfies ToolExecution["evidence"][number];
  return {
    content: JSON.stringify({
      ...evidence,
      evidenceId: evidence.id,
      totalLines: 1,
      nextLine: null,
    }),
    evidence: [evidence],
    inspectedPaths: ["src/a.ts"],
    warnings: [],
  };
}

function readCompletion(id: string, revision: "head" | "integration") {
  return {
    ...jsonCompletion(null),
    content: "",
    finishReason: "tool_calls",
    toolCalls: [
      { id, name: "read_file", arguments: { path: "src/a.ts", revision } },
    ],
  };
}

function requireRequest(
  requests: CapturedRequest[],
  stage: ModelRequest["stage"],
  last = false,
): CapturedRequest {
  const matches = requests.filter((request) => request.stage === stage);
  const request = last ? matches.at(-1) : matches[0];
  if (request === undefined) throw new Error(`Missing ${stage} request.`);
  return request;
}

function parseEnvelope(message: ModelMessage | undefined) {
  if (message === undefined) throw new Error("Missing model context message.");
  return contextEnvelopeSchema.parse(JSON.parse(message.content));
}

function expectReferencesResolved(messages: ModelMessage[]): void {
  const definitions = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "tool") continue;
    const envelope = parseEnvelope(message);
    for (const entry of envelope.sourceTexts) {
      expect(definitions.has(entry.id)).toBe(false);
      definitions.set(entry.id, entry.text);
    }
    for (const reference of textReferences([
      envelope.payload,
      envelope.evidence,
    ]))
      expect(
        definitions.has(reference),
        `Unresolved source reference ${reference}`,
      ).toBe(true);
  }
}

function textReferences(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(textReferences);
  if ("textRef" in value && typeof value.textRef === "string")
    return [value.textRef];
  return Object.values(value).flatMap(textReferences);
}

function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}
