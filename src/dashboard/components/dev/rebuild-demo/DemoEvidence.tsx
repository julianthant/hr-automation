import { useCallback, useEffect, useMemo, useState } from "react";
import { Camera, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, FileJson, FileText, ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  Banner,
  Button,
  Chip,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  KeyValueList,
  SectionLabel,
  Separator,
  dsFocus,
  dsIcon,
  dsText,
  useToasts,
} from "./demo-ui";
import { fmtClock, type SystemKey } from "./demo-wire";
import type { DemoRow } from "./demo-data";
import {
  CAPTURE_KIND_LABEL,
  capturesFor,
  exportRunJson,
  exportRunLogsText,
  type DemoCapture,
  type DemoCaptureKind,
} from "./demo-evidence-wire";

/**
 * DEV-ONLY — the evidence bar and its capture lightbox (D19b: evidence is a
 * BAR pinned above the tabs, never a tab of its own), plus the run export the
 * legacy Screenshots tab carried and the operator kept.
 *
 * The bar is built from the row's own `shots`, so the strip and the lightbox
 * can never show different sets, and a failure capture carries a red frame in
 * both. The two shared atoms the receipt and failure surfaces also need live
 * here, because this file is the one they both already depend on.
 */

// ---------------------------------------------------------------------------
// small shared parts
// ---------------------------------------------------------------------------

/** the system a fact came from, with the `test` instance called out loud */
export function SystemTag({ system, instance }: { system?: SystemKey; instance?: "prod" | "test" }) {
  if (!system) return null;
  return (
    <span className={cn("inline-flex items-center gap-[var(--ds-space-hair)]", dsText.caps, "text-[color:var(--ds-fg-muted)]")}>
      {system.toUpperCase()}
      {instance === "test" && (
        <span className="text-[color:var(--ds-status-waiting-fg)]">· TEST</span>
      )}
    </span>
  );
}

/** the browser half of an export — the content itself is built in the wire module */
export function downloadDemoFile(filename: string, body: string, type: string): void {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Evidence bar + capture lightbox (D19b)
// ---------------------------------------------------------------------------

const KIND_ORDER: DemoCaptureKind[] = ["error", "step", "form"];

/**
 * The capture frame. The demo corpus carries no image BYTES, and a drawn
 * approximation of a UCPath page on a trust surface would be the exact kind of
 * fabrication this rebuild exists to stop. So the frame renders what the
 * backend actually serves about the capture and says plainly what it is.
 */
function CaptureFrame({ capture, className }: { capture: DemoCapture; className?: string }) {
  return (
    <div
      role="img"
      aria-label={`${capture.label} — ${capture.failure ? "failure capture" : `${capture.kind} capture`}${capture.screen ? ` of ${capture.screen}` : ""}. Image bytes are not part of the demo corpus.`}
      className={cn(
        "flex flex-col items-center justify-center gap-[var(--ds-space-base)] border p-[var(--ds-space-loose)]",
        "rounded-[var(--ds-radius-lg)] bg-[var(--ds-surface-2)]",
        capture.failure
          ? "border-[length:var(--ds-border-w-rail)] border-[color:var(--ds-danger)]"
          : "border-[color:var(--ds-border)]",
        className,
      )}
    >
      <ImageOff aria-hidden className="size-6 text-[color:var(--ds-fg-faint)]" />
      <span className={cn(dsText.body, "text-center text-[color:var(--ds-fg-muted)]")}>
        The capture itself is a PNG in content-addressed storage. The demo corpus carries its metadata, not its bytes —
        drawing a stand-in of a real system page on an evidence surface is the one thing this view must never do.
      </span>
      {capture.ref && (
        <span className={cn(dsText.meta, dsText.nums, "text-[color:var(--ds-fg-faint)]")}>{capture.ref}</span>
      )}
    </div>
  );
}

function CaptureLightbox({
  captures,
  index,
  onIndex,
  onClose,
  row,
}: {
  captures: DemoCapture[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  row: DemoRow;
}) {
  const capture = captures[index];
  const step = useCallback(
    (delta: number) => onIndex((index + delta + captures.length) % captures.length),
    [captures.length, index, onIndex],
  );

  /**
   * Arrow keys page through the captures, Home/End jump to the ends. Bound in
   * the CAPTURE phase and stopped there, so the shell's own window-level queue
   * navigation cannot move the row behind an open lightbox. Escape is Radix's.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const handled: Record<string, () => void> = {
        ArrowRight: () => step(1),
        ArrowDown: () => step(1),
        ArrowLeft: () => step(-1),
        ArrowUp: () => step(-1),
        Home: () => onIndex(0),
        End: () => onIndex(captures.length - 1),
      };
      const run = handled[e.key];
      if (!run) return;
      e.preventDefault();
      e.stopPropagation();
      run();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [captures.length, onIndex, step]);

  if (!capture) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="xl"
        title={`${capture.label} — capture ${index + 1} of ${captures.length}`}
        description={`${capture.failure ? "Failure capture" : `${capture.kind} capture`} · ${row.displayName ?? row.title} · ${row.trace}`}
      >
        <DialogBody className="flex flex-col gap-[var(--ds-space-cozy)]">
          {capture.failure && (
            <Banner tone="danger" title="This is the frame captured at the failure">
              A red frame means the run was already broken when this was taken. It is the page the failure record points at.
            </Banner>
          )}

          <CaptureFrame capture={capture} className="min-h-[220px]" />

          <KeyValueList
            items={[
              { key: "Label", value: capture.label },
              { key: "Kind", value: capture.failure ? "error — failure capture" : capture.kind },
              ...(capture.step ? [{ key: "Step", value: capture.step }] : []),
              ...(capture.system ? [{ key: "System", value: capture.system.toUpperCase() }] : []),
              ...(capture.capturedAt ? [{ key: "Captured", value: fmtClock(capture.capturedAt) }] : []),
              ...(capture.screen ? [{ key: "Screen", value: capture.screen }] : []),
              ...(capture.pageState ? [{ key: "Page state", value: capture.pageState }] : []),
              ...(capture.urlRedacted ? [{ key: "URL (redacted)", value: capture.urlRedacted }] : []),
              ...(capture.size ? [{ key: "Viewport", value: `${capture.size.w} × ${capture.size.h}` }] : []),
              ...(capture.ref ? [{ key: "Content ref", value: capture.ref }] : []),
              { key: "Run", value: row.trace },
            ]}
          />
          {capture.note && (
            <p className={cn(dsText.body, "text-[color:var(--ds-fg-secondary)]")}>{capture.note}</p>
          )}

          {captures.length > 1 && (
            <div className="flex flex-col gap-[var(--ds-space-tight)]">
              <SectionLabel>All captures on this run</SectionLabel>
              <div role="tablist" aria-label="Captures" className="flex flex-wrap gap-[var(--ds-space-snug)]">
                {captures.map((c, i) => (
                  <button
                    key={c.id}
                    type="button"
                    role="tab"
                    aria-selected={i === index}
                    aria-label={`Show capture ${i + 1} of ${captures.length} — ${c.label}`}
                    onClick={() => onIndex(i)}
                    className={cn(
                      "flex h-[var(--ds-h-lg)] items-center gap-[var(--ds-space-tight)] border px-[var(--ds-space-base)]",
                      "rounded-[var(--ds-radius-md)]",
                      dsText.meta,
                      dsFocus,
                      i === index
                        ? "border-[color:var(--ds-border-loud)] bg-[var(--ds-surface-selected)] text-[color:var(--ds-fg)]"
                        : "border-[color:var(--ds-border)] bg-[var(--ds-surface-2)] text-[color:var(--ds-fg-muted)]",
                      c.failure && "border-[color:var(--ds-danger)] text-[color:var(--ds-danger)]",
                    )}
                  >
                    <Camera aria-hidden className={dsIcon.sm} />
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </DialogBody>

        <DialogFooter className="justify-between">
          <span className={cn(dsText.meta, dsText.nums, "text-[color:var(--ds-fg-muted)]")}>
            ← → to page through · Esc to close
          </span>
          <span className="flex items-center gap-[var(--ds-space-base)]">
            <Button variant="secondary" icon={<ChevronLeft aria-hidden className={dsIcon.md} />} onClick={() => step(-1)} disabled={captures.length < 2}>
              Previous
            </Button>
            <Button variant="secondary" iconAfter={<ChevronRight aria-hidden className={dsIcon.md} />} onClick={() => step(1)} disabled={captures.length < 2}>
              Next
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The evidence bar — D19b: images sit ABOVE the tabs, with no count label, and a
 * failure capture carries a red frame. The filter chips and the export menu are
 * the two affordances the legacy Screenshots tab had that the operator kept
 * (`legacy-keep-ditch` §4.20).
 */
export function EvidenceBar({ row }: { row: DemoRow }) {
  const captures = useMemo(() => capturesFor(row), [row]);
  const [kind, setKind] = useState<DemoCaptureKind | "all">("all");
  const [open, setOpen] = useState<number | null>(null);
  const { toast } = useToasts();

  useEffect(() => {
    setKind("all");
    setOpen(null);
  }, [row.id]);

  const present = KIND_ORDER.filter((k) => captures.some((c) => c.kind === k));
  const active = present.includes(kind as DemoCaptureKind) ? kind : "all";
  const shown = active === "all" ? captures : captures.filter((c) => c.kind === active);

  const copyTrace = () => {
    void navigator.clipboard
      ?.writeText(row.trace)
      .then(() => toast({ tone: "success", title: "Trace id copied", description: row.trace }))
      .catch(() =>
        toast({
          tone: "danger",
          title: "Could not copy the trace id",
          description: `The browser refused clipboard access. The id is ${row.trace} — copy it from here.`,
        }),
      );
  };

  return (
    <div className="flex items-center gap-[var(--ds-space-base)] border-b border-border/60 px-3 py-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-[var(--ds-space-snug)] overflow-x-auto">
        {present.length > 1 && (
          <>
            <Chip label="show" selected={active === "all"} onSelect={() => setKind("all")}>
              {`All ${captures.length}`}
            </Chip>
            {present.map((k) => (
              <Chip
                key={k}
                tone={k === "error" ? "danger" : "neutral"}
                selected={active === k}
                onSelect={() => setKind(k)}
              >
                {`${CAPTURE_KIND_LABEL[k]} ${captures.filter((c) => c.kind === k).length}`}
              </Chip>
            ))}
            <Separator orientation="vertical" className="mx-[var(--ds-space-hair)] h-[var(--ds-h-xs)]" />
          </>
        )}

        {shown.length === 0 ? (
          <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
            {captures.length === 0
              ? "No captures — this run has not reached a step that takes one."
              : "No captures of that kind on this run."}
          </span>
        ) : (
          shown.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setOpen(captures.indexOf(c))}
              aria-label={`Open capture — ${c.label}${c.failure ? " (failure capture)" : ""}`}
              title={`${c.label}${c.capturedAt ? ` · ${fmtClock(c.capturedAt)}` : ""}`}
              className={cn(
                "flex h-10 w-[4.75rem] shrink-0 flex-col items-center justify-center gap-0.5 border bg-[var(--ds-surface-2)]",
                "rounded-[var(--ds-radius-md)]",
                dsFocus,
                c.failure
                  ? "border-[length:var(--ds-border-w-rail)] border-[color:var(--ds-danger)]"
                  : "border-[color:var(--ds-border)] hover:border-[color:var(--ds-border-loud)]",
              )}
            >
              <Camera
                aria-hidden
                className={cn(dsIcon.sm, c.failure ? "text-[color:var(--ds-danger)]" : "text-[color:var(--ds-fg-muted)]")}
              />
              <span className={cn("max-w-full truncate px-1", dsText.micro, "text-[color:var(--ds-fg-muted)]")}>{c.label}</span>
            </button>
          ))
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Export this run"
            className={cn(
              "inline-flex shrink-0 items-center gap-[var(--ds-space-tight)] border px-[var(--ds-space-base)]",
              "h-[var(--ds-h-sm)] rounded-[var(--ds-radius-md)] border-[color:var(--ds-border)] bg-[var(--ds-surface-1)]",
              dsText.meta,
              dsFocus,
              "text-[color:var(--ds-fg-secondary)]",
            )}
          >
            <Download aria-hidden className={dsIcon.sm} />
            Export
            <ChevronDown aria-hidden className={dsIcon.sm} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[240px]">
          <DropdownMenuItem
            className="text-[12px]"
            onSelect={() => {
              downloadDemoFile(`${row.trace}-logs.txt`, exportRunLogsText(row), "text/plain");
              toast({ tone: "success", title: "Logs exported", description: `${row.trace}-logs.txt — the run's own lines, nothing added.` });
            }}
          >
            <FileText aria-hidden className="mr-2 size-3.5" />
            Logs as .txt
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-[12px]"
            onSelect={() => {
              downloadDemoFile(`${row.trace}-run.json`, exportRunJson(row), "application/json");
              toast({
                tone: "success",
                title: "Run exported",
                description: `${row.trace}-run.json — the served row, its receipt, its failure record and its captures.`,
              });
            }}
          >
            <FileJson aria-hidden className="mr-2 size-3.5" />
            Run as .json
          </DropdownMenuItem>
          <DropdownMenuItem className="text-[12px]" onSelect={copyTrace}>
            <Copy aria-hidden className="mr-2 size-3.5" />
            Copy the trace id
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {open !== null && (
        <CaptureLightbox captures={captures} index={open} onIndex={setOpen} onClose={() => setOpen(null)} row={row} />
      )}
    </div>
  );
}
