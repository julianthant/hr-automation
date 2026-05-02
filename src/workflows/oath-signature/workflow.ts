import {
  defineWorkflow,
  runWorkflow,
} from "../../core/index.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { trackEvent } from "../../tracker/jsonl.js";
import { loginToUCPath } from "../../auth/login.js";
import { buildOathSignaturePlan, type OathSignatureContext } from "./enter.js";
import { OathSignatureInputSchema, type OathSignatureInput } from "./schema.js";

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
  category: "Onboarding",
  iconName: "ClipboardSignature",
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
      // The live-page probe inside buildOathSignaturePlan still skips the
      // OK/Save steps when an oath already exists on the profile — that's
      // the sole duplicate guard now. Tracker-side idempotency was removed
      // 2026-04-23 per user direction (fail-loud / no silent skip-by-record).
      const plan = buildOathSignaturePlan(input, page, oathCtx);
      await plan.execute();
      await ctx.screenshot({ kind: 'form', label: 'oath-signature-saved' });

      if (oathCtx.employeeName) {
        ctx.updateData({ name: oathCtx.employeeName });
      }
      if (oathCtx.alreadyHasOath) {
        ctx.updateData({ status: "Skipped (Existing Oath)" });
        log.success(
          `Skipped ${input.emplId}${oathCtx.employeeName ? ` (${oathCtx.employeeName})` : ""} — oath already on file.`,
        );
        return;
      }

      log.success(
        `Oath signature added for ${input.emplId}${oathCtx.employeeName ? ` (${oathCtx.employeeName})` : ""}.`,
      );
    });
  },
});

/**
 * CLI adapter for legacy in-process runs. Single EID only — multi-EID
 * in-process batches aren't supported here (daemon mode covers that case).
 * Use `--direct` from the CLI to reach this path.
 */
export async function runOathSignature(input: OathSignatureInput): Promise<void> {
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
      onPreEmitPending: (item, runId, parentRunId) => {
        trackEvent({
          workflow: WORKFLOW,
          timestamp: now,
          id: item.emplId,
          runId,
          ...(parentRunId ? { parentRunId } : {}),
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
