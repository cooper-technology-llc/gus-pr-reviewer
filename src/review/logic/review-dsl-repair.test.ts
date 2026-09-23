// Trivial authoring slips are fixed host-side and named, so no correction turn is spent on them; anything ambiguous is left alone.
import { describe, expect, it } from "vitest";
import { analysisSchema } from "../stage-schemas.js";
import { parseReviewDsl } from "./review-dsl-parser.js";
import { repairReviewDsl } from "./review-dsl-repair.js";

const finding = `FINDING | issue-1 | major | src/value.ts | 12 | RIGHT | blocking
TITLE
Preserve the existing value
TRIGGER
A caller expects one unit.
IMPACT
The caller receives two units.
FIX
Keep the supported behavior.
EVIDENCE | head-1`;

const valid = `REVIEW v1
SUMMARY
The value changes its caller contract.
RISK | low
ARCHITECTURE | none
TESTS | none
${finding}
END`;

function repaired(document: string): { document: string; repairs: string[] } {
  const result = repairReviewDsl(document);
  expect(parseReviewDsl(result.document, "investigate")).toBeDefined();
  return result;
}

describe("repairReviewDsl", () => {
  it("returns a valid document unchanged with no repairs", () => {
    expect(repairReviewDsl(valid)).toEqual({ document: valid, repairs: [] });
    const crlf = valid.replace(/\n/g, "\r\n");
    expect(repairReviewDsl(crlf)).toEqual({ document: crlf, repairs: [] });
  });

  it("removes a complete outer Markdown fence", () => {
    const result = repaired(`\`\`\`text\n${valid}\n\`\`\``);
    expect(result.document).toBe(valid);
    expect(result.repairs).toEqual([
      "Removed the outer Markdown fence around the document.",
    ]);
  });

  it("strips prose before the header and after END", () => {
    const result = repaired(
      `Here is my review.\n\n${valid}\n\nLet me know if you need more.`,
    );
    expect(result.document).toBe(valid);
    expect(result.repairs).toEqual([
      "Removed 1 line(s) of text before the document header.",
      "Removed 1 line(s) of text after END.",
    ]);
  });

  it("strips prose around a fenced document", () => {
    const result = repaired(
      `Review follows:\n\`\`\`\n${valid}\n\`\`\`\nThanks.`,
    );
    expect(result.document).toBe(valid);
    expect(result.repairs).toEqual([
      "Removed the outer Markdown fence around the document.",
      "Removed 1 line(s) of text before the document header.",
      "Removed 1 line(s) of text after END.",
    ]);
  });

  it("adds END after a complete final record", () => {
    const result = repaired(valid.replace("\nEND", "\n"));
    expect(result.document).toBe(valid);
    expect(result.repairs).toEqual([
      "Added missing END after the last record.",
    ]);
    const report = repairReviewDsl("REVIEW v1\nSUMMARY\nA bounded change.");
    expect(report.document).toBe("REVIEW v1\nSUMMARY\nA bounded change.\nEND");
  });

  it("adds END inside a fenced document whose closing fence remains", () => {
    const result = repaired(`\`\`\`\n${valid.replace("\nEND", "")}\n\`\`\``);
    expect(result.document).toBe(valid);
    expect(result.repairs).toEqual([
      "Removed the outer Markdown fence around the document.",
      "Added missing END after the last record.",
    ]);
  });

  it.each([
    ["mid-sentence prose", "REVIEW v1\nSUMMARY\nThe value changes its"],
    ["an open code fence", "REVIEW v1\nSUMMARY\nSee:\n```ts\nconst a = 1;"],
    [
      "a finding cut before EVIDENCE",
      valid.replace("\nEVIDENCE | head-1\nEND", ""),
    ],
  ])(
    "leaves a document that may be truncated after %s alone",
    (_name, text) => {
      expect(repairReviewDsl(text)).toEqual({ document: text, repairs: [] });
    },
  );

  it("removes a trailing pipe from header lines", () => {
    const result = repaired(
      valid
        .replace("RISK | low", "RISK | low |")
        .replace("EVIDENCE | head-1", "EVIDENCE | head-1|"),
    );
    expect(result.document).toBe(valid);
    expect(result.repairs).toEqual([
      "Removed a trailing pipe from record headers (lines 4, 16).",
    ]);
  });

  it("uppercases marker names and normalizes the header", () => {
    const result = repaired(
      valid
        .replace("REVIEW v1", "review V1")
        .replace("SUMMARY", "Summary")
        .replace("\nTITLE", "\nTitle")
        .replace("\nEND", "\nend"),
    );
    expect(result.document).toBe(valid);
    expect(result.repairs).toEqual([
      "Normalized the document header (line 1).",
      "Uppercased record markers (lines 2, 8, 17).",
    ]);
  });

  it("normalizes enum values to the grammar's case", () => {
    const result = repaired(
      valid
        .replace("RISK | low", "RISK | Low")
        .replace("ARCHITECTURE | none", "ARCHITECTURE | NONE")
        .replace(
          "| major | src/value.ts | 12 | RIGHT | blocking",
          "| Major | src/value.ts | 12 | right | Blocking",
        ),
    );
    expect(result.document).toBe(valid);
    expect(result.repairs).toEqual([
      "Normalized the case of enum values (lines 4, 5, 7).",
    ]);
  });

  it("removes backticks around a path", () => {
    const result = repaired(valid.replace("src/value.ts", "`src/value.ts`"));
    expect(result.document).toBe(valid);
    expect(result.repairs).toEqual([
      "Removed backticks around paths (line 7).",
    ]);
  });

  it.each([
    ["major", "blocking"],
    ["critical", "blocking"],
    ["minor", "follow-up"],
  ])(
    "adds the %s finding's missing disposition as %s",
    (severity, disposition) => {
      const header = `FINDING | issue-1 | ${severity} | src/value.ts | 12 | RIGHT`;
      const result = repaired(
        valid.replace(
          "FINDING | issue-1 | major | src/value.ts | 12 | RIGHT | blocking",
          header,
        ),
      );
      expect(result.document).toContain(`${header} | ${disposition}\n`);
      expect(result.repairs).toEqual([
        "Added the missing FINDING disposition from its severity (blocking for critical/major, follow-up for minor) (line 7).",
      ]);
    },
  );

  it("does not guess a disposition when a different finding field is missing", () => {
    const text = valid.replace(" | RIGHT | blocking", " | blocking");
    expect(repairReviewDsl(text)).toEqual({ document: text, repairs: [] });
  });

  it("splits comma-separated and backticked evidence IDs into pipe fields", () => {
    const result = repaired(
      valid.replace("EVIDENCE | head-1", "EVIDENCE | `head-1`, `caller-1`"),
    );
    expect(result.document).toContain("EVIDENCE | head-1 | caller-1\nEND");
    expect(result.repairs).toEqual([
      "Split comma-separated EVIDENCE IDs into pipe fields (line 16).",
      "Removed backticks around EVIDENCE IDs (line 16).",
    ]);
    const parsed = analysisSchema.parse(
      parseReviewDsl(result.document, "investigate"),
    );
    expect(parsed.findings[0]?.evidenceIds).toEqual(["head-1", "caller-1"]);
  });

  it("does not touch marker-shaped lines inside a closed code fence or prose", () => {
    const prose = [
      "```ts",
      "risk | High |",
      "finding | a | Major | `src/x.ts` | 1 | right",
      "evidence | `a`, `b`",
      "```",
      "The line `Evidence, again` stays prose.",
    ].join("\n");
    const text = valid.replace("A caller expects one unit.", prose);
    expect(repairReviewDsl(text)).toEqual({ document: text, repairs: [] });
  });

  it("repairs headers after a closed code fence while leaving the fence verbatim", () => {
    const prose = "```\nrisk | High |\n```";
    const text = valid
      .replace("A caller expects one unit.", prose)
      .replace("RIGHT | blocking", "right | blocking");
    const result = repaired(text);
    expect(result.document).toContain(prose);
    expect(result.document).toContain("| RIGHT | blocking");
    expect(result.repairs).toEqual([
      "Normalized the case of enum values (line 7).",
    ]);
  });

  it("leaves a header with an empty field for the parser to reject", () => {
    const text = valid.replace(" | blocking\n", " | blocking ||\n");
    expect(repairReviewDsl(text)).toEqual({ document: text, repairs: [] });
  });

  it("leaves text without a document header alone", () => {
    const text = "I could not complete the review.";
    expect(repairReviewDsl(text)).toEqual({ document: text, repairs: [] });
  });
});
