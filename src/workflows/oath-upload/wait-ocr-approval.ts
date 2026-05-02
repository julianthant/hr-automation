import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { watchChildRuns } from "../../tracker/watch-child-runs.js";
import { dateLocal, type TrackerEntry } from "../../tracker/jsonl.js";

export interface WaitForOcrApprovalOpts {
  sessionId: string;
  trackerDir?: string;
  date?: string;
  /** Default 7 days. */
  timeoutMs?: number;
  /** Optional: if set, watcher aborts when this sentinel appears on the parent row. */
  abortIfRowState?: { workflow: string; id: string; step: string };
}

export interface OcrApprovalOutcome {
  step: "approved";
  fannedOutItemIds: string[];
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;

/**
 * Wait for the OCR row identified by `sessionId` to reach a terminal
 * approval state (`step="approved"` or `step="discarded"`). On approved,
 * returns the IDs the OCR approve handler fanned out (read back from the
 * approved entry's `data.fannedOutItemIds` — JSON-string-serialized array).
 * Throws on discarded or when fannedOutItemIds is missing/malformed.
 */
export async function waitForOcrApproval(
  opts: WaitForOcrApprovalOpts,
): Promise<OcrApprovalOutcome> {
  const dir = opts.trackerDir ?? ".tracker";
  const date = opts.date ?? dateLocal();

  await watchChildRuns({
    workflow: "ocr",
    expectedItemIds: [opts.sessionId],
    trackerDir: dir,
    date,
    timeoutMs: opts.timeoutMs ?? SEVEN_DAYS_MS,
    isTerminal: (e) => e.step === "approved" || e.step === "discarded",
    ...(opts.abortIfRowState ? { abortIfRowState: opts.abortIfRowState } : {}),
  });

  const file = join(dir, `ocr-${date}.jsonl`);
  if (!existsSync(file)) {
    throw new Error(`waitForOcrApproval: ${file} disappeared after watch resolved`);
  }
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  let latest: TrackerEntry | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]) as TrackerEntry;
      if (e.id === opts.sessionId && (e.step === "approved" || e.step === "discarded")) {
        latest = e;
        break;
      }
    } catch {
      /* tolerate malformed lines */
    }
  }
  if (!latest) {
    throw new Error(
      `waitForOcrApproval: no terminal entry found for ${opts.sessionId} after watch resolved`,
    );
  }

  if (latest.step === "discarded") {
    throw new Error(`OCR run ${opts.sessionId} was discarded by operator`);
  }

  const raw = latest.data?.fannedOutItemIds;
  if (typeof raw !== "string") {
    throw new Error(
      `waitForOcrApproval: ${opts.sessionId} approved entry missing fannedOutItemIds`,
    );
  }
  let ids: unknown;
  try {
    ids = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `waitForOcrApproval: ${opts.sessionId} fannedOutItemIds is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(ids) || !ids.every((s) => typeof s === "string")) {
    throw new Error(
      `waitForOcrApproval: ${opts.sessionId} fannedOutItemIds malformed (expected string[])`,
    );
  }
  return { step: "approved", fannedOutItemIds: ids as string[] };
}
