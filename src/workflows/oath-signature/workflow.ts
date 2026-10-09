import {
  defineWorkflow,
  runWorkflow,
} from "../../core/index.js";
import { buildCliAdapter } from "../../core/cli-adapter.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { loginToUCPath, loginToACTCrm } from "../../infra/auth/login.js";
import { todayMmDdYyyy } from "../../domain/dates.js";
import { buildOperatorSubject } from "../../domain/operator-subject.js";
import { rootQueueTitleData } from "../../domain/queue-title.js";
import { DEFAULT_WORKFLOW_RUNTIME_POLICY } from "../../domain/workflow-runtime/default-policy.js";
import type { WorkflowRuntimePolicy } from "../../domain/workflow-runtime/types.js";
import { oathSignatureStatusExtensions } from "../../domain/oath-signature-status.js";
import {
  buildOathSignaturePlan,
  returnToSearchForNextItem,
  type OathSignatureContext,
} from "./enter.js";
import { verifyOathInCrm, decideCrmGate, type CrmGateDecision } from "./crm-verify.js";
import {
  OathSignatureInputSchema,
  type OathSignatureInput,
  type OathSignerInput,
} from "./schema.js";

/**
 * Normalize a date value pulled off tracker data / input to MM/DD/YYYY.
 *
 * Accepts M/D/YYYY (single digits padded — an operator typing "7/1/2026" in
 * Edit Data must not have the override silently dropped). Empty/absent → "".
 * Any other non-empty shape THROWS: silently discarding an operator's date
 * override and substituting the CRM date (or today) is exactly the
 * plausible-but-wrong-value class the fail-loud rule forbids.
 * Exported for unit tests.
 */
export function asMmDdYyyy(value: unknown): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (s.length === 0) return "";
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) {
    throw new Error(
      `Oath signature date "${s}" is not M/D/YYYY — fix the Signature Date value (it will NOT be silently ignored)`,
    );
  }
  return `${m[1].padStart(2, "0")}/${m[2].padStart(2, "0")}/${m[3]}`;
}

/**
 * An operator "CRM Onboarding" override that forces the CRM gate to pass.
 *
 * STRICT allowlist — exact positive tokens, or the workflow's own
 * "Verified (<stage>)" label (carried through edit-and-resume). A substring
 * match here was a real bug: /verif/i also matched "Not verified" /
 * "Unverified", silently bypassing the gate on a NEGATIVE annotation.
 * Anything not on the allowlist (including negations and free text) leaves
 * the gate ON, so the CRM check simply re-runs — the safe direction.
 * Exported for unit tests.
 */
export function isForceVerifiedOverride(value: unknown): boolean {
  const s = typeof value === "string" ? value.trim() : "";
  if (s.length === 0) return false;
  return (
    /^(verified|verify|override|yes|true|approved|confirm|confirmed|force)$/i.test(s) ||
    /^verified\s*\(/i.test(s)
  );
}

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
  // batch (`alwaysOperationDelegatedMembers`), and a single manual EID input run is
  // a one-member batch too (`alwaysOperationInputRun`).
  delegation: {
    ...DEFAULT_WORKFLOW_RUNTIME_POLICY.delegation,
    alwaysOperationDelegatedMembers: true,
    alwaysOperationInputRun: true,
  },
};

const WORKFLOW = "oath-signature";
const oathSignatureSteps = ["crm-verify", "ucpath-auth", "transaction"] as const;

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
      // CRM onboarding is checked FIRST (the `crm-verify` step). deferAuth so a
      // fan-out signer child only Duos when it actually reaches CRM, and an
      // Edit-Data override that bypasses the gate never touches CRM at all.
      id: "crm",
      deferAuth: true,
    },
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
  statusExtensions: oathSignatureStatusExtensions,
  queueTitle: { kind: "single" },
  batch: {
    mode: "sequential",
    preEmitPending: true,
    betweenItems: ["reset"],
  },
  // Edit Data (opt-in via `editable`): override the CRM result (flip a
  // "Skipped — No CRM Record" row to Verified to force the oath through), the
  // signature date, and the EID, then re-run without re-checking CRM. Signature
  // Time is CRM-derived display only.
  matchKey: "emplId",
  detailFields: [
    { key: "name", label: "Employee", conditional: true },
    { key: "emplId", label: "Empl ID", editable: true, inputKind: "id", group: "Employee" },
    { key: "crmOnboarding", label: "CRM Onboarding", conditional: true, editable: true, group: "Verification" },
    { key: "date", label: "Signature Date", conditional: true, editable: true, inputKind: "date", group: "Verification" },
    { key: "signatureTime", label: "Signature Time", conditional: true },
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
  const oathCtx: OathSignatureContext = {
    employeeName: input.name ?? "",
    alreadyHasOath: false,
    oathDate: "",
    existingOathDate: "",
  };

  // Effective values read from ctx.data (which already has any Edit-Data
  // prefilled overrides merged in — see handler-runner) with the raw input as
  // the fallback, so an operator EID / date / CRM-result override reaches the
  // search + gate. The handler's own updateData must therefore use these
  // EFFECTIVE values, never input.* (which would clobber the prefill).
  const data = ctx.data;
  const effectiveEmplId =
    (typeof data.emplId === "string" && data.emplId.trim()) || input.emplId;
  const effectiveName =
    (typeof data.name === "string" ? data.name.trim() : "") || (input.name ?? "");
  const dateOverride = asMmDdYyyy(data.date) || asMmDdYyyy(input.date);
  const forceVerified = isForceVerifiedOverride(data.crmOnboarding);

  ctx.updateData({
    emplId: effectiveEmplId,
    ...(effectiveName ? { name: effectiveName } : {}),
    ...(dateOverride ? { date: dateOverride } : {}),
    ...(input.dryRun ? { dryRun: true } : {}),
  });
  oathCtx.employeeName = effectiveName;

  // ── Step 1: CRM onboarding verification (the gate) ───────────────────────
  // Confirm the employee completed onboarding in ACT CRM (has a record whose
  // UCPath ID matches, with a "Witness Ceremony Oath New Hire Signed" event) and
  // read that authoritative signature date. No record / not signed → skip. An
  // Edit-Data "CRM Onboarding = Verified" override bypasses this step entirely
  // (no CRM Duo), so an operator can force a mis-skipped row through.
  let gate: CrmGateDecision | null = null;
  if (forceVerified) {
    ctx.skipStep("crm-verify");
    const label =
      typeof data.crmOnboarding === "string" && data.crmOnboarding.trim()
        ? data.crmOnboarding.trim()
        : "Verified (override)";
    ctx.updateData({ crmOnboarding: label });
    log.step(`CRM check bypassed via Edit Data override for ${effectiveEmplId}.`);
  } else {
    gate = await ctx.step("crm-verify", async (): Promise<CrmGateDecision> => {
      const crmPage = await ctx.page("crm");
      const ok = await loginToACTCrm(crmPage, ctx.workflowInstance, ctx.signal);
      if (!ok) throw new Error("ACT CRM authentication failed");
      const verification = await verifyOathInCrm(
        crmPage,
        effectiveEmplId,
        effectiveName || undefined,
      );
      const decision = decideCrmGate(verification);
      ctx.updateData({
        crmOnboarding: decision.crmOnboarding,
        ...(decision.signedTime ? { signatureTime: decision.signedTime } : {}),
      });
      return decision;
    });

    if (gate.skip) {
      ctx.updateData({
        skipped: "true",
        skipReason: gate.skipReason ?? "Skipped",
        status: `Skipped (${gate.skipReason ?? "no CRM record"})`,
      });
      // No UCPath work — mark the remaining steps skipped so the pipeline reads
      // clean (crm-verify done → ucpath-auth / transaction skipped).
      ctx.skipStep("ucpath-auth");
      ctx.skipStep("transaction");
      log.success(
        `Skipped ${effectiveEmplId}${effectiveName ? ` (${effectiveName})` : ""} — ${gate.skipReason}.`,
      );
      return;
    }
  }

  // The CRM "New Hire Signed" date is the signature date entered into UCPath,
  // unless an explicit operator/upstream date override was supplied.
  const crmSignedDate = gate ? asMmDdYyyy(gate.signedDate) : "";
  const effectiveDate = dateOverride || crmSignedDate;

  // ── Step 2: UCPath auth ──────────────────────────────────────────────────
  // `loginToUCPath` is idempotent ("already_logged_in" → true), so on a daemon
  // only the first item shows Duo and the rest reuse the warm session.
  const page = await ctx.page("ucpath");
  await ctx.step("ucpath-auth", async () => {
    const ok = await loginToUCPath(page, undefined, ctx.signal);
    if (!ok) throw new Error("UCPath authentication failed");
  });

  // Audit shot of the ONE ucpath page at each meaningful moment. Wired into the
  // plan so the visual trail is person-found → oath-staged → saved — never the
  // empty search form.
  const shot = (label: string): Promise<void> =>
    ctx.screenshot({ kind: "form", label, systems: ["ucpath"] }).then(() => undefined);

  // ── Step 3: UCPath transaction ───────────────────────────────────────────
  await ctx.step("transaction", async () => {
    // planInput carries the effective EID + effective date (operator override →
    // CRM signed date → else UCPath's today prefill). The live-page probe inside
    // buildOathSignaturePlan still skips OK/Save when an oath already exists —
    // that's the sole duplicate guard (tracker idempotency removed 2026-04-23).
    const planInput: OathSignerInput = {
      ...input,
      emplId: effectiveEmplId,
      date: effectiveDate || undefined,
    };

    let dryRunProofCaptured = false;
    const plan = buildOathSignaturePlan(planInput, page, oathCtx, {
      onProfileLoaded: () => shot("oath-signature-profile"),
      onOathStaged: () => shot("oath-signature-oath-entered"),
      beforeCommit: async () => {
        await shot("oath-signature-dry-run-pre-save");
        dryRunProofCaptured = true;
      },
      onSaved: () => shot("oath-signature-saved"),
    });
    await plan.execute();

    if (oathCtx.employeeName) {
      ctx.updateData({ name: oathCtx.employeeName });
    }

    // Record the signature date on BOTH paths. Add path: the value read back
    // from the form (override / CRM date / today prefill). Skip-existing path:
    // the CRM/override date, else the existing grid date — recorded even though
    // someone else entered the oath (the dashboard showed "—" before).
    const recordedDate = oathCtx.alreadyHasOath
      ? effectiveDate || oathCtx.existingOathDate
      : oathCtx.oathDate || effectiveDate || todayMmDdYyyy();
    if (recordedDate) {
      ctx.updateData({ date: recordedDate });
    }

    if (oathCtx.alreadyHasOath) {
      ctx.updateData({
        skipped: "true",
        skipReason: "Oath already on file",
        status: "Skipped (Existing Oath)",
      });
      log.success(
        `Skipped ${effectiveEmplId}${oathCtx.employeeName ? ` (${oathCtx.employeeName})` : ""} — oath already on file${recordedDate ? ` (${recordedDate})` : ""}.`,
      );
      return;
    }

    if (input.dryRun) {
      ctx.updateData({
        status: "Dry Run Complete",
        dryRunProofCaptured: String(dryRunProofCaptured),
      });
      log.success(
        `Dry run complete for ${effectiveEmplId}${oathCtx.employeeName ? ` (${oathCtx.employeeName})` : ""} — UCPath Save was skipped.`,
      );
      return;
    }

    log.success(
      `Oath signature added for ${effectiveEmplId}${oathCtx.employeeName ? ` (${oathCtx.employeeName})` : ""}${recordedDate ? ` (${recordedDate})` : ""}.`,
    );
  });

  // Clean state for the next daemon EID — OUTSIDE the transaction step so its
  // end-of-step audit screenshot captures the saved oath, not this search form.
  // Best-effort: a post-save cleanup hiccup must never fail a committed oath
  // (`betweenItems: ["reset"]` also resets the page between items).
  await returnToSearchForNextItem(page).catch(() => {});
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
