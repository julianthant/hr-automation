import { readEntries, type TrackerEntry } from "../tracker/jsonl.js";
import { createTaskStore } from "./task-store/index.js";
import { openControlDb } from "./control-db.js";

const KERNEL_DATA_KEYS = new Set(["instance", "__name", "__id"]);

/**
 * Single `readEntries` pass for retry: all rows matching `id`, plus subset
 * matching optional `runId` (tier-2 JSONL input selection uses only `scoped`).
 */
export function readEntriesForRetryItem(
  workflow: string,
  id: string,
  runId: string | undefined,
  dir: string,
): { allForId: TrackerEntry[]; scoped: TrackerEntry[] } {
  const allForId = readEntries(workflow, dir).filter((e) => e.id === id);
  const scoped = runId ? allForId.filter((e) => e.runId === runId) : allForId;
  return { allForId, scoped };
}

/** JSONL tiers 2–3 of retry input — caller supplies `scoped` from {@link readEntriesForRetryItem}. */
export function selectRetryInputFromEntries(
  entries: TrackerEntry[],
): Record<string, unknown> | undefined {
  if (entries.length === 0) return undefined;

  const pendingWithInput = entries
    .filter((e) => e.status === "pending" && Boolean(e.input))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  if (pendingWithInput.length > 0) {
    return pendingWithInput[0]!.input as Record<string, unknown>;
  }

  const anyWithInput = entries
    .filter((e) => Boolean(e.input))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  if (anyWithInput.length > 0) {
    return anyWithInput[0]!.input as Record<string, unknown>;
  }

  const sorted = [...entries].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  const data = sorted[0]!.data;
  if (data && typeof data === "object") {
    const input: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) {
      if (KERNEL_DATA_KEYS.has(k)) continue;
      input[k] = v;
    }
    if (Object.keys(input).length > 0) return input;
  }

  return undefined;
}

/**
 * Canonical retry-input lookup. Three tiers, returned in the first-hit order:
 *   1. SQLite task store keyed by runId (authoritative when available).
 *   2. JSONL row's stored `input` field (pending row preferred, else any).
 *   3. JSONL latest row's `data` minus kernel keys (best-effort reconstruct).
 *
 * Returns `undefined` only when nothing matched — caller decides whether
 * that is an error or a soft skip. Workflow schemas are non-strict
 * `z.object` so any extra fields produced by tier 3 are stripped at
 * validation time.
 */
export function findInputForRetry(
  workflow: string,
  id: string,
  runId: string | undefined,
  dir: string,
): Record<string, unknown> | undefined {
  if (runId) {
    const fromTask = findTaskInput(runId, dir);
    if (fromTask) return fromTask;
  }

  const { scoped } = readEntriesForRetryItem(workflow, id, runId, dir);
  return selectRetryInputFromEntries(scoped);
}

/** SQLite tier-1 retry input lookup (exported for dashboards that dedupe JSONL reads). */
export function findRetryInputFromTaskStore(
  runId: string,
  dir: string,
): Record<string, unknown> | null {
  return findTaskInput(runId, dir);
}

function findTaskInput(runId: string, dir: string): Record<string, unknown> | null {
  try {
    const store = createTaskStore(openControlDb({ trackerDir: dir }));
    const input = store.findInputForRunId(runId);
    return input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
