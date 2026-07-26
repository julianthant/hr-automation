import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { CircleAlert, Info, TriangleAlert, X, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { dsElev, dsFocus, dsIcon, dsLayer, dsMotion, dsRadius, dsText } from "./tokens";
import { IconButton } from "./primitives-core";

/**
 * DEV-ONLY — floating surfaces: Dialog, Drawer, Tooltip, Toast.
 *
 * Everything here is built on Radix where a focus trap or an escape hatch is
 * involved, because focus management is not something to re-implement in a
 * tool that files real HR transactions. Radix gives us: focus moved into the
 * surface on open and RESTORED to the trigger on close, Escape to dismiss,
 * outside-click to dismiss, `aria-modal`, and the rest of the page hidden
 * from assistive tech while a modal is open.
 *
 * Motion: these are the only surfaces that animate on entry, because the
 * motion answers "where did this come from" — a dialog scales up from the
 * centre, a drawer slides in from its edge. All of it collapses to nothing
 * under `prefers-reduced-motion` (the --ds-dur-* tokens go to 0ms).
 */

/** True one frame after mount — lets a freshly-portalled surface transition in. */
function useEntered(): boolean {
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return entered;
}

/* =========================================================================
 * Dialog
 * ====================================================================== */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export type DsDialogSize = "sm" | "md" | "lg" | "xl";

const DIALOG_SIZE: Record<DsDialogSize, string> = {
  sm: "max-w-[420px]",
  md: "max-w-[560px]",
  lg: "max-w-[760px]",
  xl: "max-w-[min(94vw,1100px)]",
};

function Scrim({ layer, entered }: { layer: string; entered: boolean }) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        "fixed inset-0 bg-[var(--ds-surface-scrim)]",
        layer,
        dsMotion.enter,
        entered ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

/**
 * A modal dialog. `title` is REQUIRED — Radix warns without one, and an
 * unlabelled modal is unusable with a screen reader. Use `description` for
 * the one line that says what the operator is about to do.
 *
 * ```tsx
 * <Dialog open={open} onOpenChange={setOpen}>
 *   <DialogContent title="Approve 12 records" description="…">
 *     <DialogBody>…</DialogBody>
 *     <DialogFooter>
 *       <Button variant="secondary" onClick={…}>Cancel</Button>
 *       <Button variant="primary" onClick={…}>Approve</Button>
 *     </DialogFooter>
 *   </DialogContent>
 * </Dialog>
 * ```
 */
export function DialogContent({
  title,
  description,
  size = "md",
  hideClose,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  size?: DsDialogSize;
  hideClose?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogSurface
        title={title}
        description={description}
        size={size}
        hideClose={hideClose}
        className={className}
      >
        {children}
      </DialogSurface>
    </DialogPrimitive.Portal>
  );
}

/** Mounts only while the dialog is open — which is what makes the entry read. */
function DialogSurface({
  title,
  description,
  size,
  hideClose,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  size: DsDialogSize;
  hideClose?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const entered = useEntered();
  return (
    <>
      <Scrim layer={dsLayer.modal} entered={entered} />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 w-[calc(100vw-var(--ds-space-section))] -translate-x-1/2 -translate-y-1/2",
          DIALOG_SIZE[size],
          dsLayer.modal,
          "flex max-h-[86vh] flex-col overflow-hidden border outline-none",
          "border-[color:var(--ds-border-strong)] bg-[var(--ds-surface-overlay)]",
          dsRadius.xl,
          dsElev.high,
          dsMotion.enter,
          entered ? "opacity-100 scale-100" : "opacity-0 scale-[0.98]",
          className,
        )}
      >
        <header className="flex shrink-0 items-start gap-[var(--ds-space-base)] border-b border-[color:var(--ds-border)] px-[var(--ds-space-loose)] py-[var(--ds-space-cozy)]">
          <div className="flex min-w-0 flex-1 flex-col gap-[var(--ds-space-hair)]">
            <DialogPrimitive.Title className={cn(dsText.section, "font-semibold text-[color:var(--ds-fg)]")}>
              {title}
            </DialogPrimitive.Title>
            {description && (
              <DialogPrimitive.Description className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>
                {description}
              </DialogPrimitive.Description>
            )}
          </div>
          {!hideClose && (
            <DialogPrimitive.Close asChild>
              <IconButton label="Close" size="sm" icon={<X aria-hidden className={dsIcon.md} />} />
            </DialogPrimitive.Close>
          )}
        </header>
        {children}
      </DialogPrimitive.Content>
    </>
  );
}

export function DialogBody({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("min-h-0 flex-1 overflow-y-auto px-[var(--ds-space-loose)] py-[var(--ds-space-cozy)]", className)}>
      {children}
    </div>
  );
}

/** Actions right-aligned, primary last — the operator's eye ends on the verb. */
export function DialogFooter({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <footer
      className={cn(
        "flex shrink-0 items-center justify-end gap-[var(--ds-space-base)] border-t px-[var(--ds-space-loose)] py-[var(--ds-space-cozy)]",
        "border-[color:var(--ds-border)] bg-[var(--ds-surface-2)]",
        className,
      )}
    >
      {children}
    </footer>
  );
}

/* =========================================================================
 * Drawer — a side panel for detail that must not lose the list behind it
 * ====================================================================== */

export const Drawer = DialogPrimitive.Root;
export const DrawerTrigger = DialogPrimitive.Trigger;
export const DrawerClose = DialogPrimitive.Close;

export type DsDrawerSide = "right" | "bottom";

/**
 * A drawer is a dialog that arrives from an edge. Use it when the operator
 * needs the CONTEXT behind it (a run's detail beside its queue); use a Dialog
 * when the decision must be isolated.
 */
export function DrawerContent({
  title,
  description,
  side = "right",
  size = "480px",
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  side?: DsDrawerSide;
  /** width for a right drawer, height for a bottom one */
  size?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Portal>
      <DrawerSurface
        title={title}
        description={description}
        side={side}
        size={size}
        className={className}
      >
        {children}
      </DrawerSurface>
    </DialogPrimitive.Portal>
  );
}

function DrawerSurface({
  title,
  description,
  side,
  size,
  className,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  side: DsDrawerSide;
  size: string;
  className?: string;
  children: ReactNode;
}) {
  const entered = useEntered();
  const isRight = side === "right";
  return (
    <>
      <Scrim layer={dsLayer.drawer} entered={entered} />
      <DialogPrimitive.Content
        style={isRight ? { width: size } : { height: size }}
        className={cn(
          "fixed flex flex-col overflow-hidden border outline-none",
          isRight ? "inset-y-0 right-0 max-w-[94vw] border-l" : "inset-x-0 bottom-0 max-h-[90vh] border-t",
          dsLayer.drawer,
          "border-[color:var(--ds-border-strong)] bg-[var(--ds-surface-overlay)]",
          dsElev.high,
          "transition-transform duration-[var(--ds-dur-4)] ease-[var(--ds-ease-out)]",
          entered ? "translate-x-0 translate-y-0" : isRight ? "translate-x-full" : "translate-y-full",
          className,
        )}
      >
        <header className="flex shrink-0 items-start gap-[var(--ds-space-base)] border-b border-[color:var(--ds-border)] px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]">
          <div className="flex min-w-0 flex-1 flex-col gap-[var(--ds-space-hair)]">
            <DialogPrimitive.Title className={cn(dsText.title, "truncate font-semibold text-[color:var(--ds-fg)]")}>
              {title}
            </DialogPrimitive.Title>
            {description && (
              <DialogPrimitive.Description className={cn(dsText.meta, "truncate text-[color:var(--ds-fg-muted)]")}>
                {description}
              </DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close asChild>
            <IconButton label="Close" size="sm" icon={<X aria-hidden className={dsIcon.md} />} />
          </DialogPrimitive.Close>
        </header>
        {children}
      </DialogPrimitive.Content>
    </>
  );
}

/* =========================================================================
 * Tooltip
 * ====================================================================== */

export const TooltipProvider = TooltipPrimitive.Provider;

/**
 * A tooltip is a HINT, never the only place information lives — it is
 * invisible to touch and to a keyboard user who never tabs there. Anything
 * load-bearing goes in the UI.
 *
 * ```tsx
 * <Tooltip content="Replays the same input">
 *   <IconButton label="Retry" icon={…} />
 * </Tooltip>
 * ```
 */
export function Tooltip({
  content,
  side = "top",
  children,
}: {
  content: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  children: ReactNode;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            "max-w-[280px] border px-[var(--ds-space-base)] py-[var(--ds-space-tight)]",
            "border-[color:var(--ds-border-strong)] bg-[var(--ds-surface-overlay)] text-[color:var(--ds-fg)]",
            dsRadius.md,
            dsText.meta,
            dsElev.mid,
            dsLayer.menu,
          )}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/* =========================================================================
 * Toast
 * ====================================================================== */

export type DsToastTone = "info" | "success" | "warning" | "danger";

export interface DsToast {
  id: string;
  tone: DsToastTone;
  title: string;
  description?: string;
  /** a single recovery action — "Retry", "Undo", "Open the run" */
  action?: { label: string; onAction: () => void };
  /** ms before auto-dismiss; `danger` never auto-dismisses */
  duration?: number;
}

interface ToastContextValue {
  toast: (toast: Omit<DsToast, "id">) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

/**
 * `const { toast } = useToasts()` — then
 * `toast({ tone: "danger", title: "Write parked", description: "…" })`.
 *
 * Rules: a toast reports something that ALREADY happened. It never asks a
 * question, never holds the only copy of information, and a `danger` toast
 * never disappears on its own — a failed write must be dismissed by a human.
 */
export function useToasts(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToasts() must be used inside <ToastProvider>");
  return ctx;
}

const TOAST_TONE: Record<DsToastTone, { icon: typeof Info; accent: string; tint: string }> = {
  info: { icon: Info, accent: "text-[color:var(--ds-info-fg)]", tint: "border-l-[color:var(--ds-info-fg)]" },
  success: {
    icon: CheckCircle2,
    accent: "text-[color:var(--ds-success-fg)]",
    tint: "border-l-[color:var(--ds-success-fg)]",
  },
  warning: {
    icon: CircleAlert,
    accent: "text-[color:var(--ds-status-waiting-fg)]",
    tint: "border-l-[color:var(--ds-status-waiting-fg)]",
  },
  danger: {
    icon: TriangleAlert,
    accent: "text-[color:var(--ds-danger)]",
    tint: "border-l-[color:var(--ds-danger)]",
  },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<DsToast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((current) => current.filter((item) => item.id !== id));
  }, []);

  const toast = useCallback(
    (input: Omit<DsToast, "id">) => {
      const id = `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      setToasts((current) => [...current, { ...input, id }]);
      // A failure stays until acknowledged. Everything else clears itself.
      if (input.tone !== "danger") {
        const timer = setTimeout(() => dismiss(id), input.duration ?? 5000);
        timers.current.set(id, timer);
      }
      return id;
    },
    [dismiss],
  );

  // Capture the map instance for the unmount sweep — `timers.current` read at
  // cleanup time would be a lint (and correctness) hazard.
  const timersMap = timers.current;
  useEffect(() => () => timersMap.forEach((timer) => clearTimeout(timer)), [timersMap]);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

function ToastViewport({ toasts, onDismiss }: { toasts: DsToast[]; onDismiss: (id: string) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Notifications"
      className={cn(
        "pointer-events-none fixed bottom-[var(--ds-space-loose)] right-[var(--ds-space-loose)]",
        "flex w-[360px] max-w-[calc(100vw-var(--ds-space-section))] flex-col gap-[var(--ds-space-base)]",
        dsLayer.toast,
      )}
    >
      {toasts.map((item) => (
        <ToastCard key={item.id} toast={item} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: DsToast; onDismiss: (id: string) => void }) {
  const entered = useEntered();
  const spec = TOAST_TONE[toast.tone];
  const Icon = spec.icon;
  return (
    <div
      role={toast.tone === "danger" ? "alert" : "status"}
      className={cn(
        "pointer-events-auto flex items-start gap-[var(--ds-space-base)] border border-l-[length:var(--ds-border-w-rail)] p-[var(--ds-space-cozy)]",
        "border-[color:var(--ds-border-strong)] bg-[var(--ds-surface-overlay)]",
        spec.tint,
        dsRadius.md,
        dsElev.mid,
        dsMotion.enter,
        entered ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
      )}
    >
      <Icon aria-hidden className={cn(dsIcon.lg, "mt-px shrink-0", spec.accent)} />
      <div className="flex min-w-0 flex-1 flex-col gap-[var(--ds-space-hair)]">
        <span className={cn(dsText.ui, "font-medium text-[color:var(--ds-fg)]")}>{toast.title}</span>
        {toast.description && (
          <span className={cn(dsText.body, "text-[color:var(--ds-fg-muted)]")}>{toast.description}</span>
        )}
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onAction();
              onDismiss(toast.id);
            }}
            className={cn(
              "mt-[var(--ds-space-tight)] w-fit cursor-pointer underline underline-offset-2",
              dsText.meta,
              "text-[color:var(--ds-fg)]",
              dsFocus,
            )}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <IconButton
        label="Dismiss"
        size="sm"
        icon={<X aria-hidden className={dsIcon.md} />}
        onClick={() => onDismiss(toast.id)}
      />
    </div>
  );
}
