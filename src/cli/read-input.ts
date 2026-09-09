import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { parseJson } from "../config/load-config.js";
import { GusError } from "../errors.js";
import {
  checkResultSchema,
  type CheckResult,
} from "../review/review-schema.js";

export async function readJsonInput(
  path: string,
  label: string,
  maxBytes = 10000000,
): Promise<unknown> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > maxBytes)
    throw new GusError(
      "INPUT_INVALID",
      `${label} must be a file no larger than ${maxBytes} bytes.`,
    );
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > maxBytes)
    throw new GusError("INPUT_INVALID", `${label} exceeds its size limit.`);
  return parseJson(text, label);
}

export async function readChecks(path: string): Promise<CheckResult[]> {
  const parsed = z
    .array(checkResultSchema)
    .max(1000)
    .safeParse(await readJsonInput(path, "Checks input", 1000000));
  if (!parsed.success)
    throw new GusError(
      "INPUT_INVALID",
      "Checks must be a JSON array of { name, status, headSha, details?, url? }; status is passed, failed, not-run, or inconclusive.",
    );
  return parsed.data;
}
