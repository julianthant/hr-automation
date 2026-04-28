import { createHash } from "node:crypto";
import type { ZodType } from "zod/v4";
import { z } from "zod/v4";

export const PROMPT_VERSION = "v1";

export interface BuildPromptOpts<T> {
  schemaName: string;
  schema: ZodType<T>;
  examples?: Array<{ pdfPath?: string; output: T }>;
  override?: string;
}

/**
 * Convert a Zod schema to its JSON Schema form for LLM consumption.
 * Uses Zod v4's built-in toJSONSchema() if available, otherwise falls
 * back to a minimal description object.
 */
function toJsonSchemaSafe<T>(schema: ZodType<T>): unknown {
  const fn = (z as unknown as { toJSONSchema?: (s: ZodType<T>) => unknown }).toJSONSchema;
  if (typeof fn === "function") {
    try {
      return fn(schema);
    } catch {
      // Fall through.
    }
  }
  return { description: "Schema (Zod v4) — toJSONSchema unavailable; trust the type signature." };
}

export function computeSchemaJsonHash<T>(schema: ZodType<T>): string {
  const json = toJsonSchemaSafe(schema);
  const serialized = JSON.stringify(json);
  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

export function buildPrompt<T>(opts: BuildPromptOpts<T>): string {
  if (opts.override) return opts.override;
  const json = toJsonSchemaSafe(opts.schema);
  const exampleBlock = opts.examples?.length
    ? "\n\nExamples of valid output:\n" +
      opts.examples
        .map((e, i) => `Example ${i + 1}:\n${JSON.stringify(e.output, null, 2)}`)
        .join("\n\n")
    : "";
  return [
    `You are an OCR system. Extract structured data from the attached PDF.`,
    `The output type is "${opts.schemaName}". The output MUST be valid JSON matching this JSON Schema:`,
    "",
    JSON.stringify(json, null, 2),
    "",
    `Follow these rules:`,
    `- Extract every record visible in the PDF; produce one entry per record (one entry per PDF page when each page is a distinct form).`,
    `- For handwritten text, use your best transcription. If a field is illegible, set it to null where the schema allows.`,
    `- Phone numbers should be normalized to "(XXX) XXX-XXXX" format when the digits are clear.`,
    `- Addresses: keep US format. Pull out street, city, state (2-letter), and ZIP into separate fields if the schema requests them.`,
    `- Do not invent data. If a field is blank on the form, return null (or omit per schema).`,
    `- Output ONLY the JSON, no commentary.`,
    exampleBlock,
  ].join("\n");
}
