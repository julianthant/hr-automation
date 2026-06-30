// The drag-and-drop contract for placing a Data Bank op onto the graph. The
// palette rows are HTML5-draggable; the canvas reads the dropped op back. Kept as
// a tiny PURE seam (no React, no DOM) so the (de)serialization + op→node mapping
// are unit-testable — the component layer only wires `dataTransfer` to these.

import type { DataBankOperation } from "../../../../domain/workflow-design/data-bank.js";
import type { ActionNodeData } from "./graph-types.js";

/** MIME carried across the drag from the Data Bank palette to the canvas. A custom
 *  type (not `text/plain`) so a stray text/file drag never reads as an op. */
export const DATA_BANK_DRAG_MIME = "application/x-databank-op";

/** Serialize an op for `dataTransfer.setData(DATA_BANK_DRAG_MIME, …)`. */
export function serializeOpDrag(op: DataBankOperation): string {
  return JSON.stringify(op);
}

/**
 * Parse a drag payload back into an op. Defensive + total: a malformed payload or
 * a drag that isn't ours (missing the required identity fields) yields `null`
 * instead of throwing, so an errant drop is a no-op rather than a crash.
 */
export function parseOpDragPayload(text: string | null | undefined): DataBankOperation | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Partial<DataBankOperation>;
  if (
    typeof o.id === "string" &&
    typeof o.kind === "string" &&
    typeof o.system === "string" &&
    typeof o.label === "string"
  ) {
    return o as DataBankOperation;
  }
  return null;
}

/** Project a Data Bank op onto the action-node data shape, dropping palette-only
 *  provenance fields (summary / sourceRef / verified / tags / literalValue) that
 *  the placed node doesn't render. Mirrors `lane-build.ts`'s `toLaneOp`. */
export function opToActionData(op: DataBankOperation): ActionNodeData {
  return {
    opId: op.id,
    kind: op.kind,
    system: op.system,
    label: op.label,
    selectorFqn: op.selectorFqn,
    role: op.role,
    accessibleName: op.accessibleName,
    inputVar: op.inputVar,
    outputVar: op.outputVar,
    url: op.url,
    note: op.note,
  };
}
