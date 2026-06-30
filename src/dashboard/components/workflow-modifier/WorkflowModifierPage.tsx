import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "@/lib/notify";
import { Loader2, Wand2 } from "lucide-react";
import { useWorkflowPresentation } from "./useWorkflowPresentation.js";
import type { WorkflowOverride } from "./useWorkflowPresentation.js";
import { useWorkflowDesign } from "./useWorkflowDesign.js";
import { useDataBank } from "./useDataBank.js";
import { EditorSidebar } from "./EditorSidebar.js";
import { GraphCanvas } from "./graph/GraphCanvas.js";
import { groupLaneOps } from "./graph/lane-build.js";
import { buildOutlineModel } from "./graph/outline-build.js";
import { designSpecToGraph, graphToDesignSpec, mergeAddedOpsIntoModel } from "./graph/design-spec.js";
import { opToActionData } from "./graph/data-bank-dnd.js";
import type { GraphModel, AddedLaneOp, ActionNodeData } from "./graph/graph-types.js";
import type { DataBankOperation } from "../../../domain/workflow-design/data-bank.js";
import { countTotal, isDirty } from "./blueprint-helpers.js";

interface WorkflowModifierPageProps {
  /**
   * Reports the editor's unsaved-draft state up to the host. The rail uses this
   * to confirm before navigating away from a dirty editor (the "quit" guard).
   * Reports `false` on unmount so a stale dirty flag never blocks re-entry.
   */
  onDirtyChange?: (dirty: boolean) => void;
}

export function WorkflowModifierPage({
  onDirtyChange,
}: WorkflowModifierPageProps = {}): JSX.Element {
  const wp = useWorkflowPresentation();
  const wd = useWorkflowDesign(wp.selected);
  const { bank } = useDataBank();
  const [draft, setDraft] = useState<WorkflowOverride>({});
  const [status, setStatus] = useState<string>("");
  const [reverting, setReverting] = useState(false);

  // ── Lifted canvas view controller (shared with the sidebar) ───────────────────
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dataFlowOn, setDataFlowOn] = useState(false);
  const [dryRunOn, setDryRunOn] = useState(false);
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [focusTarget, setFocusTarget] = useState<{ id: string; n: number } | null>(null);
  const [fitNonce, setFitNonce] = useState(0);
  // Ops the operator dropped into step lanes from the Data Bank, keyed by bare
  // step. Design intent (no runtime override) — serialized to the scaffold.
  const [addedOps, setAddedOps] = useState<Record<string, AddedLaneOp[]>>({});

  // Latest live graph model, lifted from the canvas for "Generate scaffold".
  const modelRef = useRef<GraphModel | null>(null);
  const handleGraphChange = useCallback((m: GraphModel) => {
    modelRef.current = m;
  }, []);

  // Seed the draft from the persisted (sparse) override on select / save / revert.
  useEffect(() => {
    setDraft(wp.data?.override ?? {});
    setStatus("");
  }, [wp.data]);

  // Reset per-workflow view state when the selection changes (the canvas remounts;
  // these are page-owned so they'd otherwise leak across workflows).
  useEffect(() => {
    modelRef.current = null; // defend the handleGenerate guard until the new graph mounts
    setCollapsedIds(new Set());
    setFocusTarget(null);
    setDataFlowOn(false);
    setDryRunOn(false);
    setAddedOps({});
  }, [wp.selected]);

  const dirty = isDirty(draft, wp.data?.override ?? null);

  // Surface the unsaved-draft state to the host so leaving the editor can warn.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  // Always report "clean" when the editor unmounts (host stays unblocked).
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const total = countTotal(draft);
  const designOverlay = useMemo(() => (wd.spec ? designSpecToGraph(wd.spec) : null), [wd.spec]);

  // Restore dropped-in ops from the saved design scaffold once it resolves (and
  // clear them when switching to a workflow with no spec).
  useEffect(() => {
    setAddedOps(designOverlay?.addedOps ?? {});
  }, [designOverlay]);

  const addOpToStep = useCallback((step: string, op: DataBankOperation) => {
    setAddedOps((prev) => ({
      ...prev,
      [step]: [...(prev[step] ?? []), { ...opToActionData(op), addedId: crypto.randomUUID().slice(0, 8) }],
    }));
  }, []);
  const removeAddedOp = useCallback((step: string, addedId: string) => {
    setAddedOps((prev) => {
      const next = (prev[step] ?? []).filter((o) => o.addedId !== addedId);
      const out = { ...prev };
      if (next.length) out[step] = next;
      else delete out[step];
      return out;
    });
  }, []);
  const updateAddedOp = useCallback((step: string, addedId: string, patch: Partial<ActionNodeData>) => {
    setAddedOps((prev) => ({
      ...prev,
      [step]: (prev[step] ?? []).map((o) => (o.addedId === addedId ? { ...o, ...patch } : o)),
    }));
  }, []);

  // Outline of the selected workflow (drives the sidebar dropdown + collapse-all).
  const workflowBank = useMemo(
    () => bank?.workflows.find((w) => w.workflow === wp.selected),
    [bank, wp.selected],
  );
  const laneOps = useMemo(
    () => groupLaneOps(workflowBank, wp.data?.base.steps ?? []),
    [workflowBank, wp.data],
  );
  const outline = useMemo(
    () => (wp.data ? buildOutlineModel(wp.data.base, draft, wp.selected ?? "", laneOps) : null),
    [wp.data, draft, wp.selected, laneOps],
  );

  const allCollapsed = !!outline && outline.laneIds.length > 0 && outline.laneIds.every((id) => collapsedIds.has(id));
  const toggleAll = useCallback(() => {
    setCollapsedIds(allCollapsed ? new Set() : new Set(outline?.laneIds ?? []));
  }, [allCollapsed, outline]);
  const toggleCollapsed = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const focusLane = useCallback((id: string) => setFocusTarget((prev) => ({ id, n: (prev?.n ?? 0) + 1 })), []);
  const clearFocus = useCallback(() => setFocusTarget(null), []);
  const fitAll = useCallback(() => {
    setFocusTarget(null);
    setFitNonce((n) => n + 1);
  }, []);

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

  const handleGenerate = async () => {
    if (!wp.selected || !modelRef.current) return;
    // Fold the lane-dropped ops in as step-parented action nodes so they ride the
    // scaffold. generatedAt is stamped server-side, so a placeholder is fine here.
    const model = mergeAddedOpsIntoModel(modelRef.current, addedOps);
    const spec = graphToDesignSpec(model, wp.selected, "");
    const paths = await wd.save(spec);
    if (paths) {
      toast.success("Design scaffold generated");
      setStatus(`Scaffold → ${paths.jsonPath} + ${paths.mdPath}`);
    } else {
      toast.error("Scaffold generation failed");
      setStatus("Scaffold generation failed");
    }
  };

  return (
    <div className="flex h-full flex-1 overflow-hidden">
      <EditorSidebar
        list={wp.list}
        selected={wp.selected}
        selectedCount={total}
        onSelect={handleSelect}
        paletteOpen={paletteOpen}
        onTogglePalette={() => setPaletteOpen((o) => !o)}
        outline={outline}
        focusedId={focusTarget?.id ?? null}
        onFocus={focusLane}
        allCollapsed={allCollapsed}
        onToggleAll={toggleAll}
        dataFlowOn={dataFlowOn}
        onToggleDataFlow={() => setDataFlowOn((v) => !v)}
        dryRunOn={dryRunOn}
        onToggleDryRun={() => setDryRunOn((v) => !v)}
        onFit={fitAll}
      />

      <main className="flex flex-1 flex-col overflow-hidden" aria-label="Workflow graph editor">
        {wp.data ? (
          <>
            <div className="relative min-h-0 flex-1">
              {wd.loaded ? (
                <GraphCanvas
                  key={`${wp.selected ?? "none"}:${wd.loaded ? "L" : "_"}`}
                  data={wp.data}
                  workflowName={wp.selected ?? ""}
                  draft={draft}
                  onDraftChange={setDraft}
                  designOverlay={designOverlay}
                  onGraphChange={handleGraphChange}
                  bank={bank}
                  paletteOpen={paletteOpen}
                  onClosePalette={() => setPaletteOpen(false)}
                  dataFlowOn={dataFlowOn}
                  dryRunOn={dryRunOn}
                  collapsedIds={collapsedIds}
                  onToggleCollapsed={toggleCollapsed}
                  focusTarget={focusTarget}
                  onClearFocus={clearFocus}
                  fitNonce={fitNonce}
                  addedOps={addedOps}
                  onAddOpToStep={addOpToStep}
                  onRemoveAddedOp={removeAddedOp}
                  onUpdateAddedOp={updateAddedOp}
                />
              ) : (
                <div className="flex h-full items-center justify-center" aria-live="polite">
                  <Loader2 aria-hidden className="h-4 w-4 text-muted-foreground motion-safe:animate-spin" />
                </div>
              )}
            </div>

            {/* Action bar: config (revert/save) + scaffold (generate) */}
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

                <span aria-live="polite" className="ml-auto truncate text-xs text-muted-foreground">
                  {status}
                </span>

                <button
                  type="button"
                  disabled={wd.saving || !wd.loaded}
                  aria-disabled={wd.saving || !wd.loaded}
                  onClick={() => {
                    void handleGenerate();
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-3 py-1.5 text-sm text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {wd.saving ? (
                    <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 motion-safe:animate-spin" />
                  ) : (
                    <Wand2 aria-hidden className="h-3.5 w-3.5 shrink-0" />
                  )}
                  Generate scaffold
                </button>

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
            <p className="text-sm text-muted-foreground">Pick a workflow to open its graph.</p>
          </div>
        )}
      </main>
    </div>
  );
}
