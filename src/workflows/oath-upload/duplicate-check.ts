import { existsSync, readdirSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import { readEntriesForDate, type TrackerEntry } from "../../tracker/jsonl.js";

export interface PriorRunSummary {
  sessionId: string;
  runId: string;
  startedAt: string;
  terminalStep: string;
  status: string;
  ticketNumber?: string;
  pdfOriginalName: string;
}

export interface FindPriorRunsOpts {
  hash: string;
  trackerDir?: string;
  /** Lookback in days. Default 30. */
  lookbackDays?: number;
}

/**
 * Walk the last N days of `oath-upload-*.jsonl` files, find every
 * (sessionId, runId) pair whose latest tracker entry has
 * `data.pdfHash === hash`, dedup to one row per sessionId (keeping
 * the latest run by timestamp), and return newest-first.
 */
export function findPriorRunsForHash(opts: FindPriorRunsOpts): PriorRunSummary[] {
  const dir = opts.trackerDir ?? ".tracker";
  const lookbackDays = opts.lookbackDays ?? 30;
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter((f) => f.startsWith("oath-upload-") && f.endsWith(".jsonl"))
    .sort()
    .reverse();
  const cutoffTs = Date.now() - lookbackDays * 24 * 60 * 60_000;

  // Pass 1: collect latest entry per (id, runId).
  const latestByRunKey = new Map<string, TrackerEntry>();
  for (const f of files) {
    const dateMatch = f.match(/^oath-upload-(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!dateMatch) continue;
    const fileDate = dateMatch[1];
    if (new Date(fileDate).getTime() < cutoffTs) break;
    for (const entry of readEntriesForDate("oath-upload", fileDate, dir)) {
      if (!entry.id || !entry.runId) continue;
      latestByRunKey.set(`${entry.id}#${entry.runId}`, entry);
    }
  }

  // Pass 2: filter to entries whose latest line has matching pdfHash.
  const matches: TrackerEntry[] = [];
  for (const e of latestByRunKey.values()) {
    if ((e.data?.pdfHash as unknown) === opts.hash) {
      matches.push(e);
    }
  }

  // Pass 3: dedup to latest run per sessionId.
  const latestPerSession = new Map<string, TrackerEntry>();
  for (const e of matches) {
    const cur = latestPerSession.get(e.id);
    if (!cur || (e.timestamp ?? "") > (cur.timestamp ?? "")) {
      latestPerSession.set(e.id, e);
    }
  }

  const summaries: PriorRunSummary[] = [];
  for (const e of latestPerSession.values()) {
    summaries.push({
      sessionId: e.id,
      runId: e.runId ?? "",
      startedAt: e.timestamp,
      terminalStep: e.step ?? "",
      status: e.status,
      ticketNumber:
        typeof e.data?.ticketNumber === "string" ? e.data.ticketNumber : undefined,
      pdfOriginalName:
        typeof e.data?.pdfOriginalName === "string" ? e.data.pdfOriginalName : "",
    });
  }
  summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return summaries;
}

/** Convenience: SHA-256 hex of a file at path. */
export async function sha256OfFile(path: string): Promise<string> {
  const buf = await fsp.readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}
