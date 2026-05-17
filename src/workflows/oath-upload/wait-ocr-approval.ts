import { watchChildRuns } from "../../tracker/delegation/watch-child-runs.js";
import { SEVEN_DAYS_MS } from "../../utils/durations.js";

export interface WaitForOcrApprovalOpts {
  sessionId: string;
  trackerDir?: string;
  /** Default 7 days. */
  timeoutMs?: number;
  /** Optional: if set, watcher aborts when this sentinel appears on the parent row. */
  abortIfRowState?: { workflow: string; id: string; step: string };
}

export interface OcrApprovalOutcome {
  step: "approved";
  fannedOutItemIds: string[];
}

export { SEVEN_DAYS_MS };

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

  const outcomes = await watchChildRuns({
    workflow: "ocr",
    expectedItemIds: [opts.sessionId],
    trackerDir: dir,
    timeoutMs: opts.timeoutMs ?? SEVEN_DAYS_MS,
    isTerminal: (e) => e.step === "approved" || e.step === "discarded",
    ...(opts.abortIfRowState ? { abortIfRowState: opts.abortIfRowState } : {}),
  });

  const latest = outcomes[0]?.terminalEntry;
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
      { cause: err },
    );
  }
  if (!Array.isArray(ids) || !ids.every((s) => typeof s === "string")) {
    throw new Error(
      `waitForOcrApproval: ${opts.sessionId} fannedOutItemIds malformed (expected string[])`,
    );
  }
  return { step: "approved", fannedOutItemIds: ids as string[] };
}
