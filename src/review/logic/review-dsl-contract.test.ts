// The authoring protocol changes without losing native inspection loops or locally validated JSON compatibility.
import { describe, expect, it } from "vitest";
import { reviewChange } from "../review-change.js";
import type { ModelRequest } from "../review-ports.js";
import {
  answerStage,
  fileExecution,
  headEvidence,
  jsonCompletion,
  reviewTestInput,
  toolCompletion,
} from "../review-test-fixtures.js";

const assessment = `REVIEW v1
SUMMARY
The exported value changes.
RISK | low
ARCHITECTURE | none
TESTS | none
COVERAGE | src/a.ts | inspected
The complete changed line was assessed.
EVIDENCE | ${headEvidence().id}
END`;

describe("DSL stage protocol", () => {
  it("prompts actual findings as DSL and keeps provider JSON mode only for triage", async () => {
    const input = reviewTestInput();
    input.config.personality.enabled = true;
    const requests: ModelRequest[] = [];
    input.model = {
      complete: async (request) => {
        requests.push(request);
        return answerStage(request);
      },
    };
    await reviewChange(input);
    expect(requests.map((request) => request.stage)).toEqual([
      "triage",
      "investigate",
      "validate",
      "report",
      "personality",
    ]);
    for (const request of requests) {
      const instructions = request.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n");
      if (request.stage === "triage") {
        expect(request.jsonMode).toBe(true);
        expect(instructions).toContain("JSON Schema:");
      } else {
        expect(request.jsonMode).toBe(false);
        expect(instructions).not.toContain("JSON Schema");
        expect(instructions).toContain(
          request.stage === "personality" ? "PERSONALITY v1" : "REVIEW v1",
        );
      }
      if (request.stage === "investigate" || request.stage === "validate") {
        expect(instructions).toContain("FINDING | id | critical/major/minor");
        expect(request.tools.length).toBeGreaterThan(0);
      } else expect(request.tools).toEqual([]);
    }
  });

  it("allows chained reads in both assessment stages before their terminal DSL", async () => {
    const input = reviewTestInput();
    const turns = new Map<string, number>();
    let reads = 0;
    input.model = {
      complete: async (request) => {
        const turn = (turns.get(request.stage) ?? 0) + 1;
        turns.set(request.stage, turn);
        if (request.stage === "investigate" || request.stage === "validate") {
          expect(request.jsonMode).toBe(false);
          if (turn <= 2)
            return toolCompletion(
              `${request.stage}-${turn}`,
              "read_file",
              "src/caller.ts",
            );
          return { ...jsonCompletion(null), content: assessment };
        }
        return answerStage(request);
      },
    };
    input.tools.execute = async () => {
      reads += 1;
      return fileExecution(
        `caller-${reads}`,
        "src/caller.ts",
        "The caller reads the exported value.",
      );
    };
    const result = await reviewChange(input);
    expect(result.verdict).toBe("ready");
    expect(turns.get("investigate")).toBe(3);
    expect(turns.get("validate")).toBe(3);
    expect(reads).toBe(4);
    expect(result.usage.toolCalls).toBe(4);
  });

  it.each([false, true])(
    "retains schema-validated JSON compatibility with outer fence=%s",
    async (fenced) => {
      const input = reviewTestInput();
      input.config.personality.enabled = true;
      input.model = {
        complete: async (request) => {
          const completion = answerStage(request);
          return {
            ...completion,
            content: fenced
              ? `\`\`\`json\n${completion.content}\n\`\`\``
              : completion.content,
          };
        },
      };
      const result = await reviewChange(input);
      expect(result.verdict).toBe("ready");
      expect(result.personality.length).toBeGreaterThan(0);
    },
  );

  it("rejects malformed compatibility JSON instead of treating it as an empty assessment", async () => {
    const input = reviewTestInput();
    input.model = {
      complete: async (request) =>
        request.stage === "triage"
          ? answerStage(request)
          : { ...jsonCompletion(null), content: '{"findings": []' },
    };
    expect(await reviewChange(input)).toMatchObject({
      verdict: "incomplete",
      architecture: null,
      tests: null,
      findings: [],
    });
  });
});
