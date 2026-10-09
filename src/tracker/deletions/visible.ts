import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import type { LogEntry, TrackerEntry } from "../jsonl-core.js";
import {
  dateLocal,
  getRunIdOr,
  readEntries,
  readEntriesForDate,
  readLogEntries,
  readLogEntriesForDate,
  readRunsForId,
} from "../jsonl-core.js";
import { deletionsDir, parseSessionFilename } from "../paths.js";
import { isDeletionManifest } from "./types.js";
import type { Database } from "../../infra/sqlite/index.js";

function targetKey(workflow: string, trackerDate: string, itemId: string, runId: string): string {
  return `${workflow}\0${trackerDate}\0${itemId}\0${runId}`;
}

interface DeletionCacheEntry {
  signature: string;
  keys: Set<string>;
}

const deletionCache = new Map<string, DeletionCacheEntry>();

export function invalidateDeletedRunKeys(dir: string): void {
  deletionCache.delete(dir);
}

export function readDeletedRunKeys(dir: string): Set<string> {
  const root = deletionsDir(dir);
  const out = new Set<string>();
  if (!existsSync(root)) {
    deletionCache.delete(dir);
    return out;
  }
  const names = readdirSync(root).filter((name) => parseSessionFilename(name)).sort();
  const signature = names.map((name) => {
    const stat = statSync(join(root, name));
    return `${name}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  }).join("|");
  const cached = deletionCache.get(dir);
  if (cached?.signature === signature) return new Set(cached.keys);

  for (const name of names) {
    const path = join(root, name);
    const lines = readFileSync(path, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (error) {
        if (index === lines.length - 1) break;
        throw new Error(`Malformed deletion manifest in ${path}:${index + 1}`, { cause: error });
      }
      if (!isDeletionManifest(parsed)) {
        throw new Error(`Invalid deletion manifest in ${path}:${index + 1}`);
      }
      for (const target of parsed.targets) {
        out.add(targetKey(target.workflow, target.trackerDate, target.itemId, target.runId));
      }
    }
  }
  deletionCache.set(dir, { signature, keys: out });
  return new Set(out);
}

export function isDeletedRun(
  dir: string,
  target: { workflow: string; trackerDate: string; itemId: string; runId: string },
): boolean {
  return readDeletedRunKeys(dir).has(targetKey(target.workflow, target.trackerDate, target.itemId, target.runId));
}

export function isDeletedRunAnyDate(
  dir: string,
  target: { workflow: string; itemId: string; runId: string },
): boolean {
  const prefix = `${target.workflow}\0`;
  const suffix = `\0${target.itemId}\0${target.runId}`;
  return [...readDeletedRunKeys(dir)].some(
    (key) => key.startsWith(prefix) && key.endsWith(suffix),
  );
}

export function isRunTombstonedInDb(
  db: Database,
  target: { workflow: string; itemId: string; runId: string; trackerDate?: string },
): boolean {
  const dateClause = target.trackerDate ? "AND tracker_date = @trackerDate" : "";
  return Boolean(db.prepare(`
    SELECT 1 FROM deletion_tombstones
    WHERE workflow = @workflow AND item_id = @itemId AND run_id = @runId
      ${dateClause}
    LIMIT 1
  `).get(target));
}

export function filterVisibleTrackerEntries(
  entries: TrackerEntry[],
  trackerDate: string,
  dir: string,
): TrackerEntry[] {
  const deleted = readDeletedRunKeys(dir);
  return entries.filter((entry) => !deleted.has(targetKey(entry.workflow, trackerDate, entry.id, getRunIdOr(entry))));
}

export function filterVisibleLogEntries(
  entries: LogEntry[],
  trackerDate: string,
  dir: string,
): LogEntry[] {
  const deleted = readDeletedRunKeys(dir);
  return entries.filter((entry) => {
    const runId = entry.runId ?? `${entry.itemId}#1`;
    return !deleted.has(targetKey(entry.workflow, trackerDate, entry.itemId, runId));
  });
}

export function readVisibleEntries(workflow: string, dir: string): TrackerEntry[] {
  return filterVisibleTrackerEntries(readEntries(workflow, dir), dateLocal(), dir);
}

export function readVisibleEntriesForDate(workflow: string, date: string, dir: string): TrackerEntry[] {
  return filterVisibleTrackerEntries(readEntriesForDate(workflow, date, dir), date, dir);
}

export function readVisibleLogEntries(workflow: string, itemId: string | undefined, dir: string): LogEntry[] {
  return filterVisibleLogEntries(readLogEntries(workflow, itemId, dir), dateLocal(), dir);
}

export function readVisibleLogEntriesForDate(
  workflow: string,
  itemId: string | undefined,
  date: string,
  dir: string,
): LogEntry[] {
  return filterVisibleLogEntries(readLogEntriesForDate(workflow, itemId, date, dir), date, dir);
}

export function readVisibleRunsForId(workflow: string, itemId: string, date: string | undefined, dir: string) {
  const trackerDate = date ?? dateLocal();
  const deleted = readDeletedRunKeys(dir);
  return readRunsForId(workflow, itemId, date, dir).filter((run) => (
    !deleted.has(targetKey(workflow, trackerDate, itemId, run.runId))
  ));
}
