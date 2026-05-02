import { useCallback, useEffect, useRef } from "react";

export interface UsePrepCursorOpts {
  /**
   * localStorage key under which the cursor index is persisted. Caller
   * derives this via the OCR downstream registry's `cursorKey(...)` so
   * scope (per-run vs per-session) and prefix vary by workflow without
   * this hook needing to know about workflow names.
   */
  storageKey: string;
  /** Set false to short-circuit storage reads/writes (e.g. when the pane is closed). */
  enabled: boolean;
  /** Total record count, used to clamp restored cursor positions. */
  recordCount: number;
}

/**
 * Persists the topmost-visible pair index in localStorage under the
 * caller-provided `storageKey` so re-entering the review pane restores
 * the operator's scroll position without requiring URL state.
 *
 * Returns:
 *   - `containerRef`     — attach to the scroll container
 *   - `onPairVisible(i)` — call from each pair's IntersectionObserver
 *                          callback with that pair's index (debounced
 *                          250ms before the write fires)
 *   - `clear()`          — drop the stored cursor (call on Approve /
 *                          Discard / explicit cancel)
 */
export function usePrepCursor(opts: UsePrepCursorOpts) {
  const { storageKey } = opts;
  const debounceRef = useRef<number | undefined>(undefined);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Restore on mount + when the storageKey changes
  useEffect(() => {
    if (!opts.enabled || opts.recordCount === 0) return;
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return;
    const idx = Math.min(
      Number.parseInt(stored, 10),
      Math.max(0, opts.recordCount - 1),
    );
    if (!Number.isFinite(idx) || idx <= 0) return;
    const target = containerRef.current?.querySelector(
      `[data-pair-index="${idx}"]`,
    );
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ block: "start", behavior: "auto" });
    }
  }, [opts.enabled, opts.recordCount, storageKey]);

  const onPairVisible = useCallback(
    (index: number) => {
      if (!opts.enabled) return;
      if (debounceRef.current !== undefined) {
        window.clearTimeout(debounceRef.current);
      }
      debounceRef.current = window.setTimeout(() => {
        window.localStorage.setItem(storageKey, String(index));
      }, 250);
    },
    [opts.enabled, storageKey],
  );

  const clear = useCallback(() => {
    window.localStorage.removeItem(storageKey);
  }, [storageKey]);

  return { containerRef, onPairVisible, clear };
}
