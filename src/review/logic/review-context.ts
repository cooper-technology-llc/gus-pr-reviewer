import type { ToolExecution } from "../review-ports.js";

interface SourceTextDefinition {
  id: string;
  text: string;
}

interface TextReference {
  textRef: string;
}

export interface ReviewContext {
  projectInput(content: string): string;
  projectTool(execution: ToolExecution): string;
}

/** Defines exact source text once within a stage while preserving every evidence record and its provenance. */
export function createReviewContext(): ReviewContext {
  const knownTexts = new Map<string, string>();

  const reference = (
    text: string,
    definitions: SourceTextDefinition[],
  ): TextReference => {
    const previous = knownTexts.get(text);
    if (previous !== undefined) return { textRef: previous };
    const id = `source-${knownTexts.size + 1}`;
    knownTexts.set(text, id);
    definitions.push({ id, text });
    return { textRef: id };
  };

  const project = (
    value: unknown,
    definitions: SourceTextDefinition[],
    field?: string,
  ): unknown => {
    if (typeof value === "string" && (field === "text" || field === "patch"))
      return reference(value, definitions);
    if (Array.isArray(value))
      return value.map((entry: unknown) => project(entry, definitions));
    if (value === null || typeof value !== "object") return value;
    const entries: Array<[string, unknown]> = Object.entries(value);
    return Object.fromEntries(
      entries.map(([key, entry]) => [key, project(entry, definitions, key)]),
    );
  };

  return {
    projectInput(content) {
      const sourceTexts: SourceTextDefinition[] = [];
      const payload = project(parsePayload(content), sourceTexts);
      return JSON.stringify({ format: "gus-context-v1", sourceTexts, payload });
    },
    projectTool(execution) {
      const sourceTexts: SourceTextDefinition[] = [];
      const payload = project(parsePayload(execution.content), sourceTexts);
      const evidence = project(execution.evidence, sourceTexts);
      return JSON.stringify({
        format: "gus-context-v1",
        sourceTexts,
        payload,
        evidence,
        inspectedPaths: execution.inspectedPaths,
        warnings: execution.warnings,
      });
    },
  };
}

function parsePayload(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}
