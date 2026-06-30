import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Play,
  Loader2,
  Save,
  RefreshCcw,
  RotateCcw,
  Copy,
  Check,
  ChevronDown,
  Undo2,
  CalendarDays,
  AlertCircle,
  SquarePen,
} from "lucide-react";
import { toast } from "@/lib/notify";
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "@/components/shared/types";
import { useWorkflow } from "@/lib/workflows-context";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { statusBadgeClass } from "@/components/shared/status-styles";
import { useOptionalOperationQueueParentRunId } from "@/components/hooks/useOperationQueueContext";

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

type PendingAction = null | "run" | "save" | "refresh";
type EditableFieldKey = { key: string };

/**
 * One editable detail field as it arrives from the workflow registry. `inputKind`
 * and `group` are the Edit Data layout hints (see `DetailField` in core kernel
 * types); both are optional so any workflow opting into editable fields renders
 * sensibly even without them.
 */
type EditField = {
  key: string;
  label: string;
  multiline?: boolean;
  conditional?: boolean;
  inputKind?: "text" | "id" | "date";
  group?: string;
};

function EmptyEditState({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-10 text-center text-sm text-muted-foreground">
      <div className="max-w-sm">{children}</div>
    </div>
  );
}

export function buildEditDataResetKey(
  entry: TrackerEntry | null,
  editableFields: ReadonlyArray<EditableFieldKey>,
): string {
  const entryKey = `${entry?.id ?? ""}|${entry?.runId ?? ""}`;
  const editableKey = editableFields.map((f) => f.key).join(",");
  return `${entryKey}|${editableKey}`;
}

export function buildEditDataInitialValues(
  entry: TrackerEntry | null,
  editableFields: ReadonlyArray<EditableFieldKey>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of editableFields) {
    out[f.key] = entry?.data?.[f.key] ?? "";
  }
  return out;
}

// ── Date helpers (MM/DD/YYYY ⇄ the Calendar's YYYY-MM-DD) ─────────────
/**
 * Parse an `MM/DD/YYYY` string into the calendar's `YYYY-MM-DD`, or `undefined`
 * if it isn't a real calendar date. Used both to seed the Calendar popover and
 * to validate a typed date.
 */
export function mmddyyyyToYmd(value: string): string | undefined {
  const m = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return undefined;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  // Reject impossible days (e.g. 02/31) by round-tripping through Date.
  const dt = new Date(year, month - 1, day);
  if (dt.getMonth() !== month - 1 || dt.getDate() !== day) return undefined;
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/** Format the calendar's `YYYY-MM-DD` back into the stored `MM/DD/YYYY`. */
export function ymdToMmddyyyy(ymd: string): string {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return ymd;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

/**
 * Validate an editable field's current value. Returns a short operator-facing
 * message when the value can't be used, else `null`. Generic (keyed on
 * `inputKind`, never a field name): a date must be a real `MM/DD/YYYY`, and an
 * id must not contain whitespace. Empty is always allowed — clearing a field is
 * a valid edit; presence requirements live in the workflow handler.
 */
export function validateEditField(field: EditField, value: string): string | null {
  const v = (value ?? "").trim();
  if (v === "") return null;
  if (field.inputKind === "date" && !mmddyyyyToYmd(v)) return "Use MM/DD/YYYY.";
  if (field.inputKind === "id" && /\s/.test(v)) return "IDs can't contain spaces.";
  return null;
}

/**
 * Group editable fields into labeled sections by their consecutive `group`
 * value, preserving declared order. Fields without a `group` fall into an
 * unlabeled section, so a workflow that sets no groups still renders one clean
 * list.
 */
export function groupEditableFields(
  fields: ReadonlyArray<EditField>,
): Array<{ group?: string; fields: EditField[] }> {
  const out: Array<{ group?: string; fields: EditField[] }> = [];
  for (const f of fields) {
    const last = out[out.length - 1];
    if (last && last.group === f.group) last.fields.push(f);
    else out.push({ group: f.group, fields: [f] });
  }
  return out;
}

/** Token-driven input classes shared by the text/id, textarea, and date inputs. */
function fieldInputClass(opts: { dirty: boolean; invalid: boolean; mono: boolean }): string {
  return cn(
    "w-full rounded-md border bg-background px-2.5 py-1.5 text-sm text-foreground",
    "transition-colors duration-150 motion-reduce:transition-none",
    "placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1",
    opts.invalid
      ? "border-destructive/60 focus:border-destructive focus:ring-destructive/40"
      : opts.dirty
        ? "border-warning/50 focus:border-primary focus:ring-primary/40"
        : "border-border/60 focus:border-primary focus:ring-primary/40",
    opts.mono && "font-mono",
  );
}

/**
 * Edit-and-resume form. Reads the workflow's metadata from the registry
 * (via useWorkflow) and renders one input per `detailField` whose
 * `editable: true` flag is set, laid out in labeled sections by `group` with
 * `date` fields backed by a calendar popover and `id` fields in monospace.
 * Defaults come from `entry.data`. "Run with these values" POSTs
 * /api/run-with-data; the backend attaches the fields as a `prefilledData`
 * channel on the input, the kernel pre-merges them into ctx.data, and the
 * workflow's extraction step is bypassed via its `if (!ctx.data.X) await
 * ctx.step(...)` gate.
 *
 * "Copy from prior run" affordance: when the workflow declares a `matchKey`
 * (e.g. `"eid"` for separations) and the current entry has a non-empty
 * `data[matchKey]`, the toolbar surfaces a "Find prior" button.
 */
export function EditDataTab({ workflow, entry, runId, date }: EditDataTabProps) {
  const meta = useWorkflow(workflow);
  const operationQueueParentRunId = useOptionalOperationQueueParentRunId();
  const editableFields = useMemo(
    () => (meta?.detailFields ?? []).filter((f) => f.editable) as EditField[],
    [meta],
  );
  const resetKey = buildEditDataResetKey(entry, editableFields);
  const initial = useMemo(() => {
    return buildEditDataInitialValues(entry, editableFields);
    // Reset defaults only when the operator picks a different row or editable set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const [values, setValues] = useState<Record<string, string>>(initial);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<PendingAction>(null);

  // Reset when the entry identity / editable set changes, not on every SSE ref.
  useEffect(() => {
    setValues(initial);
    setTouched({});
  }, [initial, resetKey]);

  if (!entry) {
    return <EmptyEditState>Select a row to edit its data.</EmptyEditState>;
  }
  if (editableFields.length === 0) {
    return (
      <EmptyEditState>
        This workflow has no editable fields. Edit-and-resume is opt-in
        per workflow — see the workflow's{" "}
        <span className="font-mono">detailFields</span> metadata.
      </EmptyEditState>
    );
  }

  const setFieldValue = (key: string, next: string): void =>
    setValues((v) => ({ ...v, [key]: next }));
  const markTouched = (key: string): void => setTouched((t) => ({ ...t, [key]: true }));

  const isDirty = (f: EditField): boolean => (values[f.key] ?? "") !== (initial[f.key] ?? "");
  const dirty = editableFields.some(isDirty);
  const changedCount = editableFields.filter(isDirty).length;
  const errorFor = (f: EditField): string | null => validateEditField(f, values[f.key] ?? "");
  const hasBlockingErrors = editableFields.some((f) => errorFor(f) !== null);

  const onResetAll = (): void => {
    setValues(initial);
    setTouched({});
  };

  const onResetField = (key: string): void => {
    setValues((v) => ({ ...v, [key]: initial[key] ?? "" }));
    setTouched((t) => ({ ...t, [key]: false }));
  };

  const onRefresh = async (): Promise<void> => {
    if (pending || !entry) return;
    setPending("refresh");
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
      setTouched({});
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
      setPending(null);
    }
  };

  const onSave = async (): Promise<void> => {
    if (pending) return;
    setPending("save");
    const t = toast.loading(`Saving changes for ${entry.id}…`);
    try {
      const res = await fetch("/api/save-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow,
          id: entry.id,
          data: values,
          ...(date ? { date } : {}),
        }),
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
      setPending(null);
    }
  };

  const onSubmit = async (): Promise<void> => {
    if (pending) return;
    setPending("run");
    const t = toast.loading(`Starting ${entry.id} with edited data…`);
    try {
      const res = await fetch("/api/run-with-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workflow,
          id: entry.id,
          data: values,
          ...(runId ? { runId } : {}),
          ...(date ? { date } : {}),
          ...(operationQueueParentRunId ? { parentRunId: operationQueueParentRunId } : {}),
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
      setPending(null);
    }
  };

  // ── Copy-from-prior wiring ────────────────────────────────────────
  const matchKey = meta?.matchKey;
  const matchValue = matchKey ? (entry.data?.[matchKey] ?? "").toString().trim() : "";
  const priorAvailable = !!matchKey && matchValue.length > 0;

  const sections = groupEditableFields(editableFields);
  const busy = pending !== null;
  const workflowLabel = meta?.label ?? workflow;

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* Scrollable form body */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto w-full max-w-2xl space-y-6">
          {/* Purpose callout */}
          <div className="flex items-start gap-3 rounded-lg border border-border bg-card/40 px-3.5 py-3">
            <div
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground"
            >
              <SquarePen className="h-4 w-4" />
            </div>
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm font-medium text-foreground">Override extracted values</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Re-run this {workflowLabel.toLowerCase()} with the values below instead of
                extracting them again — useful when the data is right but a later step needs
                another pass.
              </p>
            </div>
          </div>

          {/* Field sections */}
          <div className="space-y-6">
            {sections.map((section, si) => (
              <section key={section.group ?? `__ungrouped-${si}`} className="space-y-3">
                {section.group && (
                  <div className="flex items-center gap-3">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {section.group}
                    </h3>
                    <div className="h-px flex-1 bg-border/60" />
                  </div>
                )}
                <div className="grid grid-cols-1 gap-x-4 gap-y-4 sm:grid-cols-2">
                  {section.fields.map((f) => {
                    const id = `edit-data-${f.key}`;
                    const value = values[f.key] ?? "";
                    const fieldDirty = isDirty(f);
                    const error = errorFor(f);
                    const showError = error != null && touched[f.key];
                    const invalid = showError;
                    const mono = f.inputKind === "id" || f.inputKind === "date";
                    // multiline + a lone field in a section span the full row; pairs sit half-width.
                    const fullWidth = f.multiline || section.fields.length === 1;
                    const inputCls = fieldInputClass({ dirty: fieldDirty, invalid, mono });

                    return (
                      <div key={f.key} className={cn("flex flex-col gap-1.5", fullWidth && "sm:col-span-2")}>
                        <div className="flex items-center justify-between gap-2">
                          <label
                            htmlFor={id}
                            className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
                          >
                            {f.label}
                            {fieldDirty && (
                              <>
                                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warning" />
                                <span className="sr-only">(changed)</span>
                              </>
                            )}
                          </label>
                          {fieldDirty && (
                            <button
                              type="button"
                              onClick={() => onResetField(f.key)}
                              disabled={busy}
                              aria-label={`Reset ${f.label} to the extracted value`}
                              title="Reset to the extracted value"
                              className={cn(
                                "inline-flex items-center gap-1 rounded px-1 py-0.5 cursor-pointer",
                                "text-[10px] font-medium text-muted-foreground",
                                "transition-colors duration-150 motion-reduce:transition-none",
                                "hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                                "disabled:opacity-50 disabled:cursor-not-allowed",
                              )}
                            >
                              <Undo2 className="h-3 w-3" aria-hidden />
                              Reset
                            </button>
                          )}
                        </div>

                        {f.multiline ? (
                          <textarea
                            id={id}
                            value={value}
                            disabled={busy}
                            rows={3}
                            onChange={(e) => setFieldValue(f.key, e.target.value)}
                            onBlur={() => markTouched(f.key)}
                            className={cn(inputCls, "min-h-[4.5rem] resize-y disabled:opacity-60")}
                          />
                        ) : f.inputKind === "date" ? (
                          <DateField
                            id={id}
                            value={value}
                            disabled={busy}
                            inputClassName={cn(inputCls, "pr-9 disabled:opacity-60")}
                            onChange={(next) => setFieldValue(f.key, next)}
                            onBlur={() => markTouched(f.key)}
                          />
                        ) : (
                          <input
                            id={id}
                            type="text"
                            value={value}
                            disabled={busy}
                            onChange={(e) => setFieldValue(f.key, e.target.value)}
                            onBlur={() => markTouched(f.key)}
                            className={cn(inputCls, "disabled:opacity-60")}
                          />
                        )}

                        {showError && (
                          <p
                            className="flex items-center gap-1 text-[11px] text-destructive"
                            aria-live="polite"
                          >
                            <AlertCircle className="h-3 w-3 shrink-0" aria-hidden />
                            {error}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      </div>

      {/* Action bar — pinned below the scroll area. Left: pull values in.
          Right: act on the values. */}
      <div className="shrink-0 border-t border-border bg-card/30 px-4 py-3">
        <div className="mx-auto flex w-full max-w-2xl flex-wrap items-center gap-2">
          {priorAvailable && (
            <CopyFromPriorButton
              workflow={workflow}
              workflowLabel={workflowLabel}
              keyField={matchKey!}
              keyValue={matchValue}
              excludeId={entry.id}
              editableFields={editableFields.map((f) => f.key)}
              disabled={busy}
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
                setTouched({});
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
            disabled={busy}
            title="Pull the latest values for this run from tracker entries. Falls back to the richest data across runs of this id when the active run has none."
            className={cn(
              "inline-flex items-center gap-1.5 h-8 px-3 rounded-md cursor-pointer",
              "text-xs font-medium border border-border/60 text-muted-foreground bg-transparent",
              "transition-colors duration-150 motion-reduce:transition-none",
              "hover:text-foreground hover:bg-muted",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:opacity-50 disabled:cursor-not-allowed",
            )}
          >
            {pending === "refresh" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <RefreshCcw className="h-3.5 w-3.5" aria-hidden />
            )}
            Refresh from logs
          </button>

          {/* Right cluster — act on the values. */}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {changedCount > 0 && (
              <span
                className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
                aria-live="polite"
              >
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warning" />
                {changedCount} changed
              </span>
            )}
            <button
              type="button"
              onClick={onResetAll}
              disabled={!dirty || busy}
              title="Revert every field to the extracted value"
              className={cn(
                "inline-flex items-center gap-1.5 h-8 px-3 rounded-md cursor-pointer",
                "text-xs font-medium border border-border/60 text-muted-foreground bg-transparent",
                "transition-colors duration-150 motion-reduce:transition-none",
                "hover:text-foreground hover:bg-muted",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              Reset
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={!dirty || busy || hasBlockingErrors}
              title={
                hasBlockingErrors
                  ? "Fix the highlighted fields first"
                  : "Persist these values without running. Survives dashboard refresh."
              }
              className={cn(
                "inline-flex items-center gap-1.5 h-8 px-3 rounded-md cursor-pointer",
                "text-xs font-medium border border-border/60 text-foreground bg-transparent",
                "transition-colors duration-150 motion-reduce:transition-none",
                "hover:bg-muted",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              {pending === "save" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : (
                <Save className="h-3.5 w-3.5" aria-hidden />
              )}
              Save
            </button>
            <button
              type="button"
              onClick={onSubmit}
              disabled={busy || hasBlockingErrors}
              title={hasBlockingErrors ? "Fix the highlighted fields first" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 h-8 px-3 rounded-md cursor-pointer",
                "bg-primary text-primary-foreground text-xs font-medium",
                "transition-colors duration-150 motion-reduce:transition-none",
                "hover:bg-primary/90",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                "disabled:opacity-60 disabled:cursor-not-allowed",
              )}
            >
              {pending === "run" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : (
                <Play className="h-3.5 w-3.5" aria-hidden />
              )}
              Run with these values
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface DateFieldProps {
  id: string;
  value: string;
  disabled?: boolean;
  inputClassName: string;
  onChange: (next: string) => void;
  onBlur: () => void;
}

/**
 * A `MM/DD/YYYY` text input with an inline calendar trigger. The operator can
 * type a date directly (validated on blur upstream) or pick one from the
 * popover — selecting from the calendar always yields a valid date and clears
 * any typed-format error.
 */
function DateField({ id, value, disabled, inputClassName, onChange, onBlur }: DateFieldProps) {
  const [open, setOpen] = useState(false);
  const ymd = mmddyyyyToYmd(value) ?? "";

  return (
    <div className="relative">
      <input
        id={id}
        type="text"
        inputMode="numeric"
        placeholder="MM/DD/YYYY"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        className={inputClassName}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label="Pick a date from the calendar"
            className={cn(
              "absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-6 w-6 items-center justify-center rounded cursor-pointer",
              "text-muted-foreground transition-colors duration-150 motion-reduce:transition-none",
              "hover:bg-muted hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              "disabled:opacity-50 disabled:cursor-not-allowed",
            )}
          >
            <CalendarDays className="h-3.5 w-3.5" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={6} className="w-auto p-3">
          <Calendar
            selected={ymd}
            onSelect={(picked) => {
              onChange(ymdToMmddyyyy(picked));
              onBlur();
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
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
            "transition-colors duration-150 motion-reduce:transition-none",
            "hover:bg-accent/50",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:opacity-50 disabled:cursor-not-allowed",
          )}
        >
          <Copy className="h-3.5 w-3.5" aria-hidden />
          Find prior
          <ChevronDown className="h-3 w-3 opacity-70" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[360px] p-0 max-h-[420px] overflow-hidden flex flex-col"
      >
        <div className="px-3 py-2 border-b border-border/60 flex items-center justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Prior runs · {keyField} = {keyValue}
          </div>
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none text-muted-foreground" aria-hidden />}
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
                      "hover:bg-accent/40 transition-colors motion-reduce:transition-none",
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
                        {e.status === "done" ? <Check className="inline h-3 w-3" aria-hidden /> : e.status}
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
