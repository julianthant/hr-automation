import type { ScenarioBeat } from "../_runtime/index.js";
import type { OathSignatureInput } from "../../../src/workflows/oath-signature/schema.js";

export interface OathSignatureBeatsOpts {
  /**
   * Step name to hold inside until the runtime releases or cancels. Only
   * `"transaction"` does real work in oath-signature — the other steps are
   * `ctx.markStep` markers and have no body to hold.
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
 * Build the scripted beat sequence that mirrors the real oath-signature
 * handler:
 *
 *   1. `ctx.updateData({ emplId, name, date? })` — seeds operator-facing
 *      fields onto every subsequent row.
 *   2. `ctx.markStep("ocr")` — synthetic timeline marker (OCR upstream).
 *   3. `ctx.markStep("ucpath-auth")` — synthetic timeline marker (auth done
 *      by Session.launch in production).
 *   4. `ctx.step("transaction", ...)` — the real PeopleSoft work. Held or
 *      thrown according to `opts`.
 */
export function oathSignatureBeats(
  input: OathSignatureInput,
  opts: OathSignatureBeatsOpts = {},
): ScenarioBeat[] {
  return [
    {
      kind: "updateData",
      data: {
        emplId: input.emplId,
        ...(input.name ? { name: input.name } : {}),
        ...(input.date ? { date: input.date } : {}),
        ...(input.dryRun ? { dryRun: true } : {}),
      },
    },
    { kind: "markStep", name: "ocr" },
    { kind: "markStep", name: "ucpath-auth" },
    {
      kind: "step",
      name: "transaction",
      hold: opts.holdAt === "transaction",
      throw: opts.throwAt?.step === "transaction" ? opts.throwAt.error : undefined,
    },
  ];
}

/**
 * Convenience masking helper — replaces volatile fields (per-run identifiers,
 * instance counter) with stable placeholders so `toMatchInlineSnapshot()`
 * locks the shape across runs, not the specific id values.
 */
export function maskVolatile<T extends { runId: string; itemId: string; data: Record<string, string> }>(
  snap: T,
): T {
  return {
    ...snap,
    runId: "<runId>",
    itemId: "<itemId>",
    data: { ...snap.data, instance: "<instance>" },
  };
}
