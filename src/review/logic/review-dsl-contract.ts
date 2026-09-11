import type { ReviewStage } from "../../config/config-schema.js";

/** Supplies the text authoring grammar without constraining the provider to JSON output. */
export function reviewDslContract(
  stage: Exclude<ReviewStage, "triage">,
): string {
  const syntax =
    stage === "report"
      ? reportSyntax
      : stage === "personality"
        ? personalitySyntax
        : assessmentSyntax;
  const rules = [
    "Host text protocol: finish this stage with the following line-oriented DSL, not JSON. The host parses and validates it locally. Native tools, when supplied, may be used in repeated read/assess/read cycles before the terminal document.",
    syntax,
    "END is required and terminates the document. Include exactly one header. Record markers stand on their own lines; pipe-delimited header fields share the marker's line. Marker names are case-insensitive. Enum values may vary in case. One trailing pipe is accepted on a record line. A path may have one pair of surrounding backticks.",
    "Prose is multiline text: preserve its quotes, literal backslashes, Markdown, and line breaks without JSON escaping. In header fields only, write \\| for a literal pipe and \\\\ for a literal backslash; other backslashes stay literal. To quote a reserved or marker-shaped line in prose, prefix it with one backslash, for example \\END. Markers inside a closed code fence remain prose. A complete outer Markdown fence is also accepted. Never convert a literal \\n into a line break.",
    "Unknown records, unexpected blocks, duplicate singletons or record identities, missing required prose or fields, and missing END are invalid. Do not omit a malformed finding to produce a clean assessment.",
  ];
  if (stage === "investigate" || stage === "validate") {
    rules.push(
      "SUMMARY, RISK, ARCHITECTURE, and TESTS are required exactly once. Grades must be A/B/C/D/F with a reason, or explicit none with no body. Repeated QUESTION, FINDING, COVERAGE, PRIOR, and CANDIDATE records form lists; omit a record kind for an empty list. Findings require all four prose sections in the shown order and a nonempty EVIDENCE line. Other evidence-bearing records require an EVIDENCE line, which may be bare when evidence is missing. COVERAGE is optional; the host completes it from seed patches and recorded inspections. The host still enforces reconciliation.",
    );
    rules.push(
      stage === "validate"
        ? "Use CANDIDATE | id | confirmed/rejected/unverified followed by its reason and EVIDENCE line for every investigation finding ID. Confirmed candidates must remain findings; rejection requires current evidence; unverified keeps the assessment incomplete."
        : "CANDIDATE records are reserved for the validation stage and must not appear here.",
    );
  }
  return rules.join("\n\n");
}

const reportSyntax = `REVIEW v1
SUMMARY
Multiline summary of the frozen technical facts.
END

Only SUMMARY prose is editable. No findings, grades, risk, or verdict records are allowed.`;

const personalitySyntax = `PERSONALITY v1
TAKE
Multiline voice text grounded in the frozen facts and configured style.
END

Only TAKE prose is editable. No findings, grades, risk, or verdict records are allowed.`;

const assessmentSyntax = `REVIEW v1
SUMMARY
Multiline change summary.
RISK | low/medium/high
ARCHITECTURE | A/B/C/D/F or none
Reason when a grade is supplied.
TESTS | A/B/C/D/F or none
Reason when a grade is supplied; never invent an executed check.
QUESTION
An unresolved question; repeat this optional record as needed.
FINDING | id | critical/major/minor | path | positive integer line | LEFT/RIGHT | blocking/follow-up
TITLE
Finding title.
TRIGGER
Concrete triggering condition, possibly multiline.
IMPACT
Observable consequence.
FIX
Focused correction.
EVIDENCE | actual-host-evidence-id | another-actual-id
COVERAGE | path | inspected/partial/unreviewed
Coverage reason.
EVIDENCE | actual-host-evidence-id
PRIOR | id | still-open/resolved/rejected/unverified
Current reconciliation reason.
EVIDENCE | actual-host-evidence-id
END

The example uses alternatives and placeholders to describe syntax. Choose one enum value and cite actual supplied evidence IDs. Omit optional records when the list is empty.`;
