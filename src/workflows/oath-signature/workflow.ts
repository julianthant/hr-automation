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
import { findLatestEntryForPredicate } from "../../tracker/find-latest-entry.js";
import { ocrWorkflow } from "../ocr/index.js";
import { buildOathSignaturePlan, type OathSignatureContext } from "./enter.js";
import {
  OathSignatureInputSchema,
  type OathSignatureInput,
  type OathSignerInput,
} from "./schema.js";

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
// The kernel runs both input variants through the same step list:
//   - signer branch: skips "ocr" + "fan-out"; runs "ucpath-auth" + "transaction"
//   - pdf branch: runs "ocr" (delegates to ocrWorkflow) + "fan-out"
//     (delegateToAll to self with N signer inputs); skips "ucpath-auth"
//     and "transaction"
// `ctx.skipStep` keeps the pipeline shape consistent across both branches
// so the dashboard StepPipeline always knows the full set of possible
// steps even when a given run only exercises a subset.
const oathSignatureSteps = ["ocr", "fan-out", "ucpath-auth", "transaction"] as const;

/**
 * Kernel definition for the Oath Signature workflow.
 *
 * Two input variants share this workflow definition:
 *
 *  - `kind: "signer"` (today's per-EID flow): one item, one row, one
 *    PeopleSoft transaction. Each EID is independent — daemon mode
 *    enqueues 1:1 and the daemon processes them sequentially on one
 *    browser (or fans out via `--parallel`).
 *  - `kind: "pdf"` (paper-roster flow): one input is one PDF; the
 *    handler delegates to the OCR workflow (which awaits operator
 *    approval) and then `delegateToAll`s back into oath-signature with
 *    N `kind: "signer"` inputs. The discriminator gates the recursion —
 *    fan-out children never re-enter the PDF branch.
 *
 * `betweenItems: ["reset"]` keeps the browser but resets it to
 * `about:blank` between items so a stuck Person Profile page from item N
 * doesn't leak into item N+1's navigation. Only the signer branch
 * touches the browser; PDF runs never call `ctx.page("ucpath")` and so
 * never trigger Duo auth.
 */
export const oathSignatureWorkflow = defineWorkflow({
  name: WORKFLOW,
  label: "Oath Signature",
  archetype: (input: OathSignatureInput) => (input.kind === "pdf" ? "batch" : "single"),
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
  getName: (d) => {
    if (d && typeof d === "object" && "kind" in d && d.kind === "pdf") {
      return d.pdfOriginalName ?? "";
    }
    return (d && typeof d === "object" && "name" in d ? (d.name as string | undefined) : undefined) ?? "";
  },
  getId: (d) => {
    if (d && typeof d === "object" && "kind" in d && d.kind === "pdf") {
      return d.sessionId ?? "";
    }
    return (d && typeof d === "object" && "emplId" in d ? (d.emplId as string | undefined) : undefined) ?? "";
  },
  operatorSubject: (input) => {
    if (input.kind === "pdf") {
      return buildOperatorSubject({
        kind: "pdf",
        value: input.pdfOriginalName ?? input.sessionId,
        prefix: "Oath Signature",
      });
    }
    return buildOperatorSubject({
      kind: "eid",
      value: input.emplId,
      prefix: "Oath Signature",
    });
  },
  handler: async (ctx, input) => {
    if (input.kind === "pdf") {
      await runPdfBranch(ctx, input);
      return;
    }
    await runSignerBranch(ctx, input);
  },
});

/**
 * Per-EID handler — the original oath-signature flow. Skips the upstream
 * "ocr" + "fan-out" steps and runs the UCPath transaction.
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

  // PDF-branch steps are not exercised on a signer run. Mark them skipped
  // so the dashboard StepPipeline collapses the missing dots cleanly.
  ctx.skipStep("ocr");
  ctx.skipStep("fan-out");
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
}

/**
 * Paper-roster handler. Delegates to OCR (which suspends until the operator
 * approves the extracted records), then fans out one signer child per
 * approved record back into this workflow.
 *
 * The OCR delegation uses `renderAs: "preview"` so the OCR row gets the
 * approval-delegation surface. The fan-out uses `renderAs: "batch"` so
 * N signer children group under a batch row in this workflow's tab.
 */
async function runPdfBranch(
  ctx: Parameters<typeof oathSignatureWorkflow.config.handler>[0],
  input: Extract<OathSignatureInput, { kind: "pdf" }>,
): Promise<void> {
  ctx.updateData({
    pdfOriginalName: input.pdfOriginalName,
    sessionId: input.sessionId,
    ...(input.pdfHash ? { pdfHash: input.pdfHash } : {}),
    ...(input.dryRun ? { dryRun: true } : {}),
  });

  // PDF runs do no UCPath work directly; the per-signer children do.
  ctx.skipStep("ucpath-auth");
  ctx.skipStep("transaction");

  // ─── 1. Delegate to OCR ──────────────────────────────────────
  // ocrWorkflow is in-process (not daemon-capable). delegateTo routes
  // through runWorkflow with the parent's signal forwarded, so an
  // operator cancel on this PDF row aborts the OCR run too.
  //
  // OCR's kernel handler suspends on `subscribeToApproval` until the
  // operator approves or discards the row — so this `await` resolves
  // ONLY after operator interaction. A discard rejects with
  // `OcrDiscardedError`, which surfaces here as a child `failed` status.
  await ctx.step("ocr", async () => {
    const ocrResult = await ctx.delegateTo(
      ocrWorkflow,
      {
        pdfPath: input.pdfPath,
        pdfOriginalName: input.pdfOriginalName,
        ...(input.pdfFileId ? { pdfFileId: input.pdfFileId } : {}),
        formType: "oath",
        sessionId: input.sessionId,
        rosterMode: input.rosterMode ?? "download",
        ...(input.rosterPath ? { rosterPath: input.rosterPath } : {}),
        ...(input.dryRun ? { dryRun: input.dryRun } : {}),
      },
      {
        renderAs: "preview",
        itemId: input.sessionId,
      },
    );
    if (ocrResult.status !== "done") {
      throw new Error(
        `OCR delegation terminated with status=${ocrResult.status}` +
          (ocrResult.error?.message ? ` — ${ocrResult.error.message}` : ""),
      );
    }
  });

  // ─── 2. Read approved records + fan out ──────────────────────
  await ctx.step("fan-out", async () => {
    const signerInputs = readApprovedSignerInputs({
      sessionId: input.sessionId,
      trackerDir: ctx.trackerDir,
      parentSubject: input.parentSubject,
      dryRun: input.dryRun,
    });
    if (signerInputs.length === 0) {
      throw new Error(
        `Approved OCR for session ${input.sessionId} produced 0 signer records — nothing to fan out`,
      );
    }
    log.step(
      `Fanning out ${signerInputs.length} oath-signature signer${signerInputs.length === 1 ? "" : "s"} from PDF "${input.pdfOriginalName}".`,
    );

    ctx.updateData({
      fannedOutCount: String(signerInputs.length),
    });

    const childResults = await ctx.delegateToAll(
      oathSignatureWorkflow,
      signerInputs,
      { renderAs: "batch" },
    );
    const nonDone = childResults.filter((r) => r.status !== "done");
    if (nonDone.length > 0) {
      const summary = nonDone
        .map((r) => `${r.itemId}=${r.status}${r.error?.message ? `(${r.error.message})` : ""}`)
        .join(", ");
      throw new Error(
        `${nonDone.length} of ${childResults.length} oath-signature children did not finish: ${summary}`,
      );
    }
  });
}

/**
 * Read the approved OCR row's `data.records` payload and build the
 * `kind: "signer"` input list the fan-out will dispatch. The approve
 * route writes `done step=approved` with `records: JSON.stringify(...)`
 * before `emitApproved` wakes our `subscribeToApproval` — by the time
 * this runs the row is on disk.
 *
 * Fails loud if the row is missing, the records field is missing, or no
 * record carried both a printedName/employeeId pair that we can turn
 * into a valid `kind: "signer"` input. Silent fallbacks would let a
 * misconfigured approve payload produce a fan-out of zero signers.
 */
interface ReadApprovedArgs {
  sessionId: string;
  trackerDir: string | undefined;
  parentSubject?: string;
  dryRun?: boolean;
}

function readApprovedSignerInputs(args: ReadApprovedArgs): OathSignerInput[] {
  const approvedRow = findLatestEntryForPredicate({
    workflow: "ocr",
    ...(args.trackerDir !== undefined ? { trackerDir: args.trackerDir } : {}),
    lookbackDays: 7,
    predicate: (e) =>
      e.id === args.sessionId && e.status === "done" && e.step === "approved",
  });
  if (!approvedRow) {
    throw new Error(
      `No approved OCR row found for sessionId=${args.sessionId} — cannot fan out signers`,
    );
  }
  const rawRecords = approvedRow.data?.records;
  if (typeof rawRecords !== "string") {
    throw new Error(
      `Approved OCR row for sessionId=${args.sessionId} has no records payload (data.records is not a string)`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawRecords);
  } catch (err) {
    throw new Error(
      `Approved OCR row for sessionId=${args.sessionId} has malformed records payload: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Approved OCR row for sessionId=${args.sessionId} records payload is not an array`,
    );
  }
  const signerInputs: OathSignerInput[] = [];
  for (const rec of parsed) {
    if (!rec || typeof rec !== "object") continue;
    const r = rec as Record<string, unknown>;
    if (r.selected !== true) continue;
    const emplId = typeof r.employeeId === "string" ? r.employeeId : "";
    if (!/^\d{5,}$/.test(emplId)) continue;
    const printedName = typeof r.printedName === "string" ? r.printedName.trim() : "";
    const dateSigned = typeof r.dateSigned === "string" ? r.dateSigned : "";
    const dateMatch = /^\d{2}\/\d{2}\/\d{4}$/.test(dateSigned);
    signerInputs.push({
      kind: "signer",
      emplId,
      ...(printedName ? { name: printedName } : {}),
      ...(dateMatch ? { date: dateSigned } : {}),
      ...(args.dryRun ? { dryRun: true } : {}),
      ...(args.parentSubject ? { parentSubject: args.parentSubject } : {}),
    });
  }
  return signerInputs;
}

/**
 * Internal in-process adapter. Single EID only — multi-EID in-process batches
 * aren't supported here (daemon mode covers that case). Accepts the legacy
 * shape (no `kind` field) for internal callers — the schema discriminator
 * requires `kind`, so we inject `"signer"` if it's missing.
 */
export async function runOathSignature(
  input: OathSignatureInput | Omit<OathSignerInput, "kind">,
): Promise<void> {
  const normalized: OathSignatureInput = "kind" in input
    ? input as OathSignatureInput
    : { kind: "signer", ...(input as Omit<OathSignerInput, "kind">) };
  try {
    await runWorkflow(oathSignatureWorkflow, normalized);
    log.success("Oath signature workflow completed");
  } catch (err) {
    log.error(`Oath signature failed: ${errorMessage(err)}`);
    throw err;
  }
}

function buildOathSignaturePendingData(item: OathSignatureInput): Record<string, string> {
  const parentSubject = item.parentSubject;
  const queueFields = parentSubject ? rootQueueTitleData(parentSubject) : {};
  if (item.kind === "pdf") {
    return {
      sessionId: item.sessionId,
      pdfOriginalName: item.pdfOriginalName,
      ...(item.pdfHash ? { pdfHash: item.pdfHash } : {}),
      ...(item.dryRun ? { dryRun: "true" } : {}),
      __name: item.pdfOriginalName,
      __id: item.sessionId,
      ...queueFields,
    };
  }
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
 * Internal daemon-mode adapter.
 *
 * Accepts the legacy bare `{ emplId, ... }` shape for back-compat with
 * existing internal CLI callers and tests; injects `kind: "signer"` so
 * the schema discriminator is satisfied. Callers that already pass
 * `kind: "signer"` or `kind: "pdf"` go through unchanged.
 *
 * One input batch can carry N items — they enqueue 1:1 to the shared
 * daemon queue, and whichever alive daemon finishes its current item
 * first claims the next.
 */
export type OathSignatureCliInput =
  | OathSignatureInput
  | Omit<OathSignerInput, "kind">;

function ensureKind(input: OathSignatureCliInput): OathSignatureInput {
  if ("kind" in input) return input as OathSignatureInput;
  return { kind: "signer", ...(input as Omit<OathSignerInput, "kind">) };
}

export const runOathSignatureCli = buildCliAdapter<[OathSignatureCliInput[]], OathSignatureInput>({
  workflow: oathSignatureWorkflow,
  emptyMessage: "runOathSignatureCli: no inputs provided",
  buildInputs: (inputs) => inputs.map(ensureKind),
  deriveItemId: (input) => (input.kind === "pdf" ? input.sessionId : input.emplId),
  buildPendingData: (input) => buildOathSignaturePendingData(input),
});
