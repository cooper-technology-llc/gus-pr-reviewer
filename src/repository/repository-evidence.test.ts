// The engine budgets the complete tool envelope, so an over-budget response must still be usable: clipped and marked, never discarded outright.
import { describe, expect, it } from "vitest";
import { identifyEvidence, toolResult } from "./repository-evidence.js";

describe("tool output envelope budget", () => {
  it("drops duplicated evidence, not content, when content alone already fits", () => {
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
    expect(result.content).toBe(JSON.stringify(value));
    expect(result.evidence).toEqual([]);
    expect(result.inspectedPaths).toEqual(["src/example.ts"]);
    expect(result.truncated).toBeUndefined();
    expect(result.warnings).toContainEqual(
      expect.stringContaining("Evidence for this result was dropped"),
    );
  });

  it("clips content with a visible marker and reports droppedChars when content itself cannot fit", () => {
    const maxChars = 500;
    const text = "y".repeat(5000);
    const value = { path: "src/big.ts", text };
    expect(JSON.stringify(value).length).toBeGreaterThan(maxChars);

    const result = toolResult(value, [], ["src/big.ts"], [], maxChars);

    expect(JSON.stringify(result).length).toBeLessThanOrEqual(maxChars);
    expect(result.content).toContain("; request a narrower range]");
    expect(result.truncated).toBeDefined();
    expect(result.truncated?.droppedChars).toBeGreaterThan(0);
    expect(result.content).toContain(
      `truncated ${result.truncated?.droppedChars} chars`,
    );
    expect(result.evidence).toEqual([]);
  });

  it("never throws for size, even when nothing beyond the marker itself fits", () => {
    const maxChars = 10;
    const text = "z".repeat(200);
    const value = { text };

    const result = toolResult(value, [], ["path.ts"], ["a warning"], maxChars);

    expect(result.content).toContain("truncated");
    expect(result.evidence).toEqual([]);
    expect(result.inspectedPaths).toEqual([]);
    expect(result.truncated?.droppedChars).toBeGreaterThan(0);
  });
});
