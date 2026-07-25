import type { ReactNode } from "react";
import type { TrackerEntry } from "@/components/shared/types";
import { EntryItem } from "@/components/queue-panel/EntryItem";
import { buildWorkflowRunProjection } from "../../../../domain/workflow-runtime/projection.js";
import {
  FactChip,
  FactRow,
  mockRowActions,
  ProposedRow,
  ReceiptShield,
  ScreenshotCountChip,
  AttemptChip,
  SubLine,
} from "./proposal-rows";
import { ProposedQueue } from "./proposal-rows";
import { ProposalLogPanel } from "./ProposalLogPanel";
import { ProposalToggleBar, ProposalTogglesProvider } from "./proposal-toggles";

/**
 * DEV-ONLY — UI gallery "Proposals" tab.
 *
 * The queue-row / log-panel data-enrichment proposals rendered in the real
 * skin: the assembled proposed queue (left) beside the enriched Log Panel
 * (right), before/after cells against today's real `EntryItem`, and a ledger
 * naming each proposal's data source. Toggle any proposal off to see today's
 * rendering of that slot; "Today's dashboard" turns everything off.
 *
 * Proposal keys map to docs/rebuild follow-ups: P* = row content, V* = row
 * variants/organization, L* = log panel. See the session artifact
 * "Queue Row & Log Panel Enrichment — Proposals" for the full write-up.
 */

const DATE = "2026-07-24";
const NOOP = () => {};
const EMPTY_DISPLAY_NAMES = new Map<string, string>();

function entry(partial: Partial<TrackerEntry> & { id: string }): TrackerEntry {
  return {
    workflow: "onboarding",
    timestamp: "2026-07-24T18:42:00.000Z",
    status: "done",
    _hash: partial.id,
    ...partial,
  };
}

const todayDone = entry({
  id: "cmp-done",
  status: "done",
  firstLogTs: "2026-07-24T18:42:03.000Z",
  lastLogTs: "2026-07-24T18:48:44.000Z",
  runOrdinal: 2,
  data: {
    archetype: "single",
    queueRowKind: "person",
    name: "Jordan Whitfield",
    emplId: "10633092",
    __traceId: "on-114203-4f9b",
  },
});

const todayFailed = entry({
  id: "cmp-failed",
  workflow: "crm-doc-download",
  status: "failed",
  firstLogTs: "2026-07-24T20:12:02.000Z",
  lastLogTs: "2026-07-24T20:12:50.000Z",
  error: "CRM search returned no record for samuel.ortiz@ucsd.edu — download step never reached",
  runOrdinal: 9,
  data: {
    archetype: "single",
    queueRowKind: "person",
    name: "Samuel Ortiz",
    __traceId: "cd-131202-5e19",
  },
});

function Cell({ label, note, children, width = 470 }: { label: string; note?: string; children: ReactNode; width?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border/60 bg-card/30">
      <div className="border-b border-border/60 bg-secondary/20 px-3 py-2">
        <div className="text-[13px] font-semibold text-foreground">{label}</div>
        {note && <div className="mt-0.5 text-[10.5px] text-muted-foreground/80">{note}</div>}
      </div>
      <div className="pb-2" style={{ width: `min(100%, ${width}px)` }}>
        {children}
      </div>
    </div>
  );
}

function SectionHead({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="col-span-full mt-8 first:mt-0">
      <h2 className="text-[16px] font-bold text-foreground">{title}</h2>
      <p className="mt-0.5 max-w-[90ch] text-[12px] text-muted-foreground">{sub}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ledger — every proposal, what it adds, where the data comes from.
// ---------------------------------------------------------------------------

type SourceTag = "render-only" | "wire addition" | "new stamp";

const TAG_CLASS: Record<SourceTag, string> = {
  "render-only": "bg-success/12 text-success",
  "wire addition": "bg-info/12 text-info",
  "new stamp": "bg-warning/12 text-warning",
};

const LEDGER: { code: string; title: string; tag: SourceTag; note: string }[] = [
  {
    code: "P1",
    title: "Outcome facts",
    tag: "wire addition",
    note: "2–4 workflow-declared headline fields as chips once terminal (wage/effective/txn, ticket/signers, pay rule before→after, I-9 sections). Data already in data.* per workflow; needs a rowFacts declaration + facts[] on QueueSurfaceWire.",
  },
  {
    code: "P2",
    title: "Micro step-pipeline",
    tag: "render-only",
    note: "Tiny step segments beside the badge; hover names steps + durations. The ratified wire already carries pipeline[] with per-step state/durationMs; stepDurations is recorded today.",
  },
  {
    code: "P3",
    title: "Warnings on the row",
    tag: "wire addition",
    note: "Amber count chip + first warning as a chip for Done-with-warnings (OCR record warnings, onbase keyset fallback, EC fuzzy demote, I-9 retention notes). Needs a normalized warnings {count, first} on the wire.",
  },
  {
    code: "P4",
    title: "Gate reason on waiting rows",
    tag: "render-only",
    note: "State the open gate in one line (identity mismatch with both candidates) + a Review jump. gates[] + the identity-approval pause fields are already stamped; add a human label per gate.",
  },
  {
    code: "P5",
    title: "Attempt chip + lineage",
    tag: "new stamp",
    note: "attempt N chip + prior-attempt line. A retry is a brand-new run today with nothing recording the link — needs retryOfRunId stamped at retry-enqueue.",
  },
  {
    code: "P6",
    title: "Evidence at a glance",
    tag: "render-only",
    note: "Receipt shield on Verified done (hover: what was read back); screenshot-count chip on failures. evidence{} is on the ratified wire; screenshotCount exists today with zero readers.",
  },
  {
    code: "P7",
    title: "Queue-wait & waiting-duration",
    tag: "render-only",
    note: "Queued rows show time-in-queue + position; waiting/parked rows show amber waiting-duration instead of neutral elapsed. enqueuedAt/startedAt/endedAt are first-class on the wire.",
  },
  {
    code: "P8",
    title: "Live OCR phase on coordinators",
    tag: "render-only",
    note: "“Matching people 6/8” instead of the static “OCR review” label — data.ocrStep is denormalized onto the coordinator today and never rendered.",
  },
  {
    code: "V1",
    title: "Rejected member row",
    tag: "render-only",
    note: "The ratified D3 delete-only member gets a distinct muted/italic identity with the rejection reason as its title, and its own segment in the group rollup.",
  },
  {
    code: "V2",
    title: "Write-parked row",
    tag: "render-only",
    note: "Doc-09 parked writes get a violet identity: which system + which staged write, a Resume affordance, parked-duration. Distinct from amber Waiting on you.",
  },
  {
    code: "V3",
    title: "Attention bands",
    tag: "render-only",
    note: "Queue groups into Needs you · Active · Queued · Finished today, Needs-you pinned on top. Pure projection over the 8 ratified statuses; flat list + filters remain.",
  },
  {
    code: "V4",
    title: "Day digest strip",
    tag: "render-only",
    note: "One dashed summary line atop Finished: counts by outcome + a couple of aggregates. Optional garnish — cut first if it reads as noise.",
  },
  {
    code: "L1",
    title: "Structured chips on log lines",
    tag: "render-only",
    note: "System badges, step durations, attempt markers, real category — all fields the emitter writes and the SSE wire transmits, which the client LogEntry type currently discards.",
  },
  {
    code: "L2",
    title: "Step-grouped stream",
    tag: "render-only",
    note: "Sticky collapsible step dividers mirroring the strip; strip-chip click scrolls to the section. Driven by each line's structured step field.",
  },
  {
    code: "L3",
    title: "Step-strip hover detail",
    tag: "render-only",
    note: "The already-ratified hover made concrete: status, duration, attempts, key data lines, step-screenshot link.",
  },
  {
    code: "L4",
    title: "Data provenance inline",
    tag: "render-only",
    note: "Read (cyan) / write (teal) pills where they happened, incl. “on resume this will write…” for parked runs. The existing ctx.recordData data:point lines, today visible only in the Data tab.",
  },
  {
    code: "L5",
    title: "Event cards in-stream",
    tag: "render-only",
    note: "Gate opening + step failure render as cards at their point in the timeline (identity candidates + actions; classified error + screenshot + what happened next) instead of a detached top banner.",
  },
];

function Ledger() {
  return (
    <div className="col-span-full mt-2 overflow-hidden rounded-lg border border-border/60">
      {LEDGER.map((item) => (
        <div key={item.code} className="flex gap-3 border-t border-border/40 bg-card/30 px-3.5 py-2.5 first:border-t-0">
          <span className="w-7 shrink-0 font-mono text-[12px] font-semibold text-info">{item.code}</span>
          <div className="min-w-0">
            <div className="text-[12.5px] font-semibold text-foreground">
              {item.title}
              <span className={`ml-2 rounded px-1.5 py-px align-[1px] text-[9.5px] font-semibold ${TAG_CLASS[item.tag]}`}>
                {item.tag}
              </span>
            </div>
            <p className="mt-0.5 max-w-[100ch] text-[11.5px] leading-relaxed text-muted-foreground">{item.note}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ProposalsTab() {
  return (
    <ProposalTogglesProvider>
      <ProposalToggleBar />

      <div className="grid grid-cols-1 items-start gap-4 min-[1080px]:grid-cols-[470px_minmax(0,1fr)]">
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-[12px] text-muted-foreground">
            <span className="text-[13px] font-semibold text-foreground">Queue</span>· proposed day view · Jul 24
          </div>
          <ProposedQueue />
        </div>
        <ProposalLogPanel />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 min-[980px]:grid-cols-2">
        <SectionHead
          title="Before / after"
          sub="Today's REAL EntryItem (top) against the proposed row (bottom) for the same run — same card chrome, same footer contract; only the content slots change."
        />
        <Cell label="Terminal row — today" note="real EntryItem · the outcome lives only in the log panel">
          <EntryItem
            entry={todayDone}
            projection={buildWorkflowRunProjection(todayDone, {})}
            displayNames={EMPTY_DISPLAY_NAMES}
            selected={false}
            onSelect={NOOP}
            date={DATE}
            onDelete={NOOP}
          />
        </Cell>
        <Cell label="Terminal row — proposed" note="P1 facts + P6 receipt shield + Verified done label">
          <ProposedRow
            id="cmp-done-proposed"
            status="verifiedDone"
            title="Jordan Whitfield"
            headerChips={<ReceiptShield title="Receipt — UCPath read-back verified · TXN-0891245" />}
            footer={{
              time: "11:42 AM",
              runNumber: 2,
              secondaryId: "on-114203-4f9b",
              duration: "6m 41s",
              actions: mockRowActions(["retry", "delete"]),
            }}
          >
            <FactRow>
              <FactChip label="wage" value="$18.50/hr" />
              <FactChip label="effective" value="07/01" />
              <FactChip label="dept" value="000482" />
              <FactChip label="txn" value="TXN-0891245" />
            </FactRow>
          </ProposedRow>
        </Cell>
        <Cell label="Failed row — today" note="real EntryItem · no attempt lineage, no screenshot affordance">
          <EntryItem
            entry={todayFailed}
            projection={buildWorkflowRunProjection(todayFailed, {})}
            displayNames={EMPTY_DISPLAY_NAMES}
            selected={false}
            onSelect={NOOP}
            date={DATE}
            onDelete={NOOP}
          />
        </Cell>
        <Cell label="Failed row — proposed" note="P5 attempt chip + prior-attempt line + P6 screenshot count">
          <ProposedRow
            id="cmp-failed-proposed"
            status="failed"
            title="Samuel Ortiz"
            headerChips={
              <>
                <AttemptChip n={2} title="Attempt 1 failed 12:58 PM (timeout) · this is the retry" />
                <ScreenshotCountChip count={3} />
              </>
            }
            footer={{
              time: "1:12 PM",
              runNumber: 9,
              secondaryId: "cd-131202-5e19",
              duration: "48s",
              actions: mockRowActions(["retry", "delete"]),
            }}
          >
            <SubLine tone="destructive">
              CRM search returned no record for samuel.ortiz@ucsd.edu — download step never reached
            </SubLine>
          </ProposedRow>
        </Cell>
      </div>

      <div className="grid grid-cols-1">
        <SectionHead
          title="Ledger — what each toggle adds, and where the data comes from"
          sub="render-only = the field already reaches the dashboard and is simply not shown · wire addition = a small field on the ratified QueueSurfaceWire / log wire · new stamp = the workflow layer must record something it currently doesn't."
        />
        <Ledger />
        <div className="mt-4 rounded-lg border border-border/60 bg-card/30 px-4 py-3">
          <h3 className="text-[12.5px] font-semibold text-warning">Correctness fixes worth doing regardless</h3>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[12px] text-secondary-foreground">
            <li>
              The client <span className="font-mono text-[11px]">LogEntry</span> type drops every structured field the
              server sends (system, step, attempt, durationMs, category, event) — widen it; prerequisite for L1/L2.
            </li>
            <li>
              The client duplicate-collapse overwrites the server-emitted{" "}
              <span className="font-mono text-[11px]">count</span> field with its own dedup counter — use a separate
              client field.
            </li>
            <li>
              Log categories are regex-guessed from message text while the emitter&apos;s real{" "}
              <span className="font-mono text-[11px]">category</span> rides the same payload — switch to the structured
              field.
            </li>
            <li>
              <span className="font-mono text-[11px]">screenshotCount</span> is declared on the tracker entry and read
              by nothing — surface it (P6) or delete it.
            </li>
          </ul>
        </div>
      </div>
    </ProposalTogglesProvider>
  );
}
