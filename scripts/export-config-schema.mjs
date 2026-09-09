import { writeFile } from "node:fs/promises";
import { format } from "prettier";
import { z } from "zod";
import { configSchema } from "../dist/config/config-schema.js";

const schema = z.toJSONSchema(configSchema, { io: "input" });
await writeFile(
  new URL("../gus.config.schema.json", import.meta.url),
  await format(JSON.stringify(schema), { parser: "json" }),
);
