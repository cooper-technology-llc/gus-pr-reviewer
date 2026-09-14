// Saved diagnostics retain recoverable notices while comments expose material review gaps.
import { describe, expect, it } from "vitest";
import { formatReviewMarkdown } from "../reporting/format-review.js";
import { configSchema } from "../config/config-schema.js";
import { seedDiffEvidence } from "./logic/review-evidence.js";
import { reviewChange } from "./review-change.js";
import type { ModelRequest } from "./review-ports.js";
import {
  answerStage,
  fileExecution,
  reviewTestInput,
  testAnalysis,
  testFinding,
  toolCompletion,
} from "./review-test-fixtures.js";

describe("review coverage and notices", () => {
  it("keeps validation affordable after investigation accumulates unrelated source", async () => {
    const input = reviewTestInput();
    const source = input.repository.files[0];
    if (!source) throw new Error("The test requires its source fixture.");
    input.repository.files.push({
      ...source,
      path: "src/other.ts",
      patch: `@@ -1 +1 @@\n-old\n+${"UNRELATED_SEED_".repeat(3500)}\n`,
    });
    let investigations = 0;
    const stages: string[] = [];
    let validationContent = "";
    input.model.complete = async (request) => {
      stages.push(request.stage);
      if (request.stage === "investigate") {
        investigations += 1;
        return {
          ...(investigations === 1
            ? toolCompletion("inspect-other", "read_file", "src/other.ts")
            : answerStage(request)),
          inputTokens: 60_000,
        };
      }
      if (request.stage === "validate")
        validationContent = JSON.stringify(request.messages);
      return answerStage(request);
    };
    input.tools.execute = async () =>
      fileExecution(
        "unreferenced-source",
        "src/other.ts",
        "DISCOVERY_".repeat(2500),
      );

    const result = await reviewChange(input);

    expect(stages).toContain("validate");
    expect(stages).toContain("report");
    expect(result.verdict).toBe("ready");
    expect(validationContent).toContain("src/other.ts");
    expect(validationContent).not.toContain("UNRELATED_SEED_");
    expect(validationContent).not.toContain("DISCOVERY_");
  });

  it("preserves validation budget when a near-limit candidate cites large seed evidence", async () => {
    const input = reviewTestInput({
      config: configSchema.parse({
        review: {
          maxInputChars: 100_000,
          maxTotalTokens: 140_000,
          maxSubmitContextChars: 8_000,
          maxSubmitSeedChars: 6_000,
        },
        personality: { enabled: false },
      }),
    });
    const source = input.repository.files[0];
    if (!source) throw new Error("The test requires its source fixture.");
    input.repository.files.push({
      ...source,
      path: "src/large.ts",
      patch: `@@ -1 +1 @@\n-old\n+${"LARGE_SEED_".repeat(1800)}\n`,
    });
    const largeHeadEvidence = seedDiffEvidence(
      input.repository.files,
      input.repository.snapshot,
    ).find(
      (entry) => entry.path === "src/large.ts" && entry.revision === "head",
    );
    if (!largeHeadEvidence)
      throw new Error("The test requires large head seed evidence.");
    const analysis = testAnalysis([
      testFinding({
        path: "src/large.ts",
        line: 1,
        evidenceIds: [largeHeadEvidence.id],
      }),
    ]);
    let investigationCalls = 0;
    let validationCalls = 0;
    const stages: string[] = [];
    input.tools.definitions.push({
      name: "read_diff",
      description: "Read a pinned diff range.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    });
    input.model.complete = async (request) => {
      stages.push(request.stage);
      if (request.stage === "investigate") {
        investigationCalls += 1;
        if (investigationCalls === 1)
          return {
            ...toolCompletion("inspect-large", "read_file", "src/large.ts"),
            inputTokens: 70_000,
          };
      }
      if (request.stage === "validate" && ++validationCalls === 2)
        return toolCompletion("validate-large", "read_diff", "src/large.ts");
      return answerStage(request, analysis);
    };
    input.tools.execute = async () => ({
      ...fileExecution(
        "large-source",
        "src/large.ts",
        "export const large = true;",
      ),
      content: "FAT_DISCOVERY_".repeat(2000),
    });

    const result = await reviewChange(input);

    expect(stages).toContain("validate");
    expect(stages).toContain("report");
    expect(validationCalls).toBe(3);
    expect(result.verdict).toBe("changes-requested");
    expect(result.limitations).toEqual([]);
    expect(result.diagnostics).toContain(
      "Investigation context no longer fit the review budget; the host rebuilt a compact DSL submit.",
    );
  });

  it("lets validation repair missing patch coverage after an early assessment", async () => {
    const input = reviewTestInput();
    input.repository.files = input.repository.files.map((file) => ({
      ...file,
      truncated: true,
    }));
    let validations = 0;
    let repairInstructions = "";
    input.tools.definitions.push({
      name: "read_diff",
      description: "Read missing pinned diff rows.",
      parameters: { type: "object", properties: { path: { type: "string" } } },
    });
    input.model.complete = async (request) => {
      if (request.stage === "validate" && ++validations === 2) {
        repairInstructions = JSON.stringify(request.messages);
        return toolCompletion("repair-patch", "read_diff", "src/a.ts");
      }
      return answerStage(request);
    };

    const result = await reviewChange(input);

    expect(validations).toBe(3);
    expect(repairInstructions).toContain("read_diff");
    expect(repairInstructions).toContain("src/a.ts");
    expect(result.verdict).toBe("ready");
    expect(result.coverage[0]?.status).toBe("inspected");
  });

  it("retains a validated assessment when report prose fails", async () => {
    const input = reviewTestInput();
    input.model.complete = async (request) => {
      if (request.stage === "report") throw new Error("Prose unavailable.");
      return answerStage(request);
    };

    const result = await reviewChange(input);

    expect(result).toMatchObject({
      verdict: "ready",
      summary: testAnalysis().summary,
      architecture: { grade: "A" },
      tests: { grade: "B" },
      limitations: [],
    });
    expect(result.diagnostics).toContain(
      "Report prose was unavailable; the validated assessment summary was retained.",
    );
  });

  it("preserves intentional exclusion notices without treating excluded files as incomplete", async () => {
    const input = reviewTestInput();
    const source = input.repository.files[0];
    if (!source) throw new Error("The test requires its source fixture.");
    input.repository.files.push({
      ...source,
      path: "package-lock.json",
      excluded: true,
      patch: "PRIVATE_LOCKFILE_TEXT",
    });
    input.repository.omissions = [
      "package-lock.json was excluded by the configured review scope.",
    ];
    const result = await reviewChange(input);
    expect(result.verdict).toBe("ready");
    expect(result.diagnostics).toContain(input.repository.omissions[0]);
    expect(result.limitations).toEqual([]);
    expect(
      result.coverage.find((file) => file.path === "package-lock.json")?.status,
    ).toBe("excluded");
  });

  it("recovers initial truncation and a partial-page warning after complete coverage", async () => {
    const input = reviewTestInput();
    input.repository.files = input.repository.files.map((file) => ({
      ...file,
      truncated: true,
    }));
    input.repository.omissions = [
      "src/a.ts had an initially clipped patch; further inspection was available.",
    ];
    let investigations = 0;
    let reads = 0;
    input.model = {
      complete: async (request) => {
        if (request.stage === "investigate" && ++investigations <= 2)
          return toolCompletion(
            `read-${investigations}`,
            "read_file",
            "src/a.ts",
          );
        return answerStage(request);
      },
    };
    input.tools.execute = async () => {
      reads += 1;
      const read = fileExecution(
        `evidence-${reads}`,
        "src/a.ts",
        "export const value = 2;",
      );
      if (reads === 1)
        return {
          ...read,
          inspectedPaths: [],
          warnings: [
            "The first page was incomplete; further pages were available.",
          ],
          evidence: read.evidence.map((entry) => ({
            ...entry,
            truncated: true,
          })),
        };
      return read;
    };
    const result = await reviewChange(input);
    expect(reads).toBe(2);
    expect(result.verdict).toBe("ready");
    expect(result.coverage[0]?.status).toBe("inspected");
    expect(result.diagnostics).toContain(input.repository.omissions[0]);
    expect(result.diagnostics).toContain(
      "The first page was incomplete; further pages were available.",
    );
    expect(result.limitations).toEqual([]);
  });

  it("keeps genuinely unfinished coverage incomplete even when page warnings are informational", async () => {
    const input = reviewTestInput();
    input.repository.files = input.repository.files.map((file) => ({
      ...file,
      truncated: true,
    }));
    let investigations = 0;
    input.model = {
      complete: async (request) =>
        request.stage === "investigate" && investigations++ === 0
          ? toolCompletion("partial-read", "read_file", "src/a.ts")
          : answerStage(request),
    };
    input.tools.execute = async () => ({
      ...fileExecution("partial", "src/a.ts", "export const value = 2;"),
      inspectedPaths: [],
      warnings: ["Further pages remain unread."],
    });
    const result = await reviewChange(input);
    expect(result).toMatchObject({
      verdict: "incomplete",
      architecture: null,
      tests: null,
    });
    expect(result.coverage[0]?.status).toBe("partial");
    expect(result.diagnostics).toContain("Further pages remain unread.");
    expect(result.limitations).toContain(
      `src/a.ts: ${result.coverage[0]?.reason}`,
    );
    const report = formatReviewMarkdown(result, input.subject, input.config);
    expect(report).toContain("Review incomplete");
    expect(report).toContain("### Limitations");
    expect(report).toContain("1 partial");
    expect(report).not.toContain("Further pages remain unread.");
  });

  it("saves every incidental binary warning without feeding them into summary or voice", async () => {
    const input = reviewTestInput();
    input.config.personality.enabled = true;
    input.advisories = [
      {
        code: "history-rewritten",
        message: "HISTORY_ONLY_NOTICE",
        evidence: "The old head is no longer an ancestor.",
        action: "none",
      },
      {
        code: "obsolete-parent",
        message: "RETARGET_REQUIRED",
        evidence: "The declared parent has already merged.",
        action: "retarget",
      },
    ];
    const warnings = Array.from(
      { length: 18 },
      (_, index) =>
        `.artifacts/screenshot-${index + 1}.png contains binary data.`,
    );
    const narrativeRequests: ModelRequest[] = [];
    let investigations = 0;
    input.model.complete = async (request) => {
      if (request.stage === "report" || request.stage === "personality")
        narrativeRequests.push(request);
      if (request.stage === "investigate" && investigations++ === 0)
        return toolCompletion("read-source", "read_file", "src/a.ts");
      return answerStage(request);
    };
    input.tools.execute = async () => ({
      ...fileExecution("source", "src/a.ts", "export const value = 2;"),
      warnings: [...warnings, ...warnings],
    });

    const result = await reviewChange(input);
    const report = formatReviewMarkdown(result, input.subject, input.config);

    expect(result.verdict).toBe("ready");
    expect(result.coverage[0]?.status).toBe("inspected");
    expect(result.limitations).toEqual([]);
    expect(result.diagnostics).toEqual(warnings);
    expect(JSON.parse(JSON.stringify(result)).diagnostics).toEqual(warnings);
    expect(report).not.toContain(".artifacts/screenshot-");
    expect(report).not.toContain("### Limitations");
    expect(result.snapshot.advisories).toEqual(input.advisories);
    expect(narrativeRequests).toHaveLength(2);
    for (const request of narrativeRequests) {
      const content = JSON.stringify(request.messages);
      expect(content).not.toContain(".artifacts/screenshot-");
      expect(content).not.toContain("HISTORY_ONLY_NOTICE");
      expect(content).toContain("RETARGET_REQUIRED");
    }
  });

  it("keeps optional voice failures in diagnostics without changing the completed assessment", async () => {
    const input = reviewTestInput();
    input.config.personality.enabled = true;
    input.model.complete = async (request) => {
      if (request.stage === "personality")
        throw new Error("Optional prose is unavailable.");
      return answerStage(request);
    };

    const result = await reviewChange(input);

    expect(result).toMatchObject({
      verdict: "ready",
      personality: "",
      limitations: [],
      architecture: { grade: "A" },
      tests: { grade: "B" },
    });
    expect(result.diagnostics).toContain(
      "Optional reviewer voice was omitted because it was unavailable or failed its output contract.",
    );
  });
});
