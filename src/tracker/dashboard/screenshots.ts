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
 * Grouped screenshot entry - one per screenshot tracker event (or one
 * synthetic entry for all "legacy" files that have no matching event).
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
 * handler that reads `sessions.jsonl` and groups files by screenshot events,
 * surfacing unmatched / legacy files under a synthetic `kind=error label=legacy`
 * entry. When called with a string (or no args) it returns the legacy sync
 * flat-list handler - this overload is retained for backward compat with the
 * SSE enrichment loop.
 */
export function buildScreenshotsHandler(
  rootDir?: string,
): (workflow: string, itemId: string) => ScreenshotListEntry[];
export function buildScreenshotsHandler(deps: {
  dir: string;
  screenshotsDir: string;
}): (query: { workflow: string; itemId: string }) => Promise<ScreenshotGroupedEntry[]>;
export function buildScreenshotsHandler(
  arg: string | { dir: string; screenshotsDir: string } | undefined = SCREENSHOTS_DIR,
): unknown {
  // -- New grouped overload ----------------------------------------------------
  if (arg !== null && typeof arg === "object") {
    const { dir, screenshotsDir } = arg;
    return async function groupedHandler(
      query: { workflow: string; itemId: string },
    ): Promise<ScreenshotGroupedEntry[]> {
      const { workflow, itemId } = query;

      // Prefer SQLite when ready and populated.
      if (isStateDbReady(dir)) {
        const db = openStateDb(dir);
        const rows = queryScreenshotsForItem(db, { workflow, itemId });
        if (rows.length > 0) {
          // Recover group labels from screenshot session_events for every run
          // that has file rows — not only the newest run (otherwise prior-run
          // metadata is wrong and paths only on disk vanish from the grouped UI).
          const runIds = [
            ...new Set(rows.map((r) => r.run_id).filter((id): id is string => Boolean(id))),
          ];
          const screenshotEvents: ScreenshotSessionEvent[] = [];
          for (const rid of runIds) {
            for (const e of querySessionEventsForRun(db, { runId: rid })) {
              if (e.type === "screenshot") {
                screenshotEvents.push(e as unknown as ScreenshotSessionEvent);
              }
            }
          }
          let grouped = groupScreenshotRows(
            rows.filter((r) => existsSync(r.storage_path)),
            screenshotEvents,
          );
          // Match groupedHandlerLegacy: PNGs on disk matching the prefix must
          // appear even when they have no `files` row (pre-projection captures,
          // failed registration, etc.). Without this merge, a new run that
          // adds SQLite rows caused the handler to return early and hide
          // older on-disk shots.
          grouped = mergeDiskOnlyScreenshotFiles(grouped, { screenshotsDir, workflow, itemId });
          if (grouped.length > 0) return grouped;
        }
      }

      // Fallback: original JSONL + disk implementation, unchanged.
      return groupedHandlerLegacy({ dir, screenshotsDir, workflow, itemId });
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
 * Append any `.png` files under `screenshotsDir` with the workflow+itemId
 * prefix whose paths are not already represented in `grouped` (same rule as
 * step 3 of `groupedHandlerLegacy`).
 */
function mergeDiskOnlyScreenshotFiles(
  grouped: ScreenshotGroupedEntry[],
  opts: { screenshotsDir: string; workflow: string; itemId: string },
): ScreenshotGroupedEntry[] {
  const prefix = `${opts.workflow}-${opts.itemId}-`;
  const covered = new Set<string>();
  for (const g of grouped) {
    for (const f of g.files) {
      covered.add(f.path);
    }
  }
  const additions: ScreenshotGroupedEntry["files"] = [];
  let legacyTs = 0;
  if (!existsSync(opts.screenshotsDir)) return grouped;
  for (const f of readdirSync(opts.screenshotsDir)) {
    if (!f.endsWith(".png")) continue;
    if (!f.startsWith(prefix)) continue;
    const fullPath = join(opts.screenshotsDir, f);
    if (covered.has(fullPath)) continue;
    const tsMatch = f.match(/-(\d+)\.png$/);
    const fileTsNum = tsMatch ? Number(tsMatch[1]) : 0;
    const stripped = f.slice(prefix.length, -".png".length);
    const segs = stripped.split("-");
    let system = "unknown";
    if (segs.length >= 2) {
      system = segs[segs.length - 2];
    }
    if (fileTsNum > legacyTs) legacyTs = fileTsNum;
    additions.push({
      system,
      path: fullPath,
      url: `/screenshots/${encodeURIComponent(f)}`,
    });
  }
  if (additions.length === 0) return grouped;
  const legacyIdx = grouped.findIndex((e) => e.label === "legacy" && e.kind === "error");
  let out: ScreenshotGroupedEntry[];
  if (legacyIdx >= 0) {
    out = [...grouped];
    const prev = out[legacyIdx];
    out[legacyIdx] = {
      ...prev,
      files: [...prev.files, ...additions],
      ts: Math.max(prev.ts, legacyTs),
    };
  } else {
    out = [
      ...grouped,
      {
        ts: legacyTs,
        kind: "error",
        label: "legacy",
        step: null,
        files: additions,
      },
    ];
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

/**
 * Legacy grouped handler: reads sessions.jsonl and uses readdirSync.
 * Extracted so both the SQLite path and this path are unit-testable.
 */
async function groupedHandlerLegacy(opts: {
  dir: string;
  screenshotsDir: string;
  workflow: string;
  itemId: string;
}): Promise<ScreenshotGroupedEntry[]> {
  const { dir, screenshotsDir, workflow, itemId } = opts;
  const prefix = `${workflow}-${itemId}-`;

  // 1. Read every session file (legacy sessions.jsonl + dated
  //    sessions-YYYY-MM-DD.jsonl) via readSessionEvents and collect
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
      const matches = screenshotEv.files.some((f) => {
        const base = f.path.split(/[/\\]/).pop() ?? "";
        return base.startsWith(prefix);
      });
      if (matches) events.push(screenshotEv);
    }
  }

  // 2. Build grouped entries from events. Track which file paths are covered.
  //    Only include files that still exist on disk - sessions.jsonl persists
  //    across cleanup cycles so stale references are common.
  const coveredPaths = new Set<string>();
  const grouped: ScreenshotGroupedEntry[] = [];
  for (const ev of events) {
    const files: ScreenshotGroupedEntry["files"] = [];
    for (const f of ev.files) {
      if (!existsSync(f.path)) continue;
      coveredPaths.add(f.path);
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

  // 3. Enumerate files in screenshotsDir; any not already covered become
  //    synthetic legacy entries (grouped all under one label="legacy").
  const legacyFiles: ScreenshotGroupedEntry["files"] = [];
  let legacyTs = 0;
  if (existsSync(screenshotsDir)) {
    for (const f of readdirSync(screenshotsDir)) {
      if (!f.endsWith(".png")) continue;
      if (!f.startsWith(prefix)) continue;
      const fullPath = join(screenshotsDir, f);
      if (coveredPaths.has(fullPath)) continue;

      // Parse TS from trailing numeric segment before .png
      const tsMatch = f.match(/-(\d+)\.png$/);
      const fileTsNum = tsMatch ? Number(tsMatch[1]) : 0;

      // Determine system: second-to-last dash-segment before the ts
      const stripped = f.slice(prefix.length, -".png".length);
      const segs = stripped.split("-");
      let system = "unknown";
      if (segs.length >= 2) {
        system = segs[segs.length - 2];
      }

      if (fileTsNum > legacyTs) legacyTs = fileTsNum;
      legacyFiles.push({
        system,
        path: fullPath,
        url: `/screenshots/${encodeURIComponent(f)}`,
      });
    }
  }
  if (legacyFiles.length > 0) {
    grouped.push({
      ts: legacyTs,
      kind: "error",
      label: "legacy",
      step: null,
      files: legacyFiles,
    });
  }

  // 4. Sort newest-first.
  grouped.sort((a, b) => b.ts - a.ts);
  return grouped;
}

/**
 * Build grouped `ScreenshotGroupedEntry[]` from SQLite `FileRow[]` and
 * matching screenshot session events. Files without a matching event are
 * grouped under a synthetic `kind=error label=legacy` entry.
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
  const legacyFiles: ScreenshotGroupedEntry["files"] = [];
  let legacyTs = 0;

  for (const row of rows) {
    const ev = eventByPath.get(row.storage_path);
    const fileEntry = {
      system: ev?.system ?? "unknown",
      path: row.storage_path,
      url: `/screenshots/${encodeURIComponent(row.storage_path.split(/[/\\]/).pop() ?? "")}`,
    };
    if (ev) {
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
    } else {
      const fileTs = Date.parse(row.created_at);
      if (Number.isFinite(fileTs) && fileTs > legacyTs) legacyTs = fileTs;
      legacyFiles.push(fileEntry);
    }
  }

  const out = [...groupedByTs.values()];
  if (legacyFiles.length > 0) {
    out.push({
      ts: legacyTs,
      kind: "error",
      label: "legacy",
      step: null,
      files: legacyFiles,
    });
  }
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
