import type { PriorRunSummary } from "@/components/shared/types";

interface DuplicateBannerProps {
  priorRuns: PriorRunSummary[];
}

export function DuplicateBanner({ priorRuns }: DuplicateBannerProps) {
  if (priorRuns.length === 0) return null;
  return (
    <div className="rounded border border-warning/40 bg-warning/10 p-3 text-sm">
      <div className="font-medium text-foreground mb-1">
        This PDF was uploaded before
      </div>
      <ul className="space-y-1 text-muted-foreground">
        {priorRuns.map((r) => (
          <li key={`${r.sessionId}#${r.runId}`}>
            <span className="font-mono">{r.startedAt.slice(0, 10)}</span>
            {" — "}
            <span className="font-mono">{r.runId.slice(0, 8)}</span>
            {" reached "}
            <span className="font-medium">{r.terminalStep || r.status}</span>
            {r.ticketNumber && (
              <>
                {", ticket "}
                <span className="font-mono">{r.ticketNumber}</span>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-2 text-muted-foreground text-xs">
        You can still upload — this is just a heads-up.
      </div>
    </div>
  );
}
