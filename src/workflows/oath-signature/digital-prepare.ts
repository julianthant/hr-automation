import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";
import type { OathSignatureInput } from "./schema.js";

/**
 * Digital-mode oath signature flow.
 *
 * Pre-2026-04-29 this wrote a `mode: "prepare"` parent row mirroring the
 * paper flow (so the operator could review/edit the looked-up dates
 * before approving). That added review ceremony for what is functionally
 * a kernel batch — every record is already an EID + a CRM-of-record
 * date. The prep/review pattern was overkill.
 *
 * As of 2026-04-29 (P4.1) digital-mode bypasses prep entirely:
 *   1. Launch CRM, authenticate (1 Duo).
 *   2. For each pasted EID: lookup the "Witness Ceremony Oath New Hire
 *      Signed" row in onboarding history.
 *   3. Enqueue `{emplId, date: foundDate ?? undefined}` directly into
 *      the oath-signature daemon queue. No prep row, no review pane —
 *      the per-EID kernel rows show up in the queue immediately.
 *   4. EIDs whose CRM history doesn't have the row still enqueue with
 *      `date: undefined` (the kernel today-prefills).
 */
export interface DigitalOathPrepareInput {
  /** EIDs to look up. */
  emplIds: string[];
}

export interface DigitalOathPrepareOutput {
  enqueued: number;
  lookupFailures: number;
}

/** @internal — test escape hatch. Replaces the lookup with a stub. */
export interface DigitalLookupResult {
  emplId: string;
  dateMmDdYyyy: string | null;
  error?: string;
}
export type DigitalLookupFn = (
  emplIds: string[],
) => Promise<DigitalLookupResult[]>;

let _lookupFn: DigitalLookupFn | undefined;

/** @internal — test escape hatch. */
export function __setDigitalLookupForTests(fn: DigitalLookupFn | undefined): void {
  _lookupFn = fn;
}

type EnqueueFn = (inputs: OathSignatureInput[]) => Promise<void>;
let _enqueueFn: EnqueueFn | undefined;

/** @internal — test escape hatch for the daemon-enqueue side. */
export function __setDigitalEnqueueForTests(fn: EnqueueFn | undefined): void {
  _enqueueFn = fn;
}

export async function runDigitalOathPrepare(
  input: DigitalOathPrepareInput,
): Promise<DigitalOathPrepareOutput> {
  if (input.emplIds.length === 0) {
    log.warn("[oath-digital] No EIDs supplied — nothing to enqueue");
    return { enqueued: 0, lookupFailures: 0 };
  }

  const lookup = _lookupFn ?? defaultDigitalLookup;
  let lookupFailures = 0;
  let lookupResults: DigitalLookupResult[];
  try {
    lookupResults = await lookup(input.emplIds);
  } catch (err) {
    log.error(`[oath-digital] CRM lookup batch failed: ${errorMessage(err)}`);
    // Fall back: enqueue every EID with no date and let the kernel
    // today-prefill. The operator gets a row per EID either way.
    lookupResults = input.emplIds.map((emplId) => ({
      emplId,
      dateMmDdYyyy: null,
      error: errorMessage(err),
    }));
    lookupFailures = input.emplIds.length;
  }

  const inputs: OathSignatureInput[] = lookupResults.map((r) => {
    if (r.error) lookupFailures += 1;
    return r.dateMmDdYyyy
      ? { emplId: r.emplId, date: r.dateMmDdYyyy }
      : { emplId: r.emplId };
  });

  const enqueue = _enqueueFn ?? defaultEnqueue;
  await enqueue(inputs);
  log.success(
    `[oath-digital] Enqueued ${inputs.length} EID${inputs.length === 1 ? "" : "s"}` +
      (lookupFailures > 0
        ? ` (${lookupFailures} CRM lookup failure${lookupFailures === 1 ? "" : "s"} — those rows enqueued without a date so the kernel today-prefills)`
        : ""),
  );
  return { enqueued: inputs.length, lookupFailures };
}

// ─── Production lookup + enqueue ───────────────────────────

async function defaultDigitalLookup(
  emplIds: string[],
): Promise<DigitalLookupResult[]> {
  const { launchBrowser } = await import("../../browser/launch.js");
  const { loginToACTCrm } = await import("../../auth/login.js");
  const { lookupOathSignatureDate } = await import(
    "../../systems/crm/onboarding-history.js"
  );

  const { browser, context, page } = await launchBrowser();
  try {
    const ok = await loginToACTCrm(page);
    if (!ok) throw new Error("CRM authentication failed");
    const out: DigitalLookupResult[] = [];
    for (const emplId of emplIds) {
      try {
        const date = await lookupOathSignatureDate(page, emplId);
        out.push({ emplId, dateMmDdYyyy: date });
      } catch (err) {
        out.push({
          emplId,
          dateMmDdYyyy: null,
          error: errorMessage(err),
        });
      }
    }
    return out;
  } finally {
    try {
      await context.close();
    } catch {
      /* ignore */
    }
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }
}

async function defaultEnqueue(inputs: OathSignatureInput[]): Promise<void> {
  const { ensureDaemonsAndEnqueue } = await import("../../core/daemon-client.js");
  const { oathSignatureWorkflow } = await import("./index.js");
  await ensureDaemonsAndEnqueue(oathSignatureWorkflow, inputs, {});
}
