// Review budgets cover every model stage and tool call, including retries and missing usage.
import { describe, expect, it } from "vitest";
import { configSchema } from "../config/config-schema.js";
import { ReviewBudget } from "./review-budget.js";

describe("ReviewBudget", () => {
  it("refuses context overflow before spending a provider request", () => {
    const budget = new ReviewBudget(
      configSchema.parse({ review: { maxInputChars: 10 } }),
      () => 0,
    );
    expect(() =>
      budget.beginModel(
        [{ role: "user", content: "longer than the configured context" }],
        [],
        50,
      ),
    ).toThrowError(expect.objectContaining({ code: "BUDGET_EXCEEDED" }));
    expect(budget.usage().requests).toBe(0);
  });

  it("accounts for retries, tokens, and cost without counting tool calls as model requests", () => {
    const budget = new ReviewBudget(configSchema.parse({}), () => 0);
    budget.beginModel([], [], 100);
    budget.recordCompletion({
      content: "{}",
      toolCalls: [],
      finishReason: "stop",
      inputTokens: 30,
      outputTokens: 10,
      costUsd: 0.1,
      model: "one",
      requestAttempts: 2,
    });
    budget.beginTool();
    expect(budget.usage()).toMatchObject({
      requests: 2,
      toolCalls: 1,
      inputTokens: 30,
      outputTokens: 10,
      costUsd: 0.1,
      usageComplete: true,
    });
  });

  it("marks unavailable usage and stops rather than inventing token totals", () => {
    const budget = new ReviewBudget(configSchema.parse({}), () => 0);
    budget.beginModel([], [], 100);
    expect(() =>
      budget.recordCompletion({
        content: "{}",
        toolCalls: [],
        finishReason: "stop",
        inputTokens: 0,
        outputTokens: 0,
        costUsd: null,
        model: "one",
        usageAvailable: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "BUDGET_EXCEEDED" }));
    expect(budget.usage()).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      usageComplete: false,
    });
  });
});
