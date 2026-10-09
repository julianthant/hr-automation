import { Fragment, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Ban,
  CheckCircle2,
  ChevronsUp,
  CircleSlash,
  ClipboardList,
  PauseCircle,
  Pencil,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { IconActionButton } from "@/components/shared/IconActionButton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { actionsAt, type ActionDescriptorWire, type ActionIconKey, type ActionIntent } from "./demo-wire";
import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  IconButton,
  dsBorder,
  dsFocus,
  dsIcon,
  dsMotion,
  dsRadius,
  dsText,
  useDsModalPresence,
} from "./demo-ui";
import type { DemoRow } from "./demo-data";
import type { DemoCommandResult } from "./demo-commands";
import type { DsToastTone } from "./demo-ui";

/**
 * DEV-ONLY — every control in the rebuild demo, rendered from the row's
 * server-sent `actions[]` and nothing else.
 *
 * This file exists to make one rule mechanically true: **no component decides
 * which buttons a row gets.** There is no `status === "failed" ? <Retry/> : …`
 * anywhere. A component asks for the descriptors at a placement and renders
 * them; if the surface did not send one, there is no button to render. That is
 * how the demo proves the contract carries enough to drive the UI — and how a
 * command that must not be offered (Resume on a parked write) becomes
 * structurally unreachable rather than merely hidden.
 */

/**
 * Every control calls this. It RETURNS the command result so a surface that
 * collected a typed body (a parked write's proof, a checkpoint patch) can react
 * to the server's answer in place — keep the operator's input on a rejection,
 * re-offer a patch on a conflict — while the same result still lands in the
 * shared result feed. Navigation returns nothing.
 */
export type DemoActionHandler = (row: DemoRow, action: ActionDescriptorWire) => DemoCommandResult | void;

const NOOP_ACTION: DemoActionHandler = () => {};

const ICONS: Record<ActionIconKey, ReactNode> = {
  retry: <RotateCcw aria-hidden className={dsIcon.md} />,
  cancel: <X aria-hidden className={dsIcon.md} />,
  bump: <ChevronsUp aria-hidden className={dsIcon.md} />,
  delete: <Trash2 aria-hidden className={dsIcon.md} />,
  review: <ClipboardList aria-hidden className={dsIcon.md} />,
  resolve: <PauseCircle aria-hidden className={dsIcon.md} />,
  rename: <Pencil aria-hidden className={dsIcon.md} />,
  external: <ArrowUpRight aria-hidden className={dsIcon.md} />,
  drill: <Search aria-hidden className={dsIcon.md} />,
};

/**
 * The wire's seven intents, as colour only. These are NOT `Button` variants:
 * a descriptor's intent is chosen by the server for a command, and mapping four
 * of them onto Button would either invent four chromatic variants or flatten
 * them all to "secondary". So the tone stays a map and the SHELL is shared —
 * which is the part that was actually broken.
 */
const INTENT_PILL: Record<ActionIntent, string> = {
  primary: "border-transparent bg-[var(--ds-accent)] font-semibold text-[color:var(--ds-accent-fg)] hover:bg-[var(--ds-accent-hover)]",
  neutral: cn(
    "border-[color:var(--ds-border-strong)] bg-[var(--ds-control-bg)] font-medium",
    "text-[color:var(--ds-control-fg)] hover:bg-[var(--ds-control-bg-hover)]",
  ),
  destructive:
    "border-[color:var(--ds-danger-border)] bg-[var(--ds-danger-quiet)] font-semibold text-[color:var(--ds-danger)] hover:brightness-125",
  violet: cn(
    "border-[color:var(--ds-status-parked-border)] bg-[var(--ds-status-parked-bg)]",
    "font-semibold text-[color:var(--ds-status-parked-fg)] hover:brightness-125",
  ),
  success:
    "border-[color:var(--ds-success-border)] bg-[var(--ds-success-bg)] font-semibold text-[color:var(--ds-success-fg)] hover:brightness-125",
  info: "border-[color:var(--ds-info-border)] bg-[var(--ds-info-bg)] font-semibold text-[color:var(--ds-info-fg)] hover:brightness-125",
  warning: cn(
    "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)]",
    "font-semibold text-[color:var(--ds-status-waiting-fg)] hover:brightness-125",
  ),
};

/**
 * ONE shell for every intent pill. The banner and the inline outcome button
 * were two different heights, paddings and font sizes for the same control,
 * which is why the same command looked like two commands depending on where you
 * met it. `sm` is the inline slot beside a subline; `md` is the banner.
 */
const intentPill = (intent: ActionIntent, size: "sm" | "md"): string =>
  cn(
    "inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap border",
    size === "sm"
      ? "h-[var(--ds-h-xs)] gap-[var(--ds-space-tight)] px-[var(--ds-space-base)]"
      : "h-[var(--ds-h-sm)] gap-[var(--ds-space-snug)] px-[var(--ds-space-cozy)]",
    // The INLINE pill drops its outline: it sits on a card among chips that are
    // now a fill and no line, and an extra edge there made `Open failure` the
    // heaviest thing on a row whose loudest fact should be its status. The
    // BANNER pill keeps its outline — it sits on a band of its own hue, where
    // a fill alone does not separate it. Weight, focus ring and press dip are
    // what say "command"; the border was not carrying that.
    size === "sm" && "border-transparent",
    dsRadius.md,
    size === "sm" ? dsText.meta : dsText.body,
    dsFocus,
    dsMotion.fast,
    "active:translate-y-px",
    INTENT_PILL[intent],
  );

/** the IconActionButton palette is narrower than the wire's intents */
const INTENT_TONE: Record<ActionIntent, "destructive" | "warning" | "primary" | "muted"> = {
  primary: "primary",
  neutral: "muted",
  destructive: "destructive",
  violet: "muted",
  success: "primary",
  info: "primary",
  warning: "warning",
};

// ---------------------------------------------------------------------------
// Footer — the queue row's own controls
// ---------------------------------------------------------------------------

export function FooterActions({ row, onAction = NOOP_ACTION }: { row: DemoRow; onAction?: DemoActionHandler }) {
  const actions = actionsAt(row.actions, "footer");
  if (actions.length === 0) return null;
  // The `Cancel group` caption beside the ✕ is GONE. An icon that already means
  // cancel, captioned "cancel", is the same word twice — and it was the only
  // label in the footer's action cluster, so it made one row's buttons a
  // different shape from every other row's. D16's warning did not live in that
  // caption: it is the ✕'s own `title` below, and the right-click menu carries
  // the descriptor's full sentence ("Cancel group and everything under it").
  return (
    <span className="flex items-center gap-[var(--ds-space-hair)]">
      {actions.map((a) => (
        <IconActionButton
          key={a.key}
          tone={INTENT_TONE[a.intent]}
          icon={ICONS[a.icon ?? "external"]}
          label={a.label}
          title={
            a.command === "cancel-tree"
              ? `Cancels this group, its delegated review and every member. Final — there is no undo.`
              : a.confirm
                ? `${a.label} — asks first`
                : a.label
          }
          onClick={(e) => {
            e.stopPropagation();
            onAction(row, a);
          }}
        />
      ))}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Banner — the decision the row is sitting on
// ---------------------------------------------------------------------------

/** the two Write-parked resolutions render as cards, not pills */
const PARK_COMMANDS = new Set(["resolve-write-present", "resolve-write-absent"]);

export function bannerPills(row: DemoRow): ActionDescriptorWire[] {
  return actionsAt(row.actions, "banner").filter((a) => !PARK_COMMANDS.has(a.command ?? ""));
}

export function parkResolutions(row: DemoRow): ActionDescriptorWire[] {
  return actionsAt(row.actions, "banner").filter((a) => PARK_COMMANDS.has(a.command ?? ""));
}

export function BannerActions({ row, onAction = NOOP_ACTION }: { row: DemoRow; onAction?: DemoActionHandler }) {
  const pills = bannerPills(row);
  if (pills.length === 0) return null;
  return (
    <div className="mt-[var(--ds-space-base)] flex flex-wrap gap-[var(--ds-space-snug)]">
      {pills.map((a) => (
        <button
          key={a.key}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onAction(row, a);
          }}
          className={intentPill(a.intent, "md")}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The only two exits from Write parked. Both are the operator reporting what
 * they SAW in the system of record — neither one re-submits anything. There is
 * no Resume here because the contract never sends one: resuming an unknown
 * write is how you terminate somebody twice.
 */
export function ParkResolutions({ row, onAction = NOOP_ACTION }: { row: DemoRow; onAction?: DemoActionHandler }) {
  const options = parkResolutions(row);
  if (options.length === 0) return null;
  return (
    // A CONTAINER query: these render inside the gate banner and inside the log
    // stream, both of which live in the detail region's CENTRE column — whose
    // width is now a function of the context rail's state as well as the
    // window's. Keyed to the window, two resolutions were being forced
    // side-by-side into a 414px column at a 1280px viewport.
    <div className="mt-[var(--ds-space-base)] grid gap-[var(--ds-space-snug)] @min-[35rem]:grid-cols-2">
      {options.map((a) => {
        const present = a.command === "resolve-write-present";
        const Icon = present ? CheckCircle2 : CircleSlash;
        return (
          <button
            key={a.key}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAction(row, a);
            }}
            className={cn(
              "flex cursor-pointer flex-col items-start border text-left",
              "gap-[var(--ds-space-hair)] px-[var(--ds-space-base)] py-[var(--ds-space-snug)]",
              dsRadius.md,
              dsFocus,
              dsMotion.fast,
              "hover:brightness-125",
              present
                ? "border-[color:var(--ds-success-border)] bg-[var(--ds-success-bg)]"
                : "border-[color:var(--ds-danger-border)] bg-[var(--ds-danger-quiet)]",
            )}
          >
            <span
              className={cn(
                dsText.body,
                "inline-flex items-center gap-[var(--ds-space-snug)] font-semibold",
                present ? "text-[color:var(--ds-success-fg)]" : "text-[color:var(--ds-danger)]",
              )}
            >
              <Icon aria-hidden className={dsIcon.sm} />
              {a.label}
            </span>
            {a.detail && <span className={cn(dsText.meta, "leading-snug text-[color:var(--ds-fg-muted)]")}>{a.detail}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Outcome — the ONE thing to do about this row
// ---------------------------------------------------------------------------

export function outcomeAction(row: DemoRow): ActionDescriptorWire | undefined {
  return actionsAt(row.actions, "outcome")[0];
}

export function OutcomeActionButton({
  row,
  onAction = NOOP_ACTION,
  className,
  omitKeys,
}: {
  row: DemoRow;
  onAction?: DemoActionHandler;
  className?: string;
  /**
   * Keys this SURFACE refuses to draw, because it already renders the thing the
   * action travels to. Queue cards omit `Resolve` (`open-park`) and the Review
   * ↗ (`open-gate`) — operator clicks the row (or the OCR / parent redirect
   * below) — and inside the detail panel the typed resolutions are already on
   * screen, so a pill that only scrolls is redundant.
   */
  omitKeys?: readonly string[];
}) {
  const action = outcomeAction(row);
  if (!action || omitKeys?.includes(action.key)) return null;

  // Waiting used to open with a gray ↗ beside the gate line. Queue cards now
  // omit `open-gate` entirely — the OCR / parent redirect under the line (or
  // clicking the row) is enough. This branch stays for any surface that still
  // asks for the icon-only Review jump.
  if (action.key === "open-gate") {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onAction(row, action);
        }}
        title={action.label}
        aria-label={action.label}
        className={cn(
          "inline-flex shrink-0 cursor-pointer items-center justify-center border",
          "h-[var(--ds-h-xs)] w-[var(--ds-h-xs)]",
          "border-[color:var(--ds-recess-border)] bg-[var(--ds-recess-bg)]",
          "text-[color:var(--ds-fg-muted)] hover:text-[color:var(--ds-fg)]",
          dsRadius.sm,
          dsFocus,
          dsMotion.fast,
          "active:translate-y-px",
          className,
        )}
      >
        <ArrowUpRight aria-hidden className={dsIcon.sm} />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onAction(row, action);
      }}
      className={cn(intentPill(action.intent, "sm"), "font-sans", className)}
    >
      {action.label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The row's own commands, on the row — right-click, not a `⋯`
// ---------------------------------------------------------------------------

/**
 * Wraps a row so right-clicking it opens its full command set.
 *
 * WHY THIS REPLACED THE `⋯`. The overflow button was a control whose only job
 * was to admit there were more controls: it took a slot in every footer in the
 * queue, it named nothing, and it put the row's commands behind a 24px target.
 * Production already does this properly for Session Panel browser tiles — a
 * right-click opens their recovery menu — so this is that established pattern,
 * promoted to a `ds` primitive rather than hand-rolled a second time.
 *
 * WHAT IS IN IT is not a client decision. The items are `actions[]` at the
 * `menu` placement, and the server sends every footer and outcome descriptor
 * with that placement too — so the menu is the row's FULL set, the footer is
 * the frequent subset of the same list, and a command the surface never sent is
 * structurally unreachable from either.
 *
 * The order is by KIND, which is the only grouping that survives a new
 * descriptor: go-somewhere first, do-something next, the one irreversible
 * command last behind a rule.
 */
export function RowContextMenu({
  row,
  onAction = NOOP_ACTION,
  children,
}: {
  row: DemoRow;
  onAction?: DemoActionHandler;
  children: ReactNode;
}) {
  const items = actionsAt(row.actions, "menu");
  if (items.length === 0) return <>{children}</>;
  const navigate = items.filter((a) => a.kind === "navigation");
  const commands = items.filter((a) => a.kind === "command" && a.intent !== "destructive");
  const destructive = items.filter((a) => a.kind === "command" && a.intent === "destructive");
  const groups = [navigate, commands, destructive].filter((g) => g.length > 0);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent label={`Commands for ${row.displayName ?? (row.title || row.trace)}`}>
        {groups.map((group, i) => (
          <Fragment key={i}>
            {i > 0 && <ContextMenuSeparator className={cn("my-[var(--ds-space-tight)] h-px", dsBorder.subtle, "border-t")} />}
            {group.map((a) => (
              <ContextMenuItem
                key={a.key}
                icon={ICONS[a.icon ?? "external"]}
                tone={a.intent === "destructive" ? "destructive" : "neutral"}
                hint={a.confirm ? "asks first" : undefined}
                onSelect={() => onAction(row, a)}
              >
                {a.label}
              </ContextMenuItem>
            ))}
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ---------------------------------------------------------------------------
// Confirmation — server-authored, because only the server knows the casualties
// ---------------------------------------------------------------------------

export interface PendingCommand {
  row: DemoRow;
  action: ActionDescriptorWire;
}

export function ConfirmCommandDialog({
  pending,
  onCancel,
  onConfirm,
}: {
  pending: PendingCommand | null;
  onCancel: () => void;
  onConfirm: (pending: PendingCommand) => void;
}) {
  const confirm = pending?.action.confirm;
  return (
    <Dialog open={Boolean(pending && confirm)} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent size="sm">
        {pending && confirm && <ConfirmBody pending={pending} confirm={confirm} onCancel={onCancel} onConfirm={onConfirm} />}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The body is its own component so it mounts ONLY while the dialog is open —
 * which is what lets it register modal presence. This is the app's dialog
 * (`@/components/ui/dialog`), not the `ds` one, so nothing registers on its
 * behalf: without this, a persistent `danger` toast stays live in the corner
 * and can intercept a click meant for the confirm button.
 */
function ConfirmBody({
  pending,
  confirm,
  onCancel,
  onConfirm,
}: {
  pending: PendingCommand;
  confirm: NonNullable<ActionDescriptorWire["confirm"]>;
  onCancel: () => void;
  onConfirm: (pending: PendingCommand) => void;
}) {
  useDsModalPresence();
  return (
    <>
      <DialogHeader>
          <DialogTitle className={cn(dsText.title, "flex items-center gap-[var(--ds-space-base)]")}>
            <AlertTriangle
              aria-hidden
              className={cn(
                dsIcon.lg,
                "shrink-0",
                confirm.tone === "destructive"
                  ? "text-[color:var(--ds-danger)]"
                  : "text-[color:var(--ds-status-waiting-fg)]",
              )}
            />
            {confirm.title}
          </DialogTitle>
          {/* The blast radius, in the operator's terms. This copy is served with
              the descriptor — the client never writes a confirmation message,
              because only the server knows how many rows are involved. */}
          <DialogDescription className={cn(dsText.body, "leading-relaxed")}>{confirm.body}</DialogDescription>
        </DialogHeader>
        <div className={cn(dsText.meta, dsText.nums, "px-1 text-[color:var(--ds-fg-muted)]")}>
          {pending.row.workflow.label} · {pending.row.trace} · row rev {pending.action.expectedVersion ?? pending.row.version}
        </div>
        <DialogFooter>
          {/* The safe exit is `secondary` and it comes FIRST; the surface's one
              committing action is last, so the eye ends on the verb. */}
        <Button variant="secondary" onClick={onCancel}>
          Keep it as it is
        </Button>
        <Button variant={confirm.tone === "destructive" ? "danger" : "primary"} onClick={() => onConfirm(pending)}>
          {confirm.confirmLabel}
        </Button>
      </DialogFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// Results — applied toasts; conflict / rejected stay in the feed
// ---------------------------------------------------------------------------

/**
 * Applied command outcomes toast from the bottom-right stack. Conflict and
 * rejected results stay in `CommandResultFeed` — they need the persistent band
 * and its row-refresh affordance.
 */
export function toastAppliedCommandResult(
  toast: (input: { tone: DsToastTone; title: string; description?: string; duration?: number }) => string,
  result: DemoCommandResult,
): void {
  if (result.state !== "applied") return;

  let tone: DsToastTone = "success";
  if (result.settling) tone = "warning";
  else if (result.command === "rerun-with-existing-data" || result.command === "resolve-write-absent") tone = "info";

  const meta = `${result.actionLabel} · ${result.clock} · ${result.requestedBy}`;
  toast({
    tone,
    title: result.headline,
    description: result.detail ? `${result.detail} — ${meta}` : meta,
  });
}

const RESULT_TONE: Record<Exclude<DemoCommandResult["state"], "applied">, { wrap: string; text: string; icon: ReactNode; word: string }> = {
  conflict: {
    wrap: "border-[color:var(--ds-status-waiting-border)] bg-[var(--ds-status-waiting-bg)]",
    text: "text-[color:var(--ds-status-waiting-fg)]",
    icon: <AlertTriangle aria-hidden className={dsIcon.md} />,
    word: "Conflict",
  },
  rejected: {
    wrap: "border-[color:var(--ds-danger-border)] bg-[var(--ds-danger-quiet)]",
    text: "text-[color:var(--ds-danger)]",
    icon: <Ban aria-hidden className={dsIcon.md} />,
    word: "Rejected",
  },
};

function isPersistentCommandResult(
  result: DemoCommandResult,
): result is DemoCommandResult & { state: "conflict" | "rejected" } {
  return result.state !== "applied";
}

/**
 * chrome — conflict and rejected. Applied results toast instead (see
 * `toastAppliedCommandResult`).
 */
export function CommandResultFeed({
  results,
  onDismiss,
  onRefreshRow,
}: {
  results: DemoCommandResult[];
  onDismiss: (id: string) => void;
  onRefreshRow: (rowId: string, serverVersion: number) => void;
}) {
  const feed = results.filter(isPersistentCommandResult);
  if (feed.length === 0) return null;
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col border-b bg-[var(--ds-recess-bg)]",
        dsBorder.subtle,
        "gap-[var(--ds-space-snug)] px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]",
      )}
      aria-live="polite"
      data-demo-result-feed=""
    >
      {feed.map((r) => {
        const tone = RESULT_TONE[r.state];
        return (
          <div
            key={r.id}
            className={cn("border px-[var(--ds-space-base)] py-[var(--ds-space-snug)]", dsRadius.md, tone.wrap)}
            data-demo-result={r.state}
          >
            {/* icon 14 + gap 6 = the 20px hanging indent every line below uses */}
            <div className="flex min-w-0 items-center gap-[var(--ds-space-snug)]">
              <span className={cn("inline-flex shrink-0", tone.text)}>{tone.icon}</span>
              <span className={cn(dsText.caps, "shrink-0", tone.text)}>{tone.word}</span>
              <span className={cn(dsText.body, "min-w-0 truncate font-semibold text-[color:var(--ds-fg)]")}>{r.headline}</span>
              <span className={cn(dsText.micro, dsText.nums, "ml-auto shrink-0 text-[color:var(--ds-fg-muted)]")}>
                {r.actionLabel} · {r.clock} · {r.requestedBy}
              </span>
              <IconButton
                size="sm"
                label="Dismiss this result"
                onClick={() => onDismiss(r.id)}
                icon={<X aria-hidden className={dsIcon.sm} />}
              />
            </div>
            <p className={cn(dsText.meta, "mt-[var(--ds-space-hair)] pl-5 leading-relaxed text-[color:var(--ds-fg-muted)]")}>{r.detail}</p>
            {r.code && (
              <p className={cn(dsText.micro, dsText.nums, "mt-[var(--ds-space-hair)] pl-5 text-[color:var(--ds-danger)]")}>
                code {r.code} · {r.rowTitle} · {r.workflowLabel}
              </p>
            )}
            {/* A conflict on something other than the row's version is NOT
                cured by refreshing the row, so no refresh is offered here —
                the Data tab re-offers the patch against the fresh values. */}
            {r.cas && (
              <p className={cn(dsText.micro, dsText.nums, "mt-[var(--ds-space-hair)] pl-5 text-[color:var(--ds-status-waiting-fg)]")}>
                {r.cas.kind} {r.cas.expected} → server {r.cas.server} · your edits are held on the Data tab
              </p>
            )}
            {r.settling && (
              <p className={cn(dsText.micro, dsText.nums, "mt-[var(--ds-space-hair)] pl-5 text-[color:var(--ds-status-parked-fg)]")}>
                settling {r.settling.observations}/{r.settling.required} observations · next probe {r.settling.nextProbeAt.slice(11, 19)}
              </p>
            )}
            {r.state === "conflict" && r.serverVersion !== undefined && (
              <div className="mt-[var(--ds-space-tight)] flex items-center gap-[var(--ds-space-base)] pl-5">
                <span className={cn(dsText.micro, dsText.nums, "text-[color:var(--ds-status-waiting-fg)]")}>
                  row rev {r.expectedVersion} → server {r.serverVersion}
                </span>
                <button type="button" onClick={() => onRefreshRow(r.rowId, r.serverVersion ?? 0)} className={intentPill("warning", "sm")}>
                  Refresh this row
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
