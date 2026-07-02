import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

export type MediaLightboxChrome = "screenshot" | "capture";

export interface MediaLightboxProps<T> {
  items: T[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  renderItem: (item: T, index: number) => ReactNode;
  renderCaption?: (item: T, index: number) => ReactNode;
  /**
   * When provided (and there are 2+ items), the screenshot chrome shows a
   * macOS-Preview-style vertical thumbnail rail on the left — one small preview
   * per item, the current one highlighted, click to jump. Ignored by the
   * capture chrome.
   */
  renderThumbnail?: (item: T, index: number) => ReactNode;
  /** When false, render nothing. Capture wrapper uses this for closed state. */
  open?: boolean;
  /** Chrome layout — thin wrappers set screenshot vs capture. */
  chrome?: MediaLightboxChrome;
  wrapNavigation?: boolean;
  preventDefaultOnKeys?: boolean;
  enableHomeEnd?: boolean;
  ariaLabel?: string;
}

export function MediaLightbox<T>({
  items,
  index,
  onIndexChange,
  onClose,
  renderItem,
  renderCaption,
  renderThumbnail,
  open = true,
  chrome = "screenshot",
  wrapNavigation = false,
  preventDefaultOnKeys = false,
  enableHomeEnd = false,
  ariaLabel,
}: MediaLightboxProps<T>) {
  const navigate = useCallback(
    (delta: number) => {
      if (!open) return;
      if (wrapNavigation) {
        const next = (index + delta + items.length) % items.length;
        onIndexChange(next);
        return;
      }
      const next = index + delta;
      if (next >= 0 && next < items.length) onIndexChange(next);
    },
    [index, open, onIndexChange, items.length, wrapNavigation],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (preventDefaultOnKeys) e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowLeft") {
        if (preventDefaultOnKeys) e.preventDefault();
        if (wrapNavigation) {
          navigate(-1);
        } else if (index > 0) {
          onIndexChange(index - 1);
        }
        return;
      }
      if (e.key === "ArrowRight") {
        if (preventDefaultOnKeys) e.preventDefault();
        if (wrapNavigation) {
          navigate(1);
        } else if (index < items.length - 1) {
          onIndexChange(index + 1);
        }
        return;
      }
      if (enableHomeEnd && e.key === "Home") {
        if (index !== 0) onIndexChange(0);
        return;
      }
      if (enableHomeEnd && e.key === "End") {
        const last = items.length - 1;
        if (index !== last) onIndexChange(last);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    index,
    items.length,
    onIndexChange,
    onClose,
    open,
    navigate,
    wrapNavigation,
    preventDefaultOnKeys,
    enableHomeEnd,
  ]);

  if (!open) return null;
  const current = items[index];
  if (!current) return null;

  const hasPrev = wrapNavigation ? items.length > 1 : index > 0;
  const hasNext = wrapNavigation ? items.length > 1 : index < items.length - 1;

  if (chrome === "capture") {
    return (
      <CaptureLightboxShell
        index={index}
        itemsLength={items.length}
        ariaLabel={ariaLabel}
        onClose={onClose}
        onPrev={() => navigate(-1)}
        onNext={() => navigate(1)}
      >
        {renderItem(current, index)}
      </CaptureLightboxShell>
    );
  }

  const sidebar =
    renderThumbnail && items.length > 1 ? (
      <ThumbnailRail
        items={items}
        index={index}
        onSelect={onIndexChange}
        renderThumbnail={renderThumbnail}
      />
    ) : undefined;

  return (
    <ScreenshotOverlay onClose={onClose}>
      <ScreenshotLightboxShell
        itemsLength={items.length}
        hasPrev={hasPrev}
        hasNext={hasNext}
        onClose={onClose}
        onPrev={() => hasPrev && onIndexChange(index - 1)}
        onNext={() => hasNext && onIndexChange(index + 1)}
        caption={renderCaption ? renderCaption(current, index) : undefined}
        sidebar={sidebar}
      >
        {renderItem(current, index)}
      </ScreenshotLightboxShell>
    </ScreenshotOverlay>
  );
}

/**
 * macOS-Preview-style vertical thumbnail rail. One small preview per item,
 * scrollable, the active item highlighted with a ring; clicking jumps to it.
 * The active thumbnail auto-scrolls into view as the operator pages through.
 */
function ThumbnailRail<T>({
  items,
  index,
  onSelect,
  renderThumbnail,
}: {
  items: T[];
  index: number;
  onSelect: (i: number) => void;
  renderThumbnail: (item: T, index: number) => ReactNode;
}) {
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return (
    <div
      role="tablist"
      aria-orientation="vertical"
      aria-label="Screenshot pages"
      className="flex max-h-full w-[7rem] shrink-0 flex-col gap-2 overflow-y-auto pr-1"
    >
      {items.map((item, i) => {
        const active = i === index;
        return (
          <button
            key={i}
            ref={active ? activeRef : undefined}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={`Go to page ${i + 1} of ${items.length}`}
            onClick={() => onSelect(i)}
            className={`group relative block w-full shrink-0 overflow-hidden rounded-md border bg-muted transition-[border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              active
                ? "border-primary ring-2 ring-primary"
                : "border-border opacity-80 hover:opacity-100 hover:border-primary/50"
            }`}
          >
            <div className="aspect-[16/10] w-full overflow-hidden">
              {renderThumbnail(item, i)}
            </div>
            <span className="pointer-events-none absolute bottom-0.5 right-0.5 rounded bg-card/90 px-1 font-mono text-[10px] tabular-nums text-foreground shadow-sm backdrop-blur">
              {i + 1}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ScreenshotOverlay({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 bg-black/85 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      {children}
    </div>
  );
}

function ScreenshotLightboxShell({
  itemsLength,
  hasPrev,
  hasNext,
  onClose,
  onPrev,
  onNext,
  caption,
  sidebar,
  children,
}: {
  itemsLength: number;
  hasPrev: boolean;
  hasNext: boolean;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  caption?: ReactNode;
  sidebar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="flex max-h-[92vh] max-w-[92vw] flex-col gap-3 rounded-lg border border-border bg-card p-3 shadow-2xl"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Top chrome bar — caption + Close live on the panel, never over the image. */}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 truncate text-[11px] font-mono text-muted-foreground">
          {caption}
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md bg-secondary px-3 py-1 text-[11px] font-mono text-foreground hover:bg-accent transition-colors"
          onClick={onClose}
        >
          Close
        </button>
      </div>
      {/* Body — optional thumbnail rail on the left (Preview.app style), then
          nav arrows in side gutters beside the image, never on it. */}
      <div className="flex min-h-0 items-stretch justify-center gap-3">
        {sidebar}
        <div className="flex min-h-0 items-center justify-center gap-2">
          {itemsLength > 1 && (
            <button
              type="button"
              disabled={!hasPrev}
              aria-label="Previous screenshot"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary text-foreground disabled:opacity-30 hover:bg-accent transition-colors"
              onClick={onPrev}
            >
              <ChevronLeft aria-hidden className="h-5 w-5" />
            </button>
          )}
          <div className="flex min-h-0 min-w-0 items-center justify-center">
            {children}
          </div>
          {itemsLength > 1 && (
            <button
              type="button"
              disabled={!hasNext}
              aria-label="Next screenshot"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary text-foreground disabled:opacity-30 hover:bg-accent transition-colors"
              onClick={onNext}
            >
              <ChevronRight aria-hidden className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}


function CaptureLightboxShell({
  index,
  itemsLength,
  ariaLabel,
  onClose,
  onPrev,
  onNext,
  children,
}: {
  index: number;
  itemsLength: number;
  ariaLabel?: string;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  children: ReactNode;
}) {
  const roundBtn =
    "inline-flex items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2";
  const roundBtnStyle = {
    backgroundColor: "var(--capture-bg-raised)",
    color: "var(--capture-fg-primary)",
    ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "color-mix(in srgb, var(--background) 92%, transparent)" }}
    >
      {/*
        Frame shrinks to the image (inline-flex → fit-content), so the border is
        exactly the image's size — not a full-screen box. Chrome is positioned
        relative to THIS frame (not the viewport), so the close/counter/arrows
        track the image edges instead of floating at disconnected screen corners.
      */}
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative inline-flex max-h-[92vh] max-w-[94vw] items-center justify-center rounded-xl border p-2"
        style={{
          borderColor: "var(--capture-border-subtle)",
          backgroundColor: "var(--capture-bg-raised)",
          boxShadow: "0 12px 48px rgba(0,0,0,0.55)",
        }}
      >
        {children}

        <button
          type="button"
          aria-label="Close preview"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={`absolute right-2.5 top-2.5 h-9 w-9 ${roundBtn}`}
          style={roundBtnStyle}
        >
          <X aria-hidden className="h-5 w-5" />
        </button>

        <span
          className="absolute bottom-2.5 left-1/2 -translate-x-1/2 rounded-md px-2.5 py-1 font-mono text-xs tabular-nums"
          style={{
            backgroundColor: "var(--capture-bg-raised)",
            color: "var(--capture-fg-secondary)",
          }}
          aria-live="polite"
        >
          {index + 1} / {itemsLength}
        </span>

        {itemsLength > 1 && (
          <button
            type="button"
            aria-label="Previous photo"
            onClick={(e) => {
              e.stopPropagation();
              onPrev();
            }}
            className={`absolute left-2.5 top-1/2 h-11 w-11 -translate-y-1/2 ${roundBtn}`}
            style={roundBtnStyle}
          >
            <ChevronLeft aria-hidden className="h-6 w-6" />
          </button>
        )}

        {itemsLength > 1 && (
          <button
            type="button"
            aria-label="Next photo"
            onClick={(e) => {
              e.stopPropagation();
              onNext();
            }}
            className={`absolute right-2.5 top-1/2 h-11 w-11 -translate-y-1/2 ${roundBtn}`}
            style={roundBtnStyle}
          >
            <ChevronRight aria-hidden className="h-6 w-6" />
          </button>
        )}
      </div>
    </div>
  );
}
