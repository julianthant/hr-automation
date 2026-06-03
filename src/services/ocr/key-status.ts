import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildVisionPool } from "./per-page-pool.js";
import type { VisionProviderId } from "./provider-limits.js";
import { hashKeyValue, type KeyState } from "./rotation.js";

export interface OcrKeyStatus {
  id: string;
  providerId: VisionProviderId;
  state: KeyState;
  /** Sum of requests today across this key's model cells (excludes the quota sentinel). */
  dailyCount?: number;
}

interface PersistedCell {
  rpdCount: number;
  rpdEpochDay: number;
  cooldownUntilMs: number;
  dead: boolean;
}
interface PersistedState {
  cells: Record<string, PersistedCell>;
}

/** penalize() parks the rpd count at ~MAX/2 to mark a daily wall; treat that as quota. */
const QUOTA_SENTINEL = 1e6;

const STATE_RANK: Record<KeyState["kind"], number> = {
  available: 0,
  throttled: 1,
  "quota-exhausted": 2,
  dead: 3,
};

function loadCells(path: string): Record<string, PersistedCell> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as PersistedState;
    return parsed.cells ?? {};
  } catch {
    return {};
  }
}

function cellState(c: PersistedCell, nowMs: number): KeyState {
  if (c.dead) return { kind: "dead" };
  if (c.cooldownUntilMs > nowMs) {
    return c.rpdCount >= QUOTA_SENTINEL
      ? { kind: "quota-exhausted", untilMs: c.cooldownUntilMs }
      : { kind: "throttled", untilMs: c.cooldownUntilMs };
  }
  return { kind: "available" };
}

/**
 * Current status of every key in the OCR vision pool, combining pool
 * composition (env vars) with the usage tracker's persisted state. Each key's
 * status is the worst state across its model fallback chain, with the daily
 * request count summed across those models. No state file (fresh run) ⇒ every
 * key reports `available` with no count.
 */
export function getOcrKeyStatuses(cacheDir: string): OcrKeyStatus[] {
  const pool = buildVisionPool();
  const cells = loadCells(join(cacheDir, "ocr-usage-state.json"));
  const now = Date.now();

  return pool.map((key): OcrKeyStatus => {
    const hash = hashKeyValue(key.rotationKey);
    let worst: KeyState = { kind: "available" };
    let daily = 0;
    let seen = false;
    for (const m of key.models) {
      const c = cells[`${key.providerId}::${hash}::${m.id}`];
      if (!c) continue;
      seen = true;
      if (c.rpdCount < QUOTA_SENTINEL) daily += c.rpdCount;
      const s = cellState(c, now);
      if (STATE_RANK[s.kind] > STATE_RANK[worst.kind]) worst = s;
    }
    return { id: key.id, providerId: key.providerId, state: worst, dailyCount: seen ? daily : undefined };
  });
}
