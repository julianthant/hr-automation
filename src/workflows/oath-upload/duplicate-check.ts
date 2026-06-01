import { existsSync, readdirSync } from "node:fs";
import { promises as fsp } from "node:fs";
import { createHash } from "node:crypto";
import { openControlDb } from "../../core/control-db.js";
import { readEntriesForDate, rowsDir, type TrackerEntry } from "../../tracker/jsonl.js";

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

function parseDataJson(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
      else if (v !== null && v !== undefined) out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * SQLite-first: query the items projection for oath-upload rows whose
 * latest_data_json contains pdfHash === hash. Falls back to 30-day JSONL
 * walk when SQLite is unavailable.
 */
export function findPriorRunsForHash(opts: FindPriorRunsOpts): PriorRunSummary[] {
  const dir = opts.trackerDir ?? ".tracker";
  const lookbackDays = opts.lookbackDays ?? 30;

  // SQLite fast path.
  try {
    const controlDb = openControlDb({ trackerDir: dir });
    try {
      const cutoffDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60_000)
        .toISOString()
        .slice(0, 10);
      const rows = controlDb.db.prepare(`
        SELECT item_id, latest_run_id, latest_ts, latest_status, latest_step,
               latest_data_json, latest_error
        FROM items
        WHERE workflow = 'oath-upload'
          AND latest_ts >= @cutoffDate
          AND json_extract(latest_data_json, '$.pdfHash') = @hash
        ORDER BY latest_ts DESC
      `).all({ cutoffDate, hash: opts.hash }) as {
        item_id: string;
        latest_run_id: string;
        latest_ts: string;
        latest_status: string;
        latest_step: string | null;
        latest_data_json: string | null;
        latest_error: string | null;
      }[];

      if (rows.length > 0) {
        return rows.map((row) => {
          const data = parseDataJson(row.latest_data_json);
          return {
            sessionId: row.item_id,
            runId: row.latest_run_id,
            startedAt: row.latest_ts,
            terminalStep: row.latest_step ?? "",
            status: row.latest_status,
            ticketNumber: typeof data.ticketNumber === "string" ? data.ticketNumber : undefined,
            pdfOriginalName: typeof data.pdfOriginalName === "string" ? data.pdfOriginalName : "",
          };
        });
      }
    } finally {
      controlDb.close();
    }
  } catch {
    // SQLite unavailable or schema mismatch — fall through to JSONL.
  }

  // JSONL fallback. Tracker rows live in the `rows/` subdirectory.
  const rows = rowsDir(dir);
  if (!existsSync(rows)) return [];

  const files = readdirSync(rows)
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
