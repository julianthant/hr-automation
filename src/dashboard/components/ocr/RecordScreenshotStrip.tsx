import { useMemo, useState } from "react";
import { Camera } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRunScreenshots } from "@/components/hooks/useRunScreenshots";
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
  runFormType: "verify" | "oath" | "emergency-contact";
  /** Bumps to force a refetch (e.g. when a relookup resolves). */
  refreshKey: number;
}

const SYSTEM_LABELS: Record<string, string> = {
  ucpath: "UCPath",
  crm: "CRM",
  i9: "I-9",
};

function systemLabel(system: string): string {
  return SYSTEM_LABELS[system.toLowerCase()] ?? system.toUpperCase();
}

export function RecordScreenshotStrip({
  ocrRunId,
  recordIndex,
  formKind,
  runFormType,
  refreshKey,
}: RecordScreenshotStripProps) {
  // The person-lookup child item-id prefix is set by the RUN's form type
  // (orchestrator fan-out `ocr-${oath|ec}-…`; verify `ocr-verify-…`).
  const personPrefix =
    runFormType === "oath"
      ? "ocr-oath"
      : runFormType === "emergency-contact"
        ? "ocr-ec"
        : "ocr-verify";
  const personItemId = ocrRunId ? `${personPrefix}-${ocrRunId}-r${recordIndex}` : null;
  // i9-lookup runs only inside verify's enrichRecords (for oath records).
  const i9ItemId =
    ocrRunId && runFormType === "verify" && formKind === "oath"
      ? `ocr-verify-i9-${ocrRunId}-r${recordIndex}`
      : null;

  const { entries: personEntries } = useRunScreenshots("person-lookup", personItemId, refreshKey);
  const { entries: i9Entries } = useRunScreenshots("i9-lookup", i9ItemId, refreshKey);

  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);

  // One arrow-keyable queue: person-lookup shots first, then i9, each in
  // capture order. Errors and forms interleave by ts within a source.
  const flat = useMemo<LightboxItem[]>(() => {
    const out: LightboxItem[] = [];
    for (const entry of [...personEntries, ...i9Entries].sort((a, b) => a.ts - b.ts)) {
      for (let i = 0; i < entry.files.length; i++) out.push({ entry, fileIdx: i });
    }
    return out;
  }, [personEntries, i9Entries]);

  if (flat.length === 0) return null;

  // Chrome-less: the call site provides the block wrapper (a full-width card
  // block in the single-record pair; an inline border-separated row in a
  // multi-record card).
  return (
    <div>
      <div
        className="flex items-stretch gap-2 overflow-x-auto"
        role="list"
        aria-label="Lookup screenshots by source system"
      >
        {flat.map((item, idx) => {
          const file = item.entry.files[item.fileIdx];
          if (!file) return null;
          const label = systemLabel(file.system);
          return (
            <button
              key={`${item.entry.ts}-${item.fileIdx}-${idx}`}
              type="button"
              role="listitem"
              onClick={() => setLightboxIdx(idx)}
              title={`${label} — ${item.entry.label} (click to enlarge)`}
              className={cn(
                "group relative shrink-0 overflow-hidden rounded-md border border-border bg-secondary",
                "cursor-pointer outline-none transition-colors hover:border-primary/50",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card",
              )}
            >
              <img
                src={file.url}
                srcSet={file.url}
                sizes="120px"
                alt={`${label} screenshot`}
                loading="lazy"
                decoding="async"
                className="h-16 w-28 object-cover object-top"
              />
              <span
                className={cn(
                  "absolute inset-x-0 bottom-0 flex items-center gap-1 bg-background/80 px-1.5 py-0.5",
                  "font-mono text-[9px] font-medium uppercase tracking-wider text-foreground",
                )}
              >
                <Camera className="h-2.5 w-2.5 shrink-0 text-muted-foreground" aria-hidden />
                {label}
              </span>
            </button>
          );
        })}
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
