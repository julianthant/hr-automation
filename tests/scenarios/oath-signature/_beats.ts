import type { ScenarioBeat } from "../_runtime/index.js";
import type { OathSignerInput } from "../../../src/workflows/oath-signature/schema.js";

/** Populates the workflow `date` detailField in scenario tests. */
export const SCENARIO_SIGNATURE_DATE = "05/01/2026";

export interface OathSignatureBeatsOpts {
  /**
   * Step name to hold inside until the runtime releases or cancels. Only
   * `"transaction"` does real work — `ucpath-auth` is a `markStep` marker.
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
 * Build the scripted beat sequence for the EID signer flow — mirrors the
 * real `runSignerBranch` handler:
 *
 *   1. `ctx.updateData({ emplId, name, date? })` — seeds operator-facing
 *      fields onto every subsequent row.
 *   2. `ctx.markStep("ucpath-auth")` — synthetic timeline marker (auth
 *      done by Session.launch in production).
 *   3. `ctx.step("transaction", ...)` — the real PeopleSoft work. Held or
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
 * instance counter) with stable placeholders so `toMatchInlineSnapshot()` locks
 * the shape across runs, not the specific id values.
 *
 * The retired `Oath · <last4>` subtitle masking was dead code: the EID-signer
 * flow now resolves a person-kind footer subtitle to the EID (flat single) or
 * the trace id (batch/preview anchor), never the legacy `Oath · xxxx` template,
 * so the regex never matched. Trace ids are already scrubbed by `snapshotRow`.
 */
export function maskVolatile<T extends {
  runId: string;
  itemId: string;
  data: Record<string, string>;
  parentRunId?: string | null;
}>(
  snap: T,
): T {
  const parentRunId = typeof snap.parentRunId === "string" && /#[0-9a-f]{8}$/.test(snap.parentRunId)
    ? snap.parentRunId.replace(/#[0-9a-f]{8}$/, "#<run>")
    : snap.parentRunId;
  return {
    ...snap,
    runId: "<runId>",
    itemId: "<itemId>",
    ...(parentRunId !== undefined ? { parentRunId } : {}),
    data: { ...snap.data, instance: "<instance>" },
  };
}
