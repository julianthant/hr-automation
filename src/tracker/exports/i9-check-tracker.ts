/**
 * Master I-9 retention tracker spreadsheet.
 *
 * Every completed separations i9-check member appends ONE row to a single
 * master xlsx (`PATHS.i9CheckTrackerPath`, one worksheet — NOT the daily-tab
 * `appendRow` model in `spreadsheet.ts`). Columns mirror the operator's
 * retention tracking sheet. Re-runs append again — dedupe is manual and the
 * run-modal copy says so.
 *
 * Concurrency: members run sequentially in one daemon, but the operator can
 * spawn several separations daemons, so appends are guarded by an atomic
 * advisory lock (`<file>.lock`, O_EXCL create, stale takeover) and the
 * workbook is written tmp-file + rename so a crash never truncates the master.
 */
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ExcelJS from "exceljs";
import type { ColumnDef } from "./spreadsheet.js";

export const I9_CHECK_SHEET_NAME = "I-9 Check";

export const I9_CHECK_TRACKER_COLUMNS: ColumnDef[] = [
  { header: "Employee Name", key: "employeeName", width: 26 },
  { header: "PPS EID", key: "ppsEid", width: 12 },
  { header: "UCPATH Employee ID", key: "ucpathEmplId", width: 18 },
  { header: "Hire Date (from I-9)", key: "hireDate", width: 16 },
  { header: "Separation Date", key: "separationDate", width: 16 },
  { header: "Found in UCPath?", key: "foundInUcpath", width: 22 },
  { header: "Action", key: "action", width: 10 },
  { header: "Reviewer Name", key: "reviewerName", width: 16 },
  { header: "Notes", key: "notes", width: 44 },
];

export interface I9CheckTrackerRow {
  employeeName: string;
  /** Zero-padded PPS ID verbatim (written as text — leading zeros preserved). */
  ppsEid: string;
  ucpathEmplId: string;
  /** First day of employment from the I-9 Section 2 certification. */
  hireDate: string;
  separationDate: string;
  foundInUcpath: string;
  action: "" | "Keep" | "Shred";
  reviewerName: string;
  notes: string;
}

/** How many years after separation an I-9 packet is retained. */
export const I9_RETENTION_YEARS = 5;

export interface I9RetentionDecision {
  action: "" | "Keep" | "Shred";
  foundLabel: string;
  note: string;
}

/**
 * Retention rule (operator-confirmed 2026-07-16, mirrors their manual sheet):
 * - Not found in UCPath → Shred.
 * - Ambiguous UCPath match → no action, review manually (never guess an EID).
 * - Found + separation date → Shred once `separation + 5y` has passed, else
 *   Keep with a "Shred on <separation + 5y + 1 day>" note.
 * - Found but no usable separation date → no action + an explanatory note
 *   (fail loud: an uncomputable retention date must not default to either
 *   Keep or Shred).
 */
export function decideI9RetentionAction(args: {
  found: boolean;
  /** UCPath resolved >1 candidate and refused to pick. */
  ambiguous?: boolean;
  ambiguousCandidateCount?: number;
  /** mm/dd/yyyy separation date from the Action History roster. */
  separationDate?: string;
  /** Whether the roster had a row for this person at all. */
  hasRosterRow: boolean;
  /** UCPath EID when found (for the note wording). */
  emplId?: string;
  today: Date;
}): I9RetentionDecision {
  if (args.ambiguous) {
    const n = args.ambiguousCandidateCount;
    return {
      action: "",
      foundLabel: `Ambiguous in UCPath${n ? ` (${n} candidates)` : ""}`,
      note: "UCPath person search returned multiple candidates — review manually.",
    };
  }
  if (!args.found) {
    return { action: "Shred", foundLabel: "Not found in UCPath", note: "" };
  }
  if (!args.hasRosterRow) {
    return {
      action: "",
      foundLabel: "Yes",
      note: `Found in UCPath${args.emplId ? ` (EID ${args.emplId})` : ""} but not on the Action History roster — no separation date; review manually.`,
    };
  }
  const sep = args.separationDate ? parseMmDdYyyyUtc(args.separationDate) : null;
  if (sep === null) {
    return {
      action: "",
      foundLabel: "Yes",
      note: "Found in UCPath but the Action History row has no separation date — retention cannot be computed; review manually.",
    };
  }
  const retentionEnd = addYearsUtc(sep, I9_RETENTION_YEARS);
  const todayUtc = Date.UTC(
    args.today.getFullYear(),
    args.today.getMonth(),
    args.today.getDate(),
  );
  if (retentionEnd < todayUtc) {
    return { action: "Shred", foundLabel: "Yes", note: "" };
  }
  const shredOn = new Date(retentionEnd + 24 * 60 * 60 * 1000);
  return { action: "Keep", foundLabel: "Yes", note: `Shred on ${formatMmDdYyyyUtc(shredOn)}` };
}

/**
 * Append one row to the master tracker, creating file + sheet + bold header
 * on first use. Serialized by an advisory lock; written atomically.
 */
export async function appendI9CheckTrackerRow(
  filePath: string,
  row: I9CheckTrackerRow,
): Promise<void> {
  mkdirSync(dirname(filePath), { recursive: true });
  await withFileLock(filePath, async () => {
    const workbook = new ExcelJS.Workbook();
    if (existsSync(filePath)) {
      await workbook.xlsx.readFile(filePath);
    }
    let sheet = workbook.getWorksheet(I9_CHECK_SHEET_NAME);
    if (!sheet) {
      sheet = workbook.addWorksheet(I9_CHECK_SHEET_NAME);
      sheet.columns = I9_CHECK_TRACKER_COLUMNS;
      sheet.getRow(1).font = { bold: true };
    } else {
      // ExcelJS loses column key mapping after readFile — re-apply.
      for (let i = 0; i < I9_CHECK_TRACKER_COLUMNS.length; i++) {
        sheet.getColumn(i + 1).key = I9_CHECK_TRACKER_COLUMNS[i].key;
      }
    }
    // PPS EIDs are zero-padded; force the text format so Excel never strips
    // the leading zeros back off.
    sheet.getColumn(2).numFmt = "@";
    sheet.addRow({ ...row });

    const tmpPath = join(dirname(filePath), `.${Date.now()}-i9-check-tracker.tmp.xlsx`);
    try {
      await workbook.xlsx.writeFile(tmpPath);
      renameSync(tmpPath, filePath);
    } finally {
      rmSync(tmpPath, { force: true });
    }
  });
}

const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 30_000;
const LOCK_RETRY_MS = 250;

/**
 * Atomic advisory lock: `wx`-create `<file>.lock`, retry with backoff while a
 * live peer holds it, take over a stale lock (owner crashed >60s ago), and
 * throw loudly after ~30s — never append without the lock.
 */
async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let stale: boolean;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
      } catch {
        // Lock vanished between the create attempt and the stat — retry now.
        continue;
      }
      if (stale) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `i9-check tracker: could not acquire ${lockPath} within ${LOCK_WAIT_MS}ms — another writer is stuck? Remove the lock file if its owner is dead.`,
          { cause: err },
        );
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}

function parseMmDdYyyyUtc(s: string): number | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Date.UTC(Number(m[3]), month - 1, day);
}

/** +N years in UTC; Feb 29 lands on Mar 1 of a non-leap target year. */
function addYearsUtc(utcMs: number, years: number): number {
  const d = new Date(utcMs);
  return Date.UTC(d.getUTCFullYear() + years, d.getUTCMonth(), d.getUTCDate());
}

function formatMmDdYyyyUtc(d: Date): string {
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}
