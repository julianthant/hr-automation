import { readFileSync } from "node:fs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { buildPrompt } from "../prompts.js";
import {
  OcrProviderError,
  type OcrProvider,
  type OcrRequest,
  type OcrResult,
  type ProviderKey,
} from "../types.js";

/**
 * Gemini provider — single-shot multipart call with PDF as inline
 * application/pdf data + schema-derived prompt. Validation is deferred
 * to the orchestrator (so a validation failure can retry with hint
 * feedback, separately from rotation).
 */
export class GeminiProvider implements OcrProvider {
  id = "gemini";

  async call<T>(req: OcrRequest<T>, key: ProviderKey): Promise<OcrResult<T>> {
    const start = Date.now();
    const pdfBytes = readFileSync(req.pdfPath);
    const prompt = buildPrompt({
      schemaName: req.schemaName,
      schema: req.schema,
      examples: req.examples,
      override: req.prompt,
    });

    const genai = new GoogleGenerativeAI(key.value);
    const model = genai.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: {
        responseMimeType: "application/json",
      },
    });

    let raw: { response: { text(): string } };
    try {
      raw = await model.generateContent([
        { text: prompt },
        {
          inlineData: {
            mimeType: "application/pdf",
            data: pdfBytes.toString("base64"),
          },
        },
      ]);
    } catch (err) {
      throw classifyProviderError(err);
    }

    const text = raw.response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new OcrProviderError(
        `Gemini returned non-JSON: ${text.slice(0, 200)}`,
        "unknown",
      );
    }

    return {
      data: parsed as T,
      rawText: text,
      pageCount: 0, // populated by the orchestrator if needed
      provider: this.id,
      keyIndex: key.index,
      attempts: 1,
      cached: false,
      durationMs: Date.now() - start,
    };
  }
}

function classifyProviderError(err: unknown): OcrProviderError {
  const message = err instanceof Error ? err.message : String(err);
  if (/429|rate.?limit|too\s*many/i.test(message)) {
    return new OcrProviderError(message, "rate-limit", 429);
  }
  if (/quota|exhaust|exceed/i.test(message)) {
    return new OcrProviderError(message, "quota-exhausted", 403);
  }
  if (/401|unauthor|invalid\s*api\s*key|api\s*key\s*not\s*valid/i.test(message)) {
    return new OcrProviderError(message, "auth", 401);
  }
  if (/timeout|ECONNRESET|EAI_AGAIN|ENETUNREACH|ECONNREFUSED/i.test(message)) {
    return new OcrProviderError(message, "transient");
  }
  return new OcrProviderError(message, "unknown");
}
