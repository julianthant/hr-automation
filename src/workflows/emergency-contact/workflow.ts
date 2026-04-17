import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import { launchBrowser } from "../../browser/launch.js";
import { log, withLogContext } from "../../utils/log.js";
import { errorMessage, classifyError } from "../../utils/errors.js";
import { loginToUCPath } from "../../auth/login.js";
import { trackEvent, withTrackedWorkflow } from "../../tracker/jsonl.js";
import {
  emitWorkflowStart,
  emitWorkflowEnd,
  emitSessionCreate,
  emitBrowserLaunch,
  emitBrowserClose,
  emitAuthStart,
  emitAuthComplete,
  emitAuthFailed,
  generateInstanceName,
} from "../../tracker/session-events.js";
import { TransactionError } from "../../systems/ucpath/types.js";
import { navigateToEmergencyContact } from "../../systems/ucpath/personal-data.js";
import { downloadSharePointFile } from "../../utils/sharepoint-download.js";
import { verifyBatchAgainstRoster } from "./roster-verify.js";
import { buildEmergencyContactPlan, extractEmployeeName, findExistingContactDuplicate } from "./enter.js";
import type { EmergencyContactContext } from "./enter.js";
import { loadBatch } from "./schema.js";
import type { EmergencyContactBatch, EmergencyContactRecord } from "./schema.js";
import { ROSTERS_DIR } from "./config.js";

export interface EmergencyContactOptions {
  /** Preview each record's fill plan without touching UCPath. */
  dryRun?: boolean;
  /** If provided, download the roster from SharePoint and verify EIDs/names before running. */
  rosterUrl?: string;
  /** If provided, use this local roster xlsx instead of downloading. */
  rosterPath?: string;
  /** Continue even if roster verification reports mismatches. */
  ignoreRosterMismatch?: boolean;
}

const WORKFLOW = "emergency-contact";

/**
 * Build the stable item ID for a record — used as the primary key in the dashboard.
 * Using `<sourcePage>-<emplId>` instead of just emplId so re-running with a fixed
 * batch.yml shows the record in context and avoids collisions if EIDs repeat.
 */
function recordItemId(r: EmergencyContactRecord): string {
  const pad = String(r.sourcePage).padStart(2, "0");
  return `p${pad}-${r.employee.employeeId}`;
}

function preEmitPending(batch: EmergencyContactBatch): Map<string, string> {
  const now = new Date().toISOString();
  const runIds = new Map<string, string>();
  for (const record of batch.records) {
    const id = recordItemId(record);
    const runId = `${id}#1`;
    runIds.set(id, runId);
    trackEvent({
      workflow: WORKFLOW,
      timestamp: now,
      id,
      runId,
      status: "pending",
      data: {
        batchName: batch.batchName,
        sourcePage: String(record.sourcePage),
        emplId: record.employee.employeeId,
        employeeName: record.employee.name,
        contactName: record.emergencyContact.name,
        relationship: record.emergencyContact.relationship,
      },
    });
  }
  return runIds;
}

async function runPreflight(
  batch: EmergencyContactBatch,
  options: EmergencyContactOptions,
): Promise<void> {
  let rosterPath = options.rosterPath;

  if (options.rosterUrl) {
    log.step("Pre-flight: downloading roster from SharePoint...");
    rosterPath = await downloadSharePointFile({
      url: options.rosterUrl,
      outDir: path.resolve(ROSTERS_DIR),
    });
  }

  if (!rosterPath) {
    log.step("Pre-flight: no roster URL or path provided — skipping roster verification");
    return;
  }

  log.step(`Pre-flight: verifying batch against roster (${rosterPath})...`);
  const result = await verifyBatchAgainstRoster(batch, rosterPath);
  log.step(
    `Roster check: ${result.matched}/${batch.records.length} matched, ` +
      `${result.mismatched.length} name mismatches, ${result.missing.length} EIDs not found in roster`,
  );

  for (const m of result.mismatched) {
    log.error(
      `Name mismatch for EID ${m.emplId} (page ${m.sourcePage}): batch="${m.batchName}" roster="${m.rosterName}"`,
    );
  }
  for (const m of result.missing) {
    log.error(`EID not in roster: ${m.emplId} (page ${m.sourcePage}, name="${m.batchName}")`);
  }

  if ((result.mismatched.length > 0 || result.missing.length > 0) && !options.ignoreRosterMismatch) {
    throw new Error(
      "Roster verification found mismatches — aborting. Fix the batch YAML, or pass --ignore-roster-mismatch to proceed anyway.",
    );
  }
}

async function processRecord(
  record: EmergencyContactRecord,
  page: Page,
  runId: string,
): Promise<void> {
  const itemId = recordItemId(record);
  await withLogContext(WORKFLOW, itemId, async () => {
    await withTrackedWorkflow(
      WORKFLOW,
      itemId,
      {
        sourcePage: String(record.sourcePage),
        emplId: record.employee.employeeId,
        employeeName: record.employee.name,
        contactName: record.emergencyContact.name,
        relationship: record.emergencyContact.relationship,
      },
      async (setStep, updateData, _onCleanup, _session) => {
        try {
          setStep("navigation");
          await navigateToEmergencyContact(page, record.employee.employeeId);

          const ctx: EmergencyContactContext = { employeeName: record.employee.name };
          await extractEmployeeName(page, ctx);
          if (ctx.employeeName) updateData({ employeeName: ctx.employeeName });

          // Duplicate guard (pre-plan). If the contact already exists, skip
          // the plan entirely — avoids log spam + data changes.
          const existing = await findExistingContactDuplicate(page, record.emergencyContact.name);
          if (existing) {
            setStep("skipped-duplicate");
            updateData({ skipped: "true", skipReason: `Contact "${existing}" already exists` });
            log.success(`Skipping — "${existing}" already present on this employee's record`);
            return;
          }

          setStep("fill-form");
          const ctxForPlan: EmergencyContactContext = { employeeName: ctx.employeeName };
          const plan = buildEmergencyContactPlan(record, page, ctxForPlan);
          await plan.execute();

          setStep("save");
          log.success(`Saved emergency contact for ${record.employee.name}`);
        } catch (err) {
          const msg = err instanceof TransactionError
            ? `Transaction failed at step: ${err.step ?? "unknown"} — ${err.message}`
            : errorMessage(err);
          log.error(msg);
          throw err;
        }
      },
      runId,
    );
  });
}

/**
 * Run the emergency-contact workflow for a whole batch file.
 *
 * Phases:
 *  1. Load + validate batch YAML
 *  2. Pre-flight: (optional) download roster + verify EIDs/names
 *  3. Pre-emit `pending` for all records so the dashboard shows the full queue
 *  4. Launch 1 browser, auth UCPath (Duo once)
 *  5. Per record: navigate → fill → save. Each wrapped in withTrackedWorkflow.
 *  6. Cleanup
 */
export async function runEmergencyContactBatch(
  yamlPath: string,
  options: EmergencyContactOptions = {},
): Promise<void> {
  const batch = loadBatch(yamlPath);
  log.step(`Loaded batch "${batch.batchName}" — ${batch.records.length} records`);

  if (options.dryRun) {
    log.step("=== DRY RUN MODE ===");
    for (const record of batch.records) {
      log.step(
        `[page ${record.sourcePage}] EID ${record.employee.employeeId} — ${record.employee.name} | ` +
          `contact="${record.emergencyContact.name}" rel="${record.emergencyContact.relationship}" ` +
          `sameAddr=${record.emergencyContact.sameAddressAsEmployee}`,
      );
      if (record.notes.length > 0) {
        for (const note of record.notes) log.step(`  NOTE: ${note}`);
      }
    }
    log.success("Dry run complete — no changes made to UCPath");
    return;
  }

  await runPreflight(batch, options);

  const runIds = preEmitPending(batch);

  let browser: Browser | null = null;
  let context: BrowserContext | undefined;
  let page: Page | undefined;

  try {
    const launched = await launchBrowser();
    browser = launched.browser;
    context = launched.context;
    page = launched.page;

    // Batch-level session-panel tracking — emit BEFORE auth so the dashboard
    // shows the UCPath browser (in duo_waiting state) during the Duo push wait.
    // This instance owns the shared browser; per-record instances get their
    // own tracker entries via withTrackedWorkflow but no session/browser duplicates.
    const batchInstance = generateInstanceName(WORKFLOW);
    const batchSessionId = `emergency-contact-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const batchBrowserId = `${batchSessionId}-ucpath`;
    let batchFinalStatus: "done" | "failed" = "done";

    emitWorkflowStart(batchInstance);
    emitSessionCreate(batchInstance, batchSessionId);
    emitBrowserLaunch(batchInstance, batchSessionId, batchBrowserId, "UCPath");
    emitAuthStart(batchInstance, batchBrowserId, "UCPath");

    log.step("Authenticating to UCPath (once for the whole batch)...");
    const authed = await loginToUCPath(page);
    if (!authed) {
      emitAuthFailed(batchInstance, batchBrowserId, "UCPath");
      emitBrowserClose(batchInstance, batchBrowserId, "UCPath");
      emitWorkflowEnd(batchInstance, "failed");
      log.error("UCPath authentication failed");
      process.exit(1);
    }
    emitAuthComplete(batchInstance, batchBrowserId, "UCPath");

    try {
      for (let i = 0; i < batch.records.length; i++) {
        const record = batch.records[i];
        const itemId = recordItemId(record);
        const runId = runIds.get(itemId)!;
        log.step(
          `\n========== Record ${i + 1}/${batch.records.length}: page ${record.sourcePage}, EID ${record.employee.employeeId} ==========`,
        );

        try {
          await processRecord(record, page, runId);
        } catch (err) {
          log.error(`Record failed (continuing to next): ${classifyError(err)}`);
          // Don't re-throw — process the rest of the batch
        }
      }

      log.success(`Batch "${batch.batchName}" complete — ${batch.records.length} records processed`);
    } catch (err) {
      batchFinalStatus = "failed";
      throw err;
    } finally {
      emitBrowserClose(batchInstance, batchBrowserId, "UCPath");
      emitWorkflowEnd(batchInstance, batchFinalStatus);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    else if (context) await context.close().catch(() => {});
  }
}
