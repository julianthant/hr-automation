import type { ScreenshotEntry } from "@/components/hooks/useRunScreenshots";
import { MediaLightbox } from "@/components/shared/MediaLightbox";

/** One flattened (entry, file-within-entry) pair in the lightbox queue. */
export interface LightboxItem {
  entry: ScreenshotEntry;
  fileIdx: number;
}

/**
 * Fixed-size, WIDE viewer box. Every screenshot renders into the same box and
 * `object-contain`s to fit, so the prev/next buttons that flank it never shift
 * between images (the whole point — wide chunk captures fill the width without
 * shrinking, and the nav stays put for fast clicking). For a `paged` capture
 * this steps chunk-to-chunk; otherwise it's one image per capture.
 */
function ScreenshotView({ src, alt }: { src: string; alt: string }) {
  return (
    <div
      className="flex items-center justify-center"
      style={{ width: "min(78vw, 1280px)", height: "82vh" }}
    >
      <img
        src={src}
        srcSet={src}
        sizes="86vw"
        alt={alt}
        loading="lazy"
        decoding="async"
        className="max-h-full max-w-full rounded object-contain"
      />
    </div>
  );
}

export function ScreenshotLightbox({
  items,
  idx,
  onNavigate,
  onClose,
}: {
  items: LightboxItem[];
  idx: number;
  onNavigate: (nextIdx: number) => void;
  onClose: () => void;
}) {
  const current = items[idx];
  if (!current) return null;

  return (
    <MediaLightbox
      items={items}
      index={idx}
      onIndexChange={onNavigate}
      onClose={onClose}
      chrome="screenshot"
      enableHomeEnd
      renderItem={(item) => {
        const file = item.entry.files[item.fileIdx];
        if (!file) return null;
        return <ScreenshotView key={file.url} src={file.url} alt={file.system} />;
      }}
      renderThumbnail={(item) => {
        const file = item.entry.files[item.fileIdx];
        if (!file) return null;
        return (
          <img
            src={file.url}
            srcSet={file.url}
            sizes="6rem"
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover object-top"
          />
        );
      }}
      renderCaption={(item, itemIndex) => {
        const file = item.entry.files[item.fileIdx];
        if (!file) return null;
        // A `paged` capture is one entry with several chunk files — show the
        // chunk position within the capture so the operator knows where they are.
        const chunkCount = item.entry.files.length;
        return (
          <>
            <span className="uppercase tracking-wider">{file.system}</span>
            {chunkCount > 1 && (
              <span className="text-muted-foreground">
                {" "}· chunk {item.fileIdx + 1} / {chunkCount}
              </span>
            )}
            <span className="text-muted-foreground">
              {" "}· {itemIndex + 1} / {items.length}
            </span>
            {" · "}
            <span className="truncate max-w-[40ch] inline-block align-bottom">
              {item.entry.label}
            </span>
          </>
        );
      }}
    />
  );
}
