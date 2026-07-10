import { useMemo, useState } from "react";
import {
  useRunScreenshots,
  type ScreenshotEntry,
} from "@/components/hooks/useRunScreenshots";
import { ScreenshotCard } from "@/components/log-panel/ScreenshotCard";
import { ScreenshotLightbox, type LightboxItem } from "@/components/log-panel/ScreenshotLightbox";

/**
 * Inline labeled screenshot strip for a standalone OCR review record, rendered
 * as its own block between the card header and the form/completeness body. Shows
 * the PNGs the per-record background lookups captured — person-lookup
 * (UCPath / CRM) and, for verify oath records, i9-lookup (I-9 summary) — so the
 * operator can glance at the source pages without leaving the OCR review.
 *
 * The child item-ids are deterministic and keyed by the RUN's form type: the
 * orchestrator fans out person-lookup as `ocr-oath-<runId>-r<idx>` /
 * `ocr-ec-<runId>-r<idx>` for standalone oath/EC, and verify's `enrichRecords`
 * fans out `ocr-verify-<runId>-r<idx>` (+ `ocr-verify-i9-<runId>-r<idx>`). So we
 * address the screenshots directly without task-dependency lookups. `refreshKey`
 * bumps when a per-record relookup finishes so freshly-captured shots stream in.
 * Clicking a thumbnail opens the shared centered lightbox. Self-hides when empty.
 */
export interface RecordScreenshotStripProps {
  /** The OCR prep run id (the parent of the per-record child lookups). */
  ocrRunId: string;
  /** Index into the OCR row's `data.records` array (the `r<idx>` suffix). */
  recordIndex: number;
  /** This record's form kind — verify oath records also carry an i9-lookup. */
  formKind: string;
  /** The RUN's form type — sets the person-lookup child item-id prefix. */
  runFormType: "verify" | "oath" | "emergency-contact" | "i9";
  /** Bumps to force a refetch (e.g. when a relookup resolves). */
  refreshKey: number;
}

export function RecordScreenshotStrip({
  ocrRunId,
  recordIndex,
  formKind,
  runFormType,
  refreshKey,
}: RecordScreenshotStripProps) {
  // The person child item-id prefix is set by the RUN's form type
  // (orchestrator fan-out `ocr-${oath|ec}-…`; verify `ocr-verify-…`; the i9
  // form fans out person-MATCH children as `ocr-i9-…`).
  const personPrefix =
    runFormType === "oath"
      ? "ocr-oath"
      : runFormType === "emergency-contact"
        ? "ocr-ec"
        : runFormType === "i9"
          ? "ocr-i9"
          : "ocr-verify";
  const personItemId = ocrRunId ? `${personPrefix}-${ocrRunId}-r${recordIndex}` : null;
  // i9-lookup runs only inside verify's enrichRecords (for oath records).
  const i9ItemId =
    ocrRunId && runFormType === "verify" && formKind === "oath"
      ? `ocr-verify-i9-${ocrRunId}-r${recordIndex}`
      : null;

  // An i9 run's per-record child is a person-MATCH (UCPath person search);
  // every other form's child is a person-lookup.
  const personWorkflow = runFormType === "i9" ? "person-match" : "person-lookup";
  const { entries: personEntries } = useRunScreenshots(personWorkflow, personItemId, refreshKey);
  const { entries: i9Entries } = useRunScreenshots("i9-lookup", i9ItemId, refreshKey);

  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  const entries = useMemo(
    () => [...personEntries, ...i9Entries].sort((a, b) => a.ts - b.ts),
    [personEntries, i9Entries],
  );

  const flat = useMemo<LightboxItem[]>(() => {
    const out: LightboxItem[] = [];
    for (const entry of entries) {
      for (let i = 0; i < entry.files.length; i++) out.push({ entry, fileIdx: i });
    }
    return out;
  }, [entries]);

  if (entries.length === 0) return null;

  const openFlat = (entry: ScreenshotEntry, fileIdx: number) => {
    const idx = flat.findIndex((item) => item.entry === entry && item.fileIdx === fileIdx);
    if (idx >= 0) setLightboxIdx(idx);
  };

  // Chrome-less: the call site provides the block wrapper (a full-width card
  // block in the single-record pair; an inline border-separated row in a
  // multi-record card).
  return (
    <div>
      <div className="space-y-2" aria-label="Lookup screenshots by source system">
        {entries.map((entry) => (
          <ScreenshotCard
            key={`${entry.ts}-${entry.label}`}
            entry={entry}
            onOpen={openFlat}
          />
        ))}
      </div>

      {lightboxIdx !== null && (
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
