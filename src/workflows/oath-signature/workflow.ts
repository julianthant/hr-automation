import {
  defineWorkflow,
  runWorkflow,
} from "../../core/index.js";
import { buildCliAdapter } from "../../core/cli-adapter.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { loginToUCPath } from "../../infra/auth/login.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { rootQueueTitleData } from "../../domain/queue-title.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import { buildOathSignaturePlan, type OathSignatureContext } from "./enter.js";
import { OathSignatureInputSchema, type OathSignatureInput } from "./schema.js";

/**
 * Oath Signature runtime policy.
 *
 * - Prep row (created by OCR upstream) titles by PDF filename and shows
 *   `Oath · <last4 run id>` as the default subtitle.
 * - Final per-person signature rows are delegation members, titled by
 *   the person's name (the projection's person-name fallback) and
 *   carrying the normal kernel daemon footer.
 * - Cancel on a final person row is child-only; cancel on the file prep
 *   row is handled by the OCR workflow's cancel policy.
 */
export const OATH_SIGNATURE_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy = {
  ...DEFAULT_WORKFLOW_RUNTIME_POLICY,
  memberRow: {
    titleSource: "person",
  },
  prepRow: {
    titleSource: "pdf-original-name",
    subtitleTemplate: "Oath · <last4 run id>",
  },
};

const WORKFLOW = "oath-signature";
// "ocr" leads the pipeline because every oath-signature item comes from an
// OCR-prep upload (the Run modal in this workflow always delegates to OCR
// first). For the prep parent row this is the live step until the operator
// approves; for kernel daemon items it's emitted as a completed marker so
// the timeline shows the full uploaded → OCR → UCPath → transaction story.
const oathSignatureSteps = ["ocr", "ucpath-auth", "transaction"] as const;

/**
 * Kernel definition for the Oath Signature workflow.
 *
 * Single-item shape (like `work-study`) but daemon-mode supports N EIDs per
 * invocation via `ensureDaemonsAndEnqueue`: each EID enqueues as its own
 * `{emplId, date?}` item, and the daemon processes them sequentially on one
 * browser — or fans out across N daemons with `--parallel`.
 *
 * `betweenItems: ["reset"]` keeps the browser but resets it to
 * `about:blank` between items so a stuck Person Profile page from item N
 * doesn't leak into item N+1's navigation.
 */
export const oathSignatureWorkflow = defineWorkflow({
  name: WORKFLOW,
  label: "Oath Signature",
  archetype: "single",
  category: "Onboarding",
  iconName: "ClipboardSignature",
  systems: [
    {
      id: "ucpath",
      login: async (page, instance, context) => {
        const ok = await loginToUCPath(page, instance, context?.abortSignal);
        if (!ok) throw new Error("UCPath authentication failed");
      },
    },
  ],
  authSteps: false,
  steps: oathSignatureSteps,
  schema: OathSignatureInputSchema,
  runtimePolicy: OATH_SIGNATURE_WORKFLOW_RUNTIME_POLICY,
  queueTitle: { kind: "single" },
  authChain: "sequential",
  batch: {
    mode: "sequential",
    preEmitPending: true,
    betweenItems: ["reset"],
  },
  detailFields: [
    { key: "name", label: "Employee" },
    { key: "emplId", label: "Empl ID" },
    { key: "date", label: "Signature Date" },
  ],
  getName: (d) => d.name ?? "",
  getId: (d) => d.emplId ?? "",
  operatorSubject: (input) =>
    buildOperatorSubject({ kind: "eid", value: input.emplId, prefix: "Oath Signature" }),
  handler: async (ctx, input) => {
    const oathCtx: OathSignatureContext = { employeeName: input.name ?? "", alreadyHasOath: false };

    ctx.updateData({
      emplId: input.emplId,
      ...(input.name ? { name: input.name } : {}),
      ...(input.date ? { date: input.date } : {}),
      ...(input.dryRun ? { dryRun: true } : {}),
    });

    // Synthetic "ocr" marker — every oath-signature item originates from an
    // OCR-prep upload + operator approval, so emit a completed-step beat so
    // the dashboard timeline reads `ocr ✓ → ucpath-auth → transaction`. The
    // step does no work; the work happened in the parent OCR row before
    // this kernel item was ever queued.
    ctx.markStep("ocr");
    ctx.markStep("ucpath-auth");
    const page = await ctx.page("ucpath");

    await ctx.step("transaction", async () => {
      // The live-page probe inside buildOathSignaturePlan still skips the
      // OK/Save steps when an oath already exists on the profile — that's
      // the sole duplicate guard now. Tracker-side idempotency was removed
      // 2026-04-23 per user direction (fail-loud / no silent skip-by-record).
      let dryRunProofCaptured = false;
      const plan = buildOathSignaturePlan(input, page, oathCtx, {
        beforeCommit: async () => {
          await ctx.screenshot({ kind: "form", label: "oath-signature-dry-run-pre-save" });
          dryRunProofCaptured = true;
        },
      });
      await plan.execute();
      if (!input.dryRun) {
        await ctx.screenshot({ kind: "form", label: "oath-signature-saved" });
      }

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

      if (input.dryRun) {
        ctx.updateData({
          status: "Dry Run Complete",
          dryRunProofCaptured: String(dryRunProofCaptured),
        });
        log.success(
          `Dry run complete for ${input.emplId}${oathCtx.employeeName ? ` (${oathCtx.employeeName})` : ""} — UCPath Save was skipped.`,
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
    throw err;
  }
}

function buildOathSignaturePendingData(item: OathSignatureInput): Record<string, string> {
  const parentSubject = item.parentSubject;
  const queueFields = parentSubject ? rootQueueTitleData(parentSubject) : {};
  return {
    emplId: item.emplId,
    ...(item.name ? { name: item.name } : {}),
    ...(item.date ? { date: item.date } : {}),
    ...(item.dryRun ? { dryRun: "true" } : {}),
    __name: item.name ?? item.emplId,
    __id: item.emplId,
    ...queueFields,
  };
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
export const runOathSignatureCli = buildCliAdapter<[OathSignatureInput[]], OathSignatureInput>({
  workflow: oathSignatureWorkflow,
  emptyMessage: "runOathSignatureCli: no EIDs provided",
  buildInputs: (inputs) => inputs,
  deriveItemId: (input) => input.emplId,
  buildPendingData: (input) => buildOathSignaturePendingData(input),
});
