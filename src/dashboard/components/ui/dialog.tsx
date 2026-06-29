import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * The dashboard's single Dialog primitive — a shadcn-style wrapper around Radix.
 * Every modal (RunModal, OcrReviewPane, ConfirmDialog, ShortcutsGuide, capture
 * modal, browser-peek) builds on this; there is no parallel dialog
 * implementation. Mirrors the layout idioms in `tooltip.tsx` / `popover.tsx`
 * (forwardRef, cn(...) classnames, no extra deps beyond Radix).
 *
 * Composition:
 *   <Dialog><DialogContent size="lg">
 *     <DialogHeader><DialogTitle/><DialogDescription/></DialogHeader>
 *     <DialogBody> …scrolls when tall… </DialogBody>
 *     <DialogFooter> …actions… </DialogFooter>
 *   </DialogContent></Dialog>
 */

/** Width presets for `DialogContent`. `className` still overrides if needed. */
export type DialogSize = "sm" | "md" | "lg" | "xl" | "full";

const DIALOG_SIZE: Record<DialogSize, string> = {
  sm: "max-w-[420px]",
  md: "max-w-[520px]",
  lg: "max-w-[720px]",
  xl: "max-w-[920px]",
  full: "max-w-[min(96vw,1400px)]",
};

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/60 backdrop-blur-sm",
      "data-[state=open]:animate-in data-[state=closed]:animate-out",
      "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = "DialogOverlay";

const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    /** When true, the default close (X) button is omitted. */
    hideClose?: boolean;
    /** Width preset (default `md` = 520px). `className` overrides. */
    size?: DialogSize;
  }
>(({ className, children, hideClose, size = "md", ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed left-1/2 top-1/2 z-50 w-full",
        DIALOG_SIZE[size],
        "-translate-x-1/2 -translate-y-1/2",
        "rounded-md border border-border bg-card text-foreground shadow-xl",
        "outline-none",
        "data-[state=open]:animate-in data-[state=closed]:animate-out",
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
        "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
        className,
      )}
      {...props}
    >
      {children}
      {!hideClose && (
        <DialogPrimitive.Close
          aria-label="Close dialog"
          className={cn(
            "absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-md",
            "text-muted-foreground transition-colors",
            "hover:bg-muted hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-card",
            "disabled:pointer-events-none cursor-pointer",
          )}
        >
          <X className="h-3.5 w-3.5" />
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPortal>
));
DialogContent.displayName = "DialogContent";

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col gap-1 px-5 py-4 border-b border-border", className)} {...props} />
);
DialogHeader.displayName = "DialogHeader";

/**
 * Scrollable body region for tall dialogs — caps at `maxHeight` (default 70vh)
 * and scrolls inside the themed `ScrollArea`, so the header/footer stay pinned.
 * Opt-in: simple dialogs (ConfirmDialog) don't need it.
 */
const DialogBody = ({
  className,
  viewportClassName,
  maxHeight = "70vh",
  children,
}: {
  className?: string;
  viewportClassName?: string;
  maxHeight?: string;
  children?: React.ReactNode;
}) => (
  <ScrollArea className={className} viewportClassName={viewportClassName} style={{ maxHeight }}>
    {children}
  </ScrollArea>
);
DialogBody.displayName = "DialogBody";

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex items-center justify-end gap-2 px-5 py-3 bg-muted/30 border-t border-border rounded-b-md",
      className,
    )}
    {...props}
  />
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-base font-semibold text-foreground", className)}
    {...props}
  />
));
DialogTitle.displayName = "DialogTitle";

const DialogDescription = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-xs text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = "DialogDescription";

export {
  Dialog,
  DialogTrigger,
  DialogPortal,
  DialogClose,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
