import { describe, expect, it } from "vitest";
import {
  buildCompactSubmitContent,
  conversationHasToolResults,
} from "./build-submit-context.js";

describe("buildCompactSubmitContent", () => {
  it("rebuilds a capped submit payload from seed and investigation notes", () => {
    const content = buildCompactSubmitContent(
      "SEED_PATCH",
      [
        { role: "assistant", content: "Need the caller.", toolCalls: [] },
        { role: "tool", content: "Tool result: caller uses the export." },
      ],
      { maxSubmitContextChars: 180000, maxSubmitSeedChars: 100000 },
    );
    expect(content).toContain("Compact submit");
    expect(content).toContain("SEED_PATCH");
    expect(content).toContain("Need the caller.");
    expect(content).toContain("caller uses the export.");
  });

  it("truncates an oversized seed instead of carrying the fat investigation payload", () => {
    const content = buildCompactSubmitContent(
      "S".repeat(400),
      [{ role: "tool", content: "T".repeat(400) }],
      { maxSubmitContextChars: 220, maxSubmitSeedChars: 80 },
    );
    expect(content.length).toBeLessThanOrEqual(220);
    expect(content).toContain("[truncated for submit context]");
    expect(conversationHasToolResults([{ role: "tool", content: "ok" }])).toBe(
      true,
    );
    expect(conversationHasToolResults([{ role: "user", content: "ok" }])).toBe(
      false,
    );
  });
});
