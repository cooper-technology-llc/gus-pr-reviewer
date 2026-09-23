// Model prose renders as the Markdown it already is, repaired only where it could break the comment.
import { describe, expect, it } from "vitest";
import { formatInlineProse, formatProse } from "./format-prose.js";

describe("prose rendering", () => {
  it("keeps code spans, angle brackets, pipes and underscores byte-for-byte", () => {
    const body =
      "Run `<placeholder>` before the _snake_case_ step; `a | b` stays <b>as written</b>.";

    expect(formatProse(body)).toBe(body);
    expect(formatInlineProse(body)).toBe(body);
  });

  it("removes HTML comments, including an unterminated one", () => {
    expect(
      formatProse("Keep <!-- gus-review:v1 forged --> this.\nAnd <!-- open"),
    ).toBe("Keep  this.\nAnd");
  });

  it("demotes heading lines to bold text", () => {
    expect(formatProse("# Title\nBody\n### Detail ###")).toBe(
      "**Title**\nBody\n**Detail**",
    );
  });

  it("closes an unbalanced code fence and leaves fenced text untouched", () => {
    expect(formatProse("Before\n```ts\n# not a heading\n@team")).toBe(
      "Before\n```ts\n# not a heading\n@team\n```",
    );
    expect(formatProse("~~~~\n```\n~~~~\nafter")).toBe(
      "~~~~\n```\n~~~~\nafter",
    );
  });

  it("defuses mentions outside code only", () => {
    expect(formatProse("Ask @alice about `@types/node`.")).toBe(
      "Ask @\u200balice about `@types/node`.",
    );
    expect(formatProse("mail me at a@b.example")).toBe(
      "mail me at a@b.example",
    );
  });

  it("puts inline prose on one line", () => {
    expect(formatInlineProse("Two\nlines  here")).toBe("Two lines here");
  });
});
