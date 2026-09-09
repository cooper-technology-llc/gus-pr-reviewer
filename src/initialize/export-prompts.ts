import { loadBundledPrompts } from "../config/load-config.js";
import { stageSchema, type ReviewStage } from "../config/config-schema.js";
import { writeGeneratedFiles } from "./write-generated-files.js";

/** Export editable bundled prompts without replacing a user's previous customizations. */
export async function exportPrompts(
  directory: string,
  stage?: ReviewStage,
): Promise<string[]> {
  const prompts = await loadBundledPrompts();
  const stages = stage ? [stage] : stageSchema.options;
  return writeGeneratedFiles(
    directory,
    stages.map((name) => ({ path: `${name}.md`, text: `${prompts[name]}\n` })),
  );
}
