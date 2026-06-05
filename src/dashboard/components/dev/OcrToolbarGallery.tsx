import { useEffect, useState, type ReactNode } from "react";
import {
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronDown,
  FileScan,
  Loader2,
  Moon,
  Sun,
  UploadCloud,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * TEMPORARY DEV ROUTE — `?view=ocr-toolbar-gallery`.
 *
 * A focused showcase of redesign candidates for ONE element: the right-side
 * action cluster of the OCR Review pane's header bar (`OcrReviewPane.tsx`
 * toolbar). Each candidate is rendered inside a faithful mock of the real dark
 * command bar (`bg-card border-b border-border px-6 py-4`, `[FileScan] name`
 * on the left) across three states — ready / gated / submitting — so the
 * hierarchy, balance, and disabled/loading treatments can be judged in situ.
 *
 * Token-only (no palette classes, no hex), lucide icons, accessible buttons —
 * the same contract as production, so whatever wins can be lifted straight into
 * the toolbar. Remove this file + its `?view=ocr-toolbar-gallery` gate in
 * App.tsx once a direction is picked.
 */

// ---------------------------------------------------------------------------
// State model — the cluster's three meaningful lifecycle states.
// ---------------------------------------------------------------------------

type StateKey = "ready" | "gated" | "loading";

interface ClusterState {
  key: StateKey;
  /** Total OCR-extracted records on the document. */
  records: number;
  /** How many are checked/approvable right now (gates Approve). */
  selected: number;
  submitting: boolean;
}

/** The screenshot scenario: a single-record oath PDF — proves the "1 record"
 *  grammar fix directly. selected drives the gate; submitting drives loading. */
const STATES: { key: StateKey; caption: string }[] = [
  { key: "ready", caption: "1 selected · ready" },
  { key: "gated", caption: "0 selected · gated" },
  { key: "loading", caption: "submitting" },
];

function resolveState(key: StateKey): ClusterState {
  switch (key) {
    case "ready":
      return { key, records: 1, selected: 1, submitting: false };
    case "gated":
      return { key, records: 1, selected: 0, submitting: false };
    case "loading":
      return { key, records: 1, selected: 1, submitting: true };
  }
}

const recordLabel = (n: number) => `${n} ${n === 1 ? "record" : "records"}`;

// ---------------------------------------------------------------------------
// Shared atoms — reused across variants so the comparison is apples-to-apples.
// ---------------------------------------------------------------------------

/** Faithful mock of the real preview-header bar. `meta` injects content beside
 *  the filename (variant C); `children` is the right-aligned action cluster. */
function Bar({ meta, children }: { meta?: ReactNode; children: ReactNode }) {
  return (
    <div className="border-b border-border bg-card px-6 py-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
        <FileScan className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <h3 className="min-w-0 max-w-[min(100%,18rem)] truncate text-sm font-semibold text-foreground">
          single-oath.pdf
        </h3>
        {meta}
        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">{children}</div>
      </div>
    </div>
  );
}

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

/** Neutral, secondary Reupload control. Ghost by default; `iconOnly` collapses
 *  to a square. Disabled only while the primary action is submitting. */
function Reupload({
  s,
  iconOnly = false,
  bare = false,
}: {
  s: ClusterState;
  iconOnly?: boolean;
  bare?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={s.submitting}
      aria-label="Reupload corrected PDF"
      title="Re-upload corrected PDF — carries forward resolved EIDs from this run"
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md text-xs font-medium leading-none text-muted-foreground",
        "transition-colors duration-150",
        "hover:bg-secondary hover:text-foreground",
        "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
        bare ? "px-1.5" : "border border-border/70 px-2.5 hover:border-border",
        iconOnly && "w-8 justify-center px-0",
        FOCUS_RING,
      )}
    >
      <UploadCloud className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {!iconOnly && <span>Reupload</span>}
    </button>
  );
}

/** Filled / soft primary Approve. Count rides the label (`Approve N`). */
function Approve({
  s,
  soft = false,
  label = "Approve",
}: {
  s: ClusterState;
  soft?: boolean;
  label?: string;
}) {
  const disabled = s.selected <= 0 || s.submitting;
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={`${label} ${s.selected} ${s.selected === 1 ? "record" : "records"}`}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3.5 text-xs font-semibold leading-none",
        "transition-[background-color,transform,border-color] duration-150 ease-out",
        soft
          ? "border border-primary/30 bg-primary/15 text-primary hover:bg-primary/25"
          : "bg-primary text-primary-foreground hover:bg-primary/90",
        "motion-safe:active:translate-y-px",
        "disabled:cursor-not-allowed",
        !s.submitting && "disabled:opacity-50 disabled:active:translate-y-0",
        FOCUS_RING,
      )}
    >
      {s.submitting ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
      ) : (
        <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
      )}
      <span className="tabular-nums">
        {label} {s.selected}
      </span>
    </button>
  );
}

/** Small status dot: success when something is selectable, muted when gated. */
function Dot({ active }: { active: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-full",
        active ? "bg-success" : "bg-muted-foreground/50",
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// The variants — each is a cluster renderer (+ optional filename-meta slot).
// ---------------------------------------------------------------------------

interface VariantDef {
  id: string;
  title: string;
  rationale: string;
  meta?: (s: ClusterState) => ReactNode;
  cluster: (s: ClusterState) => ReactNode;
}

const VARIANTS: VariantDef[] = [
  {
    id: "A",
    title: "Refined inline",
    rationale:
      "The current order, fixed. Reupload becomes a real ghost button, the count a quiet neutral chip, and the faint middle dot is gone — three weights resolve into secondary · meta · primary instead of mush.",
    cluster: (s) => (
      <div className="flex items-center gap-2.5">
        <Reupload s={s} />
        <span className="inline-flex h-7 items-center rounded-md bg-secondary px-2 text-[11px] font-medium tabular-nums text-muted-foreground">
          {recordLabel(s.records)}
        </span>
        <Approve s={s} />
      </div>
    ),
  },
  {
    id: "B",
    title: "Connected segmented group",
    rationale:
      "One cohesive pill binds the actions: Reupload and a non-interactive count share a track, a hairline divider separates them from the filled Approve segment. Reads as a single deliberate control, not three floating bits.",
    cluster: (s) => {
      const disabled = s.selected <= 0 || s.submitting;
      return (
        <div className="inline-flex h-8 items-center rounded-lg border border-border bg-secondary/40 p-0.5">
          <button
            type="button"
            disabled={s.submitting}
            aria-label="Reupload corrected PDF"
            title="Re-upload corrected PDF"
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium leading-none text-muted-foreground",
              "transition-colors duration-150 hover:bg-secondary hover:text-foreground",
              "disabled:cursor-not-allowed disabled:opacity-40",
              FOCUS_RING,
            )}
          >
            <UploadCloud className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Reupload
          </button>
          <span className="px-1.5 text-[11px] font-medium tabular-nums text-muted-foreground/80">
            {recordLabel(s.records)}
          </span>
          <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />
          <button
            type="button"
            disabled={disabled}
            aria-label={`Approve ${s.selected} records`}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold leading-none text-primary-foreground",
              "transition-colors duration-150 hover:bg-primary/90",
              "disabled:cursor-not-allowed",
              !s.submitting && "disabled:opacity-50",
              FOCUS_RING,
            )}
          >
            {s.submitting ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
            )}
            <span className="tabular-nums">Approve {s.selected}</span>
          </button>
        </div>
      );
    },
  },
  {
    id: "C",
    title: "Primary-dominant (count up top)",
    rationale:
      "The record count is document metadata, so it moves beside the filename as a chip. Reupload drops to an icon-only ghost. The action zone now holds exactly one prominent thing — Approve — and the eye lands on it instantly.",
    meta: (s) => (
      <span className="ml-1 inline-flex shrink-0 items-center rounded-md bg-secondary px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
        {recordLabel(s.records)}
      </span>
    ),
    cluster: (s) => (
      <div className="flex items-center gap-2">
        <Reupload s={s} iconOnly />
        <Approve s={s} />
      </div>
    ),
  },
  {
    id: "D",
    title: "Split / overflow Approve",
    rationale:
      "Approve is the only button; its chevron opens a menu (Approve selected · Approve all · Reupload). Collapses every secondary affordance into the primary's overflow — the calmest possible bar, ideal once the flow is familiar.",
    cluster: (s) => {
      const disabled = s.selected <= 0 || s.submitting;
      return (
        <div className="inline-flex h-8 items-stretch rounded-md bg-primary text-primary-foreground">
          <button
            type="button"
            disabled={disabled}
            aria-label={`Approve ${s.selected} records`}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-l-md px-3.5 text-xs font-semibold leading-none",
              "transition-colors duration-150 hover:bg-primary/90",
              "disabled:cursor-not-allowed",
              !s.submitting && "disabled:opacity-50",
              FOCUS_RING,
            )}
          >
            {s.submitting ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
            )}
            <span className="tabular-nums">Approve {s.selected}</span>
          </button>
          <span className="my-1.5 w-px shrink-0 bg-primary-foreground/25" aria-hidden />
          <button
            type="button"
            disabled={s.submitting}
            aria-label="More approve options"
            title="More options — approve all, reupload"
            className={cn(
              "inline-flex items-center rounded-r-md px-1.5",
              "transition-colors duration-150 hover:bg-primary/90",
              "disabled:cursor-not-allowed disabled:opacity-50",
              FOCUS_RING,
            )}
          >
            <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
          </button>
        </div>
      );
    },
  },
  {
    id: "E",
    title: "Soft primary",
    rationale:
      "Same layout as A, but Approve uses the house tint (`bg-primary/15` + solid `text-primary` + `border-primary/30`) instead of a heavy fill. Against near-black it stops shouting — still clearly the CTA, much easier on a dense pane.",
    cluster: (s) => (
      <div className="flex items-center gap-2.5">
        <Reupload s={s} />
        <span className="inline-flex h-7 items-center rounded-md px-1 text-[11px] font-medium tabular-nums text-muted-foreground">
          {recordLabel(s.records)}
        </span>
        <Approve s={s} soft />
      </div>
    ),
  },
  {
    id: "F",
    title: "Stat + CTA",
    rationale:
      "Promotes the count from filler to a real readout — a tabular number with a tiny caption and a leading status dot (green when records are ready, muted when gated). The dot doubles as the gate indicator next to Approve.",
    cluster: (s) => (
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Dot active={s.selected > 0} />
          <span className="flex flex-col leading-none">
            <span className="text-[13px] font-semibold tabular-nums text-foreground">{s.selected}</span>
            <span className="mt-0.5 text-[9.5px] uppercase tracking-wider text-muted-foreground">
              selected
            </span>
          </span>
        </div>
        <Reupload s={s} iconOnly />
        <Approve s={s} />
      </div>
    ),
  },
  {
    id: "G",
    title: "Count inside Approve",
    rationale:
      "Two elements total. The count lives as a contained badge inside the button, so there's no standalone number competing for attention — Reupload (icon) and Approve are the whole cluster. Maximum density, minimum noise.",
    cluster: (s) => {
      const disabled = s.selected <= 0 || s.submitting;
      return (
        <div className="flex items-center gap-2">
          <Reupload s={s} iconOnly />
          <button
            type="button"
            disabled={disabled}
            aria-label={`Approve ${s.selected} records`}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-semibold leading-none text-primary-foreground",
              "transition-[background-color,transform] duration-150 ease-out hover:bg-primary/90 motion-safe:active:translate-y-px",
              "disabled:cursor-not-allowed",
              !s.submitting && "disabled:opacity-50 disabled:active:translate-y-0",
              FOCUS_RING,
            )}
          >
            {s.submitting ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
            )}
            <span>Approve</span>
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded bg-primary-foreground/20 px-1 text-[10px] font-bold tabular-nums">
              {s.selected}
            </span>
          </button>
        </div>
      );
    },
  },
  {
    id: "H",
    title: "Pill-framed count",
    rationale:
      "The count gets a rounded-full pill with a leading status dot, giving it a clear identity instead of bare text wedged between buttons. Reupload and Approve bracket it; the pill becomes a calm middle anchor.",
    cluster: (s) => (
      <div className="flex items-center gap-2.5">
        <Reupload s={s} />
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-secondary/50 px-2.5 py-1 text-[11px] font-medium tabular-nums text-muted-foreground">
          <Dot active={s.records > 0} />
          {recordLabel(s.records)}
        </span>
        <Approve s={s} />
      </div>
    ),
  },
  {
    id: "I",
    title: "Vertical-divider grouped",
    rationale:
      "An explicit `border-l` splits the bar into a secondary zone (Reupload + count) and a primary zone (Approve). The divider does the grouping the faint dot couldn't — secondaries cluster together and visibly hand off to the CTA.",
    cluster: (s) => (
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2.5">
          <Reupload s={s} bare />
          <span className="text-[11px] font-medium tabular-nums text-muted-foreground">
            {recordLabel(s.records)}
          </span>
        </div>
        <span className="h-5 w-px shrink-0 bg-border" aria-hidden />
        <Approve s={s} />
      </div>
    ),
  },
  {
    id: "J",
    title: "Two-line cluster",
    rationale:
      "Lifts the count out of the button row entirely into a quiet caption above it (records · selected), then a clean [Reupload][Approve] pair below. Gives the metadata a home without ever interrupting the two real actions.",
    cluster: (s) => (
      <div className="flex flex-col items-end gap-1">
        <span className="text-[10.5px] tabular-nums text-muted-foreground" aria-live="polite">
          {recordLabel(s.records)} · {s.selected} selected
        </span>
        <div className="flex items-center gap-2">
          <Reupload s={s} />
          <Approve s={s} />
        </div>
      </div>
    ),
  },
];

// ---------------------------------------------------------------------------
// Per-variant block — title + rationale + the three states stacked.
// ---------------------------------------------------------------------------

function VariantBlock({ variant }: { variant: VariantDef }) {
  return (
    <section className="scroll-mt-6">
      <div className="mb-2 flex items-baseline gap-2.5">
        <span className="font-mono text-[11px] font-semibold text-primary">{variant.id}</span>
        <h2 className="text-[15px] font-semibold text-foreground">{variant.title}</h2>
      </div>
      <p className="mb-3 max-w-3xl text-[12.5px] leading-relaxed text-muted-foreground">
        {variant.rationale}
      </p>
      <div className="overflow-hidden rounded-xl border border-border/70 bg-background">
        {STATES.map((st, i) => {
          const s = resolveState(st.key);
          return (
            <div key={st.key} className={cn(i > 0 && "border-t border-border/50")}>
              <div className="flex items-center gap-2 bg-secondary/15 px-3 py-1">
                <Dot active={st.key === "ready"} />
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  {st.caption}
                </span>
              </div>
              <Bar meta={variant.meta?.(s)}>{variant.cluster(s)}</Bar>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ===========================================================================
// APPROVE BUTTON — the button itself, in isolation. Different colors / fills /
// shapes / icons / count treatments so the *button* can be picked, independent
// of the surrounding cluster.
// ===========================================================================

const approveDisabled = (s: ClusterState) => s.selected <= 0 || s.submitting;
const approveAria = (s: ClusterState) =>
  `Approve ${s.selected} ${s.selected === 1 ? "record" : "records"}`;

/** Leading glyph: spinner while submitting, else the supplied icon. */
function Lead({ s, Icon = Check }: { s: ClusterState; Icon?: typeof Check }) {
  return s.submitting ? (
    <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
  ) : (
    <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
  );
}

/** Shared structural + a11y classes; per-design adds shape + color. */
const APPROVE_BASE = cn(
  "inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold leading-none",
  "transition-[background-color,border-color,box-shadow,transform] duration-150 ease-out",
  "motion-safe:active:translate-y-px disabled:cursor-not-allowed",
  FOCUS_RING,
);
/** Filled fills keep saturation while submitting; dim only when gated. */
const dim = (s: ClusterState) => (!s.submitting ? "disabled:opacity-50 disabled:active:translate-y-0" : "");

interface ApproveDesign {
  id: string;
  title: string;
  note: string;
  render: (s: ClusterState) => ReactNode;
}

const APPROVE_DESIGNS: ApproveDesign[] = [
  {
    id: "1",
    title: "Filled · primary",
    note: "Today's button — the baseline you don't like, kept for reference.",
    render: (s) => (
      <button
        type="button"
        disabled={approveDisabled(s)}
        aria-label={approveAria(s)}
        className={cn(APPROVE_BASE, "h-8 rounded-md bg-primary px-3.5 text-primary-foreground hover:bg-primary/90", dim(s))}
      >
        <Lead s={s} />
        <span className="tabular-nums">Approve {s.selected}</span>
      </button>
    ),
  },
  {
    id: "2",
    title: "Filled · success (green)",
    note: "Green reads as 'confirm' — approve is a positive action, not a brand CTA.",
    render: (s) => (
      <button
        type="button"
        disabled={approveDisabled(s)}
        aria-label={approveAria(s)}
        className={cn(APPROVE_BASE, "h-8 rounded-md bg-success px-3.5 text-success-foreground hover:bg-success/90", dim(s))}
      >
        <Lead s={s} />
        <span className="tabular-nums">Approve {s.selected}</span>
      </button>
    ),
  },
  {
    id: "3",
    title: "Soft · success tint",
    note: "House tint in green — calm, clearly a confirm, never shouts on a dark pane.",
    render: (s) => (
      <button
        type="button"
        disabled={approveDisabled(s)}
        aria-label={approveAria(s)}
        className={cn(APPROVE_BASE, "h-8 rounded-md border border-success/30 bg-success/15 px-3.5 text-success hover:bg-success/25", dim(s))}
      >
        <Lead s={s} />
        <span className="tabular-nums">Approve {s.selected}</span>
      </button>
    ),
  },
  {
    id: "4",
    title: "Soft · primary tint",
    note: "Same calm tint, brand hue — keeps the accent colour without the heavy fill.",
    render: (s) => (
      <button
        type="button"
        disabled={approveDisabled(s)}
        aria-label={approveAria(s)}
        className={cn(APPROVE_BASE, "h-8 rounded-md border border-primary/30 bg-primary/15 px-3.5 text-primary hover:bg-primary/25", dim(s))}
      >
        <Lead s={s} />
        <span className="tabular-nums">Approve {s.selected}</span>
      </button>
    ),
  },
  {
    id: "5",
    title: "Outline · primary",
    note: "Border-only until hover — the lightest treatment, maximal restraint.",
    render: (s) => (
      <button
        type="button"
        disabled={approveDisabled(s)}
        aria-label={approveAria(s)}
        className={cn(APPROVE_BASE, "h-8 rounded-md border border-primary/40 bg-transparent px-3.5 text-primary hover:bg-primary/10", dim(s))}
      >
        <Lead s={s} />
        <span className="tabular-nums">Approve {s.selected}</span>
      </button>
    ),
  },
  {
    id: "6",
    title: "Pill · primary filled",
    note: "Fully rounded — softer, friendlier silhouette than the boxy default.",
    render: (s) => (
      <button
        type="button"
        disabled={approveDisabled(s)}
        aria-label={approveAria(s)}
        className={cn(APPROVE_BASE, "h-8 rounded-full bg-primary px-4 text-primary-foreground hover:bg-primary/90", dim(s))}
      >
        <Lead s={s} />
        <span className="tabular-nums">Approve {s.selected}</span>
      </button>
    ),
  },
  {
    id: "7",
    title: "Pill · success + status dot",
    note: "Rounded green tint with a leading dot instead of a check — quiet confidence.",
    render: (s) => (
      <button
        type="button"
        disabled={approveDisabled(s)}
        aria-label={approveAria(s)}
        className={cn(APPROVE_BASE, "h-8 rounded-full border border-success/30 bg-success/15 px-3.5 text-success hover:bg-success/25", dim(s))}
      >
        {s.submitting ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
        ) : (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" aria-hidden />
        )}
        <span className="tabular-nums">Approve {s.selected}</span>
      </button>
    ),
  },
  {
    id: "8",
    title: "Count as inner badge",
    note: "Filled, but the number is a contained chip — label stays calm, count is glanceable.",
    render: (s) => (
      <button
        type="button"
        disabled={approveDisabled(s)}
        aria-label={approveAria(s)}
        className={cn(APPROVE_BASE, "h-8 rounded-md bg-primary px-3 text-primary-foreground hover:bg-primary/90", dim(s))}
      >
        <Lead s={s} />
        <span>Approve</span>
        <span className="inline-flex h-4 min-w-4 items-center justify-center rounded bg-primary-foreground/20 px-1 text-[10px] font-bold tabular-nums">
          {s.selected}
        </span>
      </button>
    ),
  },
  {
    id: "9",
    title: "Count via inner divider",
    note: "A hairline splits label from count inside one button — structured, deliberate.",
    render: (s) => (
      <button
        type="button"
        disabled={approveDisabled(s)}
        aria-label={approveAria(s)}
        className={cn(APPROVE_BASE, "h-8 rounded-md bg-primary pl-3 pr-2.5 text-primary-foreground hover:bg-primary/90", dim(s))}
      >
        <Lead s={s} />
        <span>Approve</span>
        <span className="mx-0.5 h-3.5 w-px shrink-0 bg-primary-foreground/30" aria-hidden />
        <span className="tabular-nums">{s.selected}</span>
      </button>
    ),
  },
  {
    id: "10",
    title: "CheckCircle · no count",
    note: "Drops the number entirely (it lives in the cluster); a filled check-circle does the talking.",
    render: (s) => (
      <button
        type="button"
        disabled={approveDisabled(s)}
        aria-label={approveAria(s)}
        className={cn(APPROVE_BASE, "h-8 rounded-md bg-primary px-3.5 text-primary-foreground hover:bg-primary/90", dim(s))}
      >
        <Lead s={s} Icon={CheckCircle2} />
        <span>Approve</span>
      </button>
    ),
  },
  {
    id: "11",
    title: "Inset icon · two-tone",
    note: "The check sits in an inset tinted square — a tactile, considered detail.",
    render: (s) => (
      <button
        type="button"
        disabled={approveDisabled(s)}
        aria-label={approveAria(s)}
        className={cn(APPROVE_BASE, "h-8 rounded-md bg-primary py-1 pl-1 pr-3 text-primary-foreground hover:bg-primary/90", dim(s))}
      >
        <span className="inline-flex h-6 w-6 items-center justify-center rounded bg-primary-foreground/15">
          {s.submitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <Check className="h-3.5 w-3.5" aria-hidden />
          )}
        </span>
        <span className="tabular-nums">Approve {s.selected}</span>
      </button>
    ),
  },
  {
    id: "12",
    title: "Elevated · soft shadow",
    note: "Slightly taller with a subtle shadow — present and clickable without raw saturation.",
    render: (s) => (
      <button
        type="button"
        disabled={approveDisabled(s)}
        aria-label={approveAria(s)}
        className={cn(APPROVE_BASE, "h-9 rounded-md bg-primary px-4 text-primary-foreground shadow-sm hover:bg-primary/90 hover:shadow", dim(s))}
      >
        <Lead s={s} Icon={CheckCheck} />
        <span className="tabular-nums">Approve {s.selected}</span>
      </button>
    ),
  },
];

/** One design = header + the button in all three states on the real bar bg. */
function ApproveDesignBlock({ design }: { design: ApproveDesign }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/70">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-border/60 bg-secondary/15 px-4 py-2.5">
        <span className="font-mono text-[11px] font-semibold text-primary">{design.id}</span>
        <h3 className="text-[14px] font-semibold text-foreground">{design.title}</h3>
        <p className="basis-full text-[11.5px] leading-snug text-muted-foreground sm:basis-auto">
          {design.note}
        </p>
      </div>
      <div className="grid grid-cols-1 divide-y divide-border/50 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {STATES.map((st) => {
          const s = resolveState(st.key);
          return (
            <div key={st.key} className="bg-card px-4 py-4">
              <div className="mb-2.5 flex items-center gap-1.5">
                <Dot active={st.key === "ready"} />
                <span className="font-mono text-[9.5px] uppercase tracking-wider text-muted-foreground">
                  {st.caption}
                </span>
              </div>
              <div className="flex min-h-9 items-center justify-end">{design.render(s)}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Theme toggle — the real surface is dark, but verify both since tokens flip.
// ---------------------------------------------------------------------------

function useDocumentTheme(): [boolean, () => void] {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    // The app applies `.dark` to BOTH <html> and <body> (index.html), and a
    // `.dark` ancestor re-scopes the tokens — so both must flip together.
    const els = [document.documentElement, document.body];
    for (const el of els) el.classList.toggle("dark", dark);
    // Restore the app default (dark) when leaving the dev route.
    return () => {
      for (const el of els) el.classList.add("dark");
    };
  }, [dark]);
  return [dark, () => setDark((d) => !d)];
}

type TabKey = "approve" | "cluster";
const TABS: { key: TabKey; label: string }[] = [
  { key: "approve", label: "Approve button" },
  { key: "cluster", label: "Full cluster" },
];

export function OcrToolbarGallery() {
  const [dark, toggleTheme] = useDocumentTheme();
  const [tab, setTab] = useState<TabKey>("approve");

  return (
    <div className="h-screen overflow-y-auto bg-background text-foreground">
      <div className="mx-auto max-w-[920px] px-6 py-8">
        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-[20px] font-bold">OCR Toolbar — redesign candidates</h1>
            <p className="mt-1 max-w-2xl text-[13px] text-muted-foreground">
              Dev route (<code className="font-mono">?view=ocr-toolbar-gallery</code>). The{" "}
              <span className="font-semibold text-foreground">Approve button</span> tab isolates the
              button itself (colour / fill / shape / icon / count); the{" "}
              <span className="font-semibold text-foreground">Full cluster</span> tab shows whole-bar
              layouts. Every design is shown ready / gated / submitting; counts pluralize. Token-only,
              so the winner lifts straight into <code className="font-mono">OcrReviewPane.tsx</code>.
            </p>
          </div>
          <button
            type="button"
            onClick={toggleTheme}
            aria-pressed={!dark}
            aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border/70 bg-card px-2.5 text-xs font-medium text-muted-foreground",
              "transition-colors duration-150 hover:bg-secondary hover:text-foreground",
              FOCUS_RING,
            )}
          >
            {dark ? <Sun className="h-3.5 w-3.5 shrink-0" aria-hidden /> : <Moon className="h-3.5 w-3.5 shrink-0" aria-hidden />}
            {dark ? "Light" : "Dark"}
          </button>
        </header>

        <div role="tablist" className="mb-6 flex items-center gap-1 border-b border-border/60">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "relative -mb-px border-b-2 px-3.5 py-2 text-[13px] font-medium transition-colors",
                tab === t.key
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
                FOCUS_RING,
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "approve" && (
          <div className="space-y-3">
            <p className="mb-1 max-w-2xl text-[12.5px] leading-relaxed text-muted-foreground">
              Just the button, three states each. The default filled fill (#1) is the one to beat —
              the alternatives lean on green <code className="font-mono">success</code> (reads as
              &ldquo;confirm&rdquo;), softer tints, outline, pill shapes, and quieter count
              treatments. Pick one — or mix (e.g. &ldquo;#3 in a pill&rdquo;).
            </p>
            {APPROVE_DESIGNS.map((d) => (
              <ApproveDesignBlock key={d.id} design={d} />
            ))}
          </div>
        )}

        {tab === "cluster" && (
          <div className="space-y-9">
            {VARIANTS.map((v) => (
              <VariantBlock key={v.id} variant={v} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
