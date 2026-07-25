import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * DEV-ONLY (UI gallery "Proposals" tab). Toggle state for the queue-row /
 * log-panel enrichment proposals so each proposal can be flipped on/off live
 * and compared against today's rendering. Nothing here ships to the real
 * dashboard surfaces.
 */

export type ProposalKey =
  | "p1" // outcome facts
  | "p2" // micro step-pipeline
  | "p3" // warnings on the row
  | "p4" // gate reason on waiting rows
  | "p5" // attempt chip / retry lineage
  | "p6" // evidence (receipt shield / screenshot count)
  | "p7" // queue-wait + waiting-duration
  | "p8" // live OCR phase on coordinators
  | "v1" // rejected member row treatment
  | "v2" // write-parked row treatment
  | "v3" // attention bands
  | "v4" // day digest strip
  | "l1" // structured chips on log lines
  | "l2" // step-grouped stream
  | "l3" // step-strip hover detail
  | "l4" // data provenance inline
  | "l5"; // event cards in-stream

interface ToggleSpec {
  key: ProposalKey;
  label: string;
}

export const PROPOSAL_GROUPS: { title: string; toggles: ToggleSpec[] }[] = [
  {
    title: "Row content",
    toggles: [
      { key: "p1", label: "P1 outcome facts" },
      { key: "p2", label: "P2 micro-pipeline" },
      { key: "p3", label: "P3 warnings" },
      { key: "p4", label: "P4 gate reason" },
      { key: "p5", label: "P5 attempt chip" },
      { key: "p6", label: "P6 evidence" },
      { key: "p7", label: "P7 queue-wait" },
      { key: "p8", label: "P8 OCR phase" },
    ],
  },
  {
    title: "Variants & organization",
    toggles: [
      { key: "v1", label: "V1 rejected member" },
      { key: "v2", label: "V2 write-parked" },
      { key: "v3", label: "V3 attention bands" },
      { key: "v4", label: "V4 day digest" },
    ],
  },
  {
    title: "Log panel",
    toggles: [
      { key: "l1", label: "L1 structured chips" },
      { key: "l2", label: "L2 step grouping" },
      { key: "l3", label: "L3 strip hover" },
      { key: "l4", label: "L4 data pills" },
      { key: "l5", label: "L5 event cards" },
    ],
  },
];

const ALL_KEYS = PROPOSAL_GROUPS.flatMap((g) => g.toggles.map((t) => t.key));

interface ProposalToggleState {
  /** Is this proposal currently enabled? */
  on: (key: ProposalKey) => boolean;
  toggle: (key: ProposalKey) => void;
  setAll: (enabled: boolean) => void;
}

const ProposalTogglesContext = createContext<ProposalToggleState | null>(null);

export function useProposals(): ProposalToggleState {
  const ctx = useContext(ProposalTogglesContext);
  if (!ctx) throw new Error("useProposals must be used inside ProposalTogglesProvider");
  return ctx;
}

export function ProposalTogglesProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabled] = useState<Set<ProposalKey>>(() => new Set(ALL_KEYS));
  const value = useMemo<ProposalToggleState>(
    () => ({
      on: (key) => enabled.has(key),
      toggle: (key) =>
        setEnabled((prev) => {
          const next = new Set(prev);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        }),
      setAll: (on) => setEnabled(on ? new Set(ALL_KEYS) : new Set()),
    }),
    [enabled],
  );
  return <ProposalTogglesContext.Provider value={value}>{children}</ProposalTogglesContext.Provider>;
}

export function ProposalToggleBar() {
  const { on, toggle, setAll } = useProposals();
  return (
    <div className="sticky top-0 z-30 -mx-1 mb-5 rounded-lg border border-border/60 bg-background/95 px-3 py-2.5 backdrop-blur">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2">
        {PROPOSAL_GROUPS.map((group) => (
          <div key={group.title} className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.title}
            </span>
            <div className="flex flex-wrap gap-1">
              {group.toggles.map((t) => {
                const active = on(t.key);
                return (
                  <button
                    key={t.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggle(t.key)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors outline-none",
                      "focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "border-info/45 bg-info/10 text-foreground"
                        : "border-border bg-card text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 rounded-full",
                        active ? "bg-info" : "border border-muted-foreground",
                      )}
                    />
                    {t.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <div className="ml-auto flex gap-1.5 self-start">
          <button
            type="button"
            onClick={() => setAll(false)}
            className="rounded-md border border-border bg-card px-3 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring outline-none"
          >
            Today&apos;s dashboard
          </button>
          <button
            type="button"
            onClick={() => setAll(true)}
            className="rounded-md border border-primary bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring outline-none"
          >
            All proposals
          </button>
        </div>
      </div>
    </div>
  );
}
