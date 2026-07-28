import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { ChevronDown, ChevronUp, CircleAlert, Info, TriangleAlert, X, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { dsElev, dsFocus, dsIcon, dsLayer, dsMotion, dsRadius, dsText } from "./tokens";
import { IconButton } from "./primitives-core";
import { FloatingSurface } from "./primitives-layout";

/**
 * DEV-ONLY — floating surfaces: Dialog, Drawer, Popover, Tooltip, Toast.
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

/* =========================================================================
 * Modal presence
 *
 * A module-scoped registry of how many modal surfaces are currently mounted,
 * so the toast viewport can get out of a dialog's way without the two surfaces
 * having to know about each other (and without every app having to nest one
 * provider inside the other in the right order).
 *
 * WHY IT EXISTS: the viewport is `fixed bottom-right` at the toast layer, which
 * put it directly on top of a dialog's footer at 1280×720 — and a `danger`
 * toast never auto-dismisses, so it sat there swallowing clicks aimed at the
 * dialog's primary button. See `ToastViewport` for what we do about it.
 * ====================================================================== */

/**
 * TWO COUNTS, because two different things are being asked for.
 *
 * `modal` — a Dialog or a Drawer. It has a footer whose right-hand gutter holds
 * the primary action, and the toast viewport must not COVER that. This is the
 * only thing that may move the viewport.
 *
 * `layer` — a Popover or a context menu. Non-modal, anchored, no action gutter.
 * A toast must not swallow a click meant for one, but it has no business
 * teleporting to the other side of the window every time an ⓘ is opened. That
 * is the same "one surface moves because another exists" defect the operator
 * rejected, and a popover is the most frequently opened surface in the product.
 */
let openModalCount = 0;
let openLayerCount = 0;
const modalListeners = new Set<() => void>();

function subscribeModals(onChange: () => void): () => void {
  modalListeners.add(onChange);
  return () => {
    modalListeners.delete(onChange);
  };
}

function bumpCount(kind: "modal" | "layer", delta: number): void {
  if (kind === "modal") openModalCount += delta;
  else openLayerCount += delta;
  modalListeners.forEach((listener) => listener());
}

/** Called by every overlay surface; they only mount while open. */
function useRegisterModal(kind: "modal" | "layer" = "modal"): void {
  useEffect(() => {
    bumpCount(kind, 1);
    return () => bumpCount(kind, -1);
  }, [kind]);
}

/**
 * Register a modal surface that is NOT one of this file's Dialog/Drawer.
 *
 * The registry above is what moves the toast viewport out of a decision's way,
 * and `ds`'s own overlays opt in automatically. Any OTHER dialog primitive
 * rendered inside this app — notably `@/components/ui/dialog`, which the demo's
 * `ConfirmCommandDialog` and `RenameRunDialog` are built on — is invisible to it,
 * so a persistent `danger` toast can still sit on top of those footers and eat
 * the click. Those dialogs cannot see this module's internals, so this is the
 * seam they call instead.
 *
 * Call it from a component that MOUNTS ONLY WHILE THE DIALOG IS OPEN (the
 * content, not the root) — the count is keyed to mount, not to an `open` prop:
 *
 * ```tsx
 * function ConfirmBody() {
 *   useDsModalPresence();      // ← unregisters on unmount
 *   return <DialogHeader>…</DialogHeader>;
 * }
 *
 * <Dialog open={open}>
 *   <DialogContent>{open && <ConfirmBody />}</DialogContent>
 * </Dialog>
 * ```
 *
 * Radix's `DialogContent` already unmounts its children on close, so rendering
 * the hook's host inside `DialogContent` is enough in the common case.
 */
export function useDsModalPresence(): void {
  useRegisterModal();
}

/**
 * Is any Dialog or Drawer open right now?
 *
 * Exported because a keyboard-first shell has to stop listening while one is:
 * Radix traps FOCUS, but a `window` keydown listener still fires, so `j`/`k`
 * kept moving the queue selection behind an open modal and the operator came
 * back to a different row than the one they left.
 */
export function useDsModalOpen(): boolean {
  return useModalOpen();
}

/* -------------------------------------------------------------------------
 * TWO COORDINATE SPACES, SO THERE IS NOTHING TO ARBITRATE.
 *
 * Operator, on a frame where the decision notice had been pushed to the far
 * left while a toast sat bottom-right: *"these 2 should not be affecting each
 * other."*
 *
 * THE RULE, and it is absolute: **neither element's position may be a function
 * of the other's presence.** Not horizontally, not vertically, not
 * conditionally. The notice renders in exactly the same place at zero toasts
 * and at five, and the toast stack renders in exactly the same place whether a
 * notice exists or not.
 *
 * THREE WRONG ANSWERS WERE TRIED FIRST, and all three are the same mistake —
 * one surface reading the other's state to decide where to go:
 *
 *   1. The TOAST stepped aside for the notice (right → left). An alert that
 *      moves is one the operator learns to look for in two places.
 *   2. The NOTICE stepped aside for the toast (right → left). Same defect,
 *      other tenant: you reach for it and it is gone, for a reason invisible
 *      from where you are standing.
 *   3. The notice was LIFTED by the toast stack's measured height, published
 *      as a custom property and consumed as a transform. Quieter than the
 *      first two and still the same bug: the notice's y was a function of how
 *      many toasts happened to be on screen.
 *
 * WHAT REPLACES IT is not arbitration, it is geometry. The two belong to
 * different boxes and always did:
 *
 *   - The **decision notice** is about the RUN YOU ARE LOOKING AT, so it is
 *     positioned inside the run-detail panel's own box — `absolute`, clipped
 *     by that panel, never portalled to the body.
 *   - The **toast stack** is app-level (it reports command outcomes, not the
 *     selected run), so it stays at the VIEWPORT's bottom-right.
 *
 * They are disjoint by their ANCHOR, not by an inset: the notice hangs off its
 * panel's bottom-LEFT and this stack off the viewport's bottom-right, so there
 * is no layout — collapsed rail included — on which they converge, and neither
 * one's geometry contains a term for the other. `--ds-toast-inset-bottom`
 * therefore clears only what the APP has parked at the bottom of the window
 * (the Session bar). A floor built partly out of a panel-local reminder was the
 * coupling the operator was pointing at, even as a constant.
 * ---------------------------------------------------------------------- */

/** Is any Dialog or Drawer open right now? */
function useModalOpen(): boolean {
  return useSyncExternalStore(
    subscribeModals,
    () => openModalCount > 0,
    () => false,
  );
}

/** Is any dismissable layer open — a modal, a popover or a context menu? */
function useAnyOverlayOpen(): boolean {
  return useSyncExternalStore(
    subscribeModals,
    () => openModalCount + openLayerCount > 0,
    () => false,
  );
}

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

/**
 * The backdrop. `slow` matches a DRAWER's own `--ds-dur-4` slide: at the default
 * `--ds-dur-3` the scrim finished 60ms before the panel landed, so the last
 * third of the drawer slid over an already-solid backdrop and read as two
 * separate events instead of one surface arriving.
 */
function Scrim({ layer, entered, slow }: { layer: string; entered: boolean; slow?: boolean }) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        "fixed inset-0 bg-[var(--ds-surface-scrim)]",
        layer,
        dsMotion.enter,
        slow && "duration-[var(--ds-dur-4)]",
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
  useRegisterModal();
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

/**
 * Actions right-aligned, primary last — the operator's eye ends on the verb.
 *
 * `meta` is the quiet left-hand slot every dialog in this product wants: the
 * contract version, the source file, the standing rule. It was being hand-rolled
 * as `<span className="… mr-auto">` on five surfaces with five different text
 * treatments, so it lives here now and the footers line up. It also `min-w-0`s
 * and truncates, which the hand-rolled ones did not — a long filename used to
 * push the actions off the right edge.
 */
export function DialogFooter({
  meta,
  className,
  children,
}: {
  meta?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <footer
      className={cn(
        "flex shrink-0 items-center gap-[var(--ds-space-base)] border-t px-[var(--ds-space-loose)] py-[var(--ds-space-cozy)]",
        // The recessed plane, the same solid band the queue row's own footer
        // draws. It was `surface-2` + a full-strength border — a second answer
        // to "this sits back from the panel" living in a primitive, which is
        // the worst place for one to live: every consumer inherits it.
        "border-[color:var(--ds-border-subtle)] bg-[var(--ds-recess-bg)]",
        meta ? "justify-between" : "justify-end",
        className,
      )}
    >
      {meta && (
        <span
          className={cn(
            dsText.meta,
            "min-w-0 flex-1 truncate text-[color:var(--ds-fg-muted)]",
          )}
        >
          {meta}
        </span>
      )}
      <span className="flex shrink-0 items-center gap-[var(--ds-space-base)]">{children}</span>
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
  useRegisterModal();
  const isRight = side === "right";
  return (
    <>
      <Scrim layer={dsLayer.drawer} entered={entered} slow />
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
 * Popover
 *
 * The Tooltip's counterpart, and the reason both exist: a tooltip is a HINT
 * (hover-only, invisible to touch and to anyone who never tabs there), so
 * DESIGN.md forbids load-bearing information from living in one. A Popover is
 * where that information goes instead — it OPENS ON CLICK, so it is reachable
 * by pointer, touch and keyboard alike.
 *
 * Radix owns the parts that are not worth re-implementing in a tool that files
 * real HR transactions: anchoring with a flip when it would overflow the
 * viewport, Escape and outside-click to dismiss, focus moved into the surface
 * on open and RESTORED to the trigger on close, and the `aria-haspopup` /
 * `aria-expanded` / `aria-controls` wiring on the trigger.
 *
 * It is deliberately NON-modal: an explanation should not lock the page behind
 * it. That is also why it is not a Dialog — nothing here is a decision.
 * ====================================================================== */

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export type DsPopoverSide = "top" | "right" | "bottom" | "left";
export type DsPopoverWidth = "sm" | "md" | "lg";

const POPOVER_WIDTH: Record<DsPopoverWidth, string> = {
  sm: "w-[var(--ds-w-popover-sm)]",
  md: "w-[var(--ds-w-popover-md)]",
  lg: "w-[var(--ds-w-popover-lg)]",
};

/**
 * Entry motion is ORIGIN-AWARE: the surface scales out of the point it is
 * anchored to, so it reads as coming FROM the trigger rather than appearing
 * from nowhere. `--radix-popover-content-transform-origin` is the exact anchor
 * point Radix computed — which is why this survives a collision FLIP, where a
 * hand-picked origin (or a translate keyed off the `side` prop) would have the
 * surface moving away from its own trigger.
 *
 * It scales from 0.97, never from 0: nothing in the world appears from nothing.
 * Transform and opacity only, on `--ds-dur-3`, which `prefers-reduced-motion`
 * zeroes along with every other duration in the system.
 *
 * There is no EXIT animation, deliberately, and Dialog and Drawer do the same:
 * an entrance answers "where did this come from", a dismissal answers nothing.
 * Slow where the operator is deciding, instant where the system is responding.
 */
const POPOVER_ORIGIN = "origin-[var(--radix-popover-content-transform-origin)]";

/**
 * ```tsx
 * <Popover>
 *   <PopoverTrigger asChild>
 *     <IconButton label="Why is this parked?" icon={<Info aria-hidden />} />
 *   </PopoverTrigger>
 *   <PopoverContent title="Why is this parked?">
 *     <BulletList items={…} />
 *   </PopoverContent>
 * </Popover>
 * ```
 *
 * `title` is REQUIRED and becomes the surface's accessible name. Pass
 * `hideTitle` when the content is self-explanatory on screen — the name still
 * exists for a screen reader, it just does not take a line.
 */
export function PopoverContent({
  title,
  description,
  side = "bottom",
  align = "start",
  width = "md",
  hideTitle,
  hideClose,
  className,
  children,
}: {
  title: string;
  description?: ReactNode;
  side?: DsPopoverSide;
  align?: "start" | "center" | "end";
  width?: DsPopoverWidth;
  /** keep the accessible name, drop the visible heading row */
  hideTitle?: boolean;
  hideClose?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverSurface
        title={title}
        description={description}
        side={side}
        align={align}
        width={width}
        hideTitle={hideTitle}
        hideClose={hideClose}
        className={className}
      >
        {children}
      </PopoverSurface>
    </PopoverPrimitive.Portal>
  );
}

/**
 * Mounts only while the popover is open — which is what lets it both read as
 * arriving AND register itself in the modal-presence registry.
 *
 * WHY IT REGISTERS. The toast viewport is `fixed bottom-right` at the toast
 * layer and a `danger` toast never auto-dismisses, so a persistent failure
 * toast can sit on top of any dismissable layer below it and eat the click —
 * the exact defect the registry was built for. A popover anchored to a row
 * near the bottom of the queue lands in the same corner, so it opts in on the
 * same terms as Dialog and Drawer: while it is open the viewport steps aside
 * and its cards go inert.
 */
function PopoverSurface({
  title,
  description,
  side,
  align,
  width,
  hideTitle,
  hideClose,
  className,
  children,
}: {
  title: string;
  description?: ReactNode;
  side: DsPopoverSide;
  align: "start" | "center" | "end";
  width: DsPopoverWidth;
  hideTitle?: boolean;
  hideClose?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const entered = useEntered();
  useRegisterModal("layer");
  const showHeader = !hideTitle;
  return (
    <PopoverPrimitive.Content
      asChild
      side={side}
      align={align}
      sideOffset={6}
      collisionPadding={8}
      aria-label={title}
    >
      <FloatingSurface
        className={cn(
          POPOVER_WIDTH[width],
          "max-w-[calc(100vw-var(--ds-space-section))] outline-none",
          dsLayer.menu,
          dsMotion.enter,
          POPOVER_ORIGIN,
          entered ? "opacity-100 scale-100" : "opacity-0 scale-[0.97]",
          className,
        )}
      >
        {showHeader && (
          <header
            className={cn(
              "flex items-start gap-[var(--ds-space-base)] border-b px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]",
              "border-[color:var(--ds-border-subtle)]",
            )}
          >
            <div className="min-w-0 flex-1">
              <p className={cn(dsText.ui, "truncate font-semibold text-[color:var(--ds-fg)]")}>{title}</p>
              {description && (
                <p className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{description}</p>
              )}
            </div>
            {!hideClose && (
              <PopoverPrimitive.Close asChild>
                <IconButton label="Close" size="sm" icon={<X aria-hidden className={dsIcon.md} />} />
              </PopoverPrimitive.Close>
            )}
          </header>
        )}
        <div className={cn(dsText.body, "px-[var(--ds-space-cozy)] py-[var(--ds-space-base)] text-[color:var(--ds-fg-secondary)]")}>
          {children}
        </div>
      </FloatingSurface>
    </PopoverPrimitive.Content>
  );
}

/* =========================================================================
 * ContextMenu — the commands an object carries, on its own object
 *
 * The queue row used to hang a `⋯` button off its footer. That button is a
 * control whose only job is to admit there are more controls: it costs a slot
 * on every row in the queue, it names nothing, and it puts the row's full
 * command set behind a target the operator has to hit. Production already
 * solved this for the Session Panel's browser tiles — right-click opens the
 * recovery menu (`terminal-drawer/WorkflowBox.tsx`) — so this is that pattern
 * promoted to a primitive instead of a second hand-rolled copy.
 *
 * KEYBOARD PARITY IS NOT OPTIONAL. A menu that only opens under the pointer
 * makes every command in it unreachable from the keyboard, which in a
 * keyboard-first console is worse than the `⋯` it replaced. Two routes exist:
 * the platform's own context-menu key (Menu / Shift+F10, which the browser
 * dispatches as a `contextmenu` event on the focused element — Radix's trigger
 * answers it), and an app shortcut that dispatches the same event on the
 * selected object. `openContextMenuFor()` below is that second route, so the
 * shell can bind one key and every consumer inherits it.
 * ====================================================================== */

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuSeparator = ContextMenuPrimitive.Separator;

/**
 * Open an element's context menu from the keyboard.
 *
 * Radix's `ContextMenu.Root` has no controlled `open` prop — it opens from the
 * DOM `contextmenu` event, by design — so the honest keyboard route is to
 * dispatch that exact event rather than to reach inside the primitive. The
 * coordinates are the element's own top-left corner plus a small inset, which
 * is where a pointer-opened menu would have appeared had the operator clicked
 * the object's leading edge. Returns false when there is nothing to open, so a
 * caller never reports a menu it did not open.
 */
export function openContextMenuFor(element: Element | null | undefined): boolean {
  if (!(element instanceof HTMLElement)) return false;
  const box = element.getBoundingClientRect();
  element.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(box.left + 16),
      clientY: Math.round(box.top + 16),
    }),
  );
  return true;
}

/**
 * The surface. Same floating language as `Popover` — overlay surface, menu
 * layer, mid elevation — and the same origin-aware entry, scaled from 0.97
 * out of the point Radix resolved rather than from a hand-picked corner.
 *
 * It registers modal presence for the reason every dismissable layer in this
 * system does: a `danger` toast never auto-dismisses and the viewport is
 * `fixed bottom-right`, so a menu opened on a row near the bottom of the queue
 * would otherwise share that corner with a surface that eats clicks.
 */
export function ContextMenuContent({
  label,
  className,
  children,
}: {
  /** REQUIRED — the menu's accessible name ("Commands for Maria Lopez"). */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuSurface label={label} className={className}>
        {children}
      </ContextMenuSurface>
    </ContextMenuPrimitive.Portal>
  );
}

function ContextMenuSurface({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const entered = useEntered();
  useRegisterModal("layer");
  return (
    <ContextMenuPrimitive.Content
      aria-label={label}
      collisionPadding={8}
      className={cn(
        "min-w-[var(--ds-w-menu)] max-w-[calc(100vw-var(--ds-space-section))] overflow-hidden border py-[var(--ds-space-tight)]",
        "border-[color:var(--ds-border-strong)] bg-[var(--ds-surface-overlay)]",
        dsRadius.md,
        dsElev.mid,
        dsLayer.menu,
        dsMotion.enter,
        "origin-[var(--radix-context-menu-content-transform-origin)]",
        entered ? "opacity-100 scale-100" : "opacity-0 scale-[0.97]",
        className,
      )}
    >
      {children}
    </ContextMenuPrimitive.Content>
  );
}

/** A group heading inside the menu. Never a sentence — it names a set. */
export function ContextMenuLabel({ children }: { children: ReactNode }) {
  return (
    <ContextMenuPrimitive.Label
      className={cn(dsText.caps, "px-[var(--ds-space-cozy)] py-[var(--ds-space-tight)] text-[color:var(--ds-fg-muted)]")}
    >
      {children}
    </ContextMenuPrimitive.Label>
  );
}

/**
 * One command. `tone="destructive"` is the single irreversible slot — the same
 * rule the rest of the system holds to, so a menu never offers two.
 */
export function ContextMenuItem({
  icon,
  tone = "neutral",
  hint,
  disabled,
  onSelect,
  children,
}: {
  icon?: ReactNode;
  tone?: "neutral" | "destructive";
  /** a trailing keyboard hint or short qualifier — never an explanation */
  hint?: ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
  children: ReactNode;
}) {
  return (
    <ContextMenuPrimitive.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer select-none items-center gap-[var(--ds-space-snug)] outline-none",
        "px-[var(--ds-space-cozy)] py-[var(--ds-space-tight)]",
        dsText.body,
        dsMotion.fast,
        tone === "destructive" ? "text-[color:var(--ds-danger)]" : "text-[color:var(--ds-fg-secondary)]",
        tone === "destructive"
          ? "data-[highlighted]:bg-[var(--ds-danger-quiet)]"
          : "data-[highlighted]:bg-[var(--ds-surface-3)] data-[highlighted]:text-[color:var(--ds-fg)]",
        "data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
      )}
    >
      {icon && <span className="inline-flex shrink-0">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className={cn(dsText.micro, "shrink-0 text-[color:var(--ds-fg-faint)]")}>{hint}</span>}
    </ContextMenuPrimitive.Item>
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
 * It does RECEDE to a one-line chip once it has been readable for a while, so
 * "never dismisses" cannot mean "permanently covers the panel underneath" —
 * see `TOAST_COLLAPSE_MS`.
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

/**
 * The toast viewport.
 *
 * **While a modal is open it steps aside and goes inert.** Two changes, both
 * only while a Dialog or Drawer is mounted:
 *
 *  1. It re-anchors from the bottom-RIGHT to the bottom-LEFT. A dialog's actions
 *     are always right-aligned with the primary last (DESIGN.md, "one primary
 *     and at most one danger action per surface"), so the left gutter is the one
 *     region a decision never occupies.
 *  2. Every card becomes non-interactive and its controls render disabled, so a
 *     toast can never intercept a click meant for the surface underneath it —
 *     whatever the dialog's size or the viewport's height.
 *
 * Nothing is hidden and nothing is dismissed: the text stays fully legible above
 * the scrim, and the cards become live again the instant the modal closes. A
 * `danger` toast still never auto-dismisses, so it is still there to be
 * acknowledged afterwards.
 *
 * The bug this fixes: at 1280×720 a persistent `danger` toast sat exactly on top
 * of a dialog's footer and swallowed every click on its primary button, with no
 * visible reason — the operator could see the button, press it, and have nothing
 * happen.
 *
 * The viewport aligns its cards to the anchored edge (`items-end` / `items-start`)
 * so a RECEDED card — see `ToastCard` — can hug its own text instead of holding
 * the full 360px column.
 */
function ToastViewport({ toasts, onDismiss }: { toasts: DsToast[]; onDismiss: (id: string) => void }) {
  const modalOpen = useModalOpen();
  const anyOverlay = useAnyOverlayOpen();
  // THE ONLY reason this viewport ever leaves bottom-right, and it is the
  // ratified one: a Dialog or Drawer is open, whose footer's action gutter it
  // would otherwise cover. Nothing else moves it — not a popover, and in
  // particular not the decision notice, whose existence it does not know and
  // may never be told.
  const aside = modalOpen;
  if (toasts.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Notifications"
      data-ds-toast-viewport={aside ? "aside" : "default"}
      className={cn(
        // `--ds-toast-inset-bottom` rather than a bare space token, and it is a
        // CONSTANT the shell sets once. It clears exactly one thing — the app's
        // own Session bar — and nothing that belongs to a panel. A surface with
        // nothing parked at the bottom does not set it and gets the plain
        // gutter.
        "pointer-events-none fixed bottom-[var(--ds-toast-inset-bottom,var(--ds-space-loose))]",
        aside ? "left-[var(--ds-space-loose)] items-start" : "right-[var(--ds-space-loose)] items-end",
        "flex w-[360px] max-w-[calc(100vw-var(--ds-space-section))] flex-col gap-[var(--ds-space-base)]",
        // The step aside is a MOVE, not a jump: the viewport is a fixed box
        // changing which edge it hangs off, and seeing it travel is what tells
        // the operator the same alert is still there rather than a new one
        // having appeared on the other side.
        dsMotion.move,
        dsLayer.toast,
      )}
    >
      {toasts.map((item) => (
        // INERT for any open layer, MOVED for none but a modal: a popover
        // anchored near the bottom of the queue must not have its clicks eaten,
        // and that is what inert cards buy — without the viewport jumping.
        <ToastCard key={item.id} toast={item} onDismiss={onDismiss} inert={anyOverlay} />
      ))}
    </div>
  );
}

/**
 * How long a persistent (`danger`) toast holds its full card before it recedes
 * to a one-line chip.
 *
 * WHY IT RECEDES AT ALL: a `danger` toast never auto-dismisses — a failed write
 * is acknowledged by a human, not by a timer — but the viewport is `fixed`
 * bottom-right at a fixed width, so "never dismisses" also meant "permanently
 * covers the lower-right of whatever panel is underneath". The alert was
 * correct and the screen was unreadable, which is a failure of its own: a
 * notification that hides the data you are reading has traded one loss for
 * another. So the ALERT persists and its PRESENTATION recedes. Nothing is lost
 * by making the floating card transient — the durable copy is the notification
 * inbox behind the bell, and the chip itself still names the failure, still
 * carries the danger tint and icon, and is still one hover (or one keypress)
 * from the full text and its action.
 */
const TOAST_COLLAPSE_MS = 6000;

/**
 * One toast. A `danger` toast is PERSISTENT: it has no dismiss timer, and after
 * `TOAST_COLLAPSE_MS` it collapses to a one-line chip that stays until the
 * operator dismisses it.
 *
 * Three ways back to the full card, so it can never become a dead end:
 *  - **hover** the chip — a peek that recedes again when the pointer leaves;
 *  - **press** the chip — an explicit expand that STAYS until collapsed again
 *    (an operator choice is never undone by a timer);
 *  - the auto-collapse never fires while the pointer is over the card or focus
 *    is inside it, so it cannot close under someone reading or using it.
 *
 * `data-ds-toast-state="full" | "chip"` is the hook a headless check asserts on.
 *
 * A11y: `role="alert"` is unchanged for `danger` and lives on the SAME element
 * across both states (React reuses the node, so the alert is announced once, on
 * arrival). `aria-atomic="false"` overrides the role's implicit `true` so the
 * collapse — which only REMOVES nodes — is silent rather than re-announcing the
 * whole alert six seconds later.
 */
function ToastCard({
  toast,
  onDismiss,
  inert,
}: {
  toast: DsToast;
  onDismiss: (id: string) => void;
  inert: boolean;
}) {
  const entered = useEntered();
  const spec = TOAST_TONE[toast.tone];
  const Icon = spec.icon;

  // Only a persistent toast recedes — a self-dismissing one is already gone.
  const persistent = toast.tone === "danger";
  const [collapsed, setCollapsed] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  /** The operator has chosen a state; the timer stops second-guessing them. */
  const [pinned, setPinned] = useState(false);

  const engaged = hovering || focusWithin;
  useEffect(() => {
    if (!persistent || collapsed || pinned || engaged) return;
    const timer = setTimeout(() => setCollapsed(true), TOAST_COLLAPSE_MS);
    return () => clearTimeout(timer);
  }, [persistent, collapsed, pinned, engaged]);

  // Pressing a toggle unmounts it and mounts its counterpart, which would drop
  // a keyboard user on `<body>`. Hand focus to whichever toggle took its place.
  const toggleRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!restoreFocus.current) return;
    restoreFocus.current = false;
    toggleRef.current?.focus();
  }, [collapsed]);

  const setCollapsedByOperator = (next: boolean) => {
    restoreFocus.current = true;
    setPinned(true);
    setCollapsed(next);
  };

  /** A hover peek expands without un-collapsing — leaving recedes it again. */
  const expanded = !collapsed || hovering;

  const shell = cn(
    inert ? "pointer-events-none" : "pointer-events-auto",
    "border border-l-[length:var(--ds-border-w-rail)]",
    "border-[color:var(--ds-border-strong)] bg-[var(--ds-surface-overlay)]",
    spec.tint,
    dsRadius.md,
    dsElev.mid,
    dsMotion.enter,
    entered ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
  );

  const surfaceProps = {
    role: persistent ? ("alert" as const) : ("status" as const),
    "aria-atomic": false,
    "data-ds-toast-state": expanded ? "full" : "chip",
    onMouseEnter: () => setHovering(true),
    onMouseLeave: () => setHovering(false),
    onFocus: () => setFocusWithin(true),
    onBlur: () => setFocusWithin(false),
  };

  if (!expanded) {
    return (
      <div
        {...surfaceProps}
        className={cn(
          shell,
          "flex w-fit max-w-full items-center gap-[var(--ds-space-tight)]",
          "py-[var(--ds-space-tight)] pl-[var(--ds-space-base)] pr-[var(--ds-space-hair)]",
        )}
      >
        <button
          ref={toggleRef}
          type="button"
          disabled={inert}
          aria-expanded={false}
          title={inert ? "Show the full alert — available once the dialog is closed" : "Show the full alert"}
          onClick={() => setCollapsedByOperator(false)}
          className={cn(
            "flex min-w-0 flex-1 cursor-pointer items-center gap-[var(--ds-space-tight)]",
            "disabled:cursor-default",
            dsRadius.sm,
            dsFocus,
          )}
        >
          <Icon aria-hidden className={cn(dsIcon.md, "shrink-0", spec.accent)} />
          <span className={cn(dsText.ui, "truncate font-medium text-[color:var(--ds-fg)]")}>{toast.title}</span>
          <ChevronUp aria-hidden className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-fg-muted)]")} />
        </button>
        <IconButton
          label="Dismiss"
          size="sm"
          disabled={inert}
          title={inert ? "Dismiss — available once the dialog is closed" : "Dismiss"}
          icon={<X aria-hidden className={dsIcon.md} />}
          onClick={() => onDismiss(toast.id)}
        />
      </div>
    );
  }

  return (
    <div
      {...surfaceProps}
      // CLICK ANYWHERE DISMISSES. A toast is an interruption the operator has
      // finished with the moment they have read it, and making them find a
      // 20px × to say so is friction on the most common gesture the surface
      // has. The × STAYS — it is the labelled, keyboard-reachable control, and
      // this is a convenience layered over it, not a replacement for it. That
      // is also why no `role="button"` goes on this element: it is a live
      // region announcing an outcome, and re-labelling it as a control would
      // cost the announcement to buy a route that already exists.
      onClick={inert ? undefined : () => onDismiss(toast.id)}
      className={cn(
        shell,
        "flex w-full items-start gap-[var(--ds-space-base)] p-[var(--ds-space-cozy)]",
        !inert && "cursor-pointer",
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
            disabled={inert}
            onClick={(e) => {
              // The card behind this dismisses on click; without stopping here
              // the action would fire and the card would dismiss twice.
              e.stopPropagation();
              toast.action?.onAction();
              onDismiss(toast.id);
            }}
            className={cn(
              "mt-[var(--ds-space-tight)] w-fit cursor-pointer underline underline-offset-2",
              dsText.meta,
              "text-[color:var(--ds-fg)]",
              "disabled:cursor-default disabled:opacity-45",
              dsFocus,
            )}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-[var(--ds-space-hair)]">
        {/*
          Only offered on a genuinely expanded card — while it is a hover PEEK
          the pointer leaving is already the way back, and a button that could
          not change the state it names would be a lie.
        */}
        {persistent && !collapsed && (
          <IconButton
            ref={toggleRef}
            label="Collapse this alert to one line"
            size="sm"
            disabled={inert}
            aria-expanded
            title={
              inert
                ? "Collapse to one line — available once the dialog is closed"
                : "Collapse to one line — the alert stays until you dismiss it"
            }
            icon={<ChevronDown aria-hidden className={dsIcon.md} />}
            onClick={() => setCollapsedByOperator(true)}
          />
        )}
        <IconButton
          label="Dismiss"
          size="sm"
          disabled={inert}
          title={inert ? "Dismiss — available once the dialog is closed" : "Dismiss"}
          icon={<X aria-hidden className={dsIcon.md} />}
          onClick={() => onDismiss(toast.id)}
        />
      </div>
    </div>
  );
}
