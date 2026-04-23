import {
  defineWorkflow,
  runWorkflow,
  hashKey,
  hasRecentlySucceeded,
  recordSuccess,
} from "../../core/index.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { trackEvent } from "../../tracker/jsonl.js";
import { loginToUCPath } from "../../auth/login.js";
import { buildOathSignaturePlan, type OathSignatureContext } from "./enter.js";
import { OathSignatureInputSchema, type OathSignatureInput } from "./schema.js";

export interface OathSignatureOptions {
  dryRun?: boolean;
}

const WORKFLOW = "oath-signature";
const oathSignatureSteps = ["ucpath-auth", "transaction"] as const;

/**
 * Kernel definition for the Oath Signature workflow.
 *
 * Single-item shape (like `work-study`) but daemon-mode supports N EIDs per
 * invocation via `ensureDaemonsAndEnqueue`: each EID enqueues as its own
 * `{emplId, date?}` item, and the daemon processes them sequentially on one
 * browser — or fans out across N daemons with `--parallel`.
 *
 * `betweenItems: ["reset-browsers"]` keeps the browser but resets it to
 * `about:blank` between items so a stuck Person Profile page from item N
 * doesn't leak into item N+1's navigation.
 */
export const oathSignatureWorkflow = defineWorkflow({
  name: WORKFLOW,
  label: "Oath Signature",
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
  steps: oathSignatureSteps,
  schema: OathSignatureInputSchema,
  tiling: "single",
  authChain: "sequential",
  batch: {
    mode: "sequential",
    preEmitPending: true,
    betweenItems: ["reset-browsers"],
  },
  detailFields: [
    { key: "name", label: "Employee" },
    { key: "emplId", label: "Empl ID" },
    { key: "date", label: "Signature Date" },
  ],
  getName: (d) => d.name ?? "",
  getId: (d) => d.emplId ?? "",
  handler: async (ctx, input) => {
    const oathCtx: OathSignatureContext = { employeeName: "", alreadyHasOath: false };

    ctx.updateData({ emplId: input.emplId, ...(input.date ? { date: input.date } : {}) });

    ctx.markStep("ucpath-auth");
    const page = await ctx.page("ucpath");

    await ctx.step("transaction", async () => {
      // Idempotency: key on (workflow, emplId, date|today). Prevents
      // re-adding the same oath if the daemon crashes between OK/Save and
      // the tracker write. UCPath itself also allows multiple rows per
      // person — this guard exists to prevent accidental dupes from retries.
      const idempKey = hashKey({
        workflow: WORKFLOW,
        emplId: input.emplId,
        date: input.date ?? "today",
      });
      if (hasRecentlySucceeded(idempKey)) {
        log.warn(
          `Oath signature already recorded recently for ${input.emplId} — skipping (idempotency).`,
        );
        ctx.updateData({ status: "Skipped (Duplicate)", idempotencySkip: "true" });
        return;
      }

      const plan = buildOathSignaturePlan(input, page, oathCtx);
      await plan.execute();

      if (oathCtx.employeeName) {
        ctx.updateData({ name: oathCtx.employeeName });
      }
      if (oathCtx.alreadyHasOath) {
        ctx.updateData({
          status: "Skipped (Existing Oath)",
          idempotencySkip: "true",
        });
        log.success(
          `Skipped ${input.emplId}${oathCtx.employeeName ? ` (${oathCtx.employeeName})` : ""} — oath already on file.`,
        );
        return;
      }

      recordSuccess(idempKey, "", WORKFLOW);
      log.success(
        `Oath signature added for ${input.emplId}${oathCtx.employeeName ? ` (${oathCtx.employeeName})` : ""}.`,
      );
    });
  },
});

/**
 * CLI adapter for legacy in-process / --dry-run runs. Single EID only —
 * multi-EID in-process batches aren't supported here (daemon mode covers
 * that case). Use `--direct` from the CLI to reach this path.
 */
export async function runOathSignature(
  input: OathSignatureInput,
  options: OathSignatureOptions = {},
): Promise<void> {
  if (options.dryRun) {
    const oathCtx: OathSignatureContext = { employeeName: "", alreadyHasOath: false };
    const plan = buildOathSignaturePlan(input, null as never, oathCtx);
    log.step("=== DRY RUN MODE ===");
    plan.preview();
    log.success("Dry run complete -- no changes made to UCPath");
    return;
  }

  try {
    await runWorkflow(oathSignatureWorkflow, input);
    log.success("Oath signature workflow completed");
  } catch (err) {
    log.error(`Oath signature failed: ${errorMessage(err)}`);
    process.exit(1);
  }
}

/**
 * Daemon-mode CLI adapter.
 *
 * One invocation can carry N EIDs — they enqueue 1:1 to the shared daemon
 * queue, and whichever alive daemon finishes its current item first claims
 * the next. With `--parallel K`, K daemons process in parallel.
 *
 * Matches the shape of `runSeparationCli` / `runWorkStudyCli`:
 *   - Validates inputs via the workflow schema inside ensureDaemonsAndEnqueue.
 *   - Pre-emits `pending` tracker rows per EID so the dashboard Queue panel
 *     populates before any Duo clears.
 *   - `new` / `parallel` flags are forwarded to the spawn-plan math.
 */
export async function runOathSignatureCli(
  inputs: OathSignatureInput[],
  options: { new?: boolean; parallel?: number } = {},
): Promise<void> {
  if (inputs.length === 0) {
    log.error("runOathSignatureCli: no EIDs provided");
    process.exitCode = 1;
    return;
  }
  const { ensureDaemonsAndEnqueue } = await import("../../core/daemon-client.js");
  const now = new Date().toISOString();
  await ensureDaemonsAndEnqueue(
    oathSignatureWorkflow,
    inputs,
    { new: options.new, parallel: options.parallel },
    {
      onPreEmitPending: (item, runId) => {
        trackEvent({
          workflow: WORKFLOW,
          timestamp: now,
          id: item.emplId,
          runId,
          status: "pending",
          data: {
            emplId: item.emplId,
            ...(item.date ? { date: item.date } : {}),
          },
        });
      },
    },
  );
}
