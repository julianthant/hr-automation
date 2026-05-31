import type { ScreenshotEntry } from "@/components/hooks/useRunScreenshots";
import { MediaLightbox } from "@/components/shared/MediaLightbox";

/** One flattened (entry, file-within-entry) pair in the lightbox queue. */
export interface LightboxItem {
  entry: ScreenshotEntry;
  fileIdx: number;
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
        return (
          <img
            src={file.url}
            srcSet={file.url}
            sizes="85vw"
            alt={file.system}
            loading="lazy"
            decoding="async"
            className="max-w-full max-h-[85vh] rounded object-contain"
          />
        );
      }}
      renderCaption={(item, itemIndex) => {
        const file = item.entry.files[item.fileIdx];
        if (!file) return null;
        return (
          <>
            <span className="uppercase tracking-wider">{file.system}</span>
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
