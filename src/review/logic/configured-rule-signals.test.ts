// Configured rules produce inspectable signals from changed text and paths without fabricating defects.
import { describe, expect, it } from "vitest";
import { configSchema, type GusConfig } from "../../config/config-schema.js";
import { configuredRuleSignals } from "./configured-rule-signals.js";
import { seedDiffEvidence } from "./review-evidence.js";
import { reviewChange } from "../review-change.js";
import { buildReviewSeed } from "../review-seed.js";
import {
  answerStage,
  reviewTestInput,
  testFile,
  testSnapshot,
} from "../review-test-fixtures.js";
import type { ChangedFile } from "../review-schema.js";

function rule(
  overrides: Partial<GusConfig["rules"][number]> = {},
): GusConfig["rules"][number] {
  return {
    id: "literal-policy",
    paths: ["src/**/*.ts"],
    message: "Check the configured boundary.",
    severity: "major",
    forbiddenAddedText: "unsafe.call(*)",
    ...overrides,
  };
}

function signals(rules: GusConfig["rules"], files: ChangedFile[]) {
  return configuredRuleSignals(
    rules,
    files,
    seedDiffEvidence(files, testSnapshot),
  );
}

describe("configuredRuleSignals", () => {
  it("treats metacharacters as literal text and attaches actual head diff evidence", () => {
    const file = {
      ...testFile,
      patch: "@@ -7,2 +7,2 @@\n keep();\n-old();\n+unsafe.call(*);\n",
    };
    const evidence = seedDiffEvidence([file], testSnapshot);
    const result = configuredRuleSignals([rule()], [file], evidence);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      ruleId: "literal-policy",
      kind: "forbidden-added-text",
      path: "src/a.ts",
      line: 8,
      severity: "major",
    });
    expect(result[0]?.evidenceIds).toEqual(
      evidence
        .filter((entry) => entry.revision === "head")
        .map((entry) => entry.id),
    );
    expect(
      signals(
        [rule()],
        [{ ...file, patch: "@@ -1 +1 @@\n-old();\n+unsafeXcall(anything);\n" }],
      ),
    ).toEqual([]);
  });

  it("does not match deleted or unchanged context lines", () => {
    const file = {
      ...testFile,
      patch: "@@ -1,2 +1,2 @@\n unsafe.call(*);\n-unsafe.call(*);\n+safe();\n",
    };
    expect(signals([rule()], [file])).toEqual([]);
  });

  it("evaluates added-text and missing-companion predicates independently", () => {
    const file = {
      ...testFile,
      patch: "@@ -1 +1 @@\n-old();\n+unsafe.call(*);\n",
    };
    const configured = rule({ companionPaths: ["src/**/*.test.ts"] });
    expect(signals([configured], [file]).map((entry) => entry.kind)).toEqual([
      "forbidden-added-text",
      "missing-companion",
    ]);
    const companion = {
      ...testFile,
      path: "src/a.test.ts",
      patch: "",
      additions: 0,
      deletions: 0,
    };
    expect(
      signals([configured], [file, companion]).map((entry) => entry.kind),
    ).toEqual(["forbidden-added-text"]);
    expect(
      signals([configured], [testFile]).map((entry) => entry.kind),
    ).toEqual(["missing-companion"]);
  });

  it("counts a changed companion by its path even when its text is excluded", () => {
    const configured = rule({
      forbiddenAddedText: undefined,
      companionPaths: ["src/**/*.test.ts"],
    });
    const companion = {
      ...testFile,
      path: "src/a.test.ts",
      excluded: true,
      patch: "PRIVATE_COMPANION_TEXT",
    };
    expect(signals([configured], [testFile, companion])).toEqual([]);
  });

  it("ignores rules with no matching changed paths and preserves generic empty rules", () => {
    expect(
      signals([rule({ paths: ["contracts/**/*.ts"] })], [testFile]),
    ).toEqual([]);
    expect(signals([], [testFile])).toEqual([]);
  });

  it("carries a matching rule without predicates as applicable review policy", () => {
    expect(
      signals([rule({ forbiddenAddedText: undefined })], [testFile]),
    ).toMatchObject([
      {
        kind: "applicable-policy",
        ruleId: "literal-policy",
        line: null,
        message: "Check the configured boundary.",
      },
    ]);
  });

  it("states that a clipped patch cannot prove absence", () => {
    const result = signals([rule()], [{ ...testFile, truncated: true }]);
    expect(result).toMatchObject([
      { kind: "inspection-incomplete", line: null },
    ]);
    expect(result[0]?.reason).toContain("cannot establish absence");
  });

  it("never exposes excluded source text or claims it was inspected", () => {
    const file = {
      ...testFile,
      excluded: true,
      patch: "@@ -1 +1 @@\n-old();\n+PRIVATE_SOURCE unsafe.call(*);\n",
    };
    const result = signals([rule()], [file]);
    expect(result).toMatchObject([
      { kind: "inspection-incomplete", evidenceIds: [], line: null },
    ]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_SOURCE");
    const input = reviewTestInput({
      config: configSchema.parse({ rules: [rule()] }),
    });
    input.repository.files = [file];
    expect(buildReviewSeed(input, [], [])).not.toContain("PRIVATE_SOURCE");
  });

  it("passes signals through triage, investigation, and validation without forcing findings", async () => {
    const input = reviewTestInput({
      config: configSchema.parse({
        rules: [
          rule({ severity: "critical", forbiddenAddedText: "value = 2" }),
        ],
        personality: { enabled: false },
      }),
    });
    const seen: string[] = [];
    input.model = {
      complete: async (request) => {
        if (["triage", "investigate", "validate"].includes(request.stage)) {
          expect(JSON.stringify(request.messages)).toContain("literal-policy");
          expect(JSON.stringify(request.messages)).toContain(
            "forbidden-added-text",
          );
          seen.push(request.stage);
        }
        return answerStage(request);
      },
    };
    const result = await reviewChange(input);
    expect(seen).toEqual(["triage", "investigate", "validate"]);
    expect(result).toMatchObject({ verdict: "ready", findings: [] });
    const genericSeed: unknown = JSON.parse(
      buildReviewSeed(reviewTestInput(), [], []),
    );
    expect(genericSeed).not.toHaveProperty("configuredRuleSignals");
  });
});
