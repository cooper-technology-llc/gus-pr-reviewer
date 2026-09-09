// Informational omissions and recoverable page warnings stay visible while completed evidence controls readiness.
import { describe, expect, it } from "vitest";
import { reviewChange } from "./review-change.js";
import {
  answerStage,
  fileExecution,
  reviewTestInput,
  toolCompletion,
} from "./review-test-fixtures.js";

describe("review coverage and notices", () => {
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
    expect(result.limitations).toContain(input.repository.omissions[0]);
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
    expect(result.limitations).toContain(input.repository.omissions[0]);
    expect(result.limitations).toContain(
      "The first page was incomplete; further pages were available.",
    );
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
    expect(result.limitations).toContain("Further pages remain unread.");
  });
});
