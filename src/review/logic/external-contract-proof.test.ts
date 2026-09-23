// PR #122 mistook an Nx tuple contract for a defect; review stages must demand defining evidence, not repeated assumptions.
import { describe, expect, it } from "vitest";
import { loadBundledPrompts } from "../../config/load-config.js";

describe("external contract proof in review prompts", () => {
  it.each(["investigate", "validate"] as const)(
    "%s requires inspected defining evidence for the exact dependency version",
    async (stage) => {
      const prompts = await loadBundledPrompts();
      expect(prompts[stage]).toContain("version-sensitive external API claim");
      expect(prompts[stage]).toContain("exact dependency version");
      expect(prompts[stage]).toContain(
        "defining contract, types, or implementation",
      );
      expect(prompts[stage]).toContain(
        "Caller code, repeated usage, and model memory",
      );
      expect(prompts[stage]).toContain("focused QUESTION");
    },
  );

  it("requires independent validation to resolve counterevidence without assuming the candidate premise", async () => {
    const { validate } = await loadBundledPrompts();
    expect(validate).toContain(
      "Do not adopt a candidate's external-contract premise",
    );
    expect(validate).toContain("Actively reconcile counterevidence");
    expect(validate).toContain("reject it when defining evidence disproves it");
    expect(validate).toContain(
      "keep a focused QUESTION when material proof is unavailable",
    );
  });

  it("preserves deeper repository inspection and directly proven repository defects", async () => {
    const { investigate, validate } = await loadBundledPrompts();
    expect(investigate).toContain("trace a realistic trigger");
    expect(investigate).toContain(
      "Inspect nearby protections and counterevidence",
    );
    expect(investigate).toContain("Direct repository logic defects");
    expect(validate).toContain("Direct repository logic defects");
  });
});
