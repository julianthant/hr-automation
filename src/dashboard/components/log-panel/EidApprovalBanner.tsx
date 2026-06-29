import { useState } from "react";
import { UserRoundSearch, Check, ArrowRight } from "lucide-react";
import { toast } from "@/lib/notify";
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "@/components/shared/types";

/**
 * EID-approval review banner — shown at the top of the LogPanel when a
 * separations run PAUSED because identity-check resolved a DIFFERENT EID by name
 * (`data.eidApproval === "pending"`). The operator picks which person to
 * separate: the EID on the Kuali form (original), the name-matched EID
 * (proposed), or a manually-entered one — each re-queues the doc as a fresh,
 * gate-skipping run via POST /api/separations/approve-eid. "Dismiss" stamps the
 * row dismissed (no re-queue) via POST /api/separations/dismiss-eid.
 *
 * The banner disappears on the next SSE update: an approve re-run supersedes the
 * paused row, and a dismiss flips `eidApproval` to `"dismissed"`.
 */
interface EidApprovalBannerProps {
  entry: TrackerEntry;
  workflow: string;
  date: string;
}

interface Candidate {
  kind: "original" | "proposed";
  label: string;
  eid: string;
  name: string;
  found: boolean;
  detail: string;
}

function candidateDetail(dept?: string, title?: string): string {
  return [title, dept].filter((s) => s && s.trim().length > 0).join(" · ");
}

export function EidApprovalBanner({ entry, workflow, date }: EidApprovalBannerProps) {
  const d = entry.data ?? {};
  const id = entry.id;
  const runId = entry.runId ?? undefined;
  const [pending, setPending] = useState<string | null>(null);
  const [manualEid, setManualEid] = useState("");

  const originalEid = d.originalEid ?? "";
  const proposedEid = d.proposedEid ?? "";
  const originalFound = d.originalEidFound === "true";

  const candidates: Candidate[] = [
    {
      kind: "original",
      label: "On the Kuali form",
      eid: originalEid,
      name: originalFound ? (d.originalEidName ?? "") : "",
      found: originalFound,
      detail: candidateDetail(d.originalEidDepartment, d.originalEidPayrollTitle),
    },
    {
      kind: "proposed",
      label: "Name match (proposed)",
      eid: proposedEid,
      name: d.proposedEidName ?? "",
      found: true,
      detail: candidateDetail(d.proposedEidDepartment, d.proposedEidPayrollTitle),
    },
  ];

  async function post(url: string, body: Record<string, unknown>, busyKey: string, okMsg: string) {
    if (pending) return;
    setPending(busyKey);
    const t = toast.loading("Working…");
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && json.ok !== false) {
        toast.success(okMsg, { id: t, description: id });
      } else {
        toast.error("Couldn't complete", { id: t, description: json.error ?? `HTTP ${res.status}` });
      }
    } catch (err) {
      toast.error("Couldn't complete", { id: t, description: err instanceof Error ? err.message : String(err) });
    } finally {
      setPending(null);
    }
  }

  const approve = (eid: string, busyKey: string) =>
    post("/api/separations/approve-eid", { workflow, id, runId, eid, date }, busyKey,
      `Re-queued with EID ${eid}`);

  const dismiss = () =>
    post("/api/separations/dismiss-eid", { workflow, id, runId, date }, "dismiss",
      "Dismissed — fix the Kuali form, then re-run");

  const manualValid = /^\d{8}$/.test(manualEid.trim());

  return (
    <div
      className="rounded-lg border border-warning/40 bg-warning/10 p-3"
      role="region"
      aria-label="EID approval review"
    >
      <div className="flex items-start gap-2.5">
        <UserRoundSearch aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-warning">Identity needs approval</p>
          <p className="mt-0.5 text-[12.5px] leading-snug text-foreground/80">
            Identity-check resolved a <span className="font-medium text-foreground">different EID</span> for
            the name on the Kuali form, so it paused instead of submitting a termination. Pick which person
            to separate — the queue kept processing other docs.
          </p>
        </div>
      </div>

      {/* Candidate cards */}
      <div className="mt-3 grid gap-2 sm:grid-cols-2" aria-live="polite">
        {candidates.map((c) => {
          const busyKey = `approve:${c.kind}`;
          const disabled = pending !== null || !/^\d{8}$/.test(c.eid);
          return (
            <div
              key={c.kind}
              className={cn(
                "flex flex-col gap-2 rounded-md border bg-card p-2.5",
                c.kind === "proposed" ? "border-info/40" : "border-border",
              )}
            >
              <div className="min-w-0">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{c.label}</span>
                <p className="mt-0.5 font-mono text-[13px] font-semibold text-foreground">{c.eid || "—"}</p>
                <p className="truncate text-[12.5px] text-foreground/90">
                  {c.found ? (c.name || "—") : <span className="text-muted-foreground">not found in UCPath</span>}
                </p>
                {c.detail && <p className="truncate text-[11.5px] text-muted-foreground">{c.detail}</p>}
              </div>
              <button
                type="button"
                disabled={disabled}
                onClick={() => approve(c.eid, busyKey)}
                className={cn(
                  "inline-flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                  c.kind === "proposed"
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "border border-border bg-secondary text-foreground hover:bg-secondary/70",
                )}
              >
                <Check aria-hidden className="h-3.5 w-3.5" />
                {pending === busyKey ? "Re-queuing…" : "Use this EID"}
              </button>
            </div>
          );
        })}
      </div>

      {/* Manual entry + dismiss */}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <label htmlFor="eid-approval-manual" className="text-[12px] text-muted-foreground">
          Or enter a different EID:
        </label>
        <input
          id="eid-approval-manual"
          inputMode="numeric"
          value={manualEid}
          onChange={(e) => setManualEid(e.target.value.replace(/\D/g, "").slice(0, 8))}
          placeholder="8-digit EID"
          aria-label="Enter a different EID to approve"
          className={cn(
            "h-7 w-32 rounded-md border border-border bg-background px-2 font-mono text-[12.5px] text-foreground",
            "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        />
        <button
          type="button"
          disabled={pending !== null || !manualValid}
          onClick={() => approve(manualEid.trim(), "approve:manual")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-1.5 text-[12px] font-medium text-foreground",
            "hover:bg-secondary/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
          )}
        >
          {pending === "approve:manual" ? "Re-queuing…" : "Use entered EID"}
          <ArrowRight aria-hidden className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled={pending !== null}
          onClick={dismiss}
          className={cn(
            "ml-auto rounded-md px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground",
            "hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
          )}
        >
          {pending === "dismiss" ? "Dismissing…" : "Dismiss"}
        </button>
      </div>
    </div>
  );
}
