import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildVisionPool } from "./per-page-pool.js";
import { hashKeyValue, type KeyState } from "./rotation.js";

export interface OcrKeyStatus {
  id: string;
  providerId: "gemini" | "mistral" | "groq" | "sambanova";
  state: KeyState;
  /** Daily request count tracked by KeyRotation. Only present for Gemini keys with rotation state. */
  dailyCount?: number;
}

interface PersistedEntry {
  state: KeyState;
  dailyCount: number;
  dailyEpochDay: number;
}

function readRotationState(path: string): Record<string, PersistedEntry> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf-8"),
    ) as { keys?: Record<string, PersistedEntry> };
    return parsed.keys ?? {};
  } catch {
    return {};
  }
}

/**
 * Returns the current status of every key in the OCR vision pool, combining
 * pool composition from env vars with persisted rotation state from `cacheDir`.
 *
 * Non-Gemini keys (Mistral, Groq, Sambanova) have no rotation state file —
 * they are reported as `available` with no daily count.
 */
export function getOcrKeyStatuses(cacheDir: string): OcrKeyStatus[] {
  const pool = buildVisionPool();
  const perPageState = readRotationState(
    join(cacheDir, "rotation-state-gemini-per-page.json"),
  );

  return pool.map((key): OcrKeyStatus => {
    if (key.providerId === "gemini" && key.rotationKey) {
      const hash = hashKeyValue(key.rotationKey);
      const entry = perPageState[hash];
      if (entry) {
        return {
          id: key.id,
          providerId: key.providerId,
          state: entry.state,
          dailyCount: entry.dailyCount,
        };
      }
    }
    return { id: key.id, providerId: key.providerId, state: { kind: "available" } };
  });
}
