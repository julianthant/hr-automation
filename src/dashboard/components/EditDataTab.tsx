import { useEffect, useMemo, useState } from "react";
import { Play, Loader2, Save, RefreshCcw, Copy, Check, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "./types";
import { useWorkflow } from "../workflows-context";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";
import { statusBadgeClass } from "./status-styles";

interface EditDataTabProps {
  workflow: string;
  entry: TrackerEntry | null;
  /** Active run selection from the LogPanel. When set, `Refresh from logs`
   * pulls data from this specific run; otherwise it falls back to the
   * richest data across all runs of this id. */
  runId?: string | null;
  /** Date filter currently shown by the dashboard (YYYY-MM-DD). Forwarded
   * to the entry-data endpoint so the lookup hits the right JSONL file. */
  date?: string;
}

/**
 * Edit-and-resume form. Reads the workflow's metadata from the registry
 * (via useWorkflow) and renders one input per `detailField` whose
 * `editable: true` flag is set. Defaults from `entry.data`. "Run with
 * these values" POSTs /api/run-with-data; the backend attaches the
 * fields as a `prefilledData` channel on the input, the kernel pre-
 * merges them into ctx.data, and the workflow's extraction step is
 * bypassed via its `if (!ctx.data.X) await ctx.step(...)` gate.
 *
 * "Copy from prior run" affordance: when the workflow declares a
 * `matchKey` (e.g. `"eid"` for separations) and the current entry has a
 * non-empty `data[matchKey]`, the toolbar surfaces a "Find prior" button.
 * Clicking opens a popover listing past runs of this workflow that share
 * the same `matchKey` value but a different itemId; selecting one fills
 * the form fields with that prior run's data so the operator can carry
 * extracted/edited values forward across duplicate-employee submissions.
 */
export function EditDataTab({ workflow, entry, runId, date }: EditDataTabProps) {
  const meta = useWorkflow(workflow);
  const editableFields = useMemo(
    () => (meta?.detailFields ?? []).filter((f) => f.editable),
    [meta],
  );
  const initial = useMemo(() => {
    const out: Record<string, string> = {};
    for (const f of editableFields) {
      out[f.key] = entry?.data?.[f.key] ?? "";
    }
    return out;
  }, [editableFields, entry]);

  const [values, setValues] = useState<Record<string, string>>(initial);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Reset when the entry / editable set changes (e.g. user picks a different row).
  useEffect(() => {
    setValues(initial);
  }, [initial]);

  if (!entry) {
    return (
      <div className="flex-1 px-6 py-4 text-sm text-muted-foreground">
        Select an entry to edit its data.
      </div>
    );
  }
  if (editableFields.length === 0) {
    return (
      <div className="flex-1 px-6 py-4 text-sm text-muted-foreground">
        This workflow has no editable fields. Edit-and-resume is opt-in
        per workflow — see the workflow's <span className="font-mono">detailFields</span>{" "}
        metadata.
      </div>
    );
  }

  const dirty = editableFields.some((f) => (values[f.key] ?? "") !== (initial[f.key] ?? ""));

  const onReset = (): void => {
    setValues(initial);
  };

  const onRefresh = async (): Promise<void> => {
    if (refreshing || !entry) return;
    setRefreshing(true);
    const t = toast.loading(`Loading latest data…`);
    try {
      const params = new URLSearchParams({ workflow, id: entry.id });
      if (runId) params.set("runId", runId);
      if (date) params.set("date", date);
      const res = await fetch(`/api/entry-data?${params.toString()}`);
      const body = (await res.json()) as {
        ok: boolean;
        data?: Record<string, string>;
        runId?: string | null;
        source?: "active-run" | "fallback" | "none";
        error?: string;
      };
      if (!res.ok || !body.ok) {
        toast.error(`Couldn't load data`, { id: t, description: body.error ?? `HTTP ${res.status}` });
        return;
      }
      const fresh = body.data ?? {};
      // Only fill keys we have inputs for; leave others alone.
      const next: Record<string, string> = { ...values };
      let filled = 0;
      for (const f of editableFields) {
        const v = fresh[f.key];
        if (v != null && String(v).trim() !== "") {
          next[f.key] = String(v);
          filled += 1;
        }
      }
      setValues(next);
      if (filled === 0) {
        toast.warning(`No data available`, {
          id: t,
          description: `No values found for the editable fields in this run`,
        });
      } else {
        toast.success(`Updated ${filled} field${filled === 1 ? "" : "s"} from logs`, {
          id: t,
          description: body.source === "fallback"
            ? `Sourced from a previous run of this item`
            : `Sourced from the current run`,
        });
      }
    } catch (err) {
      toast.error(`Couldn't load data`, {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRefreshing(false);
    }
  };

  const onSave = async (): Promise<void> => {
    if (saving || pending) return;
    setSaving(true);
    const t = toast.loading(`Saving changes for ${entry.id}…`);
    try {
      const res = await fetch("/api/save-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow, id: entry.id, data: values }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (body.ok) {
        toast.success(`Changes saved`, {
          id: t,
          description: `${entry.id} — values will persist across sessions`,
        });
      } else {
        toast.error(`Couldn't save`, {
          id: t,
          description: body.error ?? `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      toast.error(`Couldn't save`, {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const onSubmit = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    const t = toast.loading(`Starting ${entry.id} with edited data…`);
    try {
      const res = await fetch("/api/run-with-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow,
          id: entry.id,
          data: values,
        }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (body.ok) {
        toast.success(`Run started`, {
          id: t,
          description: `${entry.id} will use the edited values`,
        });
      } else {
        toast.error(`Couldn't start run`, {
          id: t,
          description: body.error ?? `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      toast.error(`Couldn't start run`, {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPending(false);
    }
  };

  // ── Copy-from-prior wiring ────────────────────────────────────────
  const matchKey = meta?.matchKey;
  const matchValue = matchKey ? (entry.data?.[matchKey] ?? "").toString().trim() : "";
  const priorAvailable = !!matchKey && matchValue.length > 0;

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3">
      <div className="text-xs text-muted-foreground">
        Override extracted values. The workflow will skip its extraction
        step and use these values directly. Useful when extraction is
        correct but a downstream step needs to be re-run.
      </div>
      <div className="space-y-3">
        {editableFields.map((f) => (
          <div key={f.key} className="space-y-1">
            <label
              htmlFor={`edit-data-${f.key}`}
              className="block text-[11px] font-medium text-muted-foreground uppercase tracking-wider"
            >
              {f.label}
            </label>
            {f.multiline ? (
              <textarea
                id={`edit-data-${f.key}`}
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                rows={3}
                className={cn(
                  "w-full min-h-[4.5rem] rounded-md border border-border/60 bg-background",
                  "px-2.5 py-1.5 text-sm font-mono text-foreground",
                  "transition-colors duration-150 resize-y",
                  "focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40",
                )}
              />
            ) : (
              <input
                id={`edit-data-${f.key}`}
                type="text"
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                className={cn(
                  "w-full rounded-md border border-border/60 bg-background",
                  "px-2.5 py-1.5 text-sm font-mono text-foreground",
                  "transition-colors duration-150",
                  "focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/40",
                )}
              />
            )}
          </div>
        ))}
      </div>
      <div className="pt-3 flex items-center justify-end gap-2 flex-wrap">
        {priorAvailable && (
          <CopyFromPriorButton
            workflow={workflow}
            workflowLabel={meta?.label ?? workflow}
            keyField={matchKey!}
            keyValue={matchValue}
            excludeId={entry.id}
            editableFields={editableFields.map((f) => f.key)}
            disabled={refreshing || pending || saving}
            onApply={(picked) => {
              const next: Record<string, string> = { ...values };
              let filled = 0;
              for (const f of editableFields) {
                const v = picked.data[f.key];
                if (v != null && String(v).trim() !== "") {
                  next[f.key] = String(v);
                  filled += 1;
                }
              }
              setValues(next);
              toast.success(
                `Copied ${filled} field${filled === 1 ? "" : "s"} from ${picked.id}`,
                { description: `Source: ${picked.date}` },
              );
            }}
          />
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing || pending || saving}
          title="Pull the latest values for this run from tracker entries. Falls back to the richest data across runs of this id when the active run has none."
          className={cn(
            "inline-flex items-center gap-1.5 h-8 px-3 rounded-md cursor-pointer",
            "text-xs font-medium border border-border/60",
            "text-muted-foreground bg-transparent",
            "transition-colors duration-150",
            "hover:text-foreground hover:bg-muted",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          {refreshing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCcw className="h-3.5 w-3.5" />
          )}
          Refresh from logs
        </button>
        <button
          type="button"
          onClick={onReset}
          disabled={!dirty || pending || saving}
          className={cn(
            "inline-flex items-center h-8 px-3 rounded-md cursor-pointer",
            "text-xs font-medium border border-border/60",
            "text-muted-foreground bg-transparent",
            "transition-colors duration-150",
            "hover:text-foreground hover:bg-muted",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          Reset
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || pending || saving}
          title="Persist these values without running. Survives dashboard refresh."
          className={cn(
            "inline-flex items-center gap-1.5 h-8 px-3 rounded-md cursor-pointer",
            "text-xs font-medium border border-border/60",
            "text-foreground bg-transparent",
            "transition-colors duration-150",
            "hover:bg-muted",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          Save
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={pending || saving}
          className={cn(
            "inline-flex items-center gap-1.5 h-8 px-3 rounded-md cursor-pointer",
            "bg-primary text-primary-foreground text-xs font-medium",
            "transition-colors duration-150",
            "hover:bg-primary/90",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
            "disabled:opacity-60 disabled:cursor-wait",
          )}
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Run with these values
        </button>
      </div>
    </div>
  );
}

interface PriorEntrySummary {
  id: string;
  runId?: string;
  status: string;
  step?: string;
  timestamp: string;
  date: string;
  data: Record<string, string>;
}

interface CopyFromPriorButtonProps {
  workflow: string;
  workflowLabel: string;
  keyField: string;
  keyValue: string;
  excludeId: string;
  editableFields: string[];
  disabled?: boolean;
  onApply: (entry: PriorEntrySummary) => void;
}

/**
 * Popover trigger that, on first open, queries `/api/find-prior-by-key`
 * for past runs of the same workflow sharing the current entry's
 * `matchKey` value. Renders a list of those runs (id, date, status,
 * field summary); clicking one calls `onApply` and closes the popover.
 *
 * Visual style matches the other EditDataTab toolbar buttons (h-8,
 * tinted by accent so it reads as the "different action" of pulling
 * data from elsewhere). Hidden entirely when no prior runs come back —
 * we don't want a button that opens to "no matches" repeatedly.
 */
function CopyFromPriorButton({
  workflow,
  workflowLabel,
  keyField,
  keyValue,
  excludeId,
  editableFields,
  disabled,
  onApply,
}: CopyFromPriorButtonProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [entries, setEntries] = useState<PriorEntrySummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fetchEntries = async (): Promise<void> => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        workflow,
        keyField,
        keyValue,
        excludeId,
      });
      const res = await fetch(`/api/find-prior-by-key?${params.toString()}`);
      const body = (await res.json()) as {
        ok: boolean;
        entries?: PriorEntrySummary[];
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setError(body.error ?? `HTTP ${res.status}`);
        setEntries([]);
        return;
      }
      setEntries(body.entries ?? []);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  // Lazy load on first open. Always re-fetch on subsequent opens — the
  // operator may have run new items between visits, and a stale list
  // wouldn't surface them.
  const onOpenChange = (next: boolean): void => {
    setOpen(next);
    if (next) void fetchEntries();
  };

  const formatDate = (ts: string, fallback: string): string => {
    try {
      return new Date(ts).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      return fallback;
    }
  };

  // Compact preview of which editable fields are present in a prior run
  // — gives the operator a sense of "is there enough here to be worth
  // copying" before they click.
  const renderFieldSummary = (data: Record<string, string>): string => {
    const present = editableFields.filter((k) => {
      const v = data[k];
      return v != null && String(v).trim() !== "";
    });
    if (present.length === 0) return "no editable values";
    if (present.length === editableFields.length) return "all fields populated";
    return `${present.length} of ${editableFields.length} fields`;
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={`Find past ${workflowLabel} runs sharing ${keyField}=${keyValue}`}
          className={cn(
            "inline-flex items-center gap-1.5 h-8 px-3 rounded-md cursor-pointer",
            "text-xs font-medium border border-accent-foreground/40",
            "text-accent-foreground bg-accent/30",
            "transition-colors duration-150",
            "hover:bg-accent/50",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          <Copy className="h-3.5 w-3.5" />
          Find prior
          <ChevronDown className="h-3 w-3 opacity-70" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[360px] p-0 max-h-[420px] overflow-hidden flex flex-col"
      >
        <div className="px-3 py-2 border-b border-border/60 flex items-center justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Prior runs · {keyField} = {keyValue}
          </div>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
        <div className="flex-1 overflow-y-auto">
          {error ? (
            <div className="px-3 py-3 text-xs text-destructive">
              Couldn't load prior runs: {error}
            </div>
          ) : loading && !loaded ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">
              Searching last 90 days…
            </div>
          ) : entries.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">
              No other {workflowLabel} runs in the last 90 days share this {keyField}.
            </div>
          ) : (
            <ul className="divide-y divide-border/60">
              {entries.map((e) => (
                <li key={`${e.id}-${e.runId ?? e.timestamp}`}>
                  <button
                    type="button"
                    onClick={() => {
                      onApply(e);
                      setOpen(false);
                    }}
                    className={cn(
                      "w-full text-left px-3 py-2 cursor-pointer",
                      "hover:bg-accent/40 transition-colors",
                      "focus-visible:outline-none focus-visible:bg-accent/40",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[12px] text-foreground truncate">
                        {e.id}
                      </span>
                      <span
                        className={cn(
                          "text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded",
                          statusBadgeClass(e.status),
                        )}
                      >
                        {e.status === "done" ? <Check className="inline h-3 w-3" /> : e.status}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                      {formatDate(e.timestamp, e.date)}
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground/80">
                      {renderFieldSummary(e.data)}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
