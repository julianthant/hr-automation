import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "destructive";
  /** Optional icon beside the title (e.g. a Trash2). */
  icon?: ReactNode;
  /** Disables the confirm button + keeps the dialog open while an action runs. */
  pending?: boolean;
  onConfirm: () => void;
}

/**
 * On-theme replacement for `window.confirm` — a focus-trapped, Esc-cancellable
 * dialog built on `ui/dialog.tsx`. Used for destructive bulk actions so the
 * confirm step matches the dark UI instead of breaking out to OS chrome.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  icon,
  pending = false,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px] p-0" hideClose>
        <DialogHeader className="border-b-0 px-5 pb-0 pt-5">
          <DialogTitle className="flex items-center gap-2.5">
            {icon}
            {title}
          </DialogTitle>
          {description && (
            <DialogDescription className="mt-1.5 leading-relaxed">{description}</DialogDescription>
          )}
        </DialogHeader>
        <DialogFooter className="rounded-b-md border-t-0 bg-transparent px-5 pb-5 pt-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className={cn(
              "inline-flex h-9 items-center rounded-lg border border-border bg-transparent px-3.5 text-[13px] font-medium text-foreground",
              "outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
              "cursor-pointer",
            )}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-lg border px-3.5 text-[13px] font-medium outline-none transition-colors cursor-pointer",
              "focus-visible:ring-2 focus-visible:ring-offset-1 disabled:cursor-wait disabled:opacity-60",
              tone === "destructive"
                ? "border-destructive/45 bg-destructive/15 text-destructive hover:bg-destructive/25 focus-visible:ring-destructive"
                : "border-primary bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-primary",
            )}
          >
            {confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
