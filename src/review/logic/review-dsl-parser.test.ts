// Text review records must retain evidence and prose without accepting incomplete or ambiguous assessments.
import { describe, expect, it } from "vitest";
import {
  analysisSchema,
  personalityOutputSchema,
  reportNarrativeSchema,
  validationSchema,
} from "../stage-schemas.js";
import { assessmentWorkedExample } from "./review-dsl-contract.js";
import { ReviewDslError } from "./review-dsl-lexer.js";
import { parseReviewDsl } from "./review-dsl-parser.js";

const assessment = `REVIEW v1
SUMMARY
The value changes its caller contract.
RISK | low
ARCHITECTURE | none
TESTS | none
END`;

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

function withRecords(records: string): string {
  return assessment.replace("\nEND", `\n${records}\nEND`);
}

describe("parseReviewDsl", () => {
  it("keeps explicit empty lists and absent coverage visible to host validation", () => {
    expect(
      analysisSchema.parse(parseReviewDsl(assessment, "investigate")),
    ).toEqual({
      summary: "The value changes its caller contract.",
      risk: "low",
      architecture: null,
      tests: null,
      questions: [],
      findings: [],
      coverage: [],
      reconciliations: [],
    });
  });

  it("preserves findings, coverage, questions, prior concerns, and candidate resolutions", () => {
    const content = withRecords(`${finding}
QUESTION
Does the other caller share this constraint?
QUESTION
Which installation still consumes the old shape?
COVERAGE | src/value.ts | INSPECTED |
The complete changed behavior was inspected.
EVIDENCE | head-1 | caller-1 |
PRIOR | old-1 | Unverified
Current caller evidence is missing.
EVIDENCE
CANDIDATE | issue-1 | CONFIRMED
The current caller confirms the consequence.
EVIDENCE | head-1 | caller-1`);
    const parsed = validationSchema.parse(parseReviewDsl(content, "validate"));
    expect(parsed.findings[0]).toMatchObject({
      id: "issue-1",
      line: 12,
      evidenceIds: ["head-1"],
      suggestion: "Keep the supported behavior.",
    });
    expect(parsed.coverage).toEqual([
      {
        path: "src/value.ts",
        status: "inspected",
        reason: "The complete changed behavior was inspected.",
        evidenceIds: ["head-1", "caller-1"],
      },
    ]);
    expect(parsed.questions).toHaveLength(2);
    expect(parsed.reconciliations).toEqual([
      {
        id: "old-1",
        status: "unverified",
        reason: "Current caller evidence is missing.",
        evidenceIds: [],
      },
    ]);
    expect(parsed.candidateResolutions).toEqual([
      {
        id: "issue-1",
        status: "confirmed",
        reason: "The current caller confirms the consequence.",
        evidenceIds: ["head-1", "caller-1"],
      },
    ]);
  });

  it("retains quotes, pipes, literal backslashes, escaped markers, and fenced code across CRLF", () => {
    const prose = [
      'A caller requests "one" | value.',
      String.raw`Use C:\new\notes.txt and a literal \n.`,
      "```ts",
      "END",
      'const label = "RISK | high";',
      "```",
      String.raw`\SUMMARY`,
      String.raw`\UNKNOWN | literal text`,
    ].join("\n");
    const content = withRecords(
      finding
        .replace("src/value.ts", "`src/pipe\\|name.ts`")
        .replace(" | major |", " | MAJOR |")
        .replace(" | RIGHT |", " | right |")
        .replace("A caller expects one unit.", prose),
    );
    const wrapped = `~~~~text\n${content}\n~~~~`.replace(/\n/g, "\r\n");
    const parsed = analysisSchema.parse(parseReviewDsl(wrapped, "investigate"));
    expect(parsed.findings[0]).toMatchObject({
      path: "src/pipe|name.ts",
      severity: "major",
      side: "RIGHT",
      trigger: prose
        .replace("\\SUMMARY", "SUMMARY")
        .replace("\\UNKNOWN", "UNKNOWN"),
    });
  });

  it("decodes only documented header escapes without converting literal slash-n text", () => {
    const content = withRecords(
      finding.replace("src/value.ts", String.raw`src\\new\n.ts`),
    );
    const parsed = analysisSchema.parse(parseReviewDsl(content, "investigate"));
    expect(parsed.findings[0]?.path).toBe(String.raw`src\new\n.ts`);
  });

  it("accepts report and personality prose only in their separate envelopes", () => {
    const report = "REVIEW v1\nSUMMARY\nA bounded change.\nEND";
    const personality =
      "```text\nPERSONALITY v1\nTAKE\nA focused observation.\nEND\n```";
    expect(
      reportNarrativeSchema.parse(parseReviewDsl(report, "report")),
    ).toEqual({ summary: "A bounded change." });
    expect(
      personalityOutputSchema(100).parse(
        parseReviewDsl(personality, "personality"),
      ),
    ).toEqual({ text: "A focused observation." });
    expect(() => parseReviewDsl(assessment, "report")).toThrow(
      "only one SUMMARY",
    );
    expect(() => parseReviewDsl(report, "personality")).toThrow(
      "PERSONALITY v1",
    );
    expect(() =>
      parseReviewDsl("PERSONALITY v1\nTAKE\n   \nEND", "personality"),
    ).toThrow("meaningful prose");
  });

  it.each([
    [
      "missing terminator",
      assessment.replace("\nEND", ""),
      "Missing required END",
    ],
    ["duplicate terminator", `${assessment}\nEND`, "Nothing may follow END"],
    [
      "trailing prose",
      `${assessment}\nAdditional assessment`,
      "Nothing may follow END",
    ],
    ["second header", withRecords("REVIEW v1"), "Only one document header"],
    [
      "missing summary",
      assessment.replace(
        "SUMMARY\nThe value changes its caller contract.\n",
        "",
      ),
      "Missing required SUMMARY",
    ],
    [
      "missing grade",
      assessment.replace("ARCHITECTURE | none\n", ""),
      "Missing required ARCHITECTURE",
    ],
    [
      "duplicate summary",
      withRecords("SUMMARY\nA second summary."),
      "Duplicate SUMMARY",
    ],
    [
      "unknown record",
      withRecords("VERDICT | ready"),
      "Unknown marker VERDICT",
    ],
    ["unknown bare marker", withRecords("UNKNOWN"), "Unknown marker UNKNOWN"],
    [
      "unexpected nested block",
      withRecords("TITLE\nA misplaced finding title."),
      "Unexpected TITLE",
    ],
    [
      "empty finding",
      withRecords(
        "FINDING | issue-1 | major | src/value.ts | 12 | RIGHT | blocking",
      ),
      "Expected TITLE",
    ],
    [
      "empty finding body",
      withRecords(finding.replace("A caller expects one unit.", "  ")),
      "TRIGGER requires meaningful prose",
    ],
    [
      "empty evidence",
      withRecords(finding.replace("EVIDENCE | head-1", "EVIDENCE")),
      "at least one evidence ID",
    ],
    [
      "invalid line",
      withRecords(finding.replace(" | 12 |", " | 0 |")),
      "positive integer",
    ],
    [
      "fractional line",
      withRecords(finding.replace(" | 12 |", " | 1.5 |")),
      "positive integer",
    ],
    [
      "extra field",
      withRecords(finding.replace(" | blocking\n", " | blocking | extra\n")),
      "requires 6 header",
    ],
    [
      "two trailing pipes",
      withRecords(finding.replace(" | blocking\n", " | blocking ||\n")),
      "empty header field",
    ],
    [
      "none with prose",
      assessment.replace(
        "ARCHITECTURE | none",
        "ARCHITECTURE | none\nUnexpected grading reason.",
      ),
      "does not accept a prose body",
    ],
    [
      "missing reason",
      assessment.replace("TESTS | none", "TESTS | A"),
      "TESTS requires meaningful prose",
    ],
    [
      "unclosed code fence",
      assessment.replace(
        "The value changes its caller contract.",
        "```ts\nconst value = 2;",
      ),
      "code fence is not closed",
    ],
    [
      "unclosed outer fence",
      `\`\`\`text\n${assessment}`,
      "outer Markdown fence is not closed",
    ],
  ])("rejects %s without dropping records", (_name, content, error) => {
    expect(() => parseReviewDsl(content, "investigate")).toThrow(error);
  });

  it.each([
    [finding, "FINDING"],
    [
      "COVERAGE | src/value.ts | partial\nA caller remains unread.\nEVIDENCE",
      "COVERAGE",
    ],
    ["PRIOR | old-1 | unverified\nA caller remains unread.\nEVIDENCE", "PRIOR"],
    [
      "CANDIDATE | issue-1 | unverified\nA caller remains unread.\nEVIDENCE",
      "CANDIDATE",
    ],
  ])("rejects duplicate record identities for %s", (record, marker) => {
    expect(() =>
      parseReviewDsl(withRecords(`${record}\n${record}`), "validate"),
    ).toThrow(`Duplicate ${marker}`);
  });

  it("rejects a candidate in investigation instead of quietly removing it", () => {
    expect(() =>
      parseReviewDsl(
        withRecords(
          "CANDIDATE | issue-1 | unverified\nMissing proof.\nEVIDENCE",
        ),
        "investigate",
      ),
    ).toThrow("only during validation");
  });

  it("leaves enum and maximum-length acceptance to the existing schema", () => {
    const parsed = parseReviewDsl(
      assessment.replace("RISK | low", "RISK | impossible"),
      "investigate",
    );
    expect(analysisSchema.safeParse(parsed).success).toBe(false);
  });

  it.each(["investigate", "validate"] as const)(
    "accepts the prompt's worked example verbatim for %s",
    (stage) => {
      const schema = stage === "validate" ? validationSchema : analysisSchema;
      const parsed = schema.parse(
        parseReviewDsl(assessmentWorkedExample, stage),
      );
      expect(parsed.findings).toHaveLength(1);
      expect(parsed.findings[0]).toMatchObject({
        severity: "major",
        side: "RIGHT",
        disposition: "blocking",
      });
    },
  );
});

function dslError(
  content: string,
  stage: "investigate" | "validate" | "report" = "investigate",
): ReviewDslError {
  try {
    parseReviewDsl(content, stage);
  } catch (error) {
    if (error instanceof ReviewDslError) return error;
    throw error;
  }
  throw new Error("The document was expected to fail.");
}

describe("positioned DSL errors", () => {
  it("names the line, quotes it, and re-prints the record's grammar for a short FINDING header", () => {
    const header = "FINDING | issue-1 | major | src/value.ts | 12 | RIGHT";
    const error = dslError(
      withRecords(
        finding.replace(
          "FINDING | issue-1 | major | src/value.ts | 12 | RIGHT | blocking",
          header,
        ),
      ),
    );
    expect(error.line).toBe(7);
    expect(error.lineText).toBe(header);
    expect(error.message).toBe(
      `line 7: ${header} — FINDING requires 6 header field(s), received 5. Expected: FINDING | id | critical/major/minor | path | positive integer line | LEFT/RIGHT | blocking/follow-up`,
    );
  });

  it.each([
    ["unknown marker", withRecords("VERDICT | ready"), 7, "VERDICT | ready"],
    ["text after END", `${assessment}\nTrailing prose`, 8, "Trailing prose"],
    [
      "a finding section out of order",
      withRecords(finding.replace("TRIGGER", "IMPACT")),
      10,
      "IMPACT",
    ],
    [
      "a finding cut off before its sections",
      withRecords(
        "FINDING | issue-1 | major | src/value.ts | 12 | RIGHT | blocking",
      ),
      7,
      "FINDING | issue-1 | major | src/value.ts | 12 | RIGHT | blocking",
    ],
    [
      "an unclosed prose fence",
      assessment.replace(
        "The value changes its caller contract.",
        "```ts\nconst a = 1;",
      ),
      3,
      "```ts",
    ],
    ["a missing header", "SUMMARY\nText.\nEND", 1, "SUMMARY"],
  ])("reports the offending line for %s", (_name, content, line, lineText) => {
    const error = dslError(content);
    expect(error.line).toBe(line);
    expect(error.lineText).toBe(lineText);
    expect(error.message.startsWith(`line ${line}: ${lineText} — `)).toBe(true);
  });

  it("points at the extra record when a single-record stage has two", () => {
    const error = dslError(
      "REVIEW v1\nSUMMARY\nOne.\nSUMMARY\nTwo.\nEND",
      "report",
    );
    expect(error.message).toBe(
      "line 4: SUMMARY — report accepts only one SUMMARY record.",
    );
  });

  it("trims a long offending line to 120 characters", () => {
    const long = `VERDICT | ${"x".repeat(200)}`;
    const error = dslError(withRecords(long));
    expect(error.lineText).toBe(long);
    expect(error.message).toBe(
      `line 7: ${long.slice(0, 120)}… — Unknown marker VERDICT.`,
    );
  });

  it("keeps a plain message when no line is known", () => {
    const error = dslError(assessment.replace("\nEND", ""));
    expect(error.line).toBeUndefined();
    expect(error.message).toBe("DSL: Missing required END terminator.");
  });
});
