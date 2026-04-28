import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OcrAllKeysExhaustedError, type ProviderKey } from "./types.js";

export type KeyState =
  | { kind: "available" }
  | { kind: "throttled"; untilMs: number }
  | { kind: "quota-exhausted"; untilMs: number }
  | { kind: "dead" };

interface KeyEntry {
  state: KeyState;
  dailyCount: number;
  dailyEpochDay: number;
}

interface PersistedState {
  /** Map keyHash → KeyEntry. */
  keys: Record<string, KeyEntry>;
}

function dayUtc(ms = Date.now()): number {
  return Math.floor(ms / (24 * 3600_000));
}

/** Tiny non-cryptographic hash — just to dedupe the value in the state file. */
function hashKey(value: string): string {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = ((h << 5) - h + value.charCodeAt(i)) | 0;
  return `k${(h >>> 0).toString(36)}`;
}

/**
 * Multi-key rotation state machine. Tracks per-key availability +
 * persisted daily request counts, picks the available key with the
 * smallest daily count on each `pickNext()`. Caller marks keys
 * via `markRateLimited / markQuotaExhausted / markDead / markSuccess`
 * after the provider call returns.
 *
 * State persists at `<cacheDir>/rotation-state-<providerId>.json`
 * (debounce flush via explicit `flush()` call from the orchestrator).
 */
export class KeyRotation {
  private state = new Map<string, KeyEntry>();
  private statePath: string;

  constructor(public providerId: string, private rawKeys: readonly string[], cacheDir: string) {
    this.statePath = join(cacheDir, `rotation-state-${providerId}.json`);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.statePath)) return;
    try {
      const persisted = JSON.parse(readFileSync(this.statePath, "utf-8")) as PersistedState;
      for (const [hash, entry] of Object.entries(persisted.keys ?? {})) {
        this.state.set(hash, entry);
      }
    } catch {
      // Corrupt state — start fresh.
    }
  }

  flush(): void {
    const dir = dirname(this.statePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const persisted: PersistedState = { keys: {} };
    for (const [hash, entry] of this.state) persisted.keys[hash] = entry;
    writeFileSync(this.statePath, JSON.stringify(persisted, null, 2));
  }

  private getEntry(hash: string): KeyEntry {
    let e = this.state.get(hash);
    if (!e) {
      e = { state: { kind: "available" }, dailyCount: 0, dailyEpochDay: dayUtc() };
      this.state.set(hash, e);
    }
    const today = dayUtc();
    if (e.dailyEpochDay !== today) {
      e.dailyCount = 0;
      e.dailyEpochDay = today;
      if (e.state.kind === "quota-exhausted" && e.state.untilMs <= Date.now()) {
        e.state = { kind: "available" };
      }
    }
    if (e.state.kind === "throttled" && e.state.untilMs <= Date.now()) {
      e.state = { kind: "available" };
    }
    return e;
  }

  pickNext(): ProviderKey {
    let best: { hash: string; index: number; value: string; dailyCount: number } | null = null;
    for (let i = 0; i < this.rawKeys.length; i++) {
      const value = this.rawKeys[i];
      const hash = hashKey(value);
      const e = this.getEntry(hash);
      if (e.state.kind !== "available") continue;
      if (!best || e.dailyCount < best.dailyCount) {
        best = { hash, index: i + 1, value, dailyCount: e.dailyCount };
      }
    }
    if (!best) {
      throw new OcrAllKeysExhaustedError(this.providerId, this.rawKeys.length);
    }
    // Increment optimistically — caller's mark* may move state if the call fails.
    const e = this.getEntry(best.hash);
    e.dailyCount += 1;
    return { index: best.index, value: best.value };
  }

  private setState(key: ProviderKey, state: KeyState): void {
    const hash = hashKey(key.value);
    const e = this.getEntry(hash);
    e.state = state;
  }

  markRateLimited(key: ProviderKey, untilMs: number): void {
    this.setState(key, { kind: "throttled", untilMs });
  }
  markQuotaExhausted(key: ProviderKey, untilMs: number): void {
    this.setState(key, { kind: "quota-exhausted", untilMs });
  }
  markDead(key: ProviderKey): void {
    this.setState(key, { kind: "dead" });
  }
  markSuccess(_key: ProviderKey): void {
    // Optional: could clear transient throttle. No-op for now.
  }

  /** For tests / debugging. */
  inspect(): readonly { hash: string; state: KeyState; dailyCount: number }[] {
    return [...this.state.entries()].map(([hash, e]) => ({
      hash,
      state: e.state,
      dailyCount: e.dailyCount,
    }));
  }
}
