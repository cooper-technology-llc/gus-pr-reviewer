// CLI validation must reject ambiguous targets before model spending or publication can begin.
import { describe, expect, it } from "vitest";
import { parseCliArguments } from "../src/cli/parse-arguments.js";

describe("CLI argument validation", () => {
  it("accepts explicit local runtime updates without review or publication flags", () => {
    expect(
      parseCliArguments(["update", "--directory", "/a repo", "--force"]),
    ).toEqual({ command: "update", directory: "/a repo", force: true });
    expect(() => parseCliArguments(["update", "--publish"])).toThrow();
    expect(() =>
      parseCliArguments(["update", "--preset", "generic"]),
    ).toThrow();
  });
  it("supports generic interactive setup and an explicit noninteractive flag", () => {
    expect(parseCliArguments(["init"])).toEqual({
      command: "init",
      directory: ".",
      preset: "generic",
      force: false,
      yes: false,
    });
    expect(
      parseCliArguments(["init", "--yes", "--directory", "/a repo"]),
    ).toEqual({
      command: "init",
      directory: "/a repo",
      preset: "generic",
      force: false,
      yes: true,
    });
    expect(
      parseCliArguments(["init", "-y", "--preset", "generic"]),
    ).toMatchObject({ yes: true, preset: "generic" });
    expect(() => parseCliArguments(["review", "--yes"])).toThrow();
  });
  it("defaults GitHub reviews to no publication", () => {
    expect(
      parseCliArguments(["review", "--repo", "acme/service", "--pr", "42"]),
    ).toEqual({
      command: "review-pr",
      repository: "acme/service",
      pullRequest: 42,
      publish: false,
      format: "markdown",
    });
  });

  it("retains explicit local paths, base, head, and parent", () => {
    expect(
      parseCliArguments([
        "review",
        "--path",
        "/a repo",
        "--base",
        "trunk",
        "--head",
        "feature/child",
        "--parent",
        "feature/parent",
        "--format",
        "json",
      ]),
    ).toEqual({
      command: "review-local",
      path: "/a repo",
      base: "trunk",
      head: "feature/child",
      parent: "feature/parent",
      format: "json",
    });
  });

  it("accepts GitHub Enterprise API configuration", () => {
    expect(
      parseCliArguments([
        "issues",
        "--repo",
        "acme/service",
        "--pr",
        "42",
        "--api-url",
        "https://github.example/api/v3",
        "--publish",
      ]),
    ).toMatchObject({
      command: "issues",
      apiUrl: "https://github.example/api/v3",
      publish: true,
    });
  });

  it.each([
    [
      "review",
      "--repo",
      "acme/service",
      "--pr",
      "42",
      "--path",
      ".",
      "--base",
      "main",
    ],
    ["review", "--path", ".", "--base", "main", "--publish"],
    [
      "review",
      "--path",
      ".",
      "--base",
      "main",
      "--api-url",
      "https://api.github.com",
    ],
    ["review", "--event", "event.json", "--repo", "acme/service", "--pr", "42"],
    ["review", "--repo", "acme/service", "--pr", "42", "--base", "main"],
    ["review", "--repo", "acme/service", "--pr", "0"],
    ["review", "--repo", "acme/service", "--pr", "1.5"],
    ["review", "--repo", "acme/service", "--pr", "9007199254740993"],
    ["review", "--repo", "https://github.com/acme/service", "--pr", "42"],
    ["review", "--repo", "acme/service", "--pr", "42", "--pr", "43"],
    [
      "review",
      "--repo",
      "acme/service",
      "--pr",
      "42",
      "--api-url",
      "file:///tmp/github",
    ],
    [
      "review",
      "--repo",
      "acme/service",
      "--pr",
      "42",
      "--api-url",
      "https://user:secret@github.example/api/v3",
    ],
    ["review", "--path", "."],
    ["review", "--event", ""],
    ["init", "--preset", "unknown"],
    ["init", "--publish"],
    ["prompts", "--stage", "unknown"],
    ["prompts", "--force"],
    ["doctor", "--unknown"],
    ["trigger", "--event", "event.json", "--publish"],
    ["review", "extra", "--path", ".", "--base", "main"],
  ])("rejects unsafe or ambiguous combination %j", (...args) => {
    expect(() => parseCliArguments(args)).toThrow();
  });

  it("makes help and version available without target configuration", () => {
    expect(parseCliArguments([])).toEqual({ command: "help" });
    expect(parseCliArguments(["review", "--help"])).toEqual({
      command: "help",
    });
    expect(parseCliArguments(["--version"])).toEqual({ command: "version" });
  });
});
