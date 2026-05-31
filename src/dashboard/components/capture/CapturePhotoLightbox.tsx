import type { CapturePhotoSummary } from "./capture-types";
import { MediaLightbox } from "@/components/shared/MediaLightbox";

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
  const photo = open ? photos[activeIndex] : undefined;

  return (
    <MediaLightbox
      items={photos}
      index={activeIndex}
      onIndexChange={onNavigate}
      onClose={onClose}
      open={open}
      chrome="capture"
      wrapNavigation
      preventDefaultOnKeys
      ariaLabel={photo ? `Photo ${photo.index + 1} preview` : undefined}
      renderItem={(item) => (
        <img
          src={resolveSrc(item)}
          srcSet={resolveSrc(item)}
          sizes="88vw"
          alt={`Photo ${item.index + 1} from capture session`}
          loading="lazy"
          decoding="async"
          className="max-h-[88vh] max-w-[88vw] rounded-md object-contain"
          style={{ boxShadow: "0 8px 32px rgba(0,0,0,0.6)" }}
        />
      )}
    />
  );
}
