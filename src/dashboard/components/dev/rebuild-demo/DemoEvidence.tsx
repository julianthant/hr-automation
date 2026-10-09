import { useCallback, useEffect, useMemo, useState } from "react";
import { Camera, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, FileJson, FileText, Info, Maximize2 } from "lucide-react";
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
  dsElev,
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
  CAPTURE_STEP_UNSCOPED,
  capturesFor,
  exportRunJson,
  exportRunLogsText,
  groupCapturesByStep,
  type DemoCapture,
  type DemoCaptureKind,
  type DemoPageExtraction,
  type DemoPageFacsimile,
} from "./demo-evidence-wire";

/**
 * DEV-ONLY — the receipt's screenshot-evidence section and its capture
 * lightbox, plus the run export the legacy Screenshots tab carried and the
 * operator kept.
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
  const aspect = captureAspectValue(capture);
  // FIT TO SCALE inside a `container-type: size` parent. `min(cqw, cqh·aspect)`
  // is the CSS equivalent of `object-fit: contain` for a non-replaced box —
  // as large as the stage allows, never cropped, never overflowing. The old
  // sizing locked height to `--ds-h-capture-box` and derived width, which left
  // letter pages as a small stamp in a wide column (operator: "fit to scale").
  const fitStyle = {
    aspectRatio: String(aspect),
    width: `min(100cqw, calc(100cqh * ${aspect}))`,
    height: `min(100cqh, calc(100cqw / ${aspect}))`,
  } as const;

  if (capture.facsimile) {
    return (
      <div
        role="img"
        aria-label={`${capture.label} — a synthetic rendering of the ${capture.extraction?.formKind ?? capture.kind} page, drawn from the extraction record beside it. Not a photograph of a real document.`}
        style={fitStyle}
        className={cn(
          "overflow-hidden border",
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
      style={fitStyle}
      className={cn(
        "flex flex-col items-center justify-center gap-[var(--ds-space-base)] border p-[var(--ds-space-loose)]",
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

          <div className="grid min-h-0 grid-cols-1 gap-[var(--ds-space-cozy)] @min-[52rem]:grid-cols-[minmax(0,1.75fr)_1px_minmax(16rem,0.85fr)]">
            {/* ---- the capture: centered stage + filmstrip ----------------- */}
            <div className="flex min-w-0 flex-col gap-[var(--ds-space-snug)]">
              {/*
                PROFESSIONAL LIGHTBOX STAGE.
                The capture sits dead-centre in a recessed well. Prev/next live
                in SIDE GUTTERS — never overlaid on the page (operator: "buttons
                dont overlap"). The frame itself uses container-query contain
                sizing so it grows to the well (operator: "fit to scale").
              */}
              <div
                className={cn(
                  "grid min-w-0 items-center gap-[var(--ds-space-snug)] border",
                  dsRadius.lg,
                  "border-[color:var(--ds-border)] bg-[var(--ds-surface-1)]",
                  "px-[var(--ds-space-snug)]",
                  captures.length > 1
                    ? "grid-cols-[var(--ds-h-lg)_minmax(0,1fr)_var(--ds-h-lg)]"
                    : "grid-cols-1",
                )}
                style={{ height: "var(--ds-h-capture-box)" }}
              >
                {captures.length > 1 && (
                  <CaptureNavButton dir="prev" disabled={false} onClick={() => step(-1)} />
                )}
                {/* `container-type: size` so the frame can read both axes and
                    fit contain-style — as large as this cell allows. */}
                <div
                  className="flex h-full min-h-0 min-w-0 items-center justify-center"
                  style={{ containerType: "size" }}
                >
                  <CaptureFrame capture={capture} />
                </div>
                {captures.length > 1 && (
                  <CaptureNavButton dir="next" disabled={false} onClick={() => step(1)} />
                )}
              </div>

              {/*
                FILMSTRIP OF PREVIEWS, not labelled camera chips. The strip
                used to say `1 📷 Packet page 1` — which is a caption, not a
                preview. Each thumb is the capture itself (facsimile when the
                record serves one), so paging by eye matches paging by arrow.
              */}
              {captures.length > 1 && (
                <div
                  role="tablist"
                  aria-label="Captures on this run"
                  className={cn(
                    "flex shrink-0 items-center justify-center gap-[var(--ds-space-snug)] overflow-x-auto",
                    "h-[var(--ds-h-capture-thumb)]",
                  )}
                >
                  {captures.map((c, i) => (
                    <CaptureThumb
                      key={c.id}
                      capture={c}
                      index={i}
                      total={captures.length}
                      selected={i === index}
                      onSelect={() => onIndex(i)}
                    />
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
 * Prev/next in the STAGE GUTTER — beside the image, never on it.
 *
 * Overlaying circles on the frame looked like a media player and also ate
 * the page edge (operator: "buttons dont overlap"). A circle in a reserved
 * column keeps the hit target still between differently-sized captures and
 * leaves the fitted page alone.
 */
function CaptureNavButton({
  dir,
  disabled,
  onClick,
  className,
}: {
  dir: "prev" | "next";
  disabled: boolean;
  onClick: () => void;
  className?: string;
}) {
  const Icon = dir === "prev" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={dir === "prev" ? "Previous capture" : "Next capture"}
      className={cn(
        "flex size-[var(--ds-h-lg)] shrink-0 items-center justify-center justify-self-center rounded-full border",
        "border-[color:var(--ds-border-loud)] bg-[var(--ds-surface-overlay)]",
        "text-[color:var(--ds-fg)]",
        dsElev.low,
        dsFocus,
        dsMotion.fast,
        "cursor-pointer hover:bg-[var(--ds-surface-3)]",
        "active:translate-y-px",
        "disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
    >
      <Icon aria-hidden className={dsIcon.md} />
    </button>
  );
}

/**
 * The face of a capture thumbnail — facsimile when the record serves one,
 * quiet stand-in otherwise. Shared by the lightbox filmstrip and the Evidence
 * list so the two never disagree about what a capture looks like before open.
 */
function CaptureThumbFace({ capture }: { capture: DemoCapture }) {
  if (capture.facsimile) {
    return (
      <div className="pointer-events-none h-full w-full overflow-hidden bg-[var(--ds-paper-bg)]">
        {/* Scale the full page into the thumb. Origin top-left so the title
            block stays the recognisable corner of the larger frame. */}
        <div
          className="origin-top-left"
          style={{
            width: "222%",
            height: "222%",
            transform: "scale(0.45)",
          }}
        >
          <PageFacsimile page={capture.facsimile} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full w-full items-center justify-center bg-[var(--ds-surface-1)]">
      <Camera
        aria-hidden
        className={cn(dsIcon.sm, capture.failure ? "text-[color:var(--ds-danger)]" : "text-[color:var(--ds-fg-faint)]")}
      />
    </div>
  );
}

/**
 * One filmstrip cell — the capture itself, shrunk. A labelled camera chip is a
 * caption; this is a preview. Facsimile pages render a scaled page; metadata-
 * only captures keep a quiet stand-in so the strip never invents a photograph
 * of a system that was never captured.
 */
function CaptureThumb({
  capture,
  index,
  total,
  selected,
  onSelect,
}: {
  capture: DemoCapture;
  index: number;
  total: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const aspect = captureAspectValue(capture);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-label={`Show capture ${index + 1} of ${total} — ${capture.label}`}
      title={capture.label}
      onClick={onSelect}
      style={{
        height: "var(--ds-h-capture-thumb)",
        width: `calc(var(--ds-h-capture-thumb) * ${aspect})`,
      }}
      className={cn(
        "relative shrink-0 overflow-hidden border",
        dsRadius.md,
        dsFocus,
        dsMotion.fast,
        "active:translate-y-px",
        selected
          ? "border-[color:var(--ds-border-loud)] ring-2 ring-[color:var(--ds-ring)]"
          : "border-[color:var(--ds-border)] opacity-80 hover:opacity-100",
        capture.failure && "border-[color:var(--ds-danger)]",
      )}
    >
      <CaptureThumbFace capture={capture} />
      <span
        className={cn(
          dsText.nums,
          dsText.micro,
          "absolute bottom-[var(--ds-space-hair)] left-[var(--ds-space-hair)]",
          "rounded-[var(--ds-radius-xs)] bg-[var(--ds-surface-scrim)]",
          "px-[var(--ds-space-tight)] text-[color:var(--ds-fg)]",
        )}
      >
        {index + 1}
      </span>
    </button>
  );
}

/**
 * A receipt capture is evidence, not an attachment row. The preview therefore
 * gets a real stage and enough area to recognise the page before the operator
 * opens it. Metadata stays alongside it, rather than competing with the image
 * in a 44px list row.
 */
function ReceiptCaptureCard({ capture, onOpen }: { capture: DemoCapture; onOpen: () => void }) {
  const secondary =
    capture.screen ??
    capture.pageState ??
    capture.extraction?.sourcePdf ??
    (capture.size ? `${capture.size.w} × ${capture.size.h}` : undefined);

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open capture — ${capture.label}${capture.failure ? " (failure capture)" : ""}`}
      className={cn(
        "group grid min-w-0 overflow-hidden border text-left",
        "grid-cols-1 @min-[30rem]:grid-cols-[minmax(13rem,0.72fr)_minmax(0,1fr)]",
        dsRadius.lg,
        dsFocus,
        dsMotion.fast,
        "active:translate-y-px",
        capture.failure
          ? "border-[color:var(--ds-danger-border)] bg-[var(--ds-danger-quiet)] hover:brightness-110"
          : "border-[color:var(--ds-border)] bg-[var(--ds-surface-1)] hover:border-[color:var(--ds-border-loud)] hover:bg-[var(--ds-surface-3)]",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex min-h-[9.5rem] min-w-0 items-center justify-center border-b p-[var(--ds-space-base)]",
          "bg-[var(--ds-surface-2)] @min-[30rem]:border-r @min-[30rem]:border-b-0",
          capture.failure ? "border-[color:var(--ds-danger-border)]" : "border-[color:var(--ds-border-subtle)]",
        )}
      >
        <span
          className={cn(
            "relative h-[7.5rem] max-w-full overflow-hidden border bg-[var(--ds-surface-1)]",
            dsRadius.md,
            dsElev.low,
            capture.failure ? "border-[color:var(--ds-danger)]" : "border-[color:var(--ds-border)]",
          )}
          style={{ aspectRatio: captureAspect(capture) }}
        >
          <CaptureThumbFace capture={capture} />
        </span>
      </span>

      <span className="flex min-w-0 flex-col gap-[var(--ds-space-base)] p-[var(--ds-space-base)]">
        <span className="flex min-w-0 items-start gap-[var(--ds-space-snug)]">
          <span className="flex min-w-0 flex-1 flex-col gap-[var(--ds-space-hair)]">
            <span
              className={cn(
                dsText.ui,
                "truncate font-semibold",
                capture.failure ? "text-[color:var(--ds-danger)]" : "text-[color:var(--ds-fg)]",
              )}
            >
              {capture.label}
            </span>
            {secondary && (
              <span className={cn(dsText.meta, "line-clamp-2 text-[color:var(--ds-fg-secondary)]")}>{secondary}</span>
            )}
          </span>
          <Badge tone={capture.failure ? "danger" : "neutral"}>{CAPTURE_KIND_LABEL[capture.kind]}</Badge>
        </span>

        <MetaLine
          items={[
            capture.system?.toUpperCase(),
            capture.capturedAt ? fmtClock(capture.capturedAt) : undefined,
            capture.size ? `${capture.size.w} × ${capture.size.h}` : undefined,
          ]}
        />

        {capture.note && (
          <span className={cn(dsText.meta, "line-clamp-2 text-[color:var(--ds-fg-muted)]")}>{capture.note}</span>
        )}

        <span
          className={cn(
            dsText.meta,
            "mt-auto flex items-center gap-[var(--ds-space-tight)] font-medium text-[color:var(--ds-fg-secondary)]",
            "group-hover:text-[color:var(--ds-fg)]",
          )}
        >
          <Maximize2 aria-hidden className={dsIcon.sm} />
          Open full capture
        </span>
      </span>
    </button>
  );
}

/**
 * The receipt's SCREENSHOT EVIDENCE. It used to be a 52px strip wedged between
 * the timeline and the tabs, then briefly lived in Context. Captures qualify
 * the outcome recorded by the receipt, so each real tile now lives on that tab:
 * kind, label, the step it was taken on and the clock let the operator tell two
 * captures apart without opening either.
 *
 * The filter chips and the export menu are the two affordances the legacy
 * Screenshots tab had that the operator kept (`legacy-keep-ditch` §4.20), and
 * both carried over unchanged.
 */
export function ReceiptCapturesSection({ row }: { row: DemoRow }) {
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
  const byStep = useMemo(
    () =>
      groupCapturesByStep(
        active === "all" ? captures : captures.filter((c) => c.kind === active),
        row.steps?.map((s) => s.label),
      ),
    [captures, active, row.steps],
  );

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
    <section aria-label="Screenshot evidence" className="@container flex flex-col gap-[var(--ds-space-base)]">
      <div className="flex items-start gap-[var(--ds-space-snug)]">
        <div className="flex min-w-0 flex-1 flex-col gap-[var(--ds-space-hair)]">
          <div className="flex items-center gap-[var(--ds-space-snug)]">
            <SectionLabel className="min-w-0 truncate">Screenshots</SectionLabel>
            {captures.length > 0 && (
              <Badge tone={captures.some((c) => c.failure) ? "danger" : "neutral"}>{captures.length}</Badge>
            )}
          </div>
          <p className={cn(dsText.meta, "text-[color:var(--ds-fg-muted)]")}>
            Frames captured by this run, grouped by the step that produced them.
          </p>
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
        <div
          className={cn(
            "flex min-h-[9rem] flex-col items-center justify-center gap-[var(--ds-space-snug)] border bg-[var(--ds-surface-1)] p-[var(--ds-space-loose)] text-center",
            dsRadius.lg,
            "border-[color:var(--ds-border)]",
          )}
        >
          <Camera aria-hidden className={cn(dsIcon.lg, "text-[color:var(--ds-fg-faint)]")} />
          <p className={cn(dsText.body, "font-medium text-[color:var(--ds-fg-secondary)]")}>
            {captures.length === 0 ? "No screenshots captured yet" : "No screenshots match this filter"}
          </p>
          <p className={cn(dsText.meta, "max-w-[44ch] text-[color:var(--ds-fg-muted)]")}>
            {captures.length === 0
              ? "This run has not reached a step that records a frame."
              : "Choose another capture type to see the evidence recorded on this run."}
          </p>
        </div>
      ) : (
        /* Grouped by the WORKFLOW STEP each frame was taken on — same idea as
           the Data ledger. Kind chips (All / Errors / Steps) still filter;
           grouping is layout. A flat list of "Packet page 1" / "Page 7" did not
           say which pipeline step produced them (operator: categorize by step). */
        <div className="flex flex-col gap-[var(--ds-space-loose)]">
          {byStep.map((group) => (
            <div key={group.step} className="flex flex-col gap-[var(--ds-space-snug)]">
              <div className="flex items-center gap-[var(--ds-space-snug)]">
                <span
                  className={cn(
                    dsText.caps,
                    "min-w-0 truncate",
                    group.step === CAPTURE_STEP_UNSCOPED
                      ? "text-[color:var(--ds-fg-faint)]"
                      : "text-[color:var(--ds-fg-secondary)]",
                  )}
                >
                  {group.step}
                </span>
                <span aria-hidden className="h-px flex-1 bg-[var(--ds-border-subtle)]" />
                <Badge tone="neutral">{group.captures.length}</Badge>
              </div>
              <div className="grid grid-cols-1 gap-[var(--ds-space-snug)] @min-[68rem]:grid-cols-2">
                {group.captures.map((c) => (
                  <ReceiptCaptureCard
                    key={c.id}
                    capture={c}
                    onOpen={() => setOpen(captures.indexOf(c))}
                  />
                ))}
              </div>
            </div>
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
