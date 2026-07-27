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
  dsFocus,
  dsIcon,
  dsMotion,
  dsText,
  useToasts,
} from "./demo-ui";
import { fmtClock, type SystemKey } from "./demo-wire";
import { SYSTEM_ACCENT, type DemoRow } from "./demo-data";
import {
  CAPTURE_KIND_LABEL,
  capturesFor,
  exportRunJson,
  exportRunLogsText,
  type DemoCapture,
  type DemoCaptureKind,
} from "./demo-evidence-wire";

/**
 * DEV-ONLY — the evidence section and its capture lightbox (D19b: evidence is
 * never a tab of its own), plus the run export the legacy Screenshots tab
 * carried and the operator kept.
 *
 * It is built from the row's own `shots`, so the section and the lightbox can
 * never show different sets, and a failure capture carries a red frame in both.
 * The two shared atoms the receipt and failure surfaces also need live here,
 * because this file is the one they both already depend on.
 */

// ---------------------------------------------------------------------------
// small shared parts
// ---------------------------------------------------------------------------

/**
 * The dense system marker used inside a stream or a ledger row — the same atom
 * on the log line and on the Data row, so a `UCPATH` beside a value in the rail
 * and a `UCPATH` beside a line in the stream read as one thing. It lives here
 * with the other shared atoms because this is the file both surfaces already
 * depend on; forking a second copy is how the two drifted before.
 */
export function SystemChip({ system, className }: { system: SystemKey; className?: string }) {
  return (
    <span
      className={cn(
        "mr-1.5 inline-block rounded px-1 align-[1px] text-[9px] font-bold tracking-wider",
        SYSTEM_ACCENT[system],
        className,
      )}
    >
      {system.toUpperCase()}
    </span>
  );
}

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

const KIND_ORDER: DemoCaptureKind[] = ["error", "confirmation", "step", "form"];

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
      <ImageOff aria-hidden className={cn(dsIcon.lg, "text-[color:var(--ds-fg-faint)]")} />
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

/**
 * Exported because the identity gate needs the SAME viewer for its per-candidate
 * captures. A candidate capture opened from a decision and a step capture opened
 * from the rail are the same artefact seen from two places — giving the gate its
 * own smaller viewer would have meant a second set of honesty copy to keep in
 * step with this one.
 */
export function CaptureLightbox({
  captures,
  index,
  onIndex,
  onClose,
  subject,
}: {
  captures: DemoCapture[];
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  /**
   * Whose captures these are. Deliberately NOT a `DemoRow`: an archived run is
   * a stored snapshot, not a projected row, and it needs exactly this viewer.
   * Narrowing the prop to the two facts the surface actually prints is what
   * lets the archive reuse it instead of growing a second one.
   */
  subject: { label: string; trace: string };
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
        description={`${capture.failure ? "Failure capture" : `${capture.kind} capture`} · ${subject.label} · ${subject.trace}`}
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
              { key: "Run", value: subject.trace },
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
 * The evidence SECTION — D19b's "evidence is not a tab", now given the room it
 * was always short of. It used to be a 52px strip wedged between the timeline
 * and the tabs, where a capture got a 76×40 chip and its label truncated to
 * three characters. In the context rail each capture is a real tile: kind,
 * label, the step it was taken on and the clock, so the operator can tell two
 * captures apart without opening either.
 *
 * The filter chips and the export menu are the two affordances the legacy
 * Screenshots tab had that the operator kept (`legacy-keep-ditch` §4.20), and
 * both carried over unchanged.
 */
export function EvidenceSection({ row }: { row: DemoRow }) {
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
    <section aria-label="Evidence" className="flex flex-col gap-[var(--ds-space-snug)]">
      <div className="flex items-center gap-[var(--ds-space-snug)]">
        <SectionLabel className="min-w-0 truncate">Evidence</SectionLabel>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Export this run"
              className={cn(
                "ml-auto inline-flex shrink-0 items-center gap-[var(--ds-space-tight)] border px-[var(--ds-space-base)]",
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
              className={dsText.body}
              onSelect={() => {
                downloadDemoFile(`${row.trace}-logs.txt`, exportRunLogsText(row), "text/plain");
                toast({ tone: "success", title: "Logs exported", description: `${row.trace}-logs.txt — the run's own lines, nothing added.` });
              }}
            >
              <FileText aria-hidden className={cn("mr-2", dsIcon.md)} />
              Logs as .txt
            </DropdownMenuItem>
            <DropdownMenuItem
              className={dsText.body}
              onSelect={() => {
                downloadDemoFile(`${row.trace}-run.json`, exportRunJson(row), "application/json");
                toast({
                  tone: "success",
                  title: "Run exported",
                  description: `${row.trace}-run.json — the served row, its receipt, its failure record and its captures.`,
                });
              }}
            >
              <FileJson aria-hidden className={cn("mr-2", dsIcon.md)} />
              Run as .json
            </DropdownMenuItem>
            <DropdownMenuItem className={dsText.body} onSelect={copyTrace}>
              <Copy aria-hidden className={cn("mr-2", dsIcon.md)} />
              Copy the trace id
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {present.length > 1 && (
        <div className="flex flex-wrap items-center gap-[var(--ds-space-tight)]">
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
        </div>
      )}

      {shown.length === 0 ? (
        <p className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
          {captures.length === 0
            ? "No captures — this run has not reached a step that takes one."
            : "No captures of that kind on this run."}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-[var(--ds-space-snug)]">
          {shown.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setOpen(captures.indexOf(c))}
              aria-label={`Open capture — ${c.label}${c.failure ? " (failure capture)" : ""}`}
              className={cn(
                "flex min-w-0 flex-col items-start gap-[var(--ds-space-hair)] border bg-[var(--ds-surface-2)] text-left",
                "px-[var(--ds-space-snug)] py-[var(--ds-space-snug)] rounded-[var(--ds-radius-md)]",
                dsFocus,
                dsMotion.fast,
                // it opens the lightbox — a real command, so it dips like every
                // other pressable in the system
                "active:translate-y-px",
                c.failure
                  ? "border-[length:var(--ds-border-w-rail)] border-[color:var(--ds-danger)]"
                  : "border-[color:var(--ds-border)] hover:border-[color:var(--ds-border-loud)] hover:bg-[var(--ds-surface-3)]",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "flex h-9 w-full items-center justify-center border bg-[var(--ds-surface-1)] rounded-[var(--ds-radius-sm)]",
                  c.failure ? "border-[color:var(--ds-danger-border)]" : "border-[color:var(--ds-border-subtle)]",
                )}
              >
                <Camera
                  className={cn(dsIcon.md, c.failure ? "text-[color:var(--ds-danger)]" : "text-[color:var(--ds-fg-muted)]")}
                />
              </span>
              <span
                className={cn(
                  "w-full truncate",
                  dsText.meta,
                  c.failure ? "text-[color:var(--ds-danger)]" : "text-[color:var(--ds-fg-secondary)]",
                )}
              >
                {c.label}
              </span>
              <span className={cn("w-full truncate", dsText.micro, "text-[color:var(--ds-fg-muted)]")}>
                {[CAPTURE_KIND_LABEL[c.kind], c.step, c.capturedAt && fmtClock(c.capturedAt)].filter(Boolean).join(" · ")}
              </span>
            </button>
          ))}
        </div>
      )}

      {open !== null && (
        <CaptureLightbox
          captures={captures}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          subject={{ label: row.displayName ?? row.title, trace: row.trace }}
        />
      )}
    </section>
  );
}
