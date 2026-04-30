import { randomUUID } from "node:crypto";
import { dateLocal, trackEvent } from "../../tracker/jsonl.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";
import { OathPrepareRowDataSchema, type OathPrepareRowData, type OathPreviewRecord } from "./preview-schema.js";

const WORKFLOW = "oath-signature";

export interface DigitalOathPrepareInput {
  /** EIDs to look up. */
  emplIds: string[];
  /** Free-text label for the prep row's pdfOriginalName slot — operator-visible. */
  label?: string;
  trackerDir?: string;
  /** Externally-supplied runId so the HTTP handler can return it synchronously. */
  runId?: string;
}

export interface DigitalOathPrepareOutput {
  runId: string;
  parentRunId: string;
}

/**
 * One-EID lookup result. `dateMmDdYyyy` is null when CRM doesn't have a
 * "Witness Ceremony Oath New Hire Signed" row yet — the operator can
 * still approve manually-edited dates from the preview.
 */
export interface DigitalLookupResult {
  emplId: string;
  dateMmDdYyyy: string | null;
  /** Friendly name from CRM if discovered; falls back to the EID. */
  displayName?: string;
  /** Free-form error string if the lookup itself failed (vs. found-no-row). */
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

/**
 * Run a CRM-session lookup of oath-signature dates for one or more EIDs
 * and write a `data.mode === "prepare"` tracker row mirroring the paper
 * flow. The same `OathPreviewRow` UI renders both modes; approve fans
 * out into the kernel oath-signature daemon with the looked-up dates.
 *
 * Status transitions:
 *   pending → running(crm-auth) → running(lookup) → done
 *
 * Failed lookups get `matchState: "unresolved"` with a warning so the
 * operator sees them in the review list and can re-search or skip.
 */
export async function runDigitalOathPrepare(
  input: DigitalOathPrepareInput,
): Promise<DigitalOathPrepareOutput> {
  const runId = input.runId ?? randomUUID();
  const id = `oath-prep-${dateLocal()}-${runId.slice(0, 8)}`;
  const trackerDir = input.trackerDir;
  const label = input.label ?? `digital-${dateLocal()}-${input.emplIds.length}eid`;

  const writeTracker = (
    status: "pending" | "running" | "done" | "failed",
    data: Partial<OathPrepareRowData>,
    step?: string,
    error?: string,
  ): void => {
    trackEvent(
      {
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id,
        runId,
        status,
        ...(step ? { step } : {}),
        data: flattenForData(data),
        ...(error ? { error } : {}),
      },
      trackerDir,
    );
  };

  writeTracker("pending", {
    mode: "prepare",
    pdfPath: "",
    pdfOriginalName: label,
    rosterPath: "(digital lookup — CRM onboarding history)",
    records: [],
  });

  if (input.emplIds.length === 0) {
    writeTracker(
      "failed",
      {
        mode: "prepare",
        pdfPath: "",
        pdfOriginalName: label,
        rosterPath: "(digital lookup — CRM onboarding history)",
        records: [],
      },
      undefined,
      "No EIDs supplied",
    );
    return { runId, parentRunId: runId };
  }

  try {
    writeTracker("running", { rosterPath: "(digital lookup — CRM onboarding history)" }, "crm-auth");
    const fn = _lookupFn ?? defaultDigitalLookup;
    writeTracker("running", { rosterPath: "(digital lookup — CRM onboarding history)" }, "lookup");
    const results = await fn(input.emplIds);
    log.step(`[oath-digital] CRM lookup returned ${results.length} result(s)`);

    const records: OathPreviewRecord[] = results.map((r, i): OathPreviewRecord => {
      const printedName = r.displayName?.trim() || r.emplId;
      if (r.error || !r.dateMmDdYyyy) {
        return {
          sourcePage: 1,
          rowIndex: i,
          printedName,
          employeeSigned: true,
          officerSigned: null,
          dateSigned: null,
          notes: [],
          employeeId: r.emplId,
          matchState: "unresolved",
          documentType: "expected",
          originallyMissing: [],
          warnings: r.error
            ? [`CRM lookup failed: ${r.error}`]
            : ["No 'Witness Ceremony Oath New Hire Signed' row found in CRM history"],
          selected: false,
        };
      }
      return {
        sourcePage: 1,
        rowIndex: i,
        printedName,
        employeeSigned: true,
        officerSigned: null,
        dateSigned: r.dateMmDdYyyy,
        notes: [],
        employeeId: r.emplId,
        matchState: "matched",
        matchSource: "roster", // EID came from input + date from form-of-record (CRM)
        matchConfidence: 1.0,
        documentType: "expected",
        originallyMissing: [],
        warnings: [],
        selected: true,
      };
    });

    const finalData: OathPrepareRowData = {
      mode: "prepare",
      pdfPath: "",
      pdfOriginalName: label,
      rosterPath: "(digital lookup — CRM onboarding history)",
      records,
    };
    OathPrepareRowDataSchema.parse(finalData);
    writeTracker("done", finalData);
    log.success(`[oath-digital] Prepared ${records.filter((r) => r.selected).length}/${records.length} record(s) for review`);
    return { runId, parentRunId: runId };
  } catch (err) {
    writeTracker(
      "failed",
      {
        mode: "prepare",
        pdfPath: "",
        pdfOriginalName: label,
        rosterPath: "(digital lookup — CRM onboarding history)",
        records: [],
      },
      undefined,
      errorMessage(err),
    );
    return { runId, parentRunId: runId };
  }
}

// ─── Production lookup ─────────────────────────────────────

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
        const displayName = await readNameFromRecordPage(page).catch(() => undefined);
        out.push({ emplId, dateMmDdYyyy: date, displayName });
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

/**
 * After `lookupOathSignatureDate` finishes for a given EID, the page is
 * left on `/hr/ONB_ShowOnboardingHistory?id=...` whose H2 reads
 * "Onboarding History for <First Last>". Pull that name so the preview
 * row shows a human-friendly label instead of just the EID.
 */
async function readNameFromRecordPage(page: import("playwright").Page): Promise<string | undefined> {
  const heading = await page
    .locator("h2.mainTitle") // allow-inline-selector — `<h2 class="mainTitle">` is a Visualforce-generic page-title element used across CRM screens; not a workflow-specific anchor
    .first()
    .textContent()
    .catch(() => null);
  if (!heading) return undefined;
  const m = heading.match(/Onboarding History for\s+(.+)$/i);
  return m ? m[1].trim() : undefined;
}

// ─── Helpers ───────────────────────────────────────────────

function flattenForData(d: Partial<OathPrepareRowData>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = String(v);
    } else {
      try {
        out[k] = JSON.stringify(v);
      } catch {
        out[k] = String(v);
      }
    }
  }
  return out;
}
