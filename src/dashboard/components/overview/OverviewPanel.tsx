import { useMemo } from "react";
import { LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";
import { useWorkflows, autoLabel } from "@/lib/workflows-context";

interface OverviewPanelProps {
  /** SSE-discovered workflow names. */
  workflows: string[];
  /** Per-workflow total queue count for the selected date (rail badge source). */
  wfCounts: Record<string, number>;
  /** Per-workflow failure count for the selected date. */
  failureCounts: Record<string, number>;
  /** Selected tracker date (YYYY-MM-DD). */
  date: string;
  /** Drill into a workflow's queue. */
  onPick: (workflow: string) => void;
}

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: "default" | "failed" | "ok" | "review";
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 font-mono text-2xl font-bold tabular-nums",
          tone === "failed" && "text-destructive",
          tone === "ok" && "text-success",
          tone === "review" && "text-warning",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

/**
 * Cross-workflow landing view. Built only from the data the entries payload
 * already carries for the selected date — per-workflow totals (`wfCounts`) and
 * failures (`failureCounts`); it does not invent done/active splits the backend
 * doesn't expose. Clicking a row drills into that workflow's queue.
 */
export function OverviewPanel({
  workflows,
  wfCounts,
  failureCounts,
  date,
  onPick,
}: OverviewPanelProps) {
  const registered = useWorkflows();
  const labelFor = (wf: string): string =>
    registered.find((r) => r.name === wf)?.label ?? autoLabel(wf);

  const rows = useMemo(() => {
    return workflows
      .map((wf) => {
        const total = wfCounts[wf] ?? 0;
        const failed = failureCounts[wf] ?? 0;
        return { wf, total, failed, ok: Math.max(0, total - failed) };
      })
      .filter((r) => r.total > 0 || r.failed > 0)
      .sort((a, b) => b.total - a.total || b.failed - a.failed);
  }, [workflows, wfCounts, failureCounts]);

  const totalRuns = rows.reduce((s, r) => s + r.total, 0);
  const totalFailed = rows.reduce((s, r) => s + r.failed, 0);
  const activeWorkflows = rows.length;
  const okRate = totalRuns > 0 ? Math.round(((totalRuns - totalFailed) / totalRuns) * 100) : 100;

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-background p-6">
      <div className="mb-1 flex items-center gap-2">
        <LayoutGrid aria-hidden className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-[15px] font-semibold">Overview</h1>
        <span className="font-mono text-[12px] text-muted-foreground">· {date}</span>
      </div>
      <p className="mb-5 text-[12.5px] text-muted-foreground">
        Every workflow at a glance for the selected day. Click a row to open its queue.
      </p>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Runs" value={totalRuns} sub={`across ${activeWorkflows} workflows`} />
        <StatCard label="Failed" value={totalFailed} tone="failed" sub={totalFailed === 0 ? "all clear" : "needs attention"} />
        <StatCard label="Workflows active" value={activeWorkflows} />
        <StatCard label="Non-failed rate" value={`${okRate}%`} tone={okRate >= 90 ? "ok" : "review"} />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-10 text-center text-[13px] text-muted-foreground">
          No runs on {date}.
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="bg-card/60">
                {["Workflow", "Runs", "Failed", "Health"].map((h) => (
                  <th
                    key={h}
                    className="border-b border-border px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const okPct = r.total > 0 ? (r.ok / r.total) * 100 : 100;
                return (
                  <tr
                    key={r.wf}
                    role="button"
                    tabIndex={0}
                    onClick={() => onPick(r.wf)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onPick(r.wf);
                      }
                    }}
                    className="cursor-pointer border-b border-border last:border-0 outline-none transition-colors hover:bg-secondary focus-visible:bg-secondary"
                  >
                    <td className="px-4 py-3 font-semibold text-foreground">{labelFor(r.wf)}</td>
                    <td className="px-4 py-3 font-mono tabular-nums">{r.total}</td>
                    <td
                      className={cn(
                        "px-4 py-3 font-mono tabular-nums",
                        r.failed > 0 ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {r.failed}
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex h-1.5 w-[140px] overflow-hidden rounded-full bg-accent align-middle">
                        <span
                          className={cn("h-full", r.failed > 0 ? "bg-warning" : "bg-success")}
                          style={{ width: `${okPct}%` }}
                        />
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
