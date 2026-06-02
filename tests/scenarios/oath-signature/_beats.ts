import type { ScenarioBeat } from "../_runtime/index.js";
import type {
  OathSignerInput,
  OathPdfInput,
} from "../../../src/workflows/oath-signature/schema.js";

/** Populates the workflow `date` detailField in scenario tests. */
export const SCENARIO_SIGNATURE_DATE = "05/01/2026";

export interface OathSignatureBeatsOpts {
  /**
   * Step name to hold inside until the runtime releases or cancels. Only
   * `"transaction"` does real work in the signer branch — the other steps
   * are `ctx.markStep` / `ctx.skipStep` markers and have no body to hold.
   */
  holdAt?: "transaction";
  /**
   * Throw an error from inside the named step body. Used to simulate
   * mid-step failures (network blips, UCPath errors) — the kernel emits a
   * `failed` row with the error attached, and (when no cancel is in flight)
   * leaves `step` set to the failed step rather than `"cancelled"`.
   */
  throwAt?: { step: "transaction"; error: Error };
}

/**
 * Build the scripted beat sequence for the **signer** branch — mirrors
 * the real `runSignerBranch` handler:
 *
 *   1. `ctx.updateData({ emplId, name, date? })` — seeds operator-facing
 *      fields onto every subsequent row.
 *   2. `ctx.skipStep("ocr")` + `ctx.skipStep("delegate-signatures")` — PDF-branch
 *      steps don't apply on a signer run.
 *   3. `ctx.markStep("ucpath-auth")` — synthetic timeline marker (auth
 *      done by Session.launch in production).
 *   4. `ctx.step("transaction", ...)` — the real PeopleSoft work. Held or
 *      thrown according to `opts`.
 */
export function oathSignatureBeats(
  input: OathSignerInput,
  opts: OathSignatureBeatsOpts = {},
): ScenarioBeat[] {
  return [
    {
      kind: "updateData",
      data: {
        emplId: input.emplId,
        ...(input.name ? { name: input.name } : {}),
        date: input.date ?? SCENARIO_SIGNATURE_DATE,
        ...(input.dryRun ? { dryRun: true } : {}),
      },
    },
    { kind: "skipStep", name: "ocr" },
    { kind: "skipStep", name: "delegate-signatures" },
    { kind: "markStep", name: "ucpath-auth" },
    {
      kind: "step",
      name: "transaction",
      hold: opts.holdAt === "transaction",
      throw: opts.throwAt?.step === "transaction" ? opts.throwAt.error : undefined,
    },
  ];
}

export interface OathPdfBeatsOpts {
  /**
   * Step to hold inside until the runtime releases or cancels. `"ocr"`
   * simulates "waiting for operator to approve OCR"; `"delegate-signatures"`
   * would simulate "signer fan-out in flight" (rarely useful since the signer
   * children run real workflows in the scenario harness).
   */
  holdAt?: "ocr" | "delegate-signatures";
  /**
   * Throw from inside the named step body — e.g. simulate "OCR child
   * came back failed" or "a signer child reported non-done status".
   */
  throwAt?: { step: "ocr" | "delegate-signatures"; error: Error };
}

/**
 * Scripted beats for the **PDF** branch — mirrors `runPdfBranch` shape
 * **without** invoking real OCR delegation. The scenario harness has no
 * OCR delegation integration today; tests use scripted `step` beats to
 * stand in for the real `ctx.delegateTo(ocrWorkflow, ...)` +
 * `ctx.delegateToAll(oathSignatureWorkflow, ...)` calls.
 *
 * Step sequence:
 *   1. `updateData` — seeds pdfOriginalName / sessionId on the row.
 *   2. `ctx.skipStep("ucpath-auth")` + `ctx.skipStep("transaction")`.
 *   3. `ctx.step("ocr", ...)` — operator-approval surrogate.
 *   4. `ctx.step("delegate-signatures", ...)` — signer fan-out surrogate;
 *      tests that need to assert downstream signer rows must enqueue them
 *      through the runtime separately (the harness doesn't auto-spawn children).
 */
export function oathPdfBeats(
  input: OathPdfInput,
  opts: OathPdfBeatsOpts = {},
): ScenarioBeat[] {
  return [
    {
      kind: "updateData",
      data: {
        pdfOriginalName: input.pdfOriginalName,
        sessionId: input.sessionId,
        ...(input.pdfHash ? { pdfHash: input.pdfHash } : {}),
        ...(input.dryRun ? { dryRun: true } : {}),
      },
    },
    { kind: "skipStep", name: "ucpath-auth" },
    { kind: "skipStep", name: "transaction" },
    {
      kind: "step",
      name: "ocr",
      hold: opts.holdAt === "ocr",
      throw: opts.throwAt?.step === "ocr" ? opts.throwAt.error : undefined,
    },
    {
      kind: "step",
      name: "delegate-signatures",
      hold: opts.holdAt === "delegate-signatures",
      throw: opts.throwAt?.step === "delegate-signatures" ? opts.throwAt.error : undefined,
    },
  ];
}

/**
 * Convenience masking helper — replaces volatile fields (per-run identifiers,
 * instance counter, last-4-runId subtitle suffix) with stable placeholders so
 * `toMatchInlineSnapshot()` locks the shape across runs, not the specific id
 * values.
 */
export function maskVolatile<T extends {
  runId: string;
  itemId: string;
  data: Record<string, string>;
  subtitle?: string | undefined;
  parentRunId?: string | null;
}>(
  snap: T,
): T {
  const subtitle = typeof snap.subtitle === "string"
    ? snap.subtitle.replace(/^Oath · [0-9a-f]{4}$/, "Oath · <last4>")
    : snap.subtitle;
  const parentRunId = typeof snap.parentRunId === "string" && /#[0-9a-f]{8}$/.test(snap.parentRunId)
    ? snap.parentRunId.replace(/#[0-9a-f]{8}$/, "#<run>")
    : snap.parentRunId;
  return {
    ...snap,
    runId: "<runId>",
    itemId: "<itemId>",
    ...(parentRunId !== undefined ? { parentRunId } : {}),
    ...(subtitle !== undefined ? { subtitle } : {}),
    data: { ...snap.data, instance: "<instance>" },
  };
}
