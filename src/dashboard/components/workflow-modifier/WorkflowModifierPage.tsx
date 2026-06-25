import { useEffect, useState } from "react";
import { toast } from "sonner";
import { GitFork, Loader2, Tag, Workflow } from "lucide-react";
import { useWorkflowPresentation } from "./useWorkflowPresentation.js";
import type { WorkflowOverride } from "./useWorkflowPresentation.js";
import { WorkflowPicker } from "./WorkflowPicker.js";
import { Plate } from "./Plate.js";
import { RowNamingPlate } from "./RowNamingPlate.js";
import { StepPipelinePlate } from "./StepPipelinePlate.js";
import { DelegationPlate } from "./DelegationPlate.js";
import {
  countNaming,
  countSteps,
  countDelegation,
  countTotal,
  isDirty,
} from "./blueprint-helpers.js";

export function WorkflowModifierPage(): JSX.Element {
  const wp = useWorkflowPresentation();
  const [draft, setDraft] = useState<WorkflowOverride>({});
  const [status, setStatus] = useState<string>("");
  const [reverting, setReverting] = useState(false);

  // Seed the draft from the persisted override whenever a workflow loads or
  // reloads (select / save / revert). Using wp.data.override — the sparse saved
  // file, not the merged effective — keeps untouched sections round-tripping
  // through Save and never bakes defaults into the override.
  useEffect(() => {
    setDraft(wp.data?.override ?? {});
    setStatus("");
  }, [wp.data]);

  const dirty = isDirty(draft, wp.data?.override ?? null);
  const total = countTotal(draft);

  const handleSelect = (name: string) => {
    wp.load(name);
    setDraft({});
    setStatus("");
  };

  const handleSave = async () => {
    const ok = await wp.save(draft);
    if (ok) {
      toast.success("Saved");
      setStatus("Saved");
    } else {
      toast.error("Save failed — check your connection");
      setStatus("Save failed — check your connection");
    }
  };

  const handleRevert = async () => {
    setReverting(true);
    try {
      const ok = await wp.revert();
      if (ok) {
        toast.success("Reverted to default");
        setStatus("Reverted to default");
      } else {
        toast.error("Revert failed");
        setStatus("Revert failed");
      }
    } finally {
      setReverting(false);
    }
  };

  return (
    <div className="flex h-full flex-1 overflow-hidden">
      <WorkflowPicker
        list={wp.list}
        selected={wp.selected}
        selectedCount={total}
        onSelect={handleSelect}
      />

      <main className="flex flex-1 flex-col overflow-hidden" aria-label="Workflow blueprint">
        {wp.data ? (
          <>
            <div className="blueprint-grid flex-1 overflow-y-auto">
              <div className="mx-auto max-w-3xl space-y-4 p-5">
                <Plate
                  icon={Tag}
                  title="Row naming"
                  headerId="plate-naming"
                  count={countNaming(draft)}
                >
                  <RowNamingPlate data={wp.data} draft={draft} onChange={setDraft} />
                </Plate>

                <Plate
                  icon={Workflow}
                  title="Step pipeline"
                  headerId="plate-steps"
                  count={countSteps(draft)}
                >
                  <StepPipelinePlate data={wp.data} draft={draft} onChange={setDraft} />
                </Plate>

                <Plate
                  icon={GitFork}
                  title="Delegation"
                  headerId="plate-delegation"
                  count={countDelegation(draft)}
                >
                  <DelegationPlate
                    workflowName={wp.selected ?? ""}
                    data={wp.data}
                    draft={draft}
                    onChange={setDraft}
                  />
                </Plate>
              </div>
            </div>

            {/* Sticky action bar */}
            <div className="shrink-0 border-t border-border bg-background px-5 py-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={reverting || !wp.data?.override}
                  aria-disabled={reverting || !wp.data?.override}
                  onClick={() => {
                    void handleRevert();
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-3 py-1.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {reverting ? (
                    <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" />
                  ) : null}
                  Revert to default
                </button>

                {dirty && !wp.saving && !reverting ? (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warning" />
                    Unsaved changes
                  </span>
                ) : null}

                <span aria-live="polite" className="ml-auto text-xs text-muted-foreground">
                  {status}
                </span>

                <button
                  type="button"
                  disabled={wp.saving || !dirty}
                  aria-disabled={wp.saving || !dirty}
                  onClick={() => {
                    void handleSave();
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {wp.saving ? (
                    <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" />
                  ) : null}
                  {wp.saving ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-muted-foreground">
              Pick a workflow to shape how its rows read.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
