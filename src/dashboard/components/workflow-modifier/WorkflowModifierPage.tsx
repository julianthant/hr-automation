import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useWorkflowPresentation } from "./useWorkflowPresentation.js";
import type { WorkflowOverride } from "./useWorkflowPresentation.js";
import { NamingEditor } from "./NamingEditor.js";
import { StepDisplayEditor } from "./StepDisplayEditor.js";
import { DelegationEditor } from "./DelegationEditor.js";
import { SampleRowPreview } from "./SampleRowPreview.js";

type Tab = "naming" | "steps" | "delegation";

// Count modified leaf fields per domain from draft
function countNamingOverrides(draft: WorkflowOverride): number {
  const n = draft.presentation?.naming;
  if (!n) return 0;
  return (
    (n.title !== undefined ? 1 : 0) +
    (n.subtitle !== undefined ? 1 : 0) +
    (n.trace !== undefined ? 1 : 0)
  );
}

function countStepsOverrides(draft: WorkflowOverride): number {
  const s = draft.presentation?.steps;
  if (!s) return 0;
  return (
    (s.order !== undefined ? 1 : 0) +
    (s.rules?.length ?? 0)
  );
}

function countDelegationOverrides(draft: WorkflowOverride): number {
  const d = draft.presentation?.delegation;
  if (!d) return 0;
  return (
    (d.memberTitle !== undefined ? 1 : 0) +
    (d.memberSubtitle !== undefined ? 1 : 0) +
    (d.prepTitle !== undefined ? 1 : 0) +
    (d.coordinatorLabelSuffix !== undefined ? 1 : 0)
  );
}

// Check if draft differs from persisted override
function isDirty(draft: WorkflowOverride, persisted: WorkflowOverride | null): boolean {
  return JSON.stringify(draft) !== JSON.stringify(persisted ?? {});
}

export function WorkflowModifierPage(): JSX.Element {
  const wp = useWorkflowPresentation();
  const [draft, setDraft] = useState<WorkflowOverride>({});
  const [activeTab, setActiveTab] = useState<Tab>("naming");
  const [status, setStatus] = useState<string>("");
  const [reverting, setReverting] = useState(false);

  // Seed draft from the persisted override whenever a workflow's data loads (or
  // reloads after a save/revert). Using wp.data.override (the partial saved file
  // content) — NOT wp.data.effective (the full default⊕override merge) — avoids
  // baking default values into the override and pinning them forever. The effect
  // runs on the wp.data object reference, which changes only when load() resolves:
  // on workflow select, after save (hook refetches), and after revert (override
  // becomes null → draft resets to {}). This ensures untouched sections round-trip
  // through Save and are never silently destroyed.
  useEffect(() => {
    setDraft(wp.data?.override ?? {});
    setStatus("");
  }, [wp.data]);

  const namingCount = countNamingOverrides(draft);
  const stepsCount = countStepsOverrides(draft);
  const delegationCount = countDelegationOverrides(draft);

  const dirty = isDirty(draft, wp.data?.override ?? null);

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
        toast.success("Reverted to defaults");
        setStatus("Reverted to defaults");
      } else {
        toast.error("Revert failed");
        setStatus("Revert failed");
      }
    } finally {
      setReverting(false);
    }
  };

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "naming", label: "Naming", count: namingCount },
    { key: "steps", label: "Steps", count: stepsCount },
    { key: "delegation", label: "Delegation", count: delegationCount },
  ];

  return (
    <div className="flex h-full flex-1 overflow-hidden">
      {/* Workflow picker */}
      <aside className="w-64 shrink-0 border-r border-border overflow-y-auto">
        <div className="p-3 pb-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Workflows
          </p>
        </div>
        {wp.list.map((w) => (
          <button
            key={w.name}
            type="button"
            aria-label={`Configure ${w.label}`}
            aria-pressed={wp.selected === w.name}
            onClick={() => {
              wp.load(w.name);
              setDraft({});
              setStatus("");
            }}
            className={[
              "block w-full text-left px-3 py-2 text-sm transition-colors outline-none",
              "hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              wp.selected === w.name
                ? "bg-accent text-foreground font-medium"
                : "text-muted-foreground",
            ].join(" ")}
          >
            <span className="flex items-center gap-1.5">
              <span className="flex-1 truncate">{w.label}</span>
              {w.hasOverride ? (
                <span
                  className="shrink-0 inline-block h-1.5 w-1.5 rounded-full bg-primary align-middle"
                  aria-label="has saved override"
                />
              ) : null}
            </span>
          </button>
        ))}
      </aside>

      {/* Editors column */}
      <main
        className="flex flex-col flex-1 overflow-hidden"
        aria-label="Workflow presentation editors"
      >
        {wp.data ? (
          <>
            {/* Tab bar + scrollable editor body */}
            <div className="flex-1 overflow-y-auto">
              {/* Segmented tab bar */}
              <div className="px-4 pt-4 pb-2 shrink-0">
                <div
                  role="tablist"
                  aria-label="Presentation domain"
                  className="inline-flex h-8 items-center gap-0.5 rounded-lg border border-border bg-secondary/40 p-0.5"
                >
                  {tabs.map((t) => {
                    const active = activeTab === t.key;
                    return (
                      <button
                        key={t.key}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        aria-pressed={active}
                        onClick={() => setActiveTab(t.key)}
                        className={[
                          "inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-xs font-medium outline-none transition-colors cursor-pointer",
                          "focus-visible:ring-2 focus-visible:ring-ring",
                          active
                            ? "bg-accent text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                        ].join(" ")}
                      >
                        <span>{t.label}</span>
                        {t.count > 0 && (
                          <span className="rounded-full bg-primary/15 px-1.5 py-px text-xs font-semibold text-primary leading-none">
                            {t.count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Active editor */}
              <div className="px-4 pb-4">
                {activeTab === "naming" && (
                  <section aria-labelledby="tab-naming-heading">
                    <h2
                      id="tab-naming-heading"
                      className="text-sm font-semibold text-foreground mb-4"
                    >
                      Naming
                      {namingCount > 0 && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {namingCount} override{namingCount !== 1 ? "s" : ""}
                        </span>
                      )}
                    </h2>
                    <NamingEditor data={wp.data} draft={draft} onChange={setDraft} />
                  </section>
                )}
                {activeTab === "steps" && (
                  <section aria-labelledby="tab-steps-heading">
                    <h2
                      id="tab-steps-heading"
                      className="text-sm font-semibold text-foreground mb-4"
                    >
                      Steps
                      {stepsCount > 0 && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {stepsCount} override{stepsCount !== 1 ? "s" : ""}
                        </span>
                      )}
                    </h2>
                    <StepDisplayEditor data={wp.data} draft={draft} onChange={setDraft} />
                  </section>
                )}
                {activeTab === "delegation" && (
                  <section aria-labelledby="tab-delegation-heading">
                    <h2
                      id="tab-delegation-heading"
                      className="text-sm font-semibold text-foreground mb-4"
                    >
                      Delegation
                      {delegationCount > 0 && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {delegationCount} override{delegationCount !== 1 ? "s" : ""}
                        </span>
                      )}
                    </h2>
                    <DelegationEditor data={wp.data} draft={draft} onChange={setDraft} />
                  </section>
                )}
              </div>
            </div>

            {/* Sticky bottom action bar */}
            <div className="shrink-0 border-t border-border bg-background px-4 py-3">
              <div className="flex items-center gap-2">
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
                  onClick={() => { void handleSave(); }}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50 outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
                >
                  {wp.saving && (
                    <Loader2
                      aria-hidden
                      className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin"
                    />
                  )}
                  {wp.saving ? "Saving…" : "Save changes"}
                </button>
                <button
                  type="button"
                  disabled={reverting}
                  aria-disabled={reverting}
                  onClick={() => { void handleRevert(); }}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer disabled:opacity-50"
                >
                  {reverting && (
                    <Loader2
                      aria-hidden
                      className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin"
                    />
                  )}
                  Revert to default
                </button>
                {dirty && !wp.saving && !reverting && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    Unsaved changes
                  </span>
                )}
                {/* aria-live status line */}
                <span
                  aria-live="polite"
                  className="ml-auto text-xs text-muted-foreground"
                >
                  {status}
                </span>
              </div>
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full">
            <p className="text-sm text-muted-foreground">
              Select a workflow to configure how its rows are named.
            </p>
          </div>
        )}
      </main>

      {/* Preview panel — always mounted + sticky */}
      <aside
        className="w-80 shrink-0 border-l border-border overflow-y-auto"
        aria-label="Sample row preview"
      >
        <div className="sticky top-4 px-4 pt-4 pb-4">
          <SampleRowPreview previewResult={wp.previewResult} data={wp.data} />
        </div>
      </aside>
    </div>
  );
}
