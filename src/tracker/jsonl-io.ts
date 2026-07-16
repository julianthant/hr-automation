import { appendJsonlWithSource } from "./state/jsonl-source.js";
import { applyLogEntryLive, applySessionEventLive, applyTrackerEntryLive } from "./state/runtime.js";
import { getSessionsFilePathForDate } from "./session-events.js";
import type { ScreenshotSessionEvent } from "./session-event-types.js";
import { findLatestEntryForPredicate } from "./find-latest-entry.js";
import { rowFilePath } from "./paths.js";
import {
  DEFAULT_DIR,
  dateLocal,
  getLogsJsonlPathForDate,
  type LogEntry,
  type TrackerEntry,
  type TrackerRowEmission,
} from "./jsonl-core.js";

/**
 * WRITE half of the tracker JSONL layer: append-to-disk + live SQLite
 * projection. The pure types/validators/read primitives live in the leaf
 * `jsonl-core.ts` (re-exported below, so this module's public surface — and
 * the `jsonl.ts` barrel's — is unchanged). Split rationale: `utils/log.ts`
 * persists through `appendLogEntry`, so nothing reachable from this module
 * may import the logger (see `log-sink.ts` + the import-cycles ratchet).
 */
export * from "./jsonl-core.js";

export function appendLogEntry(entry: LogEntry, dir: string = DEFAULT_DIR): void {
  const scrubbed: LogEntry = { ...entry, message: String(entry.message ?? "") };
  const entryDate = dateLocal(new Date(scrubbed.ts));
  const logPath = getLogsJsonlPathForDate(scrubbed.workflow, dir, entryDate);
  const source = appendJsonlWithSource(logPath, scrubbed, {
    sourceKind: "log",
    workflow: scrubbed.workflow,
    trackerDate: entryDate,
  });
  applyLogEntryLive(scrubbed, source, dir);
}

function getTrackerJsonlPath(workflow: string, dir: string): string {
  return rowFilePath(workflow, dateLocal(), dir);
}

/**
 * Internal — write a tracker entry to disk without enforcing the
 * archetype-stamping contract. Used by:
 *   - {@link emitTrackerRow} and {@link emitTrackerRowForDate} after the
 *     compile-time contract has been satisfied.
 *   - The SIGINT/SIGTERM handler in `tracked-workflow.ts`, which already
 *     stamps `data.archetype` via the wrapper's seeded `data` object.
 *
 * New production emit sites must NOT call this directly — the architecture
 * guard `tests/unit/architecture/tracker-row-emission.test.ts` fails the
 * build for any caller outside the tracker module and the SIGINT handler.
 */
export function writeTrackerEntryRaw(entry: TrackerEntry, dir: string = DEFAULT_DIR): void {
  const logPath = getTrackerJsonlPath(entry.workflow, dir);
  const source = appendJsonlWithSource(logPath, entry, {
    sourceKind: "tracker",
    workflow: entry.workflow,
    trackerDate: dateLocal(new Date(entry.timestamp)),
  });
  applyTrackerEntryLive(entry, source, dir);
}

/** Internal — see {@link writeTrackerEntryRaw}. Targets a specific date file. */
export function writeTrackerEntryRawForDate(
  entry: TrackerEntry,
  date: string,
  dir: string = DEFAULT_DIR,
): void {
  const logPath = rowFilePath(entry.workflow, date, dir);
  const source = appendJsonlWithSource(logPath, entry, {
    sourceKind: "tracker",
    workflow: entry.workflow,
    trackerDate: date,
  });
  applyTrackerEntryLive(entry, source, dir);
}

/**
 * Canonical tracker row emission. Replaces the legacy `trackEvent` direct
 * write. The `data: StampedData` parameter makes archetype stamping a
 * compile-time requirement — see the `StampedData` comment in `jsonl-core.ts`.
 */
export function emitTrackerRow(emission: TrackerRowEmission, dir: string = DEFAULT_DIR): void {
  writeTrackerEntryRaw(emission, dir);
}

/**
 * Append a tracker entry to a *specific* date file (instead of today's).
 * Used by the prep-row HTTP handlers (approve / discard) so resolution
 * lines land in the same file as the row's existing history — otherwise
 * the dashboard's per-date SSE never sees them when the operator resolves
 * a row created on a previous local day.
 */
export function emitTrackerRowForDate(
  emission: TrackerRowEmission,
  date: string,
  dir: string = DEFAULT_DIR,
): void {
  writeTrackerEntryRawForDate(emission, date, dir);
}

// ── Legacy compatibility aliases ───────────────────────────────────────
//
// `trackEvent` and `trackEventForDate` remain as thin wrappers so existing
// call sites continue to compile. They accept the loose `TrackerEntry`
// shape (data optional, archetype not type-enforced). New code must use
// `emitTrackerRow` / `emitTrackerRowForDate` instead — the architecture
// guard `tests/unit/architecture/tracker-row-emission.test.ts` blocks new
// uses of the legacy alias.

/** @deprecated Use {@link emitTrackerRow}. */
export function trackEvent(entry: TrackerEntry, dir: string = DEFAULT_DIR): void {
  writeTrackerEntryRaw(entry, dir);
}

/** @deprecated Use {@link emitTrackerRowForDate}. */
export function trackEventForDate(
  entry: TrackerEntry,
  date: string,
  dir: string = DEFAULT_DIR,
): void {
  writeTrackerEntryRawForDate(entry, date, dir);
}

/**
 * Walk `lookbackDays` of `{workflow}-YYYY-MM-DD.jsonl` oldest→newest and return
 * the latest line per `(id, runId)` key. Used by dashboard restart sweeps.
 */
export function readLatestTrackerEntriesByRunKey(
  workflow: string,
  dir: string = DEFAULT_DIR,
  lookbackDays = 7,
  now: Date = new Date(),
): Map<string, TrackerEntry> {
  const newestFirst: TrackerEntry[] = [];
  findLatestEntryForPredicate({
    workflow,
    trackerDir: dir,
    lookbackDays,
    now,
    predicate: (entry) => {
      newestFirst.push(entry);
      return false;
    },
  });

  const latestByKey = new Map<string, TrackerEntry>();
  for (let i = newestFirst.length - 1; i >= 0; i--) {
    const entry = newestFirst[i];
    const key = `${entry.id}#${entry.runId ?? ""}`;
    latestByKey.set(key, entry);
  }
  return latestByKey;
}

export function emitScreenshotEvent(
  event: ScreenshotSessionEvent,
  opts?: { dir?: string },
): void {
  const dir = opts?.dir ?? DEFAULT_DIR;
  // Route to the dated file matching the event's local date, consistent with
  // how emitSessionEvent routes session events in session-events.ts.
  const trackerDate = dateLocal(new Date(event.timestamp));
  const path = getSessionsFilePathForDate(trackerDate, dir);
  const source = appendJsonlWithSource(path, event, {
    sourceKind: "session",
    trackerDate,
  });
  applySessionEventLive(event, source, dir);
}
