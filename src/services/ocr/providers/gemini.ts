import { readFileSync } from "node:fs";
import { ApiError, GoogleGenAI } from "@google/genai";
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
    const pdfBytes = readFileSync(req.pdfPath);
    const prompt = buildPrompt({
      schemaName: req.schemaName,
      schema: req.schema,
      examples: req.examples,
      override: req.prompt,
    });

    const genai = new GoogleGenAI({ apiKey: key.value });

    let raw: Awaited<ReturnType<typeof genai.models.generateContent>>;
    try {
      raw = await genai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "application/pdf",
              data: pdfBytes.toString("base64"),
            },
          },
        ],
        config: { responseMimeType: "application/json" },
      });
    } catch (err) {
      throw classifyProviderError(err);
    }

    // `response.text` is a getter that yields undefined when the candidate
    // carries no text part (safety block, empty candidates). Fail loud —
    // coercing to "" would surface as a JSON parse error and hide the cause.
    const text = raw.text;
    if (text === undefined) {
      throw new OcrProviderError(
        `Gemini returned no text part (finishReason=${raw.candidates?.[0]?.finishReason ?? "unknown"})`,
        "unknown",
      );
    }

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
      provider: this.id,
      attempts: 1,
      cached: false,
    };
  }
}

function classifyProviderError(err: unknown): OcrProviderError {
  const message = err instanceof Error ? err.message : String(err);

  // The SDK raises `ApiError` carrying the real HTTP status. Prefer it over
  // regexing the message: a message-format change would otherwise silently
  // downgrade a 429 to "unknown" and stop key rotation. The message regexes
  // below still cover transport errors, which are not `ApiError`s.
  if (err instanceof ApiError) {
    if (err.status === 429) return new OcrProviderError(message, "rate-limit", 429);
    if (err.status === 403) return new OcrProviderError(message, "quota-exhausted", 403);
    if (err.status === 401) return new OcrProviderError(message, "auth", 401);
    if (err.status >= 500) return new OcrProviderError(message, "transient", err.status);
  }

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
