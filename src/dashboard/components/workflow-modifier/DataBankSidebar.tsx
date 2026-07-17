import type { JSX } from "react";
import { useCallback, useRef, useState } from "react";
import type { DataBank, DataBankOperation } from "../../../domain/workflow-design/data-bank.js";
import { DataBankPalette, type AnnotateKind } from "./graph/DataBankPalette.js";
import { DataBankOpDialog } from "./graph/DataBankOpDialog.js";

interface DataBankSidebarProps {
  bank: DataBank | null;
  /** Place a customized op as a standalone action node on the canvas. */
  onAddOp: (op: DataBankOperation) => void;
  /** Add an annotation node (note / group). */
  onAddAnnotation: (kind: AnnotateKind) => void;
}

/**
 * Permanent right-rail Data Bank — the searchable catalog of every real automation
 * primitive. Op rows are draggable onto step lanes / the canvas; clicking opens a
 * detail dialog for explanation + customization before placement.
 */
export function DataBankSidebar({ bank, onAddOp, onAddAnnotation }: DataBankSidebarProps): JSX.Element {
  const [dialogOp, setDialogOp] = useState<DataBankOperation | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const dragStartedRef = useRef(false);

  const handleOpClick = useCallback((op: DataBankOperation) => {
    if (dragStartedRef.current) {
      dragStartedRef.current = false;
      return;
    }
    setDialogOp(op);
    setDialogOpen(true);
  }, []);

  const markDragStarted = useCallback(() => {
    dragStartedRef.current = true;
  }, []);

  return (
    <>
      <DataBankPalette
        variant="sidebar"
        bank={bank}
        onAddOp={onAddOp}
        onOpClick={handleOpClick}
        onOpDragStart={markDragStarted}
        onAddAnnotation={onAddAnnotation}
      />
      <DataBankOpDialog
        op={dialogOp}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onAddToCanvas={onAddOp}
      />
    </>
  );
}
