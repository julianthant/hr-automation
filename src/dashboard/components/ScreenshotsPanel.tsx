import { useMemo, useState } from "react";
import { ScreenshotCard } from "./ScreenshotCard";
import { ScreenshotLightbox, type LightboxItem } from "./ScreenshotLightbox";
import {
  useRunScreenshots,
  type ScreenshotEntry,
} from "./hooks/useRunScreenshots";

export function ScreenshotsPanel({
  workflow,
  itemId,
  runId,
  date,
}: {
  workflow: string | null;
  itemId: string | null;
  runId: string | null;
  date: string | null;
}) {
  const { entries } = useRunScreenshots(workflow, itemId, runId, date);
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  const { errors, others, flat } = useMemo(() => {
    const errs = entries
      .filter((e) => e.kind === "error")
      .sort((a, b) => b.ts - a.ts);
    const oth = entries
      .filter((e) => e.kind !== "error")
      .sort((a, b) => b.ts - a.ts);
    // Flatten into one arrow-keyable queue. Error screenshots first (the
    // operator typically wants to see failures before form captures), then
    // form / manual. Within an entry, files go in declared order so the
    // viewer's left/right always lands on a deterministic neighbor.
    const f: LightboxItem[] = [];
    for (const entry of [...errs, ...oth]) {
      for (let i = 0; i < entry.files.length; i++) {
        f.push({ entry, fileIdx: i });
      }
    }
    return { errors: errs, others: oth, flat: f };
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div className="px-6 py-4 text-sm text-muted-foreground">
        No screenshots captured for this run yet.
      </div>
    );
  }

  const openFlat = (entry: ScreenshotEntry, fileIdx: number) => {
    const idx = flat.findIndex(
      (item) => item.entry === entry && item.fileIdx === fileIdx,
    );
    if (idx >= 0) setLightboxIdx(idx);
  };

  return (
    <div className="space-y-4 px-6 py-4 overflow-y-auto">
      {errors.length > 0 && (
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-destructive mb-2">
            Errors ({errors.length})
          </h3>
          <div className="space-y-2">
            {errors.map((e) => (
              <ScreenshotCard
                key={`${e.ts}-${e.label}`}
                entry={e}
                onOpen={openFlat}
              />
            ))}
          </div>
        </section>
      )}

      {others.length > 0 && (
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-primary mb-2">
            Forms &amp; Manual ({others.length})
          </h3>
          <div className="space-y-2">
            {others.map((e) => (
              <ScreenshotCard
                key={`${e.ts}-${e.label}`}
                entry={e}
                onOpen={openFlat}
              />
            ))}
          </div>
        </section>
      )}

      {lightboxIdx !== null && flat.length > 0 && (
        <ScreenshotLightbox
          items={flat}
          idx={Math.min(lightboxIdx, flat.length - 1)}
          onNavigate={setLightboxIdx}
          onClose={() => setLightboxIdx(null)}
        />
      )}
    </div>
  );
}
