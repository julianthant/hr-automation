import { useCallback, useEffect } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { CapturePhotoSummary } from "./capture-types";

/**
 * Full-size preview overlay for capture photos. Lightweight custom
 * component (per visual direction §8 — "don't pull a library"). Mounts
 * a fixed-position layer outside the modal's grid so it can cover the
 * whole viewport.
 *
 * Keyboard:
 *  - Esc          → close
 *  - Left arrow   → previous photo
 *  - Right arrow  → next photo
 *
 * Note: the surrounding shadcn Dialog already traps focus, but the
 * lightbox is rendered above it, so we install our own keydown handler
 * while it's open.
 */

export interface CapturePhotoLightboxProps {
  photos: CapturePhotoSummary[];
  /** Index in `photos` of the currently-shown photo. -1 = closed. */
  activeIndex: number;
  /** Resolves a photo's index → image URL. Same fn the tiles use. */
  resolveSrc: (photo: CapturePhotoSummary) => string;
  onClose: () => void;
  onNavigate: (next: number) => void;
}

export function CapturePhotoLightbox({
  photos,
  activeIndex,
  resolveSrc,
  onClose,
  onNavigate,
}: CapturePhotoLightboxProps) {
  const open = activeIndex >= 0 && activeIndex < photos.length;

  const navigate = useCallback(
    (delta: number) => {
      if (!open) return;
      const next = (activeIndex + delta + photos.length) % photos.length;
      onNavigate(next);
    },
    [activeIndex, open, onNavigate, photos.length],
  );

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        navigate(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        navigate(1);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, navigate, onClose]);

  if (!open) return null;
  const photo = photos[activeIndex];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Photo ${photo.index + 1} preview`}
      onClick={onClose}
      className="fixed inset-0 z-[60] flex items-center justify-center"
      style={{ backgroundColor: "rgba(2, 6, 23, 0.92)" }}
    >
      {/* Close X */}
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

      {/* Index/count caption */}
      <span
        className="absolute left-1/2 top-4 -translate-x-1/2 rounded-md px-3 py-1 font-mono text-xs tabular-nums"
        style={{
          backgroundColor: "var(--capture-bg-raised)",
          color: "var(--capture-fg-secondary)",
        }}
        aria-live="polite"
      >
        {activeIndex + 1} / {photos.length}
      </span>

      {/* Prev */}
      {photos.length > 1 && (
        <button
          type="button"
          aria-label="Previous photo"
          onClick={(e) => {
            e.stopPropagation();
            navigate(-1);
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

      {/* Image */}
      <img
        src={resolveSrc(photo)}
        alt={`Photo ${photo.index + 1} from capture session`}
        className="max-h-[88vh] max-w-[88vw] rounded-md object-contain"
        style={{ boxShadow: "0 8px 32px rgba(0,0,0,0.6)" }}
        onClick={(e) => e.stopPropagation()}
      />

      {/* Next */}
      {photos.length > 1 && (
        <button
          type="button"
          aria-label="Next photo"
          onClick={(e) => {
            e.stopPropagation();
            navigate(1);
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
