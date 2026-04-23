import path from "node:path";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { defineWorkflow, runWorkflowBatch } from "../../core/index.js";
import { loginToUCPath } from "../../auth/login.js";
import { trackEvent } from "../../tracker/jsonl.js";
import { TransactionError } from "../../systems/ucpath/types.js";
import { navigateToEmergencyContact } from "../../systems/ucpath/personal-data.js";
import { downloadSharePointFile } from "../sharepoint-download/index.js";
import { verifyBatchAgainstRoster } from "./roster-verify.js";
import {
  buildEmergencyContactPlan,
  extractEmployeeName,
  findExistingContactDuplicate,
} from "./enter.js";
import type { EmergencyContactContext } from "./enter.js";
import { loadBatch, RecordSchema } from "./schema.js";
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

const emergencyContactSteps = ["navigation", "fill-form", "save"] as const;

/**
 * Stable dashboard item ID — `p{NN}-{emplId}` (zero-padded source page + EID).
 * Re-runs with a fixed batch YAML keep the record in context and avoid
 * collisions when EIDs repeat across unrelated pages.
 */
function recordItemId(r: EmergencyContactRecord): string {
  const pad = String(r.sourcePage).padStart(2, "0");
  return `p${pad}-${r.employee.employeeId}`;
}

/**
 * Kernel definition for the emergency-contact batch workflow.
 *
 * Batch mode (`sequential`, `preEmitPending: true`): the kernel pairs each record
 * with a pre-generated runId so the CLI adapter's `onPreEmitPending` callback can
 * emit the initial `pending` row with rich display fields; `withTrackedWorkflow`
 * then reuses that runId and skips its duplicate pending emit.
 *
 * `betweenItems: ["reset-browsers"]` resets UCPath to `about:blank` between
 * records so a stuck page from record N doesn't leak into record N+1's
 * `navigateToEmergencyContact`.
 */
export const emergencyContactWorkflow = defineWorkflow({
  name: WORKFLOW,
  label: "Emergency Contact",
  systems: [
    {
      id: "ucpath",
      login: async (page, instance) => {
        const ok = await loginToUCPath(page, instance);
        if (!ok) throw new Error("UCPath authentication failed");
      },
    },
  ],
  authSteps: false,
  steps: emergencyContactSteps,
  schema: RecordSchema,
  tiling: "single",
  authChain: "sequential",
  batch: {
    mode: "sequential",
    preEmitPending: true,
    betweenItems: ["reset-browsers"],
  },
  // The batch adapter's onPreEmitPending populates all four fields up front
  // (see runEmergencyContact below) so the dashboard shows rich rows from
  // the pending state onward. The handler only refreshes employeeName after
  // the iframe extraction succeeds.
  detailFields: [
    { key: "employeeName", label: "Employee" },
    { key: "emplId", label: "Empl ID" },
    { key: "contactName", label: "Contact" },
    { key: "relationship", label: "Relationship" },
  ],
  getName: (d) => d.employeeName ?? "",
  getId: (d) => d.emplId ?? "",
  handler: async (ctx, record) => {
    const page = await ctx.page("ucpath");

    const skipped = await ctx.step("navigation", async () => {
      await navigateToEmergencyContact(page, record.employee.employeeId);

      const discoveredCtx: EmergencyContactContext = { employeeName: record.employee.name };
      await extractEmployeeName(page, discoveredCtx);
      if (discoveredCtx.employeeName) {
        ctx.updateData({ employeeName: discoveredCtx.employeeName });
      }

      // Duplicate guard (pre-plan). If the contact already exists, signal
      // the outer handler to skip the plan entirely — avoids log spam + data
      // changes. Early-return here returns the skip metadata so the outer
      // handler can short-circuit without firing the fill-form / save steps.
      const existing = await findExistingContactDuplicate(page, record.emergencyContact.name);
      if (existing) {
        ctx.updateData({
          skipped: "true",
          skipReason: `Contact "${existing}" already exists`,
        });
        log.success(`Skipping — "${existing}" already present on this employee's record`);
        return true;
      }
      return false;
    });

    if (skipped) return;

    await ctx.step("fill-form", async () => {
      const planCtx: EmergencyContactContext = { employeeName: record.employee.name };
      const plan = buildEmergencyContactPlan(record, page, planCtx);
      try {
        await plan.execute();
        await ctx.screenshot({ kind: 'form', label: 'emergency-contact-saved' });
      } catch (err) {
        if (err instanceof TransactionError) {
          throw new Error(
            `Transaction failed at step: ${err.step ?? "unknown"} — ${err.message}`,
          );
        }
        throw err;
      }
    });

    await ctx.step("save", async () => {
      log.success(`Saved emergency contact for ${record.employee.name}`);
    });
  },
});

/**
 * CLI adapter for `npm run emergency-contact <batchYaml>`.
 *
 * Pre-kernel phases live here (not in the kernel handler):
 *   1. Load + validate batch YAML.
 *   2. Dry-run short-circuit: log each record's planned action, exit 0 without
 *      launching a browser.
 *   3. Optional roster preflight: download from SharePoint (if --roster-url) +
 *      verify EIDs/names against the roster. Mismatches abort unless
 *      --ignore-roster-mismatch.
 *   4. Delegate to runWorkflowBatch with onPreEmitPending emitting rich
 *      dashboard fields per record.
 */
export async function runEmergencyContact(
  batchYaml: string,
  options: EmergencyContactOptions = {},
): Promise<void> {
  const batch = loadBatch(batchYaml);
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

  const now = new Date().toISOString();
  const result = await runWorkflowBatch(emergencyContactWorkflow, batch.records, {
    // Per-record itemId shape `p{NN}-{emplId}` — the kernel's built-in
    // deriveItemId only looks at top-level emplId/docId/email, not
    // `employee.employeeId`, so without this the kernel would hand
    // withTrackedWorkflow a random UUID that doesn't match the pending row
    // written by onPreEmitPending below.
    deriveItemId: (item) => recordItemId(item as EmergencyContactRecord),
    onPreEmitPending: (item, runId) => {
      const record = item as EmergencyContactRecord;
      trackEvent({
        workflow: WORKFLOW,
        timestamp: now,
        id: recordItemId(record),
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
    },
  });

  log.success(
    `Batch "${batch.batchName}" complete — ${result.succeeded}/${result.total} succeeded, ${result.failed} failed`,
  );
  if (result.failed > 0) {
    const summary = result.errors
      .slice(0, 3)
      .map((e) => `  - ${errorMessage(e.error)}`)
      .join("\n");
    log.error(`Failures (first 3):\n${summary}`);
  }
}

/**
 * Daemon-mode CLI adapter.
 *
 * One invocation reads the whole batch YAML, runs roster preflight in-process
 * (before any daemon work), then enqueues each record 1:1 to the shared
 * `.tracker/daemons/emergency-contact.queue.jsonl`. Whichever alive daemon
 * finishes its current record first claims the next; `--parallel K` fans
 * out across K daemons (K × UCPath Duo on fresh spawn).
 *
 * Dry-run bypasses the daemon entirely (prints planned fills, exits 0).
 * Roster preflight still runs in-process because the YAML's EID/name
 * verification must gate the whole batch BEFORE any record lands in the
 * queue — a daemon can't block the spawn-plan on roster results without
 * coupling two concerns.
 *
 * Item-ID shape `p{NN}-{emplId}` (via `recordItemId`) matches the existing
 * legacy path — the kernel's default `deriveItemId` only walks top-level
 * fields and the EID is nested under `employee.employeeId`, so we pass a
 * custom deriver to `ensureDaemonsAndEnqueue`.
 */
export async function runEmergencyContactCli(
  batchYaml: string,
  options: EmergencyContactOptions & { new?: boolean; parallel?: number } = {},
): Promise<void> {
  const batch = loadBatch(batchYaml);
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

  const { ensureDaemonsAndEnqueue } = await import("../../core/daemon-client.js");
  const now = new Date().toISOString();
  await ensureDaemonsAndEnqueue(
    emergencyContactWorkflow,
    batch.records,
    { new: options.new, parallel: options.parallel },
    {
      deriveItemId: (item) => recordItemId(item as EmergencyContactRecord),
      onPreEmitPending: (item, runId) => {
        const record = item as EmergencyContactRecord;
        trackEvent({
          workflow: WORKFLOW,
          timestamp: now,
          id: recordItemId(record),
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
      },
    },
  );
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
