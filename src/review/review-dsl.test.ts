/** Proves text-authored review records become validated comments without provider JSON constraints. */
import { describe, expect, it } from "vitest";
import { buildProviderRequest } from "../model/model-protocol.js";
import { formatFindingMarkdown } from "../reporting/format-review.js";
import { reviewChange } from "./review-change.js";
import {
  answerStage,
  headEvidence,
  jsonCompletion,
  reviewTestInput,
} from "./review-test-fixtures.js";

describe("DSL review submissions", () => {
  it("turns DSL findings and personality into an evidence-backed review", async () => {
    const input = reviewTestInput();
    input.config.personality.enabled = true;
    input.model = {
      complete: async (request) => {
        if (request.stage === "triage") return answerStage(request);
        const content =
          request.stage === "personality"
            ? "PERSONALITY v1\nTAKE\nThat value has quite the workload.\nEND"
            : request.stage === "report"
              ? "REVIEW v1\nSUMMARY\nThe exported value changes its caller contract.\nEND"
              : reviewDsl(request.stage === "validate");
        return { ...jsonCompletion(null), content };
      },
    };

    const result = await reviewChange(input);

    expect(result.verdict).toBe("changes-requested");
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0];
    expect(finding).toMatchObject({
      title: "Preserve the one-unit contract",
      severity: "major",
      path: "src/a.ts",
      line: 1,
      side: "RIGHT",
      trigger:
        'A caller requests "one" | value.\nIt reads the exported constant.',
      impact: "The caller receives two units.",
      suggestion: "Preserve the documented one-unit value.",
      evidenceIds: [headEvidence().id],
    });
    expect(result.coverage[0]?.status).toBe("inspected");
    expect(result.personality).toBe("That value has quite the workload.");
    if (!finding)
      throw new Error("The review must contain its anchored finding.");
    const comment = formatFindingMarkdown(finding, result, input.subject);
    expect(comment).toContain("src/a.ts:1 (RIGHT)");
    expect(comment).toContain("**Trigger:**");
    expect(comment).toContain("Preserve the documented one-unit value.");
  });

  it("omits provider response_format for every non-triage stage", async () => {
    const input = reviewTestInput();
    input.config.personality.enabled = true;
    const requests = new Map<string, Record<string, unknown>>();
    input.model = {
      complete: async (request) => {
        requests.set(
          request.stage,
          buildProviderRequest(request, input.config),
        );
        return answerStage(request);
      },
    };

    const result = await reviewChange(input);

    expect(result.verdict).toBe("ready");
    expect(requests.get("triage")?.response_format).toEqual({
      type: "json_object",
    });
    for (const stage of ["investigate", "validate", "report", "personality"])
      expect(requests.get(stage), stage).not.toHaveProperty("response_format");
    expect(requests.get("report")).not.toHaveProperty("tools");
    expect(requests.get("personality")).not.toHaveProperty("tools");
  });

  it("bounds malformed DSL corrections and reports the syntax that needs repair", async () => {
    const input = reviewTestInput();
    let investigationCalls = 0;
    const corrections: string[] = [];
    input.model = {
      complete: async (request) => {
        if (request.stage === "triage") return answerStage(request);
        investigationCalls += 1;
        if (investigationCalls > 1)
          corrections.push(request.messages.at(-1)?.content ?? "");
        return {
          ...jsonCompletion(null),
          content: reviewDsl(false).replace("\nEND", ""),
        };
      },
    };
    const result = await reviewChange(input);
    expect(investigationCalls).toBe(3);
    expect(corrections).toHaveLength(2);
    expect(
      corrections.every((content) => content.includes("Missing required END")),
    ).toBe(true);
    expect(result).toMatchObject({
      verdict: "incomplete",
      findings: [],
      architecture: null,
      tests: null,
      usage: { requests: 4 },
    });
  });

  it("accepts a corrected complete DSL document within the same stage budget", async () => {
    const input = reviewTestInput();
    let investigationCalls = 0;
    input.model = {
      complete: async (request) => {
        if (request.stage === "investigate" && ++investigationCalls === 1) {
          return {
            ...jsonCompletion(null),
            content: reviewDsl(false).replace("\nEND", "\nRISK | low\nEND"),
          };
        }
        if (request.stage === "investigate" || request.stage === "validate")
          return {
            ...jsonCompletion(null),
            content: reviewDsl(request.stage === "validate"),
          };
        return answerStage(request);
      },
    };
    const result = await reviewChange(input);
    expect(investigationCalls).toBe(2);
    expect(result.verdict).toBe("changes-requested");
    expect(result.findings).toHaveLength(1);
  });

  it("rejects fabricated DSL evidence through the existing validation guard", async () => {
    const input = reviewTestInput();
    input.model = {
      complete: async (request) => {
        if (request.stage === "investigate" || request.stage === "validate") {
          return {
            ...jsonCompletion(null),
            content: reviewDsl(request.stage === "validate").replaceAll(
              headEvidence().id,
              "fabricated-evidence",
            ),
          };
        }
        return answerStage(request);
      },
    };
    expect(await reviewChange(input)).toMatchObject({
      verdict: "incomplete",
      findings: [],
      architecture: null,
      tests: null,
    });
  });

  it("keeps omitted coverage incomplete even when the DSL is syntactically complete", async () => {
    const input = reviewTestInput();
    input.model = {
      complete: async (request) => {
        if (request.stage === "investigate" || request.stage === "validate") {
          return {
            ...jsonCompletion(null),
            content: reviewDsl(request.stage === "validate").replace(
              /COVERAGE \|[^]*?(?=CANDIDATE \||END)/,
              "",
            ),
          };
        }
        return answerStage(request);
      },
    };
    const result = await reviewChange(input);
    expect(result).toMatchObject({
      verdict: "incomplete",
      architecture: null,
      tests: null,
    });
    expect(result.coverage[0]?.status).toBe("unreviewed");
  });

  it("omits malformed personality blocks without changing frozen technical findings", async () => {
    const input = reviewTestInput();
    input.config.personality.enabled = true;
    input.model = {
      complete: async (request) => {
        if (request.stage === "investigate" || request.stage === "validate")
          return {
            ...jsonCompletion(null),
            content: reviewDsl(request.stage === "validate"),
          };
        if (request.stage === "personality")
          return {
            ...jsonCompletion(null),
            content:
              "PERSONALITY v1\nTAKE\nA brief observation.\nRISK | low\nEND",
          };
        return answerStage(request);
      },
    };
    const result = await reviewChange(input);
    expect(result.verdict).toBe("changes-requested");
    expect(result.findings).toHaveLength(1);
    expect(result.personality).toBe("");
  });
});

function reviewDsl(validation: boolean): string {
  return `REVIEW v1
SUMMARY
The change updates the exported value.
RISK | low
ARCHITECTURE | A
The change stays within its existing module.
TESTS | B
The assessment is static; the exported value is explicit in the patch.
FINDING | candidate-1 | major | src/a.ts | 1 | RIGHT | blocking
TITLE
Preserve the one-unit contract
TRIGGER
A caller requests "one" | value.
It reads the exported constant.
IMPACT
The caller receives two units.
FIX
Preserve the documented one-unit value.
EVIDENCE | ${headEvidence().id}
COVERAGE | src/a.ts | inspected
The complete changed line was inspected.
EVIDENCE | ${headEvidence().id}
${validation ? `CANDIDATE | candidate-1 | confirmed\nThe current patch confirms the candidate.\nEVIDENCE | ${headEvidence().id}\n` : ""}END`;
}
