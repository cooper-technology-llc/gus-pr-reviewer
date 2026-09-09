import { minimatch } from "minimatch";
import type { GusConfig } from "../../config/config-schema.js";
import type { ChangedFile, ReviewEvidence } from "../review-schema.js";

type ConfiguredRule = GusConfig["rules"][number];

export interface ConfiguredRuleSignal {
  ruleId: string;
  message: string;
  severity: ConfiguredRule["severity"];
  kind:
    | "forbidden-added-text"
    | "missing-companion"
    | "applicable-policy"
    | "inspection-incomplete";
  path: string;
  line: number | null;
  reason: string;
  evidenceIds: string[];
}

export function configuredRuleSignals(
  rules: ConfiguredRule[],
  files: ChangedFile[],
  evidence: ReviewEvidence[],
): ConfiguredRuleSignal[] {
  const signals: ConfiguredRuleSignal[] = [];
  for (const rule of rules) {
    const matchingFiles = files.filter((file) =>
      matchesPath(file.path, rule.paths),
    );
    const companionPaths = rule.companionPaths ?? [];
    const hasTextPredicate = rule.forbiddenAddedText !== undefined;
    const hasCompanionPredicate = companionPaths.length > 0;
    const companionPresent =
      hasCompanionPredicate &&
      files.some((file) => matchesPath(file.path, companionPaths));
    for (const file of matchingFiles) {
      if (rule.forbiddenAddedText !== undefined)
        signals.push(
          ...addedTextSignals(rule, file, evidence, rule.forbiddenAddedText),
        );
      if (hasCompanionPredicate && !companionPresent) {
        signals.push(
          makeSignal(
            rule,
            file,
            "missing-companion",
            `No changed file matches the configured companion paths ${JSON.stringify(companionPaths)}. Investigate whether this contribution requires a companion change.`,
            evidence,
          ),
        );
      }
      if (!hasTextPredicate && !hasCompanionPredicate) {
        signals.push(
          makeSignal(
            rule,
            file,
            "applicable-policy",
            "This configured review policy applies to the matching changed path; its applicability does not establish a defect.",
            evidence,
          ),
        );
      }
    }
  }
  return signals;
}

function addedTextSignals(
  rule: ConfiguredRule,
  file: ChangedFile,
  evidence: ReviewEvidence[],
  literal: string,
): ConfiguredRuleSignal[] {
  if (file.excluded)
    return [
      makeSignal(
        rule,
        file,
        "inspection-incomplete",
        "The text predicate was not evaluated because this file is excluded from review.",
        [],
      ),
    ];
  if (file.binary)
    return [
      makeSignal(
        rule,
        file,
        "inspection-incomplete",
        "Binary content cannot be evaluated by the added-text predicate.",
        evidence,
      ),
    ];
  const signals: ConfiguredRuleSignal[] = [];
  const addedLines = addedDiffLines(file.patch);
  const matches = addedLines.filter((line) => line.text.includes(literal));
  const first = matches[0];
  if (first) {
    const evidenceIds = [
      ...new Set(
        matches.flatMap((line) => diffEvidenceIds(file, evidence, line.line)),
      ),
    ];
    signals.push({
      ...makeSignal(
        rule,
        file,
        "forbidden-added-text",
        `The configured literal substring ${JSON.stringify(literal)} occurs in ${matches.length} added diff line(s); the first occurrence is at head line ${first.line}. This is an investigation signal, not a confirmed defect.${evidenceIds.length === 0 ? " Obtain repository evidence before drawing a finding from this location." : ""}`,
        evidence,
      ),
      line: first.line,
      evidenceIds,
    });
  }
  if (file.truncated || file.additions > addedLines.length) {
    signals.push(
      makeSignal(
        rule,
        file,
        "inspection-incomplete",
        "The added-text predicate saw only a clipped or unavailable patch and cannot establish absence of matches outside the visible added lines.",
        evidence,
      ),
    );
  }
  return signals;
}

function makeSignal(
  rule: ConfiguredRule,
  file: ChangedFile,
  kind: ConfiguredRuleSignal["kind"],
  reason: string,
  evidence: ReviewEvidence[],
): ConfiguredRuleSignal {
  return {
    ruleId: rule.id,
    message: rule.message,
    severity: rule.severity,
    kind,
    path: file.path,
    line: null,
    reason,
    evidenceIds: file.excluded ? [] : diffEvidenceIds(file, evidence),
  };
}

function diffEvidenceIds(
  file: ChangedFile,
  evidence: ReviewEvidence[],
  line?: number,
): string[] {
  return evidence
    .filter((entry) => {
      if (entry.kind !== "diff") return false;
      if (line !== undefined)
        return (
          entry.path === file.path &&
          entry.revision === "head" &&
          entry.startLine <= line &&
          line <= entry.endLine
        );
      return entry.path === file.path || entry.path === file.previousPath;
    })
    .map((entry) => entry.id);
}

function matchesPath(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(path, pattern, { dot: true }));
}

function addedDiffLines(patch: string): Array<{ line: number; text: string }> {
  const added: Array<{ line: number; text: string }> = [];
  let headLine: number | null = null;
  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header?.[1]) {
      headLine = Number(header[1]);
      continue;
    }
    if (headLine === null) continue;
    if (line.startsWith("+"))
      added.push({ line: headLine++, text: line.slice(1) });
    else if (line.startsWith(" ")) headLine += 1;
  }
  return added;
}
