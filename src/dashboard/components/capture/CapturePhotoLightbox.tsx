import type { CapturePhotoSummary } from "./capture-types";
import { MediaLightbox } from "@/components/shared/MediaLightbox";

/**
 * Full-size preview overlay for capture photos.
 *
 * Uses the SAME chrome as the Screenshots tab (`chrome="screenshot"`) so a
 * captured photo reads as a proper full-screen modal — a solid card panel over
 * a dark backdrop, with the prev/next arrows living in FIXED side gutters (not
 * pinned to the image, which shifted them between differently-sized photos) and
 * a macOS-Preview-style thumbnail rail once there are 2+ photos. Every image
 * renders into a constant-size box and `object-contain`s to fit, so the nav
 * never moves and the operator can page through fast.
 *
 * Keyboard (handled by MediaLightbox):
 *  - Esc                → close
 *  - Left / Right arrow → previous / next photo
 *  - Home / End         → first / last photo
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

/**
 * Fixed-size, portrait-friendly viewer box. Every photo renders into the same
 * box and `object-contain`s to fit, so the flanking prev/next buttons never
 * shift between images (phone photos vary in aspect + resolution).
 */
function CaptureView({ src, alt }: { src: string; alt: string }) {
  return (
    <div
      className="flex items-center justify-center"
      style={{ width: "min(88vw, 560px)", height: "84vh" }}
    >
      <img
        src={src}
        srcSet={src}
        sizes="88vw"
        alt={alt}
        // Eager + high priority: the lightbox image is immediately in view, so
        // lazy-loading only delayed it appearing ("doesn't load right away").
        loading="eager"
        fetchPriority="high"
        decoding="async"
        className="max-h-full max-w-full rounded-lg object-contain"
      />
    </div>
  );
}

export function CapturePhotoLightbox({
  photos,
  activeIndex,
  resolveSrc,
  onClose,
  onNavigate,
}: CapturePhotoLightboxProps) {
  const open = activeIndex >= 0 && activeIndex < photos.length;

  return (
    <MediaLightbox
      items={photos}
      index={activeIndex}
      onIndexChange={onNavigate}
      onClose={onClose}
      open={open}
      enableHomeEnd
      ariaLabel="Capture photo preview"
      mediaNoun="photo"
      renderItem={(item) => (
        <CaptureView src={resolveSrc(item)} alt={`Photo ${item.index + 1} from capture session`} />
      )}
      renderThumbnail={(item) => (
        <img
          src={resolveSrc(item)}
          srcSet={resolveSrc(item)}
          sizes="7rem"
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover object-top"
        />
      )}
      renderCaption={(item, itemIndex) => (
        <>
          <span className="uppercase tracking-wider">Photo {item.index + 1}</span>
          <span className="text-muted-foreground">
            {" "}· {itemIndex + 1} / {photos.length}
          </span>
          {item.blurFlagged && <span className="text-warning">{" "}· flagged blurry</span>}
        </>
      )}
    />
  );
}
