import type { ReviewStage } from "../../config/config-schema.js";
import {
  readReviewDsl,
  ReviewDslError,
  type ReviewDslRecord,
} from "./review-dsl-lexer.js";

type DslStage = Exclude<ReviewStage, "triage">;

/** Converts text-authored records into the existing stage shapes for local schema validation. */
export function parseReviewDsl(
  content: string,
  stage: DslStage,
): Record<string, unknown> {
  const document = readReviewDsl(content);
  const expectedHeader = stage === "personality" ? "PERSONALITY" : "REVIEW";
  if (document.header !== expectedHeader)
    throw new ReviewDslError(`${stage} requires ${expectedHeader} v1.`);
  if (stage === "report" || stage === "personality") {
    const marker = stage === "report" ? "SUMMARY" : "TAKE";
    if (document.records.length !== 1)
      throw new ReviewDslError(`${stage} accepts only one ${marker} record.`);
    const record = expectRecord(document.records, 0, marker);
    requireFields(record, 0);
    return { [stage === "report" ? "summary" : "text"]: requiredBody(record) };
  }
  return parseAssessment(document.records, stage);
}

function parseAssessment(
  records: ReviewDslRecord[],
  stage: "investigate" | "validate",
): Record<string, unknown> {
  const findings: Record<string, unknown>[] = [];
  const coverage: Record<string, unknown>[] = [];
  const reconciliations: Record<string, unknown>[] = [];
  const candidateResolutions: Record<string, unknown>[] = [];
  const questions: string[] = [];
  const assessment: Record<string, unknown> = {
    findings,
    coverage,
    reconciliations,
    questions,
  };
  if (stage === "validate")
    assessment.candidateResolutions = candidateResolutions;
  const singletons = new Set<string>();
  const identities = new Set<string>();

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined) continue;
    switch (record.marker) {
      case "SUMMARY":
        requireUnique(singletons, record.marker, record);
        requireFields(record, 0);
        assessment.summary = requiredBody(record);
        break;
      case "RISK":
        requireUnique(singletons, record.marker, record);
        requireFields(record, 1);
        requireNoBody(record);
        assessment.risk = field(record, 0).toLowerCase();
        break;
      case "ARCHITECTURE":
      case "TESTS":
        requireUnique(singletons, record.marker, record);
        assessment[record.marker.toLowerCase()] = parseGrade(record);
        break;
      case "QUESTION":
        requireFields(record, 0);
        questions.push(requiredBody(record));
        break;
      case "FINDING":
        requireUnique(identities, `FINDING:${field(record, 0)}`, record);
        findings.push(parseFinding(records, index));
        index += 5;
        break;
      case "COVERAGE": {
        requireFields(record, 2);
        const path = pathField(record, 0);
        requireUnique(identities, `COVERAGE:${path}`, record);
        coverage.push({
          path,
          ...parseReasonedRecord(record, records[index + 1]),
        });
        index += 1;
        break;
      }
      case "PRIOR":
      case "CANDIDATE": {
        if (record.marker === "CANDIDATE" && stage !== "validate") {
          throw new ReviewDslError(
            "CANDIDATE records are available only during validation.",
            record.line,
          );
        }
        requireFields(record, 2);
        const id = field(record, 0);
        requireUnique(identities, `${record.marker}:${id}`, record);
        const value = {
          id,
          ...parseReasonedRecord(record, records[index + 1]),
        };
        if (record.marker === "PRIOR") reconciliations.push(value);
        else candidateResolutions.push(value);
        index += 1;
        break;
      }
      default:
        throw new ReviewDslError(
          `Unexpected ${record.marker} record in an assessment.`,
          record.line,
        );
    }
  }
  for (const marker of ["SUMMARY", "RISK", "ARCHITECTURE", "TESTS"]) {
    if (!singletons.has(marker))
      throw new ReviewDslError(`Missing required ${marker} record.`);
  }
  return assessment;
}

function parseFinding(
  records: ReviewDslRecord[],
  index: number,
): Record<string, unknown> {
  const record = expectRecord(records, index, "FINDING");
  requireFields(record, 6);
  requireNoBody(record);
  const lineText = field(record, 3);
  const line = Number(lineText);
  if (!/^\d+$/.test(lineText) || !Number.isSafeInteger(line) || line < 1) {
    throw new ReviewDslError(
      "FINDING line must be a positive integer.",
      record.line,
    );
  }
  const textSections = ["TITLE", "TRIGGER", "IMPACT", "FIX"].map(
    (marker, offset) => {
      const section = expectRecord(records, index + offset + 1, marker);
      requireFields(section, 0);
      return requiredBody(section);
    },
  );
  const evidenceIds = parseEvidence(
    expectRecord(records, index + 5, "EVIDENCE"),
  );
  if (evidenceIds.length === 0)
    throw new ReviewDslError(
      "FINDING requires at least one evidence ID.",
      record.line,
    );
  return {
    id: field(record, 0),
    severity: field(record, 1).toLowerCase(),
    path: pathField(record, 2),
    line,
    side: field(record, 4).toUpperCase(),
    disposition: field(record, 5).toLowerCase(),
    title: textSections[0],
    trigger: textSections[1],
    impact: textSections[2],
    suggestion: textSections[3],
    evidenceIds,
  };
}

function parseReasonedRecord(
  record: ReviewDslRecord,
  evidence: ReviewDslRecord | undefined,
): Record<string, unknown> {
  if (evidence?.marker !== "EVIDENCE") {
    throw new ReviewDslError(
      `${record.marker} requires a following EVIDENCE line.`,
      record.line,
    );
  }
  return {
    status: field(record, 1).toLowerCase(),
    reason: requiredBody(record),
    evidenceIds: parseEvidence(evidence),
  };
}

function parseGrade(record: ReviewDslRecord): Record<string, string> | null {
  requireFields(record, 1);
  const grade = field(record, 0);
  if (grade.toLowerCase() === "none") {
    requireNoBody(record);
    return null;
  }
  return { grade: grade.toUpperCase(), reason: requiredBody(record) };
}

function parseEvidence(record: ReviewDslRecord): string[] {
  requireNoBody(record);
  if (new Set(record.fields).size !== record.fields.length) {
    throw new ReviewDslError(
      "EVIDENCE IDs must not repeat within a record.",
      record.line,
    );
  }
  return record.fields;
}

function expectRecord(
  records: ReviewDslRecord[],
  index: number,
  marker: string,
): ReviewDslRecord {
  const record = records[index];
  if (record?.marker !== marker)
    throw new ReviewDslError(
      `Expected ${marker}${record ? ` before ${record.marker}` : " before END"}.`,
      record?.line,
    );
  return record;
}

function requireFields(record: ReviewDslRecord, count: number): void {
  if (record.fields.length !== count)
    throw new ReviewDslError(
      `${record.marker} requires ${count} header field(s), received ${record.fields.length}.`,
      record.line,
    );
}

function field(record: ReviewDslRecord, index: number): string {
  const value = record.fields[index];
  if (value === undefined || !value.trim())
    throw new ReviewDslError(
      `${record.marker} has a missing header field.`,
      record.line,
    );
  return value;
}

function pathField(record: ReviewDslRecord, index: number): string {
  const value = field(record, index);
  if (!value.startsWith("`") && !value.endsWith("`")) return value;
  if (value.length < 3 || !value.startsWith("`") || !value.endsWith("`")) {
    throw new ReviewDslError(
      "A backticked path needs matching backticks and a nonempty path.",
      record.line,
    );
  }
  const path = value.slice(1, -1);
  if (!path.trim())
    throw new ReviewDslError("A path must not be blank.", record.line);
  return path;
}

function requiredBody(record: ReviewDslRecord): string {
  const text = record.body.join("\n").trim();
  if (!text)
    throw new ReviewDslError(
      `${record.marker} requires meaningful prose.`,
      record.line,
    );
  return text;
}

function requireNoBody(record: ReviewDslRecord): void {
  if (record.body.some((line) => line.trim()))
    throw new ReviewDslError(
      `${record.marker} does not accept a prose body.`,
      record.line,
    );
}

function requireUnique(
  seen: Set<string>,
  identity: string,
  record: ReviewDslRecord,
): void {
  if (seen.has(identity))
    throw new ReviewDslError(`Duplicate ${record.marker} record.`, record.line);
  seen.add(identity);
}
