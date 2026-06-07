import { useEffect, useState, type SyntheticEvent } from "react";

/**
 * Renders a screenshot inside the lightbox, slicing very tall captures
 * (full PeopleSoft / CRM records) into side-by-side columns instead of
 * scaling the whole thing down to fit the viewport height.
 *
 * A tall, narrow capture under plain `object-contain max-h-[85vh]` becomes an
 * unreadable ribbon with most of the screen width empty. Here we pick the
 * column count that best fills the available box, then render the SAME cached
 * image once per column inside an `overflow-hidden` window offset by
 * `translateY` — pure-CSS slicing, one network fetch. Columns read like a
 * newspaper: top→bottom of column 1, then column 2, … (a slim numbered header
 * strip above each slice makes that order explicit without ever covering the
 * image). Images that aren't tall enough fall back to the original single
 * fit-to-height image, unchanged.
 */

export interface NaturalSize {
  w: number;
  h: number;
}

export interface ViewportBox {
  w: number;
  h: number;
}

/** Gap between sliced columns, in px. */
const COLUMN_GAP = 10;
/** Height of the numbered header strip above each slice, in px (incl. margin). */
const COLUMN_HEADER_H = 24;
/**
 * Horizontal / vertical space the lightbox shell reserves for chrome (the modal
 * panel padding + side nav gutters + the top caption/Close bar) so the slice
 * grid never pushes the panel past the viewport. Kept generous — under-filling
 * leaves a small margin; over-filling would clip the panel.
 */
const CHROME_W = 140;
const CHROME_H = 96;

/**
 * Best column count for a capture: the value that fills the box most squarely.
 * For N columns each is `~availW/N` wide and `~availH·N/r` is the height ceiling,
 * which cross at `N = √((availW/availH)·r)` — beyond that, width shrinks faster
 * than height grows. `N <= 1` means a single fit-to-height image already uses the
 * width well, so we don't slice.
 */
export function columnCountFor(
  natural: NaturalSize,
  box: ViewportBox,
  maxColumns: number,
): number {
  if (natural.w <= 0 || natural.h <= 0 || box.w <= 0 || box.h <= 0) return 1;
  const aspect = natural.h / natural.w;
  const ideal = Math.sqrt((box.w / box.h) * aspect);
  return Math.min(maxColumns, Math.max(1, Math.round(ideal)));
}

export interface SliceLayout {
  gap: number;
  headerH: number;
  /** Width of one column (the rendered image width). */
  colW: number;
  /** Visible height of one slice window (excludes the header strip). */
  colH: number;
  /** Full rendered image height at `colW` (image is offset within the window). */
  fullH: number;
}

/** Pixel geometry for an N-column slice that fits within the box. */
export function sliceLayout(
  natural: NaturalSize,
  box: ViewportBox,
  columns: number,
): SliceLayout {
  const aspect = natural.h / natural.w;
  const sliceBudget = Math.max(1, box.h - COLUMN_HEADER_H); // leave room for the header
  const widthLimited = (box.w - (columns - 1) * COLUMN_GAP) / columns;
  const heightLimited = (sliceBudget * columns) / aspect;
  const colW = Math.max(1, Math.min(widthLimited, heightLimited));
  const fullH = colW * aspect;
  return {
    gap: COLUMN_GAP,
    headerH: COLUMN_HEADER_H,
    colW,
    colH: fullH / columns,
    fullH,
  };
}

/** The slice box: 90% width / 85% height of the viewport, minus shell chrome. */
function readViewportBox(): ViewportBox {
  return {
    w: window.innerWidth * 0.9 - CHROME_W,
    h: window.innerHeight * 0.85 - CHROME_H,
  };
}

function useViewportBox(): ViewportBox {
  const [box, setBox] = useState<ViewportBox>(readViewportBox);
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setBox(readViewportBox()));
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return box;
}

export interface SlicedScreenshotProps {
  src: string;
  srcSet?: string;
  sizes?: string;
  alt: string;
  /** Upper bound on columns a tall capture is sliced into. */
  maxColumns?: number;
}

export function SlicedScreenshot({
  src,
  srcSet,
  sizes,
  alt,
  maxColumns = 4,
}: SlicedScreenshotProps) {
  const [natural, setNatural] = useState<NaturalSize | null>(null);
  const box = useViewportBox();

  const onLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (!img.naturalWidth || !img.naturalHeight) return;
    setNatural((prev) =>
      prev && prev.w === img.naturalWidth && prev.h === img.naturalHeight
        ? prev
        : { w: img.naturalWidth, h: img.naturalHeight },
    );
  };

  const columns = natural ? columnCountFor(natural, box, maxColumns) : 1;

  // Measuring pass + the not-tall-enough case: the original single image.
  if (!natural || columns <= 1) {
    return (
      <img
        src={src}
        srcSet={srcSet ?? src}
        sizes={sizes ?? "85vw"}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={onLoad}
        className="max-w-full max-h-[82vh] rounded object-contain"
      />
    );
  }

  const layout = sliceLayout(natural, box, columns);
  return (
    <div className="flex items-start" style={{ gap: layout.gap }}>
      {Array.from({ length: columns }, (_, k) => (
        <div key={k} className="flex flex-col" style={{ width: layout.colW }}>
          <div
            className="mb-1 flex items-center justify-center rounded bg-muted text-[10px] font-mono tabular-nums text-muted-foreground"
            style={{ height: layout.headerH - 4 }}
          >
            {k + 1}
          </div>
          <div
            className="relative shrink-0 overflow-hidden rounded border border-border/40 bg-background/40"
            style={{ width: layout.colW, height: layout.colH }}
          >
            <img
              src={src}
              srcSet={srcSet ?? src}
              sizes={`${Math.round(layout.colW)}px`}
              alt={k === 0 ? alt : ""}
              aria-hidden={k === 0 ? undefined : true}
              loading="lazy"
              decoding="async"
              onLoad={onLoad}
              style={{
                width: layout.colW,
                height: layout.fullH,
                maxWidth: "none",
                transform: `translateY(${-k * layout.colH}px)`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
