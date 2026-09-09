// Provider requests must preserve configured controls and reject malformed evidence-producing output.
import { describe, expect, it } from "vitest";
import { configSchema } from "../config/config-schema.js";
import type { ModelRequest } from "../review/review-ports.js";
import { createModelClient } from "./model-client.js";

const request: ModelRequest = {
  stage: "investigate",
  model: "review-model",
  messages: [{ role: "user", content: "Review this." }],
  tools: [],
  maxOutputTokens: 500,
  deadline: Date.now() + 60000,
  jsonMode: true,
  reasoningEffort: "high",
};

function completionBody() {
  return {
    model: "review-model",
    choices: [
      { finish_reason: "stop", message: { content: "{}", tool_calls: [] } },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.02 },
  };
}

describe("createModelClient", () => {
  it.each([
    "http://remote.example/v1",
    "https://user:password@models.example/v1",
  ])("rejects an unsafe credential destination %s", (baseUrl) => {
    expect(() =>
      createModelClient(configSchema.parse({ provider: { baseUrl } }), {
        apiKey: "key",
      }),
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });

  it("permits explicit loopback HTTP and prevents redirect credential forwarding", async () => {
    let redirectMode: RequestRedirect | undefined;
    const model = createModelClient(
      configSchema.parse({ provider: { baseUrl: "http://127.0.0.1:8000/v1" } }),
      {
        apiKey: "key",
        fetch: async (_url, init) => {
          redirectMode = init?.redirect;
          return Response.json(completionBody());
        },
      },
    );
    await model.complete(request);
    expect(redirectMode).toBe("error");
  });

  it("uses the selected stage model, reasoning format, output cap, and validated usage", async () => {
    const bodies: unknown[] = [];
    const config = configSchema.parse({
      provider: {
        baseUrl: "https://models.example/v1",
        reasoningFormat: "openai",
      },
    });
    const model = createModelClient(config, {
      apiKey: "private-key",
      fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json(completionBody());
      },
    });
    const result = await model.complete(request);
    expect(bodies[0]).toMatchObject({
      model: "review-model",
      reasoning_effort: "high",
      max_tokens: 500,
      response_format: { type: "json_object" },
      stream: false,
    });
    expect(result).toMatchObject({
      inputTokens: 12,
      outputTokens: 4,
      costUsd: 0.02,
      requestAttempts: 1,
      usageAvailable: true,
    });
  });

  it("retries finite transient failures and counts provider attempts", async () => {
    let calls = 0;
    const model = createModelClient(
      configSchema.parse({ provider: { retries: 1 } }),
      {
        apiKey: "key",
        fetch: async () => {
          calls += 1;
          return calls === 1
            ? new Response("Unavailable", { status: 503 })
            : Response.json(completionBody());
        },
      },
    );
    expect(await model.complete(request)).toMatchObject({ requestAttempts: 2 });
    expect(calls).toBe(2);
  });

  it("never makes a request after its deadline", async () => {
    let calls = 0;
    const model = createModelClient(configSchema.parse({}), {
      apiKey: "key",
      now: () => 100,
      fetch: async () => {
        calls += 1;
        return Response.json(completionBody());
      },
    });
    await expect(
      model.complete({ ...request, deadline: 99 }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(calls).toBe(0);
  });

  it("rejects malformed tool calls rather than coercing their arguments", async () => {
    const model = createModelClient(configSchema.parse({}), {
      apiKey: "key",
      fetch: async () =>
        Response.json({
          ...completionBody(),
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call",
                    type: "function",
                    function: { name: "read_file", arguments: "{broken" },
                  },
                ],
              },
            },
          ],
        }),
    });
    await expect(model.complete(request)).rejects.toMatchObject({
      code: "PROVIDER_PROTOCOL",
    });
  });

  it("distinguishes unavailable usage from a measured zero", async () => {
    const model = createModelClient(configSchema.parse({}), {
      apiKey: "key",
      fetch: async () => Response.json({ choices: completionBody().choices }),
    });
    expect(await model.complete(request)).toMatchObject({
      usageAvailable: false,
      costUsd: null,
    });
  });
});
