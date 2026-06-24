import { onbaseDocTypeFormType } from "@/lib/onbase-document-types";

/**
 * Resolve the OCR `formType` the OnBase run modal should apply when its
 * document-type dropdown drives the form (`showOnbaseDocType`).
 *
 * Pure so the run-modal's `formType` contract is unit-testable without a React
 * render harness (the dashboard has none). The component's effect calls this on
 * every `[open, showOnbaseDocType, onbaseDocType]` change.
 *
 * The `open` gate is load-bearing (ISS-001, 2026-06-24): the modal's
 * close-reset effect sets `formType = null` — and it ALSO runs on initial mount
 * while `open` is false. If the derivation does not re-run when the modal
 * OPENS, `formType` stays null, `handleSubmit`'s `!formType` guard returns
 * early, and clicking Run is a silent no-op (no `/api/ocr/prepare` request) —
 * making the entire OnBase workflow unstartable from the dashboard. So when the
 * modal is open we MUST apply a derived (non-null for a wired doc type)
 * formType; when it is closed we no-op and let the reset own the state.
 *
 * @returns `apply:false` → the effect should NOT call setFormType (closed, or
 *   not an onbase-doctype modal); `apply:true` with `formType` → the effect
 *   should `setFormType(formType)` (null only when the doc type is unwired).
 */
export function resolveOnbaseModalFormType(opts: {
  open: boolean;
  showOnbaseDocType: boolean;
  onbaseDocType: string;
}): { apply: boolean; formType: string | null } {
  if (!opts.showOnbaseDocType || !opts.open) {
    return { apply: false, formType: null };
  }
  return { apply: true, formType: onbaseDocTypeFormType(opts.onbaseDocType) ?? null };
}
