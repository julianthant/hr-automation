import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { PATHS } from "../../config.js";
import { readSessionEvents } from "../session-events.js";
import { isStateDbReady, openStateDb } from "../state/db.js";
import { queryScreenshotsForItem, type FileRow } from "../state/file-queries.js";
import { querySessionEventsForRun } from "../state/queries.js";
import type { ScreenshotSessionEvent } from "../session-events.js";

/** Default root dir for kernel failure screenshots. Matches `screenshotAll`. */
export const SCREENSHOTS_DIR = PATHS.screenshotDir;

export interface ScreenshotListEntry {
  filename: string;
  ts: string; // ISO-8601
  sizeBytes: number;
  step: string;
}

/**
 * Grouped screenshot entry — one per emitted screenshot session event that
 * still has files on disk (SQLite path joins `files` rows to those events).
 * Returned by the `{ dir, screenshotsDir }` overload of
 * `buildScreenshotsHandler`.
 */
export interface ScreenshotGroupedEntry {
  ts: number;
  kind: "form" | "error" | "manual";
  label: string;
  step: string | null;
  files: Array<{ system: string; path: string; url: string }>;
}

/**
 * Build a handler that lists PNGs in `.screenshots/` whose filename matches
 * `<workflow>-<itemId>-*`. Injectable root dir so tests can point at a
 * temp fixture dir. Returns `[]` when the dir doesn't exist or the prefix
 * matches nothing. Filenames produced by `Session.screenshotAll` have shape
 * `<workflow>-<itemId>-<step>-<systemId>-<timestamp>.png`; we parse `step` +
 * `ts` heuristically so the UI can show useful captions.
 *
 * Overloaded: when called with `{ dir, screenshotsDir }` it returns an async
 * handler that lists only screenshots tied to emitted screenshot session events
 * (plus SQLite `files` rows matched to those events). Orphan PNGs on disk are
 * ignored. When called with a string (or no args) it returns the legacy sync
 * flat-list handler - this overload is retained for backward compat with the
 * SSE enrichment loop.
 */
export function buildScreenshotsHandler(
  rootDir?: string,
): (workflow: string, itemId: string) => ScreenshotListEntry[];
export function buildScreenshotsHandler(deps: {
  dir: string;
  screenshotsDir: string;
}): (query: {
  workflow: string;
  itemId: string;
  /** When set, only screenshots registered to this tracker run (strict SQLite + filtered session events; skips unattributed disk orphans). */
  runId?: string | null;
}) => Promise<ScreenshotGroupedEntry[]>;
export function buildScreenshotsHandler(
  arg: string | { dir: string; screenshotsDir: string } | undefined = SCREENSHOTS_DIR,
): unknown {
  // -- New grouped overload ----------------------------------------------------
  if (arg !== null && typeof arg === "object") {
    const { dir, screenshotsDir } = arg;
    return async function groupedHandler(
      query: { workflow: string; itemId: string; runId?: string | null },
    ): Promise<ScreenshotGroupedEntry[]> {
      const { workflow, itemId } = query;
      const runId = query.runId?.trim() || undefined;

      // Prefer SQLite when ready and populated.
      if (isStateDbReady(dir)) {
        const db = openStateDb(dir);
        const rows = queryScreenshotsForItem(db, { workflow, itemId, runId });
        if (rows.length > 0) {
          const screenshotEvents: ScreenshotSessionEvent[] = [];
          if (runId) {
            for (const e of querySessionEventsForRun(db, { runId })) {
              if (e.type === "screenshot") {
                screenshotEvents.push(e as unknown as ScreenshotSessionEvent);
              }
            }
          } else {
            const runIds = [
              ...new Set(rows.map((r) => r.run_id).filter((id): id is string => Boolean(id))),
            ];
            for (const rid of runIds) {
              for (const e of querySessionEventsForRun(db, { runId: rid })) {
                if (e.type === "screenshot") {
                  screenshotEvents.push(e as unknown as ScreenshotSessionEvent);
                }
              }
            }
          }
          const grouped = groupScreenshotRows(
            rows.filter((r) => existsSync(r.storage_path)),
            screenshotEvents,
          );
          if (grouped.length > 0) return grouped;
        }
      }

      return groupedHandlerLegacy({ dir, screenshotsDir, workflow, itemId, runId });
    };
  }

  // -- Legacy flat-list overload (backward compat) ----------------------------
  const rootDir: string = typeof arg === "string" ? arg : SCREENSHOTS_DIR;

  // SQLite-first path for flat-list: try to build ScreenshotListEntry[] from
  // the files table. Falls back to readdirSync if the DB is not ready or has
  // no rows for this item.
  return (workflow: string, itemId: string): ScreenshotListEntry[] => {
    // Note: this overload is intentionally sync; SQLite reads are sync too.
    if (isStateDbReady(rootDir)) {
      // rootDir here is the screenshotsDir (legacy overload), not a tracker dir.
      // The flat-list overload doesn't have a tracker dir, only a screenshotsDir.
      // So we fall through to the legacy readdirSync path for the flat-list.
    }
    // Legacy readdirSync path (always used for flat-list overload — no tracker
    // dir is available in this overload).
    if (!existsSync(rootDir)) return [];
    const prefix = `${workflow}-${itemId}-`;
    const out: ScreenshotListEntry[] = [];
    for (const f of readdirSync(rootDir)) {
      if (!f.endsWith(".png")) continue;
      if (!f.startsWith(prefix)) continue;
      const full = join(rootDir, f);
      let sizeBytes: number;
      try {
        sizeBytes = statSync(full).size;
      } catch {
        continue;
      }
      // Parse step + ts from the tail. Filename shape:
      //   <workflow>-<itemId>-<step>-<systemId>-<ts>.png
      // We can't split blindly because step names themselves can contain
      // dashes (e.g. "crm-auth"). Strategy: strip prefix, strip `.png`, split
      // by "-", take the trailing two segments as systemId + ts, the rest is
      // step. If the remainder is empty (malformed), leave step="".
      const stripped = f.slice(prefix.length, -".png".length);
      const segs = stripped.split("-");
      let step = "";
      let tsRaw = "";
      if (segs.length >= 3) {
        tsRaw = segs[segs.length - 1];
        // segs[segs.length - 2] is systemId - discarded in the UI caption
        step = segs.slice(0, segs.length - 2).join("-");
      } else if (segs.length === 2) {
        // Legacy: no step in the filename. Keep step empty.
        tsRaw = segs[1];
      }
      const tsNum = Number(tsRaw);
      const iso = Number.isFinite(tsNum) && tsNum > 0 ? new Date(tsNum).toISOString() : "";
      out.push({ filename: f, ts: iso, sizeBytes, step });
    }
    // Newest first - the UI scrolls horizontally, so latest on the left.
    out.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    return out;
  };
}

// ── Private helpers ─────────────────────────────────────────────────────────

/**
 * Legacy grouped handler: reads session snapshots via `readSessionEvents` (no
 * SQLite disk orphan merge). Extracted so both the SQLite path and this path
 * are unit-testable.
 */
async function groupedHandlerLegacy(opts: {
  dir: string;
  screenshotsDir: string;
  workflow: string;
  itemId: string;
  runId?: string;
}): Promise<ScreenshotGroupedEntry[]> {
  const { dir, workflow, itemId, runId } = opts;
  const prefix = `${workflow}-${itemId}-`;

  // 1. Read every dated session snapshot via readSessionEvents and collect
  //    screenshot events whose files touch the requested workflow/itemId.
  const events: ScreenshotSessionEvent[] = [];
  for (const ev of readSessionEvents(dir) as unknown as Array<Record<string, unknown>>) {
    if (
      ev !== null &&
      typeof ev === "object" &&
      ev["type"] === "screenshot" &&
      "files" in ev
    ) {
      const screenshotEv = ev as unknown as ScreenshotSessionEvent;
      if (runId && screenshotEv.runId !== runId) continue;
      const matches = screenshotEv.files.some((f) => {
        const base = f.path.split(/[/\\]/).pop() ?? "";
        return base.startsWith(prefix);
      });
      if (matches) events.push(screenshotEv);
    }
  }

  // 2. Build grouped entries from events (skip stale paths missing from disk).
  const grouped: ScreenshotGroupedEntry[] = [];
  for (const ev of events) {
    const files: ScreenshotGroupedEntry["files"] = [];
    for (const f of ev.files) {
      if (!existsSync(f.path)) continue;
      files.push({
        system: f.system,
        path: f.path,
        url: `/screenshots/${encodeURIComponent(f.path.split(/[/\\]/).pop() ?? "")}`,
      });
    }
    // Skip the entire entry if none of its files survived cleanup.
    if (files.length === 0) continue;
    grouped.push({
      ts: ev.ts,
      kind: ev.kind,
      label: ev.label,
      step: ev.step,
      files,
    });
  }

  // 3. Sort newest-first.
  grouped.sort((a, b) => b.ts - a.ts);
  return grouped;
}

/**
 * Build grouped `ScreenshotGroupedEntry[]` from SQLite `FileRow[]` and
 * matching screenshot session events. Rows with no matching event are dropped
 * (projection drift); they are not listed as orphan “legacy” captures.
 */
function groupScreenshotRows(
  rows: FileRow[],
  events: ScreenshotSessionEvent[],
): ScreenshotGroupedEntry[] {
  const eventByPath = new Map<
    string,
    {
      ts: number;
      kind: "form" | "error" | "manual";
      label: string;
      step: string | null;
      system: string;
    }
  >();
  for (const ev of events) {
    for (const f of ev.files) {
      eventByPath.set(f.path, {
        ts: ev.ts,
        kind: ev.kind,
        label: ev.label,
        step: ev.step,
        system: f.system,
      });
    }
  }
  const groupedByTs = new Map<number, ScreenshotGroupedEntry>();

  for (const row of rows) {
    const ev = eventByPath.get(row.storage_path);
    if (!ev) continue;

    const fileEntry = {
      system: ev.system,
      path: row.storage_path,
      url: `/screenshots/${encodeURIComponent(row.storage_path.split(/[/\\]/).pop() ?? "")}`,
    };
    const existing = groupedByTs.get(ev.ts);
    if (existing) {
      existing.files.push(fileEntry);
    } else {
      groupedByTs.set(ev.ts, {
        ts: ev.ts,
        kind: ev.kind,
        label: ev.label,
        step: ev.step,
        files: [fileEntry],
      });
    }
  }

  const out = [...groupedByTs.values()];
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

/**
 * Path-traversal-safe resolver. Accepts a screenshot filename (no path
 * separators) and returns the absolute path inside `rootDir`, or null if the
 * filename is malicious or the file doesn't exist inside the root.
 */
export function resolveScreenshotPath(
  filename: string,
  rootDir: string = SCREENSHOTS_DIR,
): string | null {
  // Cheap guard - no separators allowed, no "..".
  if (!filename || filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    return null;
  }
  const rootAbs = resolve(rootDir);
  const fileAbs = resolve(rootDir, filename);
  // Defense in depth - ensure the resolved path is inside rootDir.
  const normalized = fileAbs + (fileAbs.endsWith(sep) ? "" : "");
  if (!normalized.startsWith(rootAbs + sep) && normalized !== rootAbs) {
    return null;
  }
  if (!existsSync(fileAbs)) return null;
  return fileAbs;
}
