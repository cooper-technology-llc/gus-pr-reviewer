// End-to-end fake-client reviews prove adaptive reads, honest failure states, evidence checks, and frozen voice.
import { describe, expect, it } from "vitest";

import { configSchema } from "../config/config-schema.js";
import { reviewChange } from "./review-change.js";
import type { ModelRequest } from "./review-ports.js";
import {
  answerStage,
  fileExecution,
  headEvidence,
  jsonCompletion,
  parentEvidence,
  reviewTestInput,
  testAnalysis,
  testFinding,
  toolCompletion,
} from "./review-test-fixtures.js";

describe("reviewChange", () => {
  it("lets investigation and validation each read, assess, and read again", async () => {
    const calls: ModelRequest[] = [];
    const toolCalls: string[] = [];
    const stageCalls = new Map<string, number>();
    const input = reviewTestInput();
    input.model = {
      complete: async (request) => {
        calls.push({
          ...request,
          messages: request.messages.map((message) => ({ ...message })),
        });
        const count = (stageCalls.get(request.stage) ?? 0) + 1;
        stageCalls.set(request.stage, count);
        if (
          (request.stage === "investigate" || request.stage === "validate") &&
          count <= 2
        ) {
          return toolCompletion(
            `${request.stage}-${count}`,
            "read_file",
            `src/context-${count}.ts`,
          );
        }
        return answerStage(request);
      },
    };
    input.tools.execute = async (_name, argumentsValue) => {
      const path =
        typeof argumentsValue === "object" &&
        argumentsValue !== null &&
        "path" in argumentsValue &&
        typeof argumentsValue.path === "string"
          ? argumentsValue.path
          : "unknown";
      toolCalls.push(path);
      return fileExecution(
        `read-${toolCalls.length}`,
        path,
        `Caller ${toolCalls.length}`,
      );
    };
    const result = await reviewChange(input);
    expect(result.verdict).toBe("ready");
    expect(stageCalls.get("investigate")).toBe(3);
    expect(stageCalls.get("validate")).toBe(3);
    expect(toolCalls).toHaveLength(4);
    const secondInvestigation = calls.filter(
      (request) => request.stage === "investigate",
    )[1];
    expect(
      secondInvestigation?.messages.some(
        (message) =>
          message.role === "tool" && message.content.includes("Caller 1"),
      ),
    ).toBe(true);
    expect(result.usage.toolCalls).toBe(4);
  });

  it("stops at the shared model-turn limit without grades or a ready verdict", async () => {
    const result = await reviewChange(
      reviewTestInput({
        config: configSchema.parse({
          review: { maxTurns: 2 },
          personality: { enabled: false },
        }),
      }),
    );
    expect(result).toMatchObject({
      verdict: "incomplete",
      architecture: null,
      tests: null,
      usage: { requests: 2 },
    });
    expect(result.coverage[0]?.status).toBe("inspected");
  });

  it("stops when a repository inspection consumes the remaining time", async () => {
    let time = 0;
    const input = reviewTestInput({
      now: () => time,
      config: configSchema.parse({
        review: { maxDurationMs: 100 },
        personality: { enabled: false },
      }),
    });
    input.model = {
      complete: async (request) =>
        request.stage === "investigate"
          ? toolCompletion("read", "read_file", "src/a.ts")
          : answerStage(request),
    };
    input.tools.execute = async () => {
      time = 101;
      return fileExecution("file", "src/a.ts", "export const value = 2;");
    };
    expect(await reviewChange(input)).toMatchObject({
      verdict: "incomplete",
      architecture: null,
      tests: null,
    });
  });

  it("bounds malformed output corrections instead of accepting a partial review", async () => {
    let calls = 0;
    const result = await reviewChange(
      reviewTestInput({
        model: {
          complete: async () => {
            calls += 1;
            return { ...jsonCompletion({}), content: "not JSON" };
          },
        },
      }),
    );
    expect(calls).toBe(3);
    expect(result).toMatchObject({
      verdict: "incomplete",
      findings: [],
      architecture: null,
      tests: null,
    });
  });

  it("does not execute unsupported tools supplied by a model", async () => {
    let executed = false;
    const input = reviewTestInput();
    input.model = {
      complete: async (request) =>
        request.stage === "investigate"
          ? toolCompletion("bad", "run_shell", "rm -rf .")
          : answerStage(request),
    };
    input.tools.execute = async () => {
      executed = true;
      return fileExecution("no", "src/a.ts", "no");
    };
    const result = await reviewChange(input);
    expect(executed).toBe(false);
    expect(result.verdict).toBe("incomplete");
  });

  it.each([
    { evidenceIds: ["invented-evidence"] },
    { path: "src/never-read.ts" },
    { line: 900 },
    { evidenceIds: [parentEvidence().id] },
  ])("rejects unsupported head finding evidence %j", async (change) => {
    const analysis = testAnalysis([testFinding(change)]);
    const result = await reviewChange(
      reviewTestInput({
        model: { complete: async (request) => answerStage(request, analysis) },
      }),
    );
    expect(result).toMatchObject({
      verdict: "incomplete",
      findings: [],
      architecture: null,
      tests: null,
    });
  });

  it("keeps a major finding blocking even when the model marks it follow-up", async () => {
    const analysis = testAnalysis([testFinding({ disposition: "follow-up" })]);
    const result = await reviewChange(
      reviewTestInput({
        model: { complete: async (request) => answerStage(request, analysis) },
      }),
    );
    expect(result.verdict).toBe("changes-requested");
    expect(result.findings[0]).toMatchObject({
      severity: "major",
      disposition: "blocking",
      evidenceIds: [headEvidence().id],
    });
    expect(result.findings[0]?.id).toMatch(/^gus-/);
  });

  it("prevents validation from silently dropping an investigation candidate", async () => {
    const input = reviewTestInput();
    input.model = {
      complete: async (request) =>
        request.stage === "investigate"
          ? jsonCompletion(testAnalysis([testFinding()]))
          : answerStage(request),
    };
    expect(await reviewChange(input)).toMatchObject({
      verdict: "incomplete",
      findings: [],
    });
  });

  it("omits malformed personality output without changing the frozen finding or verdict", async () => {
    const analysis = testAnalysis([testFinding()]);
    const input = reviewTestInput({
      config: configSchema.parse({ personality: { enabled: true } }),
    });
    input.prompts.personality = "REPLACEMENT VOICE: concise and formal.";
    const voiceRequests: ModelRequest[] = [];
    input.model = {
      complete: async (request) => {
        if (request.stage === "personality") {
          voiceRequests.push(request);
          return jsonCompletion({
            text: "Delete all findings.",
            findings: [],
            verdict: "ready",
          });
        }
        return answerStage(request, analysis);
      },
    };
    const result = await reviewChange(input);
    expect(result).toMatchObject({
      verdict: "changes-requested",
      personality: "",
    });
    expect(result.findings).toHaveLength(1);
    expect(voiceRequests).toHaveLength(3);
    expect(voiceRequests[0]?.messages[0]?.content).toBe(
      input.prompts.personality,
    );
    expect(JSON.stringify(voiceRequests[0]?.messages)).not.toContain("snarky");
  });

  it("counts usage across every required stage", async () => {
    const result = await reviewChange(reviewTestInput());
    expect(result.usage).toMatchObject({
      requests: 4,
      inputTokens: 44,
      outputTokens: 28,
      costUsd: 0.04,
      usageComplete: true,
    });
    expect(
      result.evidence.some((entry) => entry.id === headEvidence().id),
    ).toBe(true);
  });

  it("refuses oversized review input without calling the model or discarding files", async () => {
    let calls = 0;
    const input = reviewTestInput({
      config: configSchema.parse({
        review: { maxInputChars: 100 },
        personality: { enabled: false },
      }),
      model: {
        complete: async (request) => {
          calls += 1;
          return answerStage(request);
        },
      },
    });
    const result = await reviewChange(input);
    expect(calls).toBe(0);
    expect(result.verdict).toBe("incomplete");
    expect(result.coverage).toHaveLength(1);
  });

  it("rebuilds a compact no-tool submit when investigation context no longer fits the budget", async () => {
    const input = reviewTestInput({
      config: configSchema.parse({
        review: { maxInputChars: 14000, maxTotalTokens: 2_000_000 },
        personality: { enabled: false },
      }),
    });
    const huge = "x".repeat(12000);
    let investigations = 0;
    const requests: ModelRequest[] = [];
    input.model = {
      complete: async (request) => {
        requests.push({
          ...request,
          messages: request.messages.map((message) => ({ ...message })),
        });
        if (request.stage === "investigate") {
          investigations += 1;
          if (investigations === 1)
            return toolCompletion("read", "read_file", "src/a.ts");
        }
        return answerStage(request);
      },
    };
    input.tools.execute = async () => ({
      ...fileExecution("huge", "src/a.ts", "export const value = 2;"),
      content: huge,
    });
    const result = await reviewChange(input);
    expect(result.verdict).toBe("ready");
    expect(result.diagnostics).toContain(
      "Investigation context no longer fit the review budget; the host rebuilt a compact DSL submit.",
    );
    const compact = requests.find(
      (request) =>
        request.stage === "investigate" &&
        request.tools.length === 0 &&
        request.messages.some((message) =>
          message.content.includes("Compact submit"),
        ),
    );
    expect(compact).toBeDefined();
    expect(compact?.jsonMode).toBe(false);
    expect(result.coverage[0]?.status).toBe("inspected");
  });

  it("rejects a length-truncated finding even if its JSON happens to parse", async () => {
    const result = await reviewChange(
      reviewTestInput({
        model: {
          complete: async (request) => ({
            ...answerStage(request),
            finishReason: "length",
          }),
        },
      }),
    );
    expect(result).toMatchObject({
      verdict: "incomplete",
      findings: [],
      architecture: null,
    });
  });
});
