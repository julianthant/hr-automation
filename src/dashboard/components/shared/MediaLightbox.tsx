import { useCallback, useEffect, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

export type MediaLightboxChrome = "screenshot" | "capture";

export interface MediaLightboxProps<T> {
  items: T[];
  index: number;
  onIndexChange: (i: number) => void;
  onClose: () => void;
  renderItem: (item: T, index: number) => ReactNode;
  renderCaption?: (item: T, index: number) => ReactNode;
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
      >
        {renderItem(current, index)}
      </ScreenshotLightboxShell>
    </ScreenshotOverlay>
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
      className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center"
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
  children,
}: {
  itemsLength: number;
  hasPrev: boolean;
  hasNext: boolean;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  caption?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="relative max-w-[90vw] max-h-[90vh]"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
      {caption ? (
        <div className="absolute bottom-2 left-2 bg-background/90 rounded px-2 py-1 text-[11px] font-mono text-foreground/80">
          {caption}
        </div>
      ) : null}
      {itemsLength > 1 && (
        <>
          <button
            type="button"
            disabled={!hasPrev}
            aria-label="Previous screenshot"
            className="absolute left-2 top-1/2 -translate-y-1/2 bg-background/90 rounded px-2 py-1 text-xs font-mono text-foreground/80 disabled:opacity-30 hover:bg-background transition-colors"
            onClick={onPrev}
          >
            ‹
          </button>
          <button
            type="button"
            disabled={!hasNext}
            aria-label="Next screenshot"
            className="absolute right-2 top-1/2 -translate-y-1/2 bg-background/90 rounded px-2 py-1 text-xs font-mono text-foreground/80 disabled:opacity-30 hover:bg-background transition-colors"
            onClick={onNext}
          >
            ›
          </button>
        </>
      )}
      <button
        type="button"
        className="absolute top-2 right-2 bg-background/90 rounded px-2 py-1 text-[11px] font-mono text-foreground/80 hover:bg-background transition-colors"
        onClick={onClose}
      >
        Close
      </button>
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
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ backgroundColor: "hsl(15 11% 4% / 0.92)" }}
    >
      <button
        type="button"
        aria-label="Close preview"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="absolute right-4 top-4 inline-flex h-10 w-10 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2"
        style={{
          backgroundColor: "var(--capture-bg-raised)",
          color: "var(--capture-fg-primary)",
          ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
        }}
      >
        <X aria-hidden className="h-5 w-5" />
      </button>

      <span
        className="absolute left-1/2 top-4 -translate-x-1/2 rounded-md px-3 py-1 font-mono text-xs tabular-nums"
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
          className="absolute left-4 top-1/2 inline-flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2"
          style={{
            backgroundColor: "var(--capture-bg-raised)",
            color: "var(--capture-fg-primary)",
            ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
          }}
        >
          <ChevronLeft aria-hidden className="h-6 w-6" />
        </button>
      )}

      <div onClick={(e) => e.stopPropagation()}>{children}</div>

      {itemsLength > 1 && (
        <button
          type="button"
          aria-label="Next photo"
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          className="absolute right-4 top-1/2 inline-flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2"
          style={{
            backgroundColor: "var(--capture-bg-raised)",
            color: "var(--capture-fg-primary)",
            ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
          }}
        >
          <ChevronRight aria-hidden className="h-6 w-6" />
        </button>
      )}
    </div>
  );
}
