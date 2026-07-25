import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Ban,
  Camera,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  Loader2,
  RotateCcw,
  Search,
  SearchX,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { IconActionButton } from "@/components/shared/IconActionButton";
import { QueueRowCard } from "@/components/queue-panel/QueueRowCard";
import { StatusCounts } from "@/components/queue-panel/StatusCounts";
import { FactChip, mockRowActions, StatusBadge, SubLine } from "./proposal-rows";
import { useProposals } from "./proposal-toggles";

/**
 * DEV-ONLY — group-at-scale prototypes (G1–G4) for the UI gallery "Proposals"
 * tab. The thesis: 50 members does NOT need a fourth row type — a large group
 * is still a Group Row. What scales is the PRESENTATION: a density ladder by
 * member count (G1), a status matrix on the card past ~20 members (G2), a
 * keyboard-driven triage table as the drill-in (G3), and a review conveyor
 * with operator check-marks for manual verification passes (G4).
 */

const NOOP = () => {};

// ---------------------------------------------------------------------------
// Deterministic 50-member fixture (no randomness — stable screenshots).
// ---------------------------------------------------------------------------

export type MemberStatus = "done" | "doneWarnings" | "running" | "queued" | "failed" | "waiting" | "rejected";

export interface FixtureMember {
  i: number;
  name: string;
  eid: string;
  status: MemberStatus;
  fact: string;
  duration: string;
  checked: boolean;
}

const FIRST = [
  "Ana", "Ben", "Carla", "Diego", "Emma", "Felix", "Grace", "Hugo", "Iris", "Jonah",
  "Kara", "Liam", "Mona", "Noel", "Opal", "Pablo", "Quinn", "Rita", "Sam", "Tara",
  "Uma", "Victor", "Wren", "Xena", "Yara",
];
const LAST = ["Alvarez", "Brooks", "Chen", "Diaz", "Egan", "Flores", "Garcia", "Hahn", "Ito", "Jones"];

/** index → non-done status; everything else is done (checked ⇢ first 12). */
const SPECIAL: Record<number, MemberStatus> = {
  4: "failed",
  11: "waiting",
  19: "doneWarnings",
  23: "failed",
  31: "running",
  38: "queued",
  39: "queued",
  40: "queued",
  46: "rejected",
};

const FACT_BY_STATUS: Record<MemberStatus, string> = {
  done: "S1 + S2 · retain 3y",
  doneWarnings: "S2 missing — flag",
  running: "person-lookup…",
  queued: "—",
  failed: "no UCPath match",
  waiting: "2 name candidates",
  rejected: "no searchable name",
};

export const FIFTY: FixtureMember[] = Array.from({ length: 50 }, (_, i) => {
  const status = SPECIAL[i] ?? "done";
  return {
    i,
    name: i === 46 ? "Page 31" : `${FIRST[i % 25]} ${LAST[i % 10]}`,
    eid: `105${String(31000 + i * 137).padStart(5, "0")}`,
    status,
    fact: FACT_BY_STATUS[status],
    duration: status === "done" || status === "doneWarnings" ? `${34 + (i % 5) * 7}s` : status === "failed" ? "41s" : "—",
    checked: status === "done" && i < 12,
  };
});

const ATTENTION: MemberStatus[] = ["failed", "waiting", "doneWarnings"];
const attentionCount = FIFTY.filter((m) => ATTENTION.includes(m.status)).length;
const checkedCount = FIFTY.filter((m) => m.checked).length;

// ---------------------------------------------------------------------------
// Shared status visuals (member-scale, mirrors StatusCounts / EntryItem tones)
// ---------------------------------------------------------------------------

const MEMBER_ICON: Record<MemberStatus, { icon: typeof Check; cls: string; label: string }> = {
  done: { icon: CheckCircle2, cls: "text-success", label: "Done" },
  doneWarnings: { icon: CheckCircle2, cls: "text-warning", label: "Done with warnings" },
  running: { icon: Loader2, cls: "text-primary animate-spin motion-reduce:animate-none", label: "Running" },
  queued: { icon: Clock, cls: "text-warning", label: "Queued" },
  failed: { icon: AlertTriangle, cls: "text-destructive", label: "Failed" },
  waiting: { icon: Eye, cls: "text-warning", label: "Waiting on you" },
  rejected: { icon: SearchX, cls: "text-muted-foreground", label: "Rejected" },
};

const CELL_CLASS: Record<MemberStatus, string> = {
  done: "bg-success/75",
  doneWarnings: "bg-warning/80",
  running: "bg-primary/80 animate-pulse motion-reduce:animate-none",
  queued: "bg-secondary",
  failed: "bg-destructive",
  waiting: "bg-warning",
  rejected: "bg-muted-foreground/40",
};

// ---------------------------------------------------------------------------
// G2 — the status matrix: one cell per member, click = jump to that member.
// ---------------------------------------------------------------------------

export function StatusMatrix({
  members,
  selected,
  onSelect,
}: {
  members: FixtureMember[];
  selected?: number;
  onSelect?: (i: number) => void;
}) {
  return (
    <div className="mt-1.5 ml-5 flex flex-wrap gap-[3px]" role="listbox" aria-label="Member status matrix">
      {members.map((m) => (
        <button
          key={m.i}
          type="button"
          role="option"
          aria-selected={selected === m.i}
          title={`${m.name} — ${MEMBER_ICON[m.status].label}${m.fact !== "—" ? ` · ${m.fact}` : ""}`}
          aria-label={`${m.name} — ${MEMBER_ICON[m.status].label}`}
          onClick={() => onSelect?.(m.i)}
          className={cn(
            "size-3.5 rounded-[3px] outline-none transition-transform focus-visible:ring-2 focus-visible:ring-ring",
            "hover:scale-125",
            CELL_CLASS[m.status],
            selected === m.i && "ring-2 ring-primary",
            m.checked && "ring-1 ring-success/70",
          )}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// G1 — compact member lines (the 6–20 member "medium" density).
// ---------------------------------------------------------------------------

export function CompactMemberList({ members }: { members: FixtureMember[] }) {
  return (
    <div className="mt-1.5 ml-5 divide-y divide-border/40 overflow-hidden rounded-md border border-border/60">
      {members.map((m) => {
        const spec = MEMBER_ICON[m.status];
        const Icon = spec.icon;
        return (
          <button
            key={m.i}
            type="button"
            onClick={NOOP}
            className="flex w-full items-center gap-2 bg-card px-2.5 py-1 text-left text-[11.5px] outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon aria-hidden className={cn("size-3 shrink-0", spec.cls)} />
            <span className="min-w-0 flex-1 truncate text-foreground">{m.name}</span>
            <span className="shrink-0 truncate font-mono text-[10px] text-muted-foreground">{m.fact}</span>
            <span className="w-16 shrink-0 text-right font-mono text-[10px] text-muted-foreground tabular-nums">
              {m.eid}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// G2 card — the 50-member Group Row, collapsed: rollup + matrix + attention
// entry point. Expanding a 20+ group routes to the triage drill-in (G3), not
// inline member rows.
// ---------------------------------------------------------------------------

export function GroupCardFifty() {
  const { on } = useProposals();
  const [selected, setSelected] = useState<number | undefined>(undefined);
  return (
    <QueueRowCard
      selected={false}
      rootProps={{
        role: "button",
        tabIndex: 0,
        "aria-label": "I9 retention batch — 50 members",
      }}
      footer={{
        time: "1:40 PM",
        runNumber: 8,
        secondaryId: "ic-134001-77aa",
        elapsed: "22m 5s",
        actions: mockRowActions(["cancel"]),
      }}
    >
      <div className="px-3.5 py-2.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin text-primary motion-reduce:animate-none" />
            <span className="truncate text-[14px] font-semibold text-foreground">I9_Quarterly_Retention.pdf</span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <StatusBadge status="running" />
          </div>
        </div>
        <SubLine tone="muted">
          UCPath search · roster re-match — <span className="text-foreground">44/50</span> people processed
        </SubLine>
        <div className="mt-1.5 ml-5 flex items-center gap-2.5 text-[11px]">
          <StatusCounts counts={{ done: 43, running: 1, queued: 3, failed: 2 }} />
          <span className="inline-flex items-center gap-1 text-muted-foreground" aria-label="1 rejected">
            <SearchX aria-hidden className="size-3" />1
          </span>
          {on("g4") && (
            <span className="inline-flex items-center gap-1 text-success" aria-label={`${checkedCount} manually checked`}>
              <Check aria-hidden className="size-3" />
              {checkedCount} checked
            </span>
          )}
        </div>
        {on("g2") ? (
          <StatusMatrix members={FIFTY} selected={selected} onSelect={setSelected} />
        ) : (
          <div className="mt-1.5 ml-5 text-[11px] text-muted-foreground">
            Kara Alvarez, Liam Brooks, Mona Chen +47 more — expand scrolls a 24rem list…
          </div>
        )}
        {on("g4") && (
          <div className="mt-2 ml-5 flex items-center gap-2 rounded-md border border-warning/35 bg-warning/6 px-2.5 py-1.5">
            <AlertTriangle aria-hidden className="size-3.5 shrink-0 text-warning" />
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-warning">
              {attentionCount} need attention — 2 failed · 1 waiting · 1 warning
            </span>
            <button
              type="button"
              onClick={NOOP}
              className="shrink-0 rounded-md border border-warning/45 bg-warning/12 px-2.5 py-0.5 text-[10.5px] font-semibold text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Start review
            </button>
          </div>
        )}
      </div>
    </QueueRowCard>
  );
}

// ---------------------------------------------------------------------------
// G3 — triage drill-in: dense sortable/filterable table with keyboard flow.
// ---------------------------------------------------------------------------

const ATTENTION_ORDER: Record<MemberStatus, number> = {
  failed: 0,
  waiting: 1,
  doneWarnings: 2,
  running: 3,
  queued: 4,
  rejected: 5,
  done: 6,
};

type TriageFilter = "attention" | "all" | "done";

export function TriageTable() {
  const { on } = useProposals();
  const [filter, setFilter] = useState<TriageFilter>("attention");
  const [cursor, setCursor] = useState(0);

  const rows = useMemo(() => {
    const sorted = [...FIFTY].sort((a, b) => ATTENTION_ORDER[a.status] - ATTENTION_ORDER[b.status] || a.i - b.i);
    if (filter === "attention") return sorted.filter((m) => ATTENTION.includes(m.status) || m.status === "running" || m.status === "queued" || m.status === "rejected");
    if (filter === "done") return sorted.filter((m) => m.status === "done");
    return sorted;
  }, [filter]);

  const visible = rows.slice(0, 12);

  const chip = (key: TriageFilter, label: string, n: number, tone?: "warning") => (
    <button
      type="button"
      aria-pressed={filter === key}
      onClick={() => {
        setFilter(key);
        setCursor(0);
      }}
      className={cn(
        "rounded-full border px-2.5 py-0.5 text-[10.5px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
        filter === key
          ? tone === "warning"
            ? "border-warning/50 bg-warning/12 text-warning"
            : "border-primary/50 bg-primary/12 text-foreground"
          : "border-border bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {label} <span className="font-mono tabular-nums">{n}</span>
    </button>
  );

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2">
        <button
          type="button"
          onClick={NOOP}
          aria-label="Back to queue"
          className="mr-1 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft aria-hidden className="size-3.5" />
        </button>
        <span className="mr-2 truncate text-[13px] font-semibold text-foreground">I9_Quarterly_Retention.pdf</span>
        {chip("attention", "Attention", 9, "warning")}
        {chip("all", "All", 50)}
        {chip("done", "Done", 42)}
        <span className="relative ml-auto">
          <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <input
            aria-label="Search members"
            placeholder="name / EID…"
            className="w-36 rounded-md border border-border bg-secondary/40 py-0.5 pl-6 pr-2 text-[11px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </span>
      </div>

      {/* rows (virtualized in the real build) */}
      <div role="listbox" aria-label="Group members, attention first" className="divide-y divide-border/30">
        {visible.map((m, idx) => {
          const spec = MEMBER_ICON[m.status];
          const Icon = spec.icon;
          const isCursor = idx === cursor;
          return (
            <button
              key={m.i}
              type="button"
              role="option"
              aria-selected={isCursor}
              onClick={() => setCursor(idx)}
              className={cn(
                "grid w-full grid-cols-[16px_minmax(120px,1.2fr)_78px_minmax(110px,1fr)_52px_max-content] items-center gap-x-3 px-3 py-[5px] text-left text-[12px] outline-none",
                "hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                isCursor && "bg-info/8 shadow-[inset_2px_0_0_var(--info)]",
              )}
            >
              <Icon aria-hidden className={cn("size-3.5", spec.cls)} />
              <span className="flex min-w-0 items-center gap-1.5">
                <span className={cn("truncate font-medium text-foreground", m.status === "rejected" && "italic text-muted-foreground")}>
                  {m.name}
                </span>
                {on("g4") && m.checked && (
                  <Check aria-hidden className="size-3 shrink-0 text-success" />
                )}
              </span>
              <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">{m.eid}</span>
              <span
                className={cn(
                  "truncate font-mono text-[10.5px]",
                  m.status === "failed" && "text-destructive",
                  m.status === "waiting" && "text-warning",
                  m.status === "doneWarnings" && "text-warning",
                  (m.status === "done" || m.status === "running") && "text-muted-foreground",
                  (m.status === "queued" || m.status === "rejected") && "text-muted-foreground/70",
                )}
              >
                {m.fact}
              </span>
              <span className="text-right font-mono text-[10.5px] text-muted-foreground tabular-nums">{m.duration}</span>
              <span className="flex items-center gap-0.5">
                {(m.status === "failed" || m.status === "doneWarnings") && (
                  <IconActionButton tone="primary" icon={<RotateCcw aria-hidden className="size-3" />} label={`Retry ${m.name}`} onClick={NOOP} />
                )}
                {m.status === "rejected" ? (
                  <IconActionButton tone="destructive" icon={<Trash2 aria-hidden className="size-3" />} label={`Delete ${m.name}`} onClick={NOOP} />
                ) : (
                  <IconActionButton tone="muted" icon={<ArrowRight aria-hidden className="size-3" />} label={`Open ${m.name}`} onClick={NOOP} />
                )}
              </span>
            </button>
          );
        })}
      </div>
      {rows.length > visible.length && (
        <div className="border-t border-border/40 px-3 py-1.5 text-center text-[10.5px] text-muted-foreground">
          + {rows.length - visible.length} more — list virtualizes and scrolls
        </div>
      )}

      {/* keyboard hints */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 bg-secondary/20 px-3 py-1.5 font-mono text-[10px] text-muted-foreground">
        <span>
          <kbd className="rounded border border-border bg-card px-1">j</kbd>/<kbd className="rounded border border-border bg-card px-1">k</kbd> move
        </span>
        <span>
          <kbd className="rounded border border-border bg-card px-1">Enter</kbd> open logs
        </span>
        <span>
          <kbd className="rounded border border-border bg-card px-1">n</kbd> next attention
        </span>
        <span>
          <kbd className="rounded border border-border bg-card px-1">r</kbd> retry
        </span>
        {on("g4") && (
          <span>
            <kbd className="rounded border border-border bg-card px-1">c</kbd> mark checked
          </span>
        )}
        <span className="ml-auto">sorted attention-first</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// G4 — the review conveyor: the member log panel header walks attention items
// with prev/next + a per-member action bar + operator check-marks.
// ---------------------------------------------------------------------------

export function MemberConveyorPanel() {
  const { on } = useProposals();
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card">
      {/* conveyor header */}
      <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-2">
        <IconActionButton tone="muted" icon={<ChevronLeft aria-hidden className="size-3.5" />} label="Previous member" onClick={NOOP} />
        <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">7/50</span>
        <IconActionButton tone="muted" icon={<ChevronRight aria-hidden className="size-3.5" />} label="Next member" onClick={NOOP} />
        <span className="ml-1 min-w-0 truncate text-[13px] font-semibold text-foreground">Emma Egan</span>
        <StatusBadge status="failed" />
        <button
          type="button"
          onClick={NOOP}
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md border border-warning/45 bg-warning/10 px-2 py-0.5 text-[10.5px] font-semibold text-warning outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Next attention
          <ArrowRight aria-hidden className="size-3" />
        </button>
      </div>

      {/* progress through the batch */}
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-[10.5px] text-muted-foreground">
        <span aria-hidden className="flex h-1 flex-1 overflow-hidden rounded-full bg-secondary">
          <span className="bg-success/70" style={{ flexGrow: 12 }} />
          <span className="bg-border" style={{ flexGrow: 38 }} />
        </span>
        <span className="shrink-0 font-mono tabular-nums">{checkedCount}/50 checked</span>
      </div>

      {/* compact context */}
      <div className="px-3 py-2 text-[12px]">
        <div className="flex flex-wrap items-center gap-1.5">
          <FactChip label="EID" value="10531548" />
          <FactChip label="I-9 hire" value="03/12/2024" />
          <FactChip warn value="no UCPath match for name or EID" />
        </div>
        <div className="mt-2 rounded-lg border border-destructive/40 bg-destructive/6 px-3 py-2">
          <div className="text-[11.5px] font-semibold text-destructive">Person search found no match</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            Searched “Emma Egan” + EID 10531548 in UCPath — 0 results either way.{" "}
            <span className="inline-flex items-center gap-1 text-info">
              <Camera aria-hidden className="size-3" />
              Search screenshot
            </span>
          </div>
        </div>
        <div className="mt-2 flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <X aria-hidden className="mt-0.5 size-3 shrink-0 text-destructive" />
          <span>
            2:41:07 — UCPath person search: “Emma Egan” → no rows · retried by EID → no rows · roster row 7 left
            unmatched
          </span>
        </div>
      </div>

      {/* per-member action bar */}
      <div className="mt-auto flex items-center gap-1.5 border-t border-border/60 bg-secondary/20 px-3 py-2">
        <button
          type="button"
          onClick={NOOP}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-secondary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RotateCcw aria-hidden className="size-3" />
          Retry
        </button>
        {on("g4") && (
          <button
            type="button"
            onClick={NOOP}
            className="inline-flex items-center gap-1.5 rounded-md border border-success/45 bg-success/10 px-2.5 py-1 text-[11px] font-semibold text-success outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Check aria-hidden className="size-3" />
            Mark checked
          </button>
        )}
        <button
          type="button"
          onClick={NOOP}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Ban aria-hidden className="size-3" />
          Skip
        </button>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          <kbd className="rounded border border-border bg-card px-1">n</kbd> advances after action
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// G1 medium fixture — a 12-member group with compact lines.
// ---------------------------------------------------------------------------

export function GroupCardMedium() {
  return (
    <QueueRowCard
      selected={false}
      rootProps={{ role: "button", tabIndex: 0, "aria-label": "Oath packet — 12 signers" }}
      footer={{
        time: "11:05 AM",
        runNumber: 4,
        secondaryId: "os-110501-c2f0",
        duration: "18m 40s",
        actions: mockRowActions(["retry", "delete"]),
      }}
    >
      <div className="px-3.5 py-2.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <CheckCircle2 aria-hidden className="h-3.5 w-3.5 shrink-0 text-success" />
            <span className="truncate text-[14px] font-semibold text-foreground">Oath_Packet_Spring.pdf</span>
          </div>
          <StatusBadge status="verifiedDone" />
        </div>
        <div className="mt-1.5 ml-5 flex items-center gap-2.5 text-[11px]">
          <StatusCounts counts={{ done: 11, running: 0, queued: 0, failed: 1 }} />
        </div>
        <CompactMemberList
          members={[
            { ...FIFTY[0], name: "Ana Alvarez", status: "done", fact: "signed 11:08 AM", duration: "40s" },
            { ...FIFTY[1], name: "Ben Brooks", status: "done", fact: "signed 11:10 AM", duration: "38s" },
            { ...FIFTY[2], name: "Carla Chen", status: "failed", fact: "signature field never rendered", duration: "1m 2s" },
            { ...FIFTY[3], name: "Diego Diaz", status: "done", fact: "signed 11:13 AM", duration: "41s" },
            { ...FIFTY[4], name: "Emma Egan", status: "done", fact: "signed 11:15 AM", duration: "35s" },
            { ...FIFTY[5], name: "Felix Flores", status: "done", fact: "signed 11:16 AM", duration: "37s" },
          ]}
        />
        <div className="mt-1 ml-5 text-[10.5px] text-muted-foreground">+ 6 more — scrolls</div>
      </div>
    </QueueRowCard>
  );
}
