import { useEffect, useMemo, useState } from "react";
import { Play, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { TrackerEntry } from "./types";
import { useWorkflow } from "../workflows-context";

interface EditDataTabProps {
  workflow: string;
  entry: TrackerEntry | null;
}

/**
 * Edit-and-resume form. Reads the workflow's metadata from the registry
 * (via useWorkflow) and renders one input per `detailField` whose
 * `editable: true` flag is set. Defaults from `entry.data`. "Run with
 * these values" POSTs /api/run-with-data; the backend attaches the
 * fields as a `prefilledData` channel on the input, the kernel pre-
 * merges them into ctx.data, and the workflow's extraction step is
 * bypassed via its `if (!ctx.data.X) await ctx.step(...)` gate.
 */
export function EditDataTab({ workflow, entry }: EditDataTabProps) {
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

  const onSubmit = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    const t = toast.loading(`Running ${entry.id} with edited data…`);
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
        toast.success(`Run enqueued`, {
          id: t,
          description: `${entry.id} will use these values; extraction step is bypassed`,
        });
      } else {
        toast.error(`Enqueue failed`, {
          id: t,
          description: body.error ?? `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      toast.error(`Enqueue failed`, {
        id: t,
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setPending(false);
    }
  };

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
          </div>
        ))}
      </div>
      <div className="pt-3 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onReset}
          disabled={!dirty || pending}
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
          onClick={onSubmit}
          disabled={pending}
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
