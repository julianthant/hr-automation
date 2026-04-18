/**
 * RunnerDrawer — slide-in panel for launching workflows from the dashboard.
 *
 * Aesthetic: mission-control HUD. Instrument Serif italic title, Geist Mono
 * everywhere else, single amber accent (#F59E0B) for the ENGAGE CTA. Drawer
 * slides from the right at 320ms with a deceleration curve; backdrop fades
 * with a backdrop-blur. See `index.css` for the full motion + palette spec.
 *
 * Three states:
 *   1. Idle — workflow picker visible, no form.
 *   2. Composing — workflow chosen, schema-driven form rendered.
 *   3. Engaged — POST /api/workflows/:name/run returned a runId; CANCEL pill
 *      replaces the ENGAGE button. Operator can cancel before the drawer
 *      closes.
 */

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Activity, RotateCcw, X, Zap } from "lucide-react";
import { toast } from "sonner";
import { useWorkflows } from "../workflows-context";
import { ARGV_NAMES, recallRecent, rememberRecent, type RecentEntry } from "@/lib/runner-recents";
import {
  SchemaForm,
  buildInitialFormValue,
} from "./SchemaForm";
import {
  pruneEmpty,
  type JsonSchema,
} from "@/lib/schema-form-utils";
import { cn } from "@/lib/utils";

// ── Types + state machine ─────────────────────────────────

type PanelState =
  | { kind: "idle" }
  | { kind: "loading-schema"; workflow: string }
  | { kind: "schema-error"; workflow: string; message: string }
  | { kind: "cli-only"; workflow: string }
  | { kind: "composing"; workflow: string; schema: JsonSchema; value: Record<string, unknown> }
  | { kind: "spawning"; workflow: string; schema: JsonSchema; value: Record<string, unknown> }
  | { kind: "engaged"; workflow: string; runId: string; pid: number };

interface RunnerDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Called with workflow + runId when a spawn succeeds — caller can switch the dashboard view. */
  onSpawned?: (workflow: string, runId: string) => void;
}

// ── Component ─────────────────────────────────────────────

export function RunnerDrawer({ open, onClose, onSpawned }: RunnerDrawerProps) {
  const workflows = useWorkflows();
  const [panel, setPanel] = useState<PanelState>({ kind: "idle" });
  const [dryRun, setDryRun] = useState(false);
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  // Animate the exit before unmounting — use a sub-state so the slide-out
  // animation runs to completion before the drawer is removed from the DOM.
  const [visible, setVisible] = useState(open);
  const [closing, setClosing] = useState(false);

  // ── Open/close lifecycle ──
  useEffect(() => {
    if (open) {
      setVisible(true);
      setClosing(false);
    } else if (visible) {
      setClosing(true);
      const t = setTimeout(() => {
        setVisible(false);
        setClosing(false);
        // Reset panel state on full close so the next open starts fresh.
        setPanel({ kind: "idle" });
        setDryRun(false);
      }, 230);
      return () => clearTimeout(t);
    }
  }, [open, visible]);

  // ── Esc-to-close ──
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, onClose]);

  // Refresh recents whenever the panel changes workflow.
  useEffect(() => {
    if (panel.kind === "composing" || panel.kind === "loading-schema") {
      setRecents(recallRecent(panel.workflow));
    }
  }, [panel]);

  // Filter the workflow picker to ones we know how to launch.
  const launchable = useMemo(
    () => workflows.filter((w) => ARGV_NAMES.has(w.name)),
    [workflows],
  );
  const cliOnly = useMemo(
    () => workflows.filter((w) => !ARGV_NAMES.has(w.name)),
    [workflows],
  );

  // ── Handlers ──

  const pickWorkflow = async (name: string) => {
    if (!ARGV_NAMES.has(name)) {
      setPanel({ kind: "cli-only", workflow: name });
      return;
    }
    setPanel({ kind: "loading-schema", workflow: name });
    try {
      const r = await fetch(`/api/workflows/${encodeURIComponent(name)}/schema`);
      if (r.status === 404) {
        const body = await r.json().catch(() => ({}));
        setPanel({
          kind: "schema-error",
          workflow: name,
          message: body.error || "Schema not found. Run npm run schemas:export.",
        });
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const schema = (await r.json()) as JsonSchema;
      setPanel({
        kind: "composing",
        workflow: name,
        schema,
        value: buildInitialFormValue(schema),
      });
    } catch (err) {
      setPanel({
        kind: "schema-error",
        workflow: name,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const recallRecentRun = (workflow: string, recent: RecentEntry) => {
    if (panel.kind !== "composing" || panel.workflow !== workflow) return;
    setPanel({ ...panel, value: recent.input });
    setDryRun(recent.dryRun);
  };

  const submit = async () => {
    if (panel.kind !== "composing") return;
    const cleaned = pruneEmpty(panel.value, panel.schema) as Record<string, unknown>;
    setPanel({ kind: "spawning", workflow: panel.workflow, schema: panel.schema, value: panel.value });
    try {
      const r = await fetch(`/api/workflows/${encodeURIComponent(panel.workflow)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: cleaned, dryRun }),
      });
      const body = await r.json().catch(() => ({}));
      if (r.status === 202) {
        const { runId, pid } = body as { runId: string; pid: number };
        toast.success(`${panel.workflow} engaged`, {
          description: `runId ${runId.slice(0, 8)} · pid ${pid}`,
          duration: 4000,
        });
        rememberRecent(panel.workflow, panel.value, dryRun);
        setRecents(recallRecent(panel.workflow));
        onSpawned?.(panel.workflow, runId);
        setPanel({ kind: "engaged", workflow: panel.workflow, runId, pid });
      } else {
        const message = body?.error || `HTTP ${r.status}`;
        toast.error("Spawn rejected", { description: message, duration: 6000 });
        // Restore composing state so the operator can fix and resubmit.
        setPanel({ kind: "composing", workflow: panel.workflow, schema: panel.schema, value: panel.value });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error("Spawn failed", { description: message, duration: 6000 });
      setPanel({ kind: "composing", workflow: panel.workflow, schema: panel.schema, value: panel.value });
    }
  };

  const cancel = async () => {
    if (panel.kind !== "engaged") return;
    try {
      const r = await fetch(`/api/runs/${encodeURIComponent(panel.runId)}/cancel`, { method: "POST" });
      const { cancelled } = (await r.json()) as { cancelled: boolean };
      if (cancelled) {
        toast.success("Cancelled", { description: `runId ${panel.runId.slice(0, 8)}`, duration: 3000 });
        onClose();
      } else {
        toast.warning("Already exited", { description: "The run has already finished.", duration: 3000 });
        onClose();
      }
    } catch (err) {
      toast.error("Cancel failed", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  if (!visible) return null;

  // ── Render ──

  const labelFor = (name: string) => workflows.find((w) => w.name === name)?.label ?? name;
  const drawerStyle: CSSProperties = {
    backgroundColor: "var(--runner-bg)",
    color: "var(--runner-fg)",
    borderLeft: "1px solid var(--runner-border)",
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div
        className={cn(
          "absolute inset-0 bg-black/60 backdrop-blur-md",
          closing ? "" : "runner-backdrop-enter",
        )}
        onClick={onClose}
      />
      {/* Drawer */}
      <aside
        className={cn(
          "relative h-full w-full md:w-[480px] flex flex-col overflow-hidden",
          closing ? "runner-drawer-exit" : "runner-drawer-enter",
          "shadow-[0_0_64px_-8px_rgba(245,158,11,0.18)]",
        )}
        style={drawerStyle}
        role="dialog"
        aria-label="Workflow runner"
      >
        {/* Header */}
        <header className="relative px-6 pt-5 pb-4 border-b border-runner-border runner-scanlines">
          <div className="flex items-start justify-between">
            <div className="flex flex-col gap-1">
              <span className="font-runner-mono text-[10px] tracking-[0.32em] text-runner-accent uppercase">
                <span className="runner-status-dot mr-2 align-middle" data-state={panel.kind === "engaged" ? "running" : "idle"} />
                Console / Runner
              </span>
              <h2 className="font-runner-display text-[36px] leading-tight italic text-runner-fg tracking-tight">
                Run Workflow
              </h2>
              <p className="font-runner-mono text-[11px] text-runner-fg-muted">
                Spawn an automation. Streams to the dashboard queue.
              </p>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-[2px] text-runner-fg-muted hover:text-runner-fg hover:bg-runner-surface transition-colors"
              aria-label="Close runner"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-5">
          {/* Workflow picker — always visible */}
          <div className="flex flex-col gap-2">
            <span className="font-runner-mono text-[10px] tracking-[0.18em] text-runner-fg-muted uppercase">
              Target Workflow
            </span>
            <div className="grid grid-cols-2 gap-1.5">
              {launchable.map((w) => {
                const isActive =
                  (panel.kind === "composing" || panel.kind === "loading-schema" || panel.kind === "spawning" || panel.kind === "engaged" || panel.kind === "schema-error" || panel.kind === "cli-only") &&
                  panel.workflow === w.name;
                return (
                  <button
                    key={w.name}
                    onClick={() => pickWorkflow(w.name)}
                    className={cn(
                      "px-3 py-2 text-left border rounded-[2px] transition-colors",
                      "font-runner-mono text-[12px]",
                      isActive
                        ? "border-runner-accent bg-runner-accent/10 text-runner-fg"
                        : "border-runner-border bg-runner-surface text-runner-fg-muted hover:border-[#2A2F38] hover:text-runner-fg",
                    )}
                  >
                    {w.label}
                  </button>
                );
              })}
            </div>
            {cliOnly.length > 0 && (
              <details className="group">
                <summary className="font-runner-mono text-[10px] uppercase tracking-[0.18em] text-runner-fg-muted/70 cursor-pointer hover:text-runner-fg-muted transition-colors">
                  + {cliOnly.length} CLI-only
                </summary>
                <div className="grid grid-cols-2 gap-1.5 mt-2">
                  {cliOnly.map((w) => (
                    <button
                      key={w.name}
                      onClick={() => pickWorkflow(w.name)}
                      className="px-3 py-2 text-left border border-runner-border bg-runner-surface text-runner-fg-muted hover:text-runner-fg hover:border-[#2A2F38] transition-colors font-runner-mono text-[12px] rounded-[2px] italic"
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
              </details>
            )}
          </div>

          {/* Per-state body */}
          {panel.kind === "loading-schema" && (
            <div className="font-runner-mono text-[11px] text-runner-fg-muted italic">
              Loading {labelFor(panel.workflow)} schema…
            </div>
          )}

          {panel.kind === "schema-error" && (
            <div className="border border-[#7F1D1D]/60 bg-[#7F1D1D]/10 px-3 py-2.5 rounded-[2px]">
              <div className="font-runner-mono text-[10px] uppercase tracking-[0.18em] text-[#FCA5A5] mb-1">
                Schema unavailable
              </div>
              <div className="font-runner-mono text-[11px] text-runner-fg leading-relaxed">
                {panel.message}
              </div>
            </div>
          )}

          {panel.kind === "cli-only" && (
            <div className="border border-runner-border bg-runner-surface px-3 py-3 rounded-[2px]">
              <div className="font-runner-mono text-[10px] uppercase tracking-[0.18em] text-runner-fg-muted mb-2">
                CLI-only workflow
              </div>
              <div className="font-runner-mono text-[11px] text-runner-fg leading-relaxed">
                {labelFor(panel.workflow)} hasn't been wired into the runner yet.
                Use the terminal:
              </div>
              <code className="block mt-2 px-2 py-1.5 bg-[#0F1116] border border-runner-border rounded-[2px] font-runner-mono text-[11px] text-runner-accent">
                npm run {panel.workflow}
              </code>
            </div>
          )}

          {(panel.kind === "composing" || panel.kind === "spawning") && (
            <>
              {recents.length > 0 && (
                <div className="flex flex-col gap-2">
                  <span className="font-runner-mono text-[10px] tracking-[0.18em] text-runner-fg-muted uppercase">
                    Recent
                  </span>
                  <div className="flex flex-col gap-1">
                    {recents.map((r, i) => (
                      <button
                        key={i}
                        onClick={() => recallRecentRun(panel.workflow, r)}
                        className="flex items-center gap-2 px-3 py-2 border border-runner-border bg-runner-surface hover:border-runner-accent/50 hover:bg-runner-accent/5 transition-colors text-left rounded-[2px] group"
                      >
                        <RotateCcw className="w-3 h-3 text-runner-fg-muted group-hover:text-runner-accent transition-colors" />
                        <span className="font-runner-mono text-[11px] text-runner-fg flex-1 truncate">
                          {summarizeInput(r.input)}
                        </span>
                        {r.dryRun && (
                          <span className="font-runner-mono text-[9px] uppercase tracking-[0.18em] text-runner-accent/80">
                            dry
                          </span>
                        )}
                        <span className="font-runner-mono text-[9px] text-runner-fg-muted/60">
                          {relativeTime(r.ts)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-3.5">
                <SchemaForm
                  schema={panel.schema}
                  value={panel.value}
                  onChange={(next) => setPanel({ ...panel, kind: "composing", value: next })}
                />
              </div>
            </>
          )}

          {panel.kind === "engaged" && (
            <div className="flex flex-col gap-3 px-3 py-3 border border-runner-accent/40 bg-runner-accent/5 rounded-[2px]">
              <div className="flex items-center gap-2">
                <Activity className="w-3.5 h-3.5 text-runner-accent" />
                <span className="font-runner-mono text-[10px] uppercase tracking-[0.18em] text-runner-accent">
                  Engaged
                </span>
              </div>
              <div className="font-runner-mono text-[11px] text-runner-fg leading-relaxed">
                {labelFor(panel.workflow)} is now running. The queue panel
                shows live progress.
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[10px] font-runner-mono">
                <dt className="uppercase tracking-[0.18em] text-runner-fg-muted">Run ID</dt>
                <dd className="text-runner-fg truncate">{panel.runId}</dd>
                <dt className="uppercase tracking-[0.18em] text-runner-fg-muted">PID</dt>
                <dd className="text-runner-fg">{panel.pid}</dd>
              </dl>
            </div>
          )}
        </div>

        {/* Footer */}
        <footer className="px-6 py-4 border-t border-runner-border bg-[#0E1014]">
          {panel.kind === "engaged" ? (
            <div className="flex items-stretch gap-2">
              <button
                onClick={cancel}
                className="flex-1 px-4 py-3 border border-[#7F1D1D]/60 bg-[#7F1D1D]/10 hover:bg-[#7F1D1D]/20 text-[#FCA5A5] font-runner-mono text-[12px] tracking-[0.18em] uppercase rounded-[2px] transition-colors"
              >
                Cancel Run
              </button>
              <button
                onClick={onClose}
                className="px-4 py-3 border border-runner-border bg-runner-surface hover:bg-[#1A1D24] text-runner-fg-muted hover:text-runner-fg font-runner-mono text-[12px] tracking-[0.18em] uppercase rounded-[2px] transition-colors"
              >
                Done
              </button>
            </div>
          ) : (
            <>
              <label className="flex items-center gap-2 mb-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={dryRun}
                  onChange={(e) => setDryRun(e.target.checked)}
                  disabled={panel.kind !== "composing"}
                  className="appearance-none w-4 h-4 border border-runner-border bg-runner-surface checked:bg-runner-accent checked:border-runner-accent rounded-[2px] cursor-pointer transition-colors"
                />
                <span className="font-runner-mono text-[10px] uppercase tracking-[0.18em] text-runner-fg-muted">
                  Dry run
                  <span className="ml-2 text-runner-fg-muted/60 normal-case tracking-normal italic">
                    preview, no UCPath changes
                  </span>
                </span>
              </label>
              <button
                onClick={submit}
                disabled={panel.kind !== "composing"}
                className="runner-engage w-full px-5 py-3 rounded-[2px] flex items-center justify-center gap-2 text-[13px]"
              >
                <Zap className="w-3.5 h-3.5" />
                {panel.kind === "spawning" ? "Spawning…" : "Engage"}
              </button>
            </>
          )}
        </footer>
      </aside>
    </div>
  );
}

// ── Local helpers ──

/** Short, lossy summary of an input object for the recent-runs list. */
function summarizeInput(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [, v] of Object.entries(input)) {
    if (Array.isArray(v)) {
      if (v.length > 0) parts.push(`[${v.length}] ${v.slice(0, 2).join(", ")}${v.length > 2 ? "…" : ""}`);
    } else if (typeof v === "string" && v) {
      parts.push(v);
    } else if (typeof v === "number" || typeof v === "boolean") {
      parts.push(String(v));
    }
  }
  const joined = parts.join(" · ");
  return joined.length > 64 ? joined.slice(0, 61) + "…" : joined;
}

/** Cheap relative-time helper — no Intl.RelativeTimeFormat dependency. */
function relativeTime(ts: number): string {
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}
