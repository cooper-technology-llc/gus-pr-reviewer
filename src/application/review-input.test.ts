// Review setup must use only declared policy files and avoid copying credentials into config.
import { describe, expect, it } from "vitest";
import { parseConfig } from "../config/load-config.js";
import { loadPolicies, requireModelKey } from "./review-input.js";

describe("review setup", () => {
  it("reads only configured policy paths and skips absent optional files", async () => {
    const readPaths: string[] = [];
    const policies = await loadPolicies(
      parseConfig({ contextFiles: ["AGENTS.md", "docs/rules.md"] }),
      async (path) => {
        readPaths.push(path);
        return path === "AGENTS.md" ? "Review the documented behavior." : null;
      },
    );
    expect(readPaths).toEqual(["AGENTS.md", "docs/rules.md"]);
    expect(policies).toEqual([
      { path: "AGENTS.md", text: "Review the documented behavior." },
    ]);
  });

  it("resolves only the configured model credential", () => {
    const config = parseConfig({ provider: { apiKeyEnv: "CUSTOM_MODEL_KEY" } });
    expect(
      requireModelKey(config, {
        CUSTOM_MODEL_KEY: "secret",
        OPENROUTER_API_KEY: "different",
      }),
    ).toBe("secret");
    expect(() =>
      requireModelKey(config, { OPENROUTER_API_KEY: "different" }),
    ).toThrowError(expect.objectContaining({ code: "CONFIG_INVALID" }));
  });
});
