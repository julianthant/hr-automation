import { z } from "zod/v4";
import { normalizeUcpathEmployeeId } from "../../../domain/identity/eid.js";

/** Minimum LLM confidence to auto-accept a disambiguation result as `matched`. */
export const LLM_HIGH_CONFIDENCE = 0.6;

/**
 * Shared 3-branch LLM-disambiguation outcome (oath + EC twins, extracted):
 * no-EID → `lookup-pending` with the spec's own matchSource/warning (oath
 * routes to manual review, EC falls back to name lookup); low confidence →
 * `lookup-pending`/`llm` + review warning; high confidence → `matched`/`llm`.
 * The EID write path differs per record shape (oath flat `employeeId`, EC
 * nested `employee.employeeId`) — supplied via `writeEid`.
 */
export function applyDisambiguationStd<R extends { warnings?: string[] }>(args: {
  record: R;
  result: { eid?: string | null; confidence: number };
  writeEid: (record: R, eid: string) => R;
  /** matchSource + warning for the LLM "none of these candidates" branch. */
  noMatch: { matchSource: string; warning: string };
}): R {
  const { record, result } = args;
  const resultEid = normalizeUcpathEmployeeId(result.eid ?? "");
  if (resultEid.length === 0) {
    return {
      ...args.writeEid(record, ""),
      matchState: "lookup-pending",
      matchSource: args.noMatch.matchSource,
      warnings: [...(record.warnings ?? []), args.noMatch.warning],
    };
  }

  if (result.confidence < LLM_HIGH_CONFIDENCE) {
    return {
      ...args.writeEid(record, resultEid),
      matchState: "lookup-pending",
      matchSource: "llm",
      matchConfidence: result.confidence,
      warnings: [
        ...(record.warnings ?? []),
        `LLM picked EID ${resultEid} but low confidence (${result.confidence.toFixed(2)}) — review`,
      ],
    };
  }

  return {
    ...args.writeEid(record, resultEid),
    matchState: "matched",
    matchSource: "llm",
    matchConfidence: result.confidence,
    warnings: record.warnings ?? [],
  };
}

export const VerificationSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("verified"),
    hrStatus: z.string(),
    department: z.string(),
    screenshotFilename: z.string(),
    checkedAt: z.string(),
  }),
  z.object({
    state: z.literal("inactive"),
    hrStatus: z.string(),
    department: z.string().optional(),
    screenshotFilename: z.string(),
    checkedAt: z.string(),
  }),
  z.object({
    state: z.literal("non-hdh"),
    hrStatus: z.string(),
    department: z.string(),
    screenshotFilename: z.string(),
    checkedAt: z.string(),
  }),
  z.object({
    state: z.literal("lookup-failed"),
    error: z.string(),
    checkedAt: z.string(),
  }),
]);

export type Verification = z.infer<typeof VerificationSchema>;

/**
 * `documentType` classifier from an OCR pass: `"expected"` = a real form page,
 * `"unknown"` = blank / garbage / non-form page.
 *
 * The vision prompt shows the model the page-format codes (signin / upay585 /
 * upay586 / unknown), so models routinely emit a format name (e.g. `"upay586"`)
 * here instead of the abstract `"expected"`. A strict `z.enum` would reject
 * that, and per-page `finalize()` drops the WHOLE record on any field failure —
 * so one classifier quibble silently discarded an otherwise-perfect row (name,
 * EID, signatures) and left the operator with 0 records to approve.
 *
 * The field only means "is this a real form page or junk", so coerce ANY
 * non-`"unknown"` value to `"expected"` rather than dropping the record. Only an
 * explicit (case-insensitive) `"unknown"` maps to `"unknown"`.
 */
export const DocumentTypeSchema = z.preprocess(
  (v) => (typeof v === "string" && v.trim().toLowerCase() === "unknown" ? "unknown" : "expected"),
  z.enum(["expected", "unknown"]),
);

export const MatchStateSchema = z.enum([
  "extracted",
  "matched",
  "lookup-pending",
  "lookup-running",
  "resolved",
  "unresolved",
]);

export type MatchState = z.infer<typeof MatchStateSchema>;

/**
 * The per-record child-row itemId PREFIX for an OCR form's lookup fan-out
 * (`<prefix>-<runId>-r<index>`). Oath → `ocr-oath`, emergency-contact →
 * `ocr-ec`, verify → `ocr-verify`; any other form type falls back to the
 * `ocr-<formType>` shape so a new form gets a unique, debuggable prefix rather
 * than colliding with EC.
 *
 * (F8) Replaces three hand-spelled prefixes (oath/EC `approveTo.deriveItemId`,
 * verify `enrichRecords`) AND the buggy orchestrator ternary
 * `formType === "oath" ? "oath" : "ec"` — which mislabeled EVERY non-oath form
 * (verify, future forms) as `ec`, so a verify fan-out child's itemId read
 * `ocr-ec-…` and a stale EC outcome could in principle match it.
 */
export function ocrChildItemIdPrefix(formType: string): string {
  switch (formType) {
    case "oath": return "ocr-oath";
    case "emergency-contact": return "ocr-ec";
    case "verify": return "ocr-verify";
    default: return `ocr-${formType}`;
  }
}

/**
 * Shared `OcrFormSpec.isForceResearchFlag` — every form's implementation is the
 * byte-identical `record.forceResearch === true` (F8e). One predicate, used by
 * all three specs, so the contract can't drift.
 */
export function isForceResearchFlagRecord(record: unknown): boolean {
  return (record as { forceResearch?: unknown } | null)?.forceResearch === true;
}

/**
 * Shared cross-form-kind carry-forward guard (F8e). verify rows are
 * heterogeneous (oath + EC + unknown in one PDF) and a re-run may re-classify a
 * page, so a carry-forward only rejects merging two DIFFERENT *known* kinds.
 * Legacy JSONL rows (parsed without Zod defaults) may carry `undefined` — those
 * are tolerated. Normalizes the prior `as string` casts oath/EC hand-rolled.
 *
 * @throws when both kinds are known and differ.
 */
export function assertCarryForwardKindCompatible(
  specName: string,
  v1Kind: unknown,
  v2Kind: unknown,
): void {
  const k1 = typeof v1Kind === "string" ? v1Kind : undefined;
  const k2 = typeof v2Kind === "string" ? v2Kind : undefined;
  if (k1 !== undefined && k2 !== undefined && k1 !== k2) {
    throw new Error(
      `${specName}.applyCarryForward: cross-form-kind carry-forward not supported (v1=${k1}, v2=${k2})`,
    );
  }
}
