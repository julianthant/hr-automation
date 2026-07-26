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

export type DemoActionHandler = (row: DemoRow, action: ActionDescriptorWire) => void;

const NOOP_ACTION: DemoActionHandler = () => {};

const ICONS: Record<ActionIconKey, ReactNode> = {
  retry: <RotateCcw aria-hidden className="size-3.5" />,
  cancel: <X aria-hidden className="size-3.5" />,
  bump: <ChevronsUp aria-hidden className="size-3.5" />,
  delete: <Trash2 aria-hidden className="size-3.5" />,
  review: <ClipboardList aria-hidden className="size-3.5" />,
  resolve: <PauseCircle aria-hidden className="size-3.5" />,
  rename: <Pencil aria-hidden className="size-3.5" />,
  external: <ArrowUpRight aria-hidden className="size-3.5" />,
  drill: <Search aria-hidden className="size-3.5" />,
};

const INTENT_PILL: Record<ActionIntent, string> = {
  primary: "border-primary bg-primary font-semibold text-primary-foreground",
  neutral: "border-border bg-card font-medium text-secondary-foreground",
  destructive: "border-destructive/45 bg-destructive/8 font-semibold text-destructive",
  violet: "border-log-violet/45 bg-log-violet/8 font-semibold text-log-violet",
  success: "border-success/45 bg-success/8 font-semibold text-success",
  info: "border-info/40 bg-info/8 font-semibold text-info",
  warning: "border-warning/45 bg-warning/10 font-semibold text-warning",
};

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
      {tree && <span className="mr-1 hidden text-[10px] font-sans text-muted-foreground min-[400px]:inline">Cancel group</span>}
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
    <div className="mt-2 flex flex-wrap gap-1.5">
      {pills.map((a) => (
        <button
          key={a.key}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onAction(row, a);
          }}
          className={cn(
            "rounded-md border px-2.5 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
            INTENT_PILL[a.intent],
          )}
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
    <div className="mt-2 grid gap-1.5 min-[560px]:grid-cols-2">
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
              "flex flex-col items-start gap-0.5 rounded-md border px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
              present ? "border-success/45 bg-success/8 hover:bg-success/12" : "border-destructive/40 bg-destructive/6 hover:bg-destructive/10",
            )}
          >
            <span className={cn("inline-flex items-center gap-1.5 text-[11.5px] font-semibold", present ? "text-success" : "text-destructive")}>
              <Icon aria-hidden className="size-3" />
              {a.label}
            </span>
            {a.detail && <span className="text-[10.5px] leading-snug text-muted-foreground">{a.detail}</span>}
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
      className={cn(
        "shrink-0 rounded-md border px-2 py-px text-[10.5px] font-sans outline-none focus-visible:ring-2 focus-visible:ring-ring",
        INTENT_PILL[action.intent],
        className,
      )}
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
        <button
          type="button"
          aria-label={`More actions for ${row.displayName ?? row.title}`}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MoreHorizontal aria-hidden className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[190px]">
        {items.map((a) => (
          <DropdownMenuItem
            key={a.key}
            onSelect={() => onAction(row, a)}
            className={cn("text-[12px]", a.intent === "destructive" && "text-destructive focus:text-destructive")}
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
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[14px]">
            <AlertTriangle
              aria-hidden
              className={cn("size-4 shrink-0", confirm?.tone === "destructive" ? "text-destructive" : "text-warning")}
            />
            {confirm?.title}
          </DialogTitle>
          {/* The blast radius, in the operator's terms. This copy is served with
              the descriptor — the client never writes a confirmation message,
              because only the server knows how many rows are involved. */}
          <DialogDescription className="text-[12px] leading-relaxed">{confirm?.body}</DialogDescription>
        </DialogHeader>
        {pending && (
          <div className="px-1 font-mono text-[10.5px] text-muted-foreground">
            {pending.row.workflow.label} · {pending.row.trace} · version {pending.action.expectedVersion ?? pending.row.version}
          </div>
        )}
        <DialogFooter>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border bg-card px-3 py-1 text-[12px] font-medium text-secondary-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
          >
            Keep it as it is
          </button>
          <button
            type="button"
            onClick={() => pending && onConfirm(pending)}
            className={cn(
              "rounded-md border px-3 py-1 text-[12px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring",
              confirm?.tone === "destructive"
                ? "border-destructive bg-destructive/15 text-destructive hover:bg-destructive/25"
                : "border-primary bg-primary text-primary-foreground hover:bg-primary/90",
            )}
          >
            {confirm?.confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Results — applied / conflict / rejected, all three visible
// ---------------------------------------------------------------------------

const RESULT_TONE: Record<DemoCommandResult["state"], { wrap: string; text: string; icon: ReactNode; word: string }> = {
  applied: {
    wrap: "border-success/40 bg-success/8",
    text: "text-success",
    icon: <CheckCircle2 aria-hidden className="size-3.5" />,
    word: "Applied",
  },
  conflict: {
    wrap: "border-warning/45 bg-warning/10",
    text: "text-warning",
    icon: <AlertTriangle aria-hidden className="size-3.5" />,
    word: "Conflict",
  },
  rejected: {
    wrap: "border-destructive/45 bg-destructive/8",
    text: "text-destructive",
    icon: <Ban aria-hidden className="size-3.5" />,
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
    <div className="flex flex-col gap-1.5 border-b border-border/60 bg-secondary/20 px-3 py-2" aria-live="polite" data-demo-result-feed="">
      {results.map((r) => {
        const tone = RESULT_TONE[r.state];
        return (
          <div key={r.id} className={cn("rounded-md border px-2.5 py-1.5", tone.wrap)} data-demo-result={r.state}>
            <div className="flex min-w-0 items-center gap-2">
              <span className={cn("inline-flex shrink-0", tone.text)}>{tone.icon}</span>
              <span className={cn("shrink-0 text-[11px] font-semibold uppercase tracking-wider", tone.text)}>{tone.word}</span>
              <span className="min-w-0 truncate text-[12px] font-semibold text-foreground">{r.headline}</span>
              <span className="ml-auto shrink-0 font-mono text-[9.5px] text-muted-foreground tabular-nums">
                {r.actionLabel} · {r.clock} · {r.requestedBy}
              </span>
              <button
                type="button"
                aria-label="Dismiss this result"
                onClick={() => onDismiss(r.id)}
                className="shrink-0 rounded p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X aria-hidden className="size-3" />
              </button>
            </div>
            <p className="mt-0.5 pl-6 text-[11px] leading-relaxed text-muted-foreground">{r.detail}</p>
            {r.code && (
              <p className="mt-0.5 pl-6 font-mono text-[10px] text-destructive">
                code {r.code} · {r.rowTitle} · {r.workflowLabel}
              </p>
            )}
            {r.state === "conflict" && r.serverVersion !== undefined && (
              <div className="mt-1 flex items-center gap-2 pl-6">
                <span className="font-mono text-[10px] text-warning">
                  expectedVersion {r.expectedVersion} → server {r.serverVersion}
                </span>
                <button
                  type="button"
                  onClick={() => onRefreshRow(r.rowId, r.serverVersion ?? 0)}
                  className="rounded-md border border-warning/50 bg-warning/15 px-2 py-px text-[10.5px] font-semibold text-warning outline-none hover:bg-warning/25 focus-visible:ring-2 focus-visible:ring-ring"
                >
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
