import { OcrProviderError } from "./types.js";

export type OcrErrorClass =
  | "rate-limit"
  | "quota-exhausted"
  | "auth"
  | "transient"
  | "permanent";

export function classifyOcrError(err: unknown): OcrErrorClass {
  if (err instanceof OcrProviderError) {
    switch (err.kind) {
      case "rate-limit":
        return "rate-limit";
      case "quota-exhausted":
        return "quota-exhausted";
      case "auth":
        return "auth";
      case "transient":
        return "transient";
      case "unknown":
        return "permanent";
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/401|unauthor|invalid\s*api\s*key/i.test(message)) return "auth";
  if (/quota|exhaust/i.test(message)) return "quota-exhausted";
  if (/429|rate.?limit|too many requests/i.test(message)) return "rate-limit";
  if (/ECONNRESET|ETIMEDOUT|503|504/i.test(message)) return "transient";
  return "permanent";
}
