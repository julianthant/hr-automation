import { type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Ban,
  CheckCircle2,
  ChevronsUp,
  CircleSlash,
  ClipboardList,
  MoreHorizontal,
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { actionsAt, type ActionDescriptorWire, type ActionIconKey, type ActionIntent } from "./demo-wire";
import { Button, IconButton, dsBorder, dsFocus, dsIcon, dsMotion, dsRadius, dsText, useDsModalPresence } from "./demo-ui";
import type { DemoRow } from "./demo-data";
import type { DemoCommandResult } from "./demo-commands";

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
  // D16: a group's cancel takes the whole tree down with no confirm and no
  // undo, so it says so in words as well as in the tooltip.
  const tree = actions.find((a) => a.command === "cancel-tree");
  return (
    <span className="flex items-center gap-1">
      {tree && (
        <span className={cn(dsText.micro, "mr-[var(--ds-space-tight)] hidden font-sans text-[color:var(--ds-fg-muted)] min-[400px]:inline")}>
          Cancel group
        </span>
      )}
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
    <div className="mt-[var(--ds-space-base)] grid gap-[var(--ds-space-snug)] min-[560px]:grid-cols-2">
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
}: {
  row: DemoRow;
  onAction?: DemoActionHandler;
  className?: string;
}) {
  const action = outcomeAction(row);
  if (!action) return null;
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
// Menu — the commands that do not earn a footer slot
// ---------------------------------------------------------------------------

export function RowActionMenu({ row, onAction = NOOP_ACTION }: { row: DemoRow; onAction?: DemoActionHandler }) {
  const items = actionsAt(row.actions, "menu");
  if (items.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          size="sm"
          label={`More actions for ${row.displayName ?? row.title}`}
          onClick={(e) => e.stopPropagation()}
          icon={<MoreHorizontal aria-hidden className={dsIcon.md} />}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[190px]">
        {items.map((a) => (
          <DropdownMenuItem
            key={a.key}
            onSelect={() => onAction(row, a)}
            className={cn(dsText.body, a.intent === "destructive" && "text-destructive focus:text-destructive")}
          >
            <span className="mr-2 inline-flex">{ICONS[a.icon ?? "external"]}</span>
            {a.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
          {pending.row.workflow.label} · {pending.row.trace} · version {pending.action.expectedVersion ?? pending.row.version}
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
// Results — applied / conflict / rejected, all three visible
// ---------------------------------------------------------------------------

const RESULT_TONE: Record<DemoCommandResult["state"], { wrap: string; text: string; icon: ReactNode; word: string }> = {
  applied: {
    wrap: "border-[color:var(--ds-success-border)] bg-[var(--ds-success-bg)]",
    text: "text-[color:var(--ds-success-fg)]",
    icon: <CheckCircle2 aria-hidden className={dsIcon.md} />,
    word: "Applied",
  },
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

/**
 * The command result feed. Every submission lands here — including the two that
 * did nothing. A partial outcome may never be collapsed into "Done", so each
 * result keeps its own card with its own state word.
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
  if (results.length === 0) return null;
  return (
    <div
      className={cn(
        "flex shrink-0 flex-col border-b bg-[var(--ds-surface-2)]",
        dsBorder.subtle,
        "gap-[var(--ds-space-snug)] px-[var(--ds-space-cozy)] py-[var(--ds-space-base)]",
      )}
      aria-live="polite"
      data-demo-result-feed=""
    >
      {results.map((r) => {
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
                  expectedVersion {r.expectedVersion} → server {r.serverVersion}
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
