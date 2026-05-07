import { useEffect, useState } from "react";
import { X } from "lucide-react";
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
        "transition-shadow",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        !disabled && "cursor-pointer hover:shadow-md",
        disabled && "opacity-60 cursor-not-allowed",
        justArrived && "capture-anim-thumb-enter",
      )}
      style={{
        backgroundColor: "var(--capture-bg-raised)",
        outlineColor: photo.blurFlagged ? "var(--capture-warn)" : "transparent",
        outlineWidth: photo.blurFlagged ? 1 : 0,
        outlineStyle: "solid",
        outlineOffset: -1,
        ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
      }}
    >
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

      {/* Blur label — text-only mono caps, flashes once on transition. */}
      {photo.blurFlagged && (
        <span
          key={flashKey}
          className="capture-anim-blur-flash absolute right-1.5 bottom-1.5 font-sans text-[9px] uppercase tracking-[0.08em] font-medium"
          style={{ color: "var(--capture-warn)" }}
        >
          blurry
        </span>
      )}

      {/* Hover/focus delete overlay — outlined ghost circle. */}
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
                "absolute right-1 top-1 inline-flex h-7 w-7 items-center justify-center rounded-full",
                "opacity-0 transition-opacity duration-150",
                "group-hover:opacity-100 focus-visible:opacity-100",
                "focus-visible:outline-none focus-visible:ring-2",
              )}
              style={{
                backgroundColor: "var(--capture-bg-modal)",
                color: "var(--capture-fg-secondary)",
                border: "1px solid var(--capture-border-strong)",
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
