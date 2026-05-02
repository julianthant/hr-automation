import type { PriorRunSummary } from "../types";

interface DuplicateBannerProps {
  priorRuns: PriorRunSummary[];
}

export function DuplicateBanner({ priorRuns }: DuplicateBannerProps) {
  if (priorRuns.length === 0) return null;
  return (
    <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/40">
      <div className="font-medium text-amber-900 dark:text-amber-200 mb-1">
        This PDF was uploaded before
      </div>
      <ul className="space-y-1 text-amber-800 dark:text-amber-300">
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
      <div className="mt-2 text-amber-700 dark:text-amber-400 text-xs">
        You can still upload — this is just a heads-up.
      </div>
    </div>
  );
}
