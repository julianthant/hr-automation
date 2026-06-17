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
import {
  OathSignatureInputSchema,
  type OathSignatureInput,
  type OathSignerInput,
} from "./schema.js";

/**
 * Oath Signature runtime policy.
 *
 * Each row is one person/EID: titled by the person's name (projection's
 * person-name fallback) with the normal kernel daemon footer. When the row is
 * fanned out from an OCR approval it carries `parentRunId` (delegated scope)
 * and is grouped under the OCR run; scope never changes the row's `single`
 * shape.
 */
export const OATH_SIGNATURE_WORKFLOW_RUNTIME_POLICY: WorkflowRuntimePolicy = {
  ...DEFAULT_WORKFLOW_RUNTIME_POLICY,
  memberRow: {
    titleSource: "person",
  },
  // Oath Signature is always a batch, whether delegated or not — never a
  // standalone single row. Signers fan out from an OCR roster/PDF (conceptually
  // a group of people), so even a single fanned-out signer is a one-member
  // batch (`alwaysBatchDelegatedMembers`), and a single manual EID input run is
  // a one-member batch too (`alwaysBatchInputRun`).
  delegation: {
    ...DEFAULT_WORKFLOW_RUNTIME_POLICY.delegation,
    alwaysBatchDelegatedMembers: true,
    alwaysBatchInputRun: true,
  },
};

const WORKFLOW = "oath-signature";
const oathSignatureSteps = ["ucpath-auth", "transaction"] as const;

/**
 * Kernel definition for the Oath Signature workflow — **EID-only**.
 *
 * One person, one row, one PeopleSoft transaction. Each EID is independent —
 * daemon mode enqueues 1:1 and the daemon processes them sequentially on one
 * browser (or fans out via `--parallel`). The paper-roster PDF variant was
 * removed: OCR owns prep/approval and fans out signer rows here on approve
 * (plus a single oath-upload ticket row); this workflow no longer runs OCR or
 * delegates to itself.
 *
 * `betweenItems: ["reset"]` keeps the browser but resets it to `about:blank`
 * between items so a stuck Person Profile page from item N doesn't leak into
 * item N+1's navigation. UCPath auth is deferred to the `ucpath-auth` step (the
 * system `login` is a no-op; Duo fires only when the item reaches UCPath — for
 * fan-out children, that's AFTER OCR approval). `loginToUCPath` is idempotent,
 * so a daemon Duos once on the first item and reuses the warm session.
 */
export const oathSignatureWorkflow = defineWorkflow({
  name: WORKFLOW,
  label: "Oath Signature",
  archetype: "single",
  inputSubject: "eid",
  code: "os",
  category: "Onboarding",
  iconName: "ClipboardSignature",
  systems: [
    {
      id: "ucpath",
      // deferAuth: UCPath auth is deferred to the `ucpath-auth` step so a
      // fan-out signer child only Duos AFTER OCR approval, when it actually
      // reaches UCPath. Mirrors oath-upload's ServiceNow deferral and
      // emergency-contact's UCPath deferral.
      deferAuth: true,
    },
  ],
  authSteps: false,
  steps: oathSignatureSteps,
  schema: OathSignatureInputSchema,
  runtimePolicy: OATH_SIGNATURE_WORKFLOW_RUNTIME_POLICY,
  queueTitle: { kind: "single" },
  batch: {
    mode: "sequential",
    preEmitPending: true,
    betweenItems: ["reset"],
  },
  detailFields: [
    { key: "name", label: "Employee", conditional: true },
    { key: "emplId", label: "Empl ID" },
    { key: "date", label: "Signature Date", conditional: true },
  ],
  initialData: (input) => ({
    emplId: input.emplId,
    ...(input.name ? { name: input.name } : {}),
  }),
  getName: (d) => {
    if (d && typeof d === "object") {
      const r = d as Record<string, unknown>;
      if (typeof r.name === "string") return r.name;
    }
    return "";
  },
  getId: (d) => {
    if (d && typeof d === "object") {
      const r = d as Record<string, unknown>;
      if (typeof r.emplId === "string") return r.emplId;
    }
    return "";
  },
  operatorSubject: (input) =>
    buildOperatorSubject({
      kind: "eid",
      value: input.emplId,
      prefix: "Oath Signature",
    }),
  handler: async (ctx, input) => {
    await runSignerBranch(ctx, input);
  },
});

/**
 * Per-EID handler — adds an Oath Signature Date row to the UCPath Person
 * Profile after authenticating UCPath.
 */
async function runSignerBranch(
  ctx: Parameters<typeof oathSignatureWorkflow.config.handler>[0],
  input: OathSignerInput,
): Promise<void> {
  const oathCtx: OathSignatureContext = { employeeName: input.name ?? "", alreadyHasOath: false };

  ctx.updateData({
    emplId: input.emplId,
    ...(input.name ? { name: input.name } : {}),
    ...(input.date ? { date: input.date } : {}),
    ...(input.dryRun ? { dryRun: true } : {}),
  });

  // UCPath auth is deferred from session launch to here (the system's `login`
  // is a no-op). `loginToUCPath` is idempotent ("already_logged_in" → true), so
  // on a daemon only the first item shows Duo and the rest reuse the warm
  // session.
  const page = await ctx.page("ucpath");
  await ctx.step("ucpath-auth", async () => {
    const ok = await loginToUCPath(page, undefined, ctx.signal);
    if (!ok) throw new Error("UCPath authentication failed");
  });

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
}

/**
 * Internal in-process adapter. Single EID only — multi-EID in-process batches
 * aren't supported here (daemon mode covers that case).
 */
export async function runOathSignature(
  input: OathSignatureInput,
): Promise<void> {
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
 * Internal daemon-mode adapter. One input batch can carry N items — they
 * enqueue 1:1 to the shared daemon queue, and whichever alive daemon finishes
 * its current item first claims the next.
 */
export type OathSignatureCliInput = OathSignatureInput;

export const runOathSignatureCli = buildCliAdapter<[OathSignatureCliInput[]], OathSignatureInput>({
  workflow: oathSignatureWorkflow,
  emptyMessage: "runOathSignatureCli: no inputs provided",
  buildInputs: (inputs) => inputs,
  deriveItemId: (input) => input.emplId,
  buildPendingData: (input) => buildOathSignaturePendingData(input),
});
