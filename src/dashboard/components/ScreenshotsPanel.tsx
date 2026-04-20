import { useState } from "react";
import { ScreenshotCard } from "./ScreenshotCard";
import { ScreenshotLightbox } from "./ScreenshotLightbox";
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
  const [lightbox, setLightbox] = useState<{
    entry: ScreenshotEntry;
    fileIdx: number;
  } | null>(null);

  if (entries.length === 0) {
    return (
      <div className="px-6 py-4 text-sm text-muted-foreground">
        No screenshots captured for this run yet.
      </div>
    );
  }

  const errors = entries
    .filter((e) => e.kind === "error")
    .sort((a, b) => b.ts - a.ts);
  const others = entries
    .filter((e) => e.kind !== "error")
    .sort((a, b) => b.ts - a.ts);

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
                onOpen={(entry, i) => setLightbox({ entry, fileIdx: i })}
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
                onOpen={(entry, i) => setLightbox({ entry, fileIdx: i })}
              />
            ))}
          </div>
        </section>
      )}

      {lightbox && (
        <ScreenshotLightbox
          entry={lightbox.entry}
          fileIdx={lightbox.fileIdx}
          onNavigate={(i) => setLightbox({ ...lightbox, fileIdx: i })}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}
