// Per-call metrics explain provider spend without retaining review content or inventing missing accounting.
import { describe, expect, it } from "vitest";
import { configSchema } from "../config/config-schema.js";
import { ReviewBudget } from "./review-budget.js";
import type {
  ModelCompletion,
  ModelMessage,
  ModelTool,
} from "./review-ports.js";
import type { ReviewModelCallContext } from "./review-schema.js";

const callContext: ReviewModelCallContext = {
  stage: "investigate",
  model: "example/requested-model",
  trigger: "initial",
  policyChars: 23,
};

describe("review model call metrics", () => {
  it("records character counts and allowed invocation names without retaining content", () => {
    let now = 100;
    const budget = new ReviewBudget(configSchema.parse({}), () => now);
    const messages: ModelMessage[] = [
      { role: "system", content: "system-content-sentinel" },
      { role: "system", content: "host-contract-sentinel" },
      { role: "user", content: "seed-content-sentinel: src/widget.ts" },
      {
        role: "assistant",
        content: "assistant-content-sentinel",
        toolCalls: [
          {
            id: "prior",
            name: "read_file",
            arguments: { token: "argument-sentinel" },
          },
        ],
      },
      { role: "tool", content: "source-content-sentinel", toolCallId: "prior" },
      { role: "user", content: "correction-content-sentinel" },
    ];
    const tools: ModelTool[] = [
      {
        name: "read_file",
        description: "tool-description-sentinel",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    ];
    budget.beginModel(messages, tools, 100, {
      ...callContext,
      trigger: "correction",
    });
    now = 425;
    budget.recordCompletion(
      makeCompletion({
        content: "completion-content-sentinel",
        requestAttempts: 2,
        toolCalls: [
          {
            id: "one",
            name: "read_file",
            arguments: { path: "src/widget.ts" },
          },
          {
            id: "two",
            name: "name-content-sentinel",
            arguments: "argument-sentinel",
          },
          { id: "three", name: "read_file", arguments: {} },
        ],
      }),
    );

    expect(budget.usage().calls).toEqual([
      {
        ...callContext,
        model: "example/returned-model",
        trigger: "correction",
        turn: 1,
        inputChars: JSON.stringify({ messages, tools }).length,
        systemChars:
          "system-content-sentinel".length + "host-contract-sentinel".length,
        seedChars: "seed-content-sentinel: src/widget.ts".length,
        toolResultChars: "source-content-sentinel".length,
        toolDefinitionChars: JSON.stringify(tools).length,
        inputTokens: 30,
        outputTokens: 10,
        costUsd: 0.01,
        attempts: 2,
        elapsedMs: 325,
        status: "completed",
        toolNames: ["read_file", "unsupported", "read_file"],
      },
    ]);
    const telemetry = JSON.stringify(budget.usage());
    expect(telemetry).not.toContain("sentinel");
    expect(telemetry).not.toContain("src/widget.ts");
    expect(telemetry).not.toContain("arguments");
  });

  it("reconciles sequential call totals and retry attempts with aggregate usage", () => {
    let now = 0;
    const budget = new ReviewBudget(configSchema.parse({}), () => now);
    budget.beginModel([], [], 100, { ...callContext, stage: "triage" });
    now = 50;
    budget.recordCompletion(makeCompletion({ requestAttempts: 2 }));
    budget.beginTool();
    now = 60;
    budget.beginModel([{ role: "tool", content: "result" }], [], 100, {
      ...callContext,
      trigger: "tool-results",
    });
    now = 100;
    budget.recordCompletion(
      makeCompletion({
        inputTokens: 70,
        outputTokens: 20,
        costUsd: 0.02,
      }),
    );

    const usage = budget.usage();
    expect(usage.calls).toMatchObject([
      {
        turn: 1,
        stage: "triage",
        trigger: "initial",
        attempts: 2,
        elapsedMs: 50,
      },
      {
        turn: 2,
        stage: "investigate",
        trigger: "tool-results",
        attempts: 1,
        elapsedMs: 40,
      },
    ]);
    expect(
      usage.calls?.reduce((total, call) => total + (call.inputTokens ?? 0), 0),
    ).toBe(usage.inputTokens);
    expect(
      usage.calls?.reduce((total, call) => total + (call.outputTokens ?? 0), 0),
    ).toBe(usage.outputTokens);
    expect(
      usage.calls?.reduce((total, call) => total + (call.costUsd ?? 0), 0),
    ).toBeCloseTo(usage.costUsd ?? -1);
    expect(usage.calls?.reduce((total, call) => total + call.attempts, 0)).toBe(
      usage.requests,
    );
    expect(usage).toMatchObject({
      requests: 3,
      toolCalls: 1,
      usageComplete: true,
    });
  });

  it("does not record calls rejected before admission", () => {
    const budget = new ReviewBudget(
      configSchema.parse({ review: { maxInputChars: 10 } }),
      () => 0,
    );
    expect(() => budget.beginModel([], [], 100, callContext)).toThrowError(
      expect.objectContaining({ code: "BUDGET_EXCEEDED" }),
    );
    expect(budget.usage()).toMatchObject({ calls: [], requests: 0 });
  });

  it("records failed attempts with unknown usage and no provider error content", () => {
    let now = 0;
    const budget = new ReviewBudget(configSchema.parse({}), () => now);
    budget.beginModel([], [], 100, callContext);
    now = 200;
    budget.recordModelFailure({
      requestAttempts: 3,
      message: "provider-error-content-sentinel",
      response: "provider-response-content-sentinel",
    });

    expect(budget.usage()).toMatchObject({
      requests: 3,
      costUsd: null,
      usageComplete: false,
      calls: [
        {
          ...callContext,
          turn: 1,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          attempts: 3,
          elapsedMs: 200,
          status: "failed",
          toolNames: [],
        },
      ],
    });
    expect(JSON.stringify(budget.usage())).not.toContain("sentinel");
  });

  it("finalizes unknown provider usage as null even when accounting stops the review", () => {
    let now = 0;
    const budget = new ReviewBudget(configSchema.parse({}), () => now);
    budget.beginModel([], [], 100, callContext);
    now = 75;
    expect(() =>
      budget.recordCompletion(
        makeCompletion({
          usageAvailable: false,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: null,
          requestAttempts: 2,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "BUDGET_EXCEEDED" }));
    expect(budget.usage()).toMatchObject({
      usageComplete: false,
      calls: [
        {
          status: "completed",
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
          attempts: 2,
          elapsedMs: 75,
        },
      ],
    });
  });

  it.each([
    {
      stop: "token limit",
      review: { maxTotalTokens: 1000 },
      completion: makeCompletion({ inputTokens: 600, outputTokens: 500 }),
      elapsedMs: 20,
    },
    {
      stop: "cost threshold",
      review: { maxCostUsd: 0.005 },
      completion: makeCompletion(),
      elapsedMs: 20,
    },
    {
      stop: "deadline",
      review: { maxDurationMs: 10 },
      completion: makeCompletion(),
      elapsedMs: 20,
    },
  ])(
    "retains actual call usage when completion crosses the $stop",
    ({ review, completion, elapsedMs }) => {
      let now = 0;
      const budget = new ReviewBudget(
        configSchema.parse({ review }),
        () => now,
      );
      budget.beginModel([], [], 100, callContext);
      now = elapsedMs;
      expect(() => budget.recordCompletion(completion)).toThrowError(
        expect.objectContaining({ code: "BUDGET_EXCEEDED" }),
      );
      expect(budget.usage().calls).toMatchObject([
        {
          status: "completed",
          inputTokens: completion.inputTokens,
          outputTokens: completion.outputTokens,
          costUsd: completion.costUsd,
          attempts: 1,
          elapsedMs,
        },
      ]);
    },
  );

  it("keeps metadata-free callers compatible without inventing a review stage", () => {
    const budget = new ReviewBudget(configSchema.parse({}), () => 0);
    budget.beginModel([], [], 100);
    budget.recordCompletion(makeCompletion());
    expect(budget.usage()).toMatchObject({
      inputTokens: 30,
      outputTokens: 10,
      costUsd: 0.01,
      requests: 1,
      calls: [],
    });
  });
});

function makeCompletion(
  overrides: Partial<ModelCompletion> = {},
): ModelCompletion {
  return {
    content: "{}",
    toolCalls: [],
    finishReason: "stop",
    inputTokens: 30,
    outputTokens: 10,
    costUsd: 0.01,
    model: "example/returned-model",
    ...overrides,
  };
}
