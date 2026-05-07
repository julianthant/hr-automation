import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OcrResult } from "./types.js";

export interface CacheKeyParts {
  pdfBytes: Buffer;
  schemaName: string;
  schemaJsonHash: string;
  promptVersion: string;
}

/** SHA-256 over (pdfBytes || schemaName || schemaJsonHash || promptVersion). */
export function computeCacheKey(parts: CacheKeyParts): string {
  const h = createHash("sha256");
  h.update(parts.pdfBytes);
  h.update("\0");
  h.update(parts.schemaName);
  h.update("\0");
  h.update(parts.schemaJsonHash);
  h.update("\0");
  h.update(parts.promptVersion);
  return h.digest("hex");
}

export function cachePath(dir: string, key: string): string {
  return join(dir, `${key}.json`);
}

export function readCache<T>(dir: string, key: string): OcrResult<T> | undefined {
  const p = cachePath(dir, key);
  if (!existsSync(p)) return undefined;
  try {
    const raw = readFileSync(p, "utf-8");
    return JSON.parse(raw) as OcrResult<T>;
  } catch {
    return undefined;
  }
}

export function writeCache<T>(dir: string, key: string, result: OcrResult<T>): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = cachePath(dir, key);
  writeFileSync(p, JSON.stringify(result, null, 2));
}
