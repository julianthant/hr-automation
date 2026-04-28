import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { CapturePhotoSummary } from "./capture-types";

/**
 * Single thumbnail tile for the capture modal's live mirror grid.
 *
 * - Aspect 3/4 (matches phone portrait orientation).
 * - Index badge top-left (mono).
 * - Blur warning badge top-right when `photo.blurFlagged`.
 * - On hover (or focus): delete X overlay → calls `onDelete(index)`.
 * - Click anywhere on the tile (except delete) → `onView(index)` for
 *   the lightbox.
 *
 * Visual identity comes entirely from the `--capture-*` tokens defined
 * in `index.css` — no inline hex.
 */

export interface CapturePhotoTileProps {
  photo: CapturePhotoSummary;
  /** The token used to fetch image bytes via `/capture-photos/:token/:index`. */
  imageSrc: string;
  /** Fires when operator clicks the tile body. Opens lightbox. */
  onView?: (index: number) => void;
  /** Fires when operator confirms delete via the overlay X. */
  onDelete?: (index: number) => void;
  /**
   * If true, the tile renders the "just-arrived" enter animation. Modal
   * sets this for one render cycle when a `photo_added` event lands so
   * the bounce only plays once.
   */
  justArrived?: boolean;
  /** Disables interactivity (e.g. while the session is finalizing). */
  disabled?: boolean;
}

export function CapturePhotoTile({
  photo,
  imageSrc,
  onView,
  onDelete,
  justArrived,
  disabled,
}: CapturePhotoTileProps) {
  const [imageError, setImageError] = useState(false);
  const [flashKey, setFlashKey] = useState(0);

  // Replay the blur-flash animation when blurFlagged transitions to true.
  useEffect(() => {
    if (photo.blurFlagged) setFlashKey((k) => k + 1);
  }, [photo.blurFlagged]);

  const handleDelete = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    if (!disabled && onDelete) onDelete(photo.index);
  };

  return (
    <div
      role={onView ? "button" : undefined}
      tabIndex={onView && !disabled ? 0 : -1}
      aria-label={`Photo ${photo.index + 1} from capture session${
        photo.blurFlagged ? " — flagged as blurry" : ""
      }`}
      onClick={() => !disabled && onView?.(photo.index)}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !disabled) {
          e.preventDefault();
          onView?.(photo.index);
        }
      }}
      className={cn(
        "group relative aspect-[3/4] overflow-hidden rounded-md",
        "border transition-shadow",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        photo.blurFlagged ? "border-transparent" : "border-[var(--capture-border-strong)]",
        !disabled && "cursor-pointer hover:shadow-lg",
        disabled && "opacity-60 cursor-not-allowed",
        justArrived && !photo.blurFlagged && "capture-anim-thumb-enter",
        photo.blurFlagged && "capture-anim-thumb-enter",
      )}
      style={{
        backgroundColor: "var(--capture-bg-raised)",
        outlineColor: photo.blurFlagged ? "var(--capture-warn)" : "transparent",
        outlineWidth: photo.blurFlagged ? 2 : 0,
        outlineStyle: "solid",
        outlineOffset: -2,
        // CSS focus-visible ring color
        ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
      }}
    >
      {/* Image — tolerates 404 (e.g. before the photo file lands on disk
          or after a delete races with state). */}
      {!imageError ? (
        <img
          src={imageSrc}
          alt={`Photo ${photo.index + 1}`}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
          onError={() => setImageError(true)}
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center text-xs"
          style={{ color: "var(--capture-fg-faint)" }}
        >
          —
        </div>
      )}

      {/* Index badge */}
      <span
        className="absolute left-1.5 top-1.5 rounded-sm px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums"
        style={{
          backgroundColor: "rgba(15, 23, 42, 0.7)",
          color: "var(--capture-fg-primary)",
        }}
        aria-hidden
      >
        {photo.index + 1}
      </span>

      {/* Blur badge — color + icon + word per visual direction §1.2 */}
      {photo.blurFlagged && (
        <span
          key={flashKey}
          className="capture-anim-blur-flash absolute right-1.5 top-1.5 inline-flex items-center gap-0.5 rounded-sm px-1.5 py-0.5 font-sans text-[10px] font-semibold uppercase"
          style={{
            backgroundColor: "rgba(245, 158, 11, 0.9)",
            color: "#1F1300",
          }}
        >
          <AlertTriangle aria-hidden className="h-3 w-3" />
          blur
        </span>
      )}

      {/* Hover/focus delete overlay */}
      {onDelete && !disabled && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`Delete photo ${photo.index + 1}`}
              onClick={handleDelete}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") handleDelete(e);
              }}
              tabIndex={0}
              className={cn(
                "absolute right-1 bottom-1 inline-flex h-7 w-7 items-center justify-center rounded-full",
                "opacity-0 transition-opacity duration-150",
                "group-hover:opacity-100 focus-visible:opacity-100",
                "focus-visible:outline-none focus-visible:ring-2",
              )}
              style={{
                backgroundColor: "rgba(15, 23, 42, 0.85)",
                color: "var(--capture-fg-primary)",
                ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
              }}
            >
              <X aria-hidden className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Delete photo</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
