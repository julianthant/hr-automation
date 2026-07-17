import type { JSX } from "react";
import { useEffect, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DataBankOperation } from "../../../../domain/workflow-design/data-bank.js";
import { opKindVisual } from "./op-kind-visuals.js";

const TEXT_INPUT_CLASS =
  "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring";

export type DataBankOpDraft = Pick<
  DataBankOperation,
  "inputVar" | "outputVar" | "literalValue" | "note"
>;

interface DataBankOpDialogProps {
  op: DataBankOperation | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Place the customized op on the canvas (standalone action node). */
  onAddToCanvas: (op: DataBankOperation) => void;
}

/**
 * Detail + customization dialog for a Data Bank operation. Opens when the
 * operator clicks an op row in the sidebar — explains what it locates/does and
 * lets them tweak data-flow vars before placing it on the graph.
 */
export function DataBankOpDialog({
  op,
  open,
  onOpenChange,
  onAddToCanvas,
}: DataBankOpDialogProps): JSX.Element {
  const [draft, setDraft] = useState<DataBankOpDraft>({});

  useEffect(() => {
    if (!op) return;
    setDraft({
      inputVar: op.inputVar,
      outputVar: op.outputVar,
      literalValue: op.literalValue,
      note: op.note,
    });
  }, [op]);

  const merged: DataBankOperation | null = op
    ? {
        ...op,
        inputVar: draft.inputVar || undefined,
        outputVar: draft.outputVar || undefined,
        literalValue: draft.literalValue || undefined,
        note: draft.note || undefined,
      }
    : null;

  const v = op ? opKindVisual(op.kind) : null;

  const handleAdd = (): void => {
    if (!merged) return;
    onAddToCanvas(merged);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" aria-describedby={op ? "databank-op-desc" : undefined}>
        {op && v ? (
          <>
            <DialogHeader>
              <div className="flex items-start gap-3 pr-6">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary">
                  <v.icon aria-hidden className={cn("h-4 w-4", v.accent)} />
                </span>
                <div className="min-w-0 flex-1">
                  <DialogTitle>{op.label}</DialogTitle>
                  <DialogDescription id="databank-op-desc">
                    {op.summary ?? `${v.verb} on ${op.system}`}
                  </DialogDescription>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className={cn("rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide", v.chip)}>
                      {v.verb}
                    </span>
                    <span className="rounded border border-border bg-secondary/60 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {op.system}
                    </span>
                    {op.verified ? (
                      <span className="text-[10px] text-muted-foreground">Verified {op.verified}</span>
                    ) : null}
                  </div>
                </div>
              </div>
            </DialogHeader>

            <DialogBody className="px-5 py-4" viewportClassName="px-0">
              <div className="space-y-4">
                {(op.selectorFqn || op.role || op.accessibleName || op.url) ? (
                  <section className="space-y-1.5">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Target</h3>
                    {op.selectorFqn ? (
                      <p className="break-all font-mono text-[12px] text-foreground">{op.selectorFqn}</p>
                    ) : null}
                    {op.role || op.accessibleName ? (
                      <p className="text-[12px] text-muted-foreground">
                        {[op.role, op.accessibleName].filter(Boolean).join(" · ")}
                      </p>
                    ) : null}
                    {op.url ? <p className="break-all font-mono text-[12px] text-muted-foreground">{op.url}</p> : null}
                  </section>
                ) : null}

                {(op.inputVar || op.outputVar) && !draft.inputVar && !draft.outputVar ? (
                  <section className="space-y-1.5">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Default data flow
                    </h3>
                    <div className="flex flex-wrap gap-2">
                      {op.inputVar ? (
                        <VarChip icon={ArrowDownToLine} value={op.inputVar} accent="text-log-teal" label="Fills from" />
                      ) : null}
                      {op.outputVar ? (
                        <VarChip icon={ArrowUpFromLine} value={op.outputVar} accent="text-log-cyan" label="Scrapes into" />
                      ) : null}
                    </div>
                  </section>
                ) : null}

                {op.sourceRef ? (
                  <section className="space-y-1">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Source</h3>
                    <p className="break-all font-mono text-[11px] text-muted-foreground">{op.sourceRef}</p>
                  </section>
                ) : null}

                {op.tags?.length ? (
                  <section className="space-y-1.5">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Tags</h3>
                    <div className="flex flex-wrap gap-1">
                      {op.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded border border-border bg-secondary/50 px-1.5 py-px font-mono text-[10px] text-muted-foreground"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </section>
                ) : null}

                <section className="space-y-3 rounded-lg border border-border bg-secondary/20 p-3">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Customize</h3>
                  <label className="block space-y-1">
                    <span className="text-[11px] text-muted-foreground">Fills from (variable)</span>
                    <input
                      type="text"
                      value={draft.inputVar ?? ""}
                      placeholder="e.g. {eid}"
                      aria-label="Fills from variable"
                      onChange={(e) => setDraft((d) => ({ ...d, inputVar: e.target.value || undefined }))}
                      className={TEXT_INPUT_CLASS}
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[11px] text-muted-foreground">Scrapes into (variable)</span>
                    <input
                      type="text"
                      value={draft.outputVar ?? ""}
                      placeholder="e.g. {department}"
                      aria-label="Scrapes into variable"
                      onChange={(e) => setDraft((d) => ({ ...d, outputVar: e.target.value || undefined }))}
                      className={TEXT_INPUT_CLASS}
                    />
                  </label>
                  {(op.kind === "fill" || op.kind === "select") && (
                    <label className="block space-y-1">
                      <span className="text-[11px] text-muted-foreground">Literal value</span>
                      <input
                        type="text"
                        value={draft.literalValue ?? ""}
                        placeholder="Fixed value when not from a variable"
                        aria-label="Literal value"
                        onChange={(e) => setDraft((d) => ({ ...d, literalValue: e.target.value || undefined }))}
                        className={TEXT_INPUT_CLASS}
                      />
                    </label>
                  )}
                  <label className="block space-y-1">
                    <span className="text-[11px] text-muted-foreground">Note</span>
                    <textarea
                      value={draft.note ?? ""}
                      rows={3}
                      placeholder="Gotcha / why you're placing this op"
                      aria-label="Operation note"
                      onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value || undefined }))}
                      className={`${TEXT_INPUT_CLASS} resize-y`}
                    />
                  </label>
                </section>

                <p className="text-[11px] leading-snug text-muted-foreground">
                  Drag this op onto a step lane to add it there, or use &ldquo;Add to canvas&rdquo; for a standalone
                  connectable node.
                </p>
              </div>
            </DialogBody>

            <DialogFooter>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="inline-flex items-center rounded-md border border-border bg-secondary px-3 py-1.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAdd}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Plus aria-hidden className="h-3.5 w-3.5 shrink-0" />
                Add to canvas
              </button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function VarChip({
  icon: Icon,
  value,
  accent,
  label,
}: {
  icon: typeof ArrowDownToLine;
  value: string;
  accent: string;
  label: string;
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 rounded border border-border bg-card px-2 py-1">
      <Icon aria-hidden className={cn("h-3 w-3 shrink-0", accent)} />
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className="font-mono text-[11px] text-foreground">{value}</span>
    </span>
  );
}
