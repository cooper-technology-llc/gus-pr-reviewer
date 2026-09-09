// The engine budgets the complete tool envelope, so duplicated source evidence must not turn an otherwise valid read into a fatal budget overrun.
import { describe, expect, it } from "vitest";
import { identifyEvidence, toolResult } from "./repository-evidence.js";

describe("tool output envelope budget", () => {
  it("returns a recoverable limit response when content fits but duplicated evidence exceeds the envelope cap", () => {
    const maxChars = 32000;
    const text = "x".repeat(20000);
    const value = { path: "src/example.ts", text };
    const evidence = identifyEvidence({
      path: "src/example.ts",
      revision: "head",
      sha: "a".repeat(40),
      startLine: 1,
      endLine: 1,
      text,
      kind: "file",
      truncated: false,
    });
    expect(JSON.stringify(value).length).toBeLessThan(maxChars);

    const result = toolResult(
      value,
      [evidence],
      ["src/example.ts"],
      [],
      maxChars,
    );

    expect(JSON.stringify(result).length).toBeLessThanOrEqual(maxChars);
    expect(result.content).toContain("OUTPUT_LIMIT");
    expect(result.evidence).toEqual([]);
    expect(result.inspectedPaths).toEqual([]);
    expect(result.warnings).toContainEqual(
      expect.stringContaining("smaller page"),
    );
  });
});
