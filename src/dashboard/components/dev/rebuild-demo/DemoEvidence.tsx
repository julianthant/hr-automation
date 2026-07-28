import { useCallback, useEffect, useMemo, useState } from "react";
import { Camera, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, FileJson, FileText, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  Badge,
  Banner,
  BulletList,
  Button,
  Chip,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogFooter,
  IconButton,
  KeyValueList,
  MetaLine,
  SectionLabel,
  dsClip,
  dsFocus,
  dsIcon,
  dsMotion,
  dsRadius,
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
  type DemoPageExtraction,
  type DemoPageFacsimile,
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
        // 9px is below the type floor — the system a line came from is a fact
        // the operator reads, not a watermark. `micro` (10px) is the smallest
        // size in the system and the one every other count badge uses.
        "mr-[var(--ds-space-tight)] inline-block px-[var(--ds-space-tight)] align-[1px] font-bold",
        dsClip.token,
        dsRadius.xs,
        dsText.caps,
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
/**
 * A capture's own SHAPE, as a CSS aspect ratio.
 *
 * The backend serves the captured dimensions and nothing was using them — the
 * frame took a hand-picked `min-h`, so a portrait document page and a landscape
 * browser viewport were drawn as the same box. They are not the same shape, and
 * the shape is the cheapest true thing a placeholder can say about the image it
 * is standing in for.
 *
 * A capture with no served size falls back to the LETTER token, because every
 * capture in this product is either a page or a screen and the page is what a
 * placeholder with no dimensions is most likely to be standing in for. The
 * fallback is a shape, never a claim: nothing here says the image is that size.
 */
export function captureAspect(capture: DemoCapture): string {
  return capture.size ? `${capture.size.w} / ${capture.size.h}` : "var(--ds-aspect-page)";
}

/** the same ratio as a NUMBER, for deriving a width from a height budget */
function captureAspectValue(capture: DemoCapture): number {
  // US Letter when the capture serves no dimensions — the same fallback
  // `captureAspect` states, kept beside it so the two cannot drift.
  return capture.size ? capture.size.w / capture.size.h : 612 / 792;
}

/**
 * THE PAGE, DRAWN FROM THE RECORD BESIDE IT — and marked, on its face, as a
 * demo rendering.
 *
 * The rule the placeholder frame protects is that an evidence surface never
 * draws an approximation of a REAL system page. This does not break it: it is
 * not a picture of anyone's document, it is the SYNTHETIC record rendered on
 * the synthetic form's layout, with a `synthetic` marker in the corner that
 * scrolls with it. The demo needed one so the viewer could be designed at its
 * real size — a full-screen lightbox judged entirely on an empty grey box tells
 * you nothing about the proportions of the thing that ships.
 *
 * The real scans are not an option and never were: they are live HR documents
 * with live PII, and this repo will not commit them into a demo bundle.
 */
export function PageFacsimile({ page }: { page: DemoPageFacsimile }) {
  return (
    <div className="flex h-full w-full flex-col gap-[var(--ds-space-snug)] overflow-hidden bg-[var(--ds-paper-bg)] p-[var(--ds-space-cozy)] text-[color:var(--ds-paper-fg)]">
      <div className="flex shrink-0 items-start justify-between gap-[var(--ds-space-snug)] border-b border-[color:var(--ds-paper-rule)] pb-[var(--ds-space-snug)]">
        <span className="flex min-w-0 flex-col">
          <span className={cn(dsText.body, "font-semibold uppercase tracking-wide")}>{page.formTitle}</span>
          <span className={cn(dsText.meta, "text-[color:var(--ds-paper-fg-quiet)]")}>{page.agency}</span>
        </span>
        {/* The one piece of chrome on the page, and it is a REFUSAL to be
            mistaken for the artefact — allowed prose under the design rule for
            exactly that reason. */}
        <span
          className={cn(
            dsText.meta,
            dsRadius.sm,
            "shrink-0 border border-[color:var(--ds-paper-rule)] px-[var(--ds-space-tight)] uppercase tracking-wide",
            "text-[color:var(--ds-paper-fg-quiet)]",
          )}
        >
          synthetic
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-[var(--ds-space-snug)] overflow-hidden">
        {page.sections.map((section) => (
          <div key={section.heading} className="flex min-w-0 flex-col gap-[var(--ds-space-tight)]">
            <span className={cn(dsText.meta, "font-semibold uppercase tracking-wide text-[color:var(--ds-paper-fg-quiet)]")}>
              {section.heading}
            </span>
            {section.fields.map((f) => (
              <span
                key={f.label}
                className="flex min-w-0 items-baseline gap-[var(--ds-space-snug)] border-b border-[color:var(--ds-paper-rule)] pb-[var(--ds-space-hair)]"
              >
                <span className={cn(dsText.meta, "w-[12ch] shrink-0 text-[color:var(--ds-paper-fg-quiet)]")}>{f.label}</span>
                <span className={cn(dsText.meta, "min-w-0 flex-1 truncate", f.hand && "font-medium italic")}>{f.value}</span>
              </span>
            ))}
          </div>
        ))}
      </div>

      <div className="flex shrink-0 flex-wrap items-end gap-[var(--ds-space-cozy)] border-t border-[color:var(--ds-paper-rule)] pt-[var(--ds-space-snug)]">
        {page.signatures.map((s) => (
          <span key={s.label} className="flex min-w-[16ch] flex-1 flex-col">
            <span className={cn(dsText.meta, "truncate italic", !s.signedBy && "text-[color:var(--ds-paper-fg-quiet)]")}>
              {s.signedBy ?? "—"}
            </span>
            <span className="border-t border-[color:var(--ds-paper-rule)]" />
            <span className={cn(dsText.meta, "truncate text-[color:var(--ds-paper-fg-quiet)]")}>
              {s.label}
              {s.date ? ` · ${s.date}` : ""}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * WHAT THE PAGE GAVE UP, beside the page.
 *
 * The panel this joins was, on a packet capture, entirely empty — the viewer
 * gave 40% of a full-screen dialog to a column headed `What was recorded` that
 * recorded nothing, because no metadata was served for those captures. The fix
 * is not layout: it is that a page capture now serves its EXTRACTION, which is
 * the only thing an operator opens a packet page to check.
 *
 * A field that was NOT read is as load-bearing as one that was — `missing` and
 * `illegible` are the extractor's two ways of saying "do not trust a value
 * here", and each carries the reason it said it. They are told apart by a
 * pill's tone and by the word in it, never by colour alone.
 */
function ExtractionRecord({ extraction }: { extraction: DemoPageExtraction }) {
  const unread = extraction.fields.filter((f) => f.state !== "read");
  return (
    <div className="flex min-w-0 flex-col gap-[var(--ds-space-snug)]">
      <div className="flex items-center gap-[var(--ds-space-snug)]">
        <SectionLabel className="min-w-0 truncate">Extracted fields</SectionLabel>
        <Badge tone={unread.length > 0 ? "warning" : "neutral"}>
          {unread.length > 0 ? `${extraction.fields.length - unread.length}/${extraction.fields.length}` : extraction.fields.length}
        </Badge>
      </div>
      <MetaLine
        items={[
          extraction.formKind,
          extraction.sourcePdf,
          `page ${extraction.sourcePage} of ${extraction.pageCount}`,
        ]}
      />
      <div
        className={cn(
          "flex flex-col divide-y overflow-hidden border",
          dsRadius.md,
          "divide-[color:var(--ds-border-subtle)] border-[color:var(--ds-border)]",
        )}
      >
        {extraction.fields.map((f) => (
          <div
            key={f.key}
            className="flex min-w-0 flex-col gap-[var(--ds-space-hair)] bg-[var(--ds-recess-bg)] px-[var(--ds-space-snug)] py-[var(--ds-space-tight)]"
          >
            <div className="flex min-w-0 items-baseline gap-[var(--ds-space-snug)]">
              <span className={cn(dsText.meta, "min-w-0 flex-1 truncate text-[color:var(--ds-recess-fg-quiet)]")}>
                {f.key}
              </span>
              {f.state === "read" ? (
                <span className={cn(dsText.meta, dsClip.text, "min-w-0 max-w-[18ch] text-[color:var(--ds-fg)]")}>
                  {f.value}
                </span>
              ) : (
                <Badge tone={f.state === "illegible" ? "warning" : "neutral"}>{f.state}</Badge>
              )}
            </div>
            <MetaLine
              tone="faint"
              items={[
                f.source,
                f.confidence !== undefined ? `${Math.round(f.confidence * 100)}% confident` : undefined,
              ]}
            />
            {f.reason && (
              <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>{f.reason}</span>
            )}
          </div>
        ))}
      </div>
      {extraction.notes.length > 0 && (
        <span className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
          <BulletList items={extraction.notes} />
        </span>
      )}
    </div>
  );
}

function CaptureFrame({ capture, className }: { capture: DemoCapture; className?: string }) {
  const [ruleOpen, setRuleOpen] = useState(false);

  if (capture.facsimile) {
    return (
      <div
        role="img"
        aria-label={`${capture.label} — a synthetic rendering of the ${capture.extraction?.formKind ?? capture.kind} page, drawn from the extraction record beside it. Not a photograph of a real document.`}
        style={{
          aspectRatio: captureAspect(capture),
          maxHeight: "var(--ds-h-capture-box)",
          width: `min(100%, calc(var(--ds-h-capture-box) * ${captureAspectValue(capture)}))`,
        }}
        className={cn(
          "mx-auto overflow-hidden border",
          dsRadius.lg,
          capture.failure
            ? "border-[length:var(--ds-border-w-rail)] border-[color:var(--ds-danger)]"
            : "border-[color:var(--ds-border)]",
          className,
        )}
      >
        <PageFacsimile page={capture.facsimile} />
      </div>
    );
  }

  return (
    <div
      role="img"
      aria-label={`${capture.label} — ${capture.failure ? "failure capture" : `${capture.kind} capture`}${capture.screen ? ` of ${capture.screen}` : ""}${capture.size ? `, ${capture.size.w} × ${capture.size.h}` : ""}. The demo serves capture metadata for this frame, without a preview.`}
      // WIDTH IS DERIVED FROM THE HEIGHT BUDGET, never clamped after the fact —
      // `aspect-ratio` + `width: 100%` + `max-height` is a conflict the browser
      // resolves by dropping the RATIO, which is how a 612 × 792 page came to
      // be drawn landscape. `--ds-h-capture-box` is the box the column gives
      // it; the width falls out of the served ratio, so the SHAPE is never the
      // thing that gives.
      style={{
        aspectRatio: captureAspect(capture),
        maxHeight: "var(--ds-h-capture-box)",
        width: `min(100%, calc(var(--ds-h-capture-box) * ${captureAspectValue(capture)}))`,
      }}
      className={cn(
        "mx-auto flex flex-col items-center justify-center gap-[var(--ds-space-base)] border p-[var(--ds-space-loose)]",
        "rounded-[var(--ds-radius-lg)] bg-[var(--ds-surface-2)]",
        capture.failure
          ? "border-[length:var(--ds-border-w-rail)] border-[color:var(--ds-danger)]"
          : "border-[color:var(--ds-border)]",
        className,
      )}
    >
      <Camera aria-hidden className={cn(dsIcon.lg, "text-[color:var(--ds-fg-faint)]")} />
      {/* A STATEMENT AND AN ⓘ, not a paragraph.

          It was three lines of prose in the middle of every capture frame in
          the product, and two of those lines were the RULE (why a stand-in is
          never drawn) rather than the fact (there are no bytes here). The rule
          is worth keeping and it is worth keeping ONCE, behind a press; the
          fact is four words and stays on the surface, because "this is not the
          image" is the one thing the frame has to say.

          THE RULE ITSELF DOES NOT MOVE: nothing here ever draws an
          approximation of a real system page on an evidence surface. */}
      <span className={cn(dsText.body, "flex items-center gap-[var(--ds-space-tight)] text-[color:var(--ds-fg-muted)]")}>
        Capture metadata only
        {/* An IN-PLACE disclosure, not a `Popover`. This frame's main home is
            INSIDE the capture lightbox, and a Popover portals at `dsLayer.menu`
            (z-20) under a Dialog at z-40 — it would open behind the very dialog
            that contains it. Anything disclosed from inside a dialog is
            disclosed inside the dialog. */}
        <IconButton
          size="xs"
          label="Why there is no image here"
          aria-expanded={ruleOpen}
          onClick={() => setRuleOpen((v) => !v)}
          icon={<Info aria-hidden className={dsIcon.sm} />}
        />
      </span>
      {ruleOpen && (
        <span className={cn(dsText.meta, "max-w-[46ch] text-left text-[color:var(--ds-fg-muted)]")}>
          <BulletList
            items={[
              "The capture preview lives in content-addressed storage; this demo fixture carries the capture record, not that preview.",
              "Drawing a stand-in of a real system page on an evidence surface is the one thing this view must never do — a picture of a UCPath page that was never taken is exactly the fabrication the rebuild exists to stop.",
              "Everything the backend does serve about this capture is listed beside it.",
            ]}
          />
        </span>
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
        {/*
          TWO COLUMNS, AND THE CAPTURE GETS THE ROOM.

          It was a single stack — image, then eleven metadata rows, then the
          capture chips, then the footer — so the thing the viewer exists to
          show got about a third of the height and every one of its facts was
          below the fold. A viewer whose subject is the smallest element on it
          is not a viewer.

          Left column (wider) is the CAPTURE, right column (narrower) is what
          the backend serves about it, with a hairline between them, and both
          are cut to `--ds-h-capture-box` so the two columns END ON THE SAME
          LINE. The metadata scrolls inside its own column rather than pushing
          the image shorter — the capture's height is a constant, which is what
          makes paging through a set feel like paging rather than reflowing.

          `@container`, not a media query: this is inside a dialog whose width
          is a token, so what decides whether the two columns fit is the
          DIALOG's width and never the window's.
        */}
        <DialogBody className="@container flex min-h-0 flex-col gap-[var(--ds-space-cozy)]">
          {capture.failure && (
            <Banner tone="danger" title="This is the frame captured at the failure">
              The run was already broken when this was taken. It is the page the failure record points at.
            </Banner>
          )}

          <div className="grid min-h-0 grid-cols-1 gap-[var(--ds-space-cozy)] @min-[52rem]:grid-cols-[minmax(0,1.6fr)_1px_minmax(0,1fr)]">
            {/* ---- the capture, with its nav in FIXED gutters -------------- */}
            <div className="flex min-w-0 flex-col gap-[var(--ds-space-snug)]">
              <div className="flex min-w-0 items-center gap-[var(--ds-space-snug)]">
                {/*
                  THE ARROWS LIVE IN GUTTERS OF A FIXED WIDTH, flanking a box of
                  a fixed height. Production shipped the bug this avoids: the
                  chrome was positioned on a frame that hugged each image, so
                  the arrows MOVED between two differently-sized captures and
                  paging through a set became a game of chasing the button. A
                  gutter is a column; a column does not move.
                */}
                <CaptureNavButton
                  dir="prev"
                  disabled={captures.length < 2}
                  onClick={() => step(-1)}
                />
                <div
                  className="flex min-w-0 flex-1 items-center justify-center"
                  style={{ height: "var(--ds-h-capture-box)" }}
                >
                  <CaptureFrame capture={capture} />
                </div>
                <CaptureNavButton
                  dir="next"
                  disabled={captures.length < 2}
                  onClick={() => step(1)}
                />
              </div>

              {/*
                THE THUMBNAIL STRIP, along the bottom of the column it belongs
                to. It was a wrapping row of labelled chips below the metadata,
                three bands away from the image it cycles — so the control that
                changes the capture was nowhere near the capture. Here it is
                part of the same column, it scrolls sideways rather than
                wrapping (a second row of thumbnails would change the column's
                height, and the two columns are supposed to end level), and the
                current one is marked by a fill and a ring rather than by
                colour alone.
              */}
              {captures.length > 1 && (
                <div
                  role="tablist"
                  aria-label="Captures on this run"
                  className={cn(
                    "flex shrink-0 items-center gap-[var(--ds-space-tight)] overflow-x-auto",
                    "h-[var(--ds-h-capture-thumb)]",
                  )}
                >
                  {captures.map((c, i) => (
                    <button
                      key={c.id}
                      type="button"
                      role="tab"
                      aria-selected={i === index}
                      aria-label={`Show capture ${i + 1} of ${captures.length} — ${c.label}`}
                      title={c.label}
                      onClick={() => onIndex(i)}
                      className={cn(
                        "flex h-full shrink-0 items-center gap-[var(--ds-space-tight)] border",
                        "px-[var(--ds-space-base)]",
                        dsRadius.md,
                        dsText.meta,
                        dsClip.token,
                        dsFocus,
                        dsMotion.fast,
                        "active:translate-y-px",
                        i === index
                          ? "border-[color:var(--ds-border-loud)] bg-[var(--ds-surface-selected)] text-[color:var(--ds-fg)]"
                          : "border-[color:var(--ds-recess-border)] bg-[var(--ds-recess-bg)] text-[color:var(--ds-recess-fg-quiet)]",
                        c.failure && "border-[color:var(--ds-danger)] text-[color:var(--ds-danger)]",
                      )}
                    >
                      <span className={cn(dsText.nums, "shrink-0")}>{i + 1}</span>
                      <Camera aria-hidden className={cn(dsIcon.sm, "shrink-0")} />
                      <span className={dsClip.text}>{c.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* the divider is a GRID TRACK, so it is exactly as tall as the
                taller column and needs no height of its own */}
            <span aria-hidden className="hidden bg-[color:var(--ds-border)] @min-[52rem]:block" />

            {/* ---- what the backend serves about it ----------------------- */}
            <div
              className="flex min-w-0 flex-col gap-[var(--ds-space-snug)] overflow-y-auto"
              style={{ maxHeight: "calc(var(--ds-h-capture-box) + var(--ds-h-capture-thumb))" }}
            >
              <SectionLabel>What was recorded</SectionLabel>
              {/*
                THE DIALOG'S OWN HEADER ALREADY SAID THREE OF THESE. `Label`,
                `Kind` and `Run` were in the title and the description a
                centimetre above, and the content ref was printed inside the
                frame as well as here. A metadata column that opens by
                repeating the title is a column the eye learns to start
                halfway down.
              */}
              <KeyValueList
                items={[
                  ...(capture.step ? [{ key: "Step", value: capture.step }] : []),
                  ...(capture.system ? [{ key: "System", value: capture.system.toUpperCase() }] : []),
                  ...(capture.capturedAt ? [{ key: "Captured", value: fmtClock(capture.capturedAt) }] : []),
                  ...(capture.screen ? [{ key: "Screen", value: capture.screen }] : []),
                  ...(capture.pageState ? [{ key: "Page state", value: capture.pageState }] : []),
                  ...(capture.urlRedacted ? [{ key: "URL (redacted)", value: capture.urlRedacted }] : []),
                  ...(capture.size ? [{ key: "Viewport", value: `${capture.size.w} × ${capture.size.h}` }] : []),
                  ...(capture.ref ? [{ key: "Content ref", value: capture.ref }] : []),
                ]}
              />
              {capture.note && (
                <p className={cn(dsText.body, "text-[color:var(--ds-fg-secondary)]")}>{capture.note}</p>
              )}
              {capture.extraction && <ExtractionRecord extraction={capture.extraction} />}
            </div>
          </div>
        </DialogBody>

        {/* The gutters and the strip carry the paging, so the footer stops
            re-offering it as two more buttons. What is left is the keyboard
            route (quiet, left) and the one way out. */}
        <DialogFooter
          meta={
            <MetaLine
              tone="faint"
              items={[`${index + 1} of ${captures.length}`, "← → to page through", "Esc to close"]}
            />
          }
        >
          <DialogClose asChild>
            <Button variant="secondary">Close</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The prev/next control, in a gutter of its own. A fixed width is the whole
 * point — see the note at its call site.
 */
function CaptureNavButton({ dir, disabled, onClick }: { dir: "prev" | "next"; disabled: boolean; onClick: () => void }) {
  const Icon = dir === "prev" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={dir === "prev" ? "Previous capture" : "Next capture"}
      className={cn(
        "flex w-[var(--ds-h-lg)] shrink-0 items-center justify-center self-stretch border",
        "border-[color:var(--ds-recess-border)] bg-[var(--ds-recess-bg)]",
        dsRadius.md,
        dsFocus,
        dsMotion.fast,
        "cursor-pointer text-[color:var(--ds-fg-secondary)]",
        "hover:bg-[var(--ds-surface-3)] hover:text-[color:var(--ds-fg)]",
        "active:translate-y-px",
        "disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      <Icon aria-hidden className={dsIcon.lg} />
    </button>
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
        {/* HOW MANY THERE ARE, at the top. The section used to say only what it
            was; whether a run carried one capture or nine could be told apart
            only by counting tiles, and the filter chips that print the counts
            appear only when a run has more than one KIND. */}
        {captures.length > 0 && (
          <Badge tone={captures.some((c) => c.failure) ? "danger" : "neutral"}>{captures.length}</Badge>
        )}
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
        /* A FULL-WIDTH LIST, not a two-column grid of tall tiles.
           Operator: *"this needs to be designed better too."* The grid was
           built for a wall of thumbnails and this rail never has one — the
           common run carries ONE capture, which took a third of the column and
           left two thirds empty, and the tile spent its height on a large icon
           well above a two-line label that then truncated. A row spends the
           width instead: the shape on the left at a fixed height, the label and
           its provenance filling the rest, and every row the same height so
           three of them read as a list rather than as three cards.
           It scales in the one direction that matters — the well caps at four
           rows and scrolls, clipping on a whole row (see the token), so a
           nine-capture run cannot push Data off the rail. */
        <div
          className={cn(
            "flex flex-col divide-y overflow-hidden overflow-y-auto border",
            "max-h-[var(--ds-h-evidence-well)]",
            dsRadius.md,
            "divide-[color:var(--ds-border-subtle)] border-[color:var(--ds-border)]",
          )}
        >
          {shown.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setOpen(captures.indexOf(c))}
              aria-label={`Open capture — ${c.label}${c.failure ? " (failure capture)" : ""}`}
              className={cn(
                // The recessed plane. A capture row is a thing that sits BACK
                // from the section, and it was the last one drawing its own
                // lighter fill inside a surface that had already stepped down.
                "flex min-w-0 shrink-0 items-center gap-[var(--ds-space-base)] bg-[var(--ds-recess-bg)] text-left",
                "h-[var(--ds-h-evidence-row)] px-[var(--ds-space-snug)]",
                dsFocus,
                dsMotion.fast,
                // it opens the lightbox — a real command, so it dips like every
                // other pressable in the system
                "active:translate-y-px",
                c.failure
                  ? "bg-[var(--ds-danger-quiet)] hover:brightness-125"
                  : "hover:bg-[var(--ds-surface-3)]",
              )}
            >
              {/* The thumbnail is the capture's own SHAPE at a shared height —
                  a portrait document page and a landscape browser viewport
                  read as different things before either is opened, which is the
                  one true thing a byte-less placeholder can offer. Fixed
                  height, derived width, so the rows still land on one grid. */}
              <span
                aria-hidden
                style={{ aspectRatio: captureAspect(c) }}
                className={cn(
                  "flex h-[var(--ds-h-evidence-thumb)] shrink-0 items-center justify-center border bg-[var(--ds-surface-1)] rounded-[var(--ds-radius-sm)]",
                  c.failure ? "border-[color:var(--ds-danger-border)]" : "border-[color:var(--ds-border-subtle)]",
                )}
              >
                <Camera
                  className={cn(dsIcon.md, c.failure ? "text-[color:var(--ds-danger)]" : "text-[color:var(--ds-fg-muted)]")}
                />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span
                  className={cn(
                    "truncate",
                    dsText.body,
                    c.failure
                      ? "font-semibold text-[color:var(--ds-danger)]"
                      : "font-medium text-[color:var(--ds-fg)]",
                  )}
                >
                  {c.label}
                </span>
                {/* WHERE IT CAME FROM, and `Steps` is not in it. The kind was
                    printed here as the plural FILTER label — a capture whose
                    subtitle read `Steps` was not telling you it came from a
                    step, it was echoing the name of the chip that would filter
                    it. The chips above own the kind; the row owns the step it
                    was taken on and the clock, which is what tells two captures
                    of the same page apart. */}
                <MetaLine items={[c.step, c.system?.toUpperCase(), c.capturedAt ? fmtClock(c.capturedAt) : undefined]} />
              </span>
              <ChevronRight aria-hidden className={cn(dsIcon.sm, "shrink-0 text-[color:var(--ds-fg-faint)]")} />
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
