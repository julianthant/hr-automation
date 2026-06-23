import { useState } from "react";
import { useWorkflowPresentation } from "./useWorkflowPresentation.js";
import type { WorkflowOverride } from "./useWorkflowPresentation.js";
import { NamingEditor } from "./NamingEditor.js";
import { StepDisplayEditor } from "./StepDisplayEditor.js";
import { DelegationEditor } from "./DelegationEditor.js";
import { SampleRowPreview } from "./SampleRowPreview.js";

export function WorkflowModifierPage(): JSX.Element {
  const wp = useWorkflowPresentation();
  const [draft, setDraft] = useState<WorkflowOverride>({});

  return (
    <div className="flex h-full flex-1 overflow-hidden">
      {/* Workflow picker */}
      <aside className="w-64 shrink-0 border-r border-border overflow-y-auto">
        <div className="p-3 pb-1">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Workflows
          </p>
        </div>
        {wp.list.map((w) => (
          <button
            key={w.name}
            type="button"
            aria-label={`Configure ${w.label}`}
            onClick={() => {
              wp.load(w.name);
              setDraft({});
            }}
            className={[
              "block w-full text-left px-3 py-2 text-sm transition-colors outline-none",
              "hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              wp.selected === w.name
                ? "bg-accent text-foreground font-medium"
                : "text-muted-foreground",
            ].join(" ")}
          >
            {w.label}
            {w.hasOverride ? (
              <span
                className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-primary align-middle"
                aria-label="has override"
              />
            ) : null}
          </button>
        ))}
      </aside>

      {/* Editors column */}
      <main className="flex-1 overflow-y-auto p-4 space-y-4" aria-label="Workflow presentation editors">
        {wp.data ? (
          <>
            <NamingEditor data={wp.data} draft={draft} onChange={setDraft} />
            <StepDisplayEditor data={wp.data} draft={draft} onChange={setDraft} />
            <DelegationEditor data={wp.data} draft={draft} onChange={setDraft} />

            {/* Action bar */}
            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => { void wp.preview(draft); }}
                className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm text-foreground hover:bg-accent transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
              >
                Preview
              </button>
              <button
                type="button"
                disabled={wp.saving}
                aria-disabled={wp.saving}
                onClick={() => { void wp.save(draft); }}
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
              >
                {wp.saving ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => { void wp.revert(); }}
                className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
              >
                Revert to default
              </button>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-48">
            <p className="text-sm text-muted-foreground">
              Select a workflow on the left to configure its presentation.
            </p>
          </div>
        )}
      </main>

      {/* Preview panel */}
      <aside
        className="w-80 shrink-0 border-l border-border p-4 overflow-y-auto"
        aria-label="Sample row preview"
      >
        <SampleRowPreview previewResult={wp.previewResult} data={wp.data} />
      </aside>
    </div>
  );
}
