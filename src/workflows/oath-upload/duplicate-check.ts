import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { TrackerEntry } from "../../tracker/jsonl.js";

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
    const path = join(dir, f);
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (stat.mtimeMs < cutoffTs) break;
    let raw;
    try { raw = readFileSync(path, "utf-8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let entry: TrackerEntry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry.id || !entry.runId) continue;
      const key = `${entry.id}#${entry.runId}`;
      latestByRunKey.set(key, entry);
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
