import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { TrackerEntry } from "./types";
import {
  parsePrepareRowData,
  type PreviewRecord,
  type Verification,
} from "./preview-types";
import {
  parseOathPrepareRowData,
  type OathPreviewRecord,
} from "./oath-preview-types";
import { PrepReviewPair } from "./PrepReviewPair";
import { PrepReviewMultiPair } from "./PrepReviewMultiPair";
import { PrepReviewFormCard } from "./PrepReviewFormCard";
import { EcReviewForm } from "./EcReviewForm";
import { OathReviewForm } from "./OathReviewForm";
import { usePrepCursor } from "./hooks/usePrepCursor";
import { cn } from "@/lib/utils";

export interface PrepReviewPaneProps {
  entry: TrackerEntry;
  onClose: () => void;
}

type AnyPreviewRecord = PreviewRecord | OathPreviewRecord;

/**
 * Replaces the LogPanel for the active prep row. Owns the header
 * (Back arrow, filename, Cancel, Approve N), the scroll body grouped
 * by sourcePage (single → PrepReviewPair, multi → PrepReviewMultiPair),
 * per-record edit state mirrored to localStorage, and the approve POST.
 *
 * Closing the pane (Back arrow, Cancel, or selecting another queue
 * entry) preserves localStorage edits — Approve / Discard clear them.
 */
export function PrepReviewPane({ entry, onClose }: PrepReviewPaneProps) {
  const isOath = entry.workflow === "oath-signature";
  const runId = entry.runId ?? entry.id;
  const data = useMemo(
    () => (isOath ? parseOathPrepareRowData(entry.data) : parsePrepareRowData(entry.data)),
    [entry.data, isOath],
  );
  const baseRecords = useMemo(() => data?.records ?? [], [data]);
  const storageKey = isOath ? `oath-prep-edits:${runId}` : `ec-prep-edits:${runId}`;

  const [localEdits, setLocalEdits] = useState<Record<number, AnyPreviewRecord>>(
    () => {
      try {
        const raw = window.localStorage.getItem(storageKey);
        return raw ? (JSON.parse(raw) as Record<number, AnyPreviewRecord>) : {};
      } catch {
        return {};
      }
    },
  );
  const [submitting, setSubmitting] = useState(false);

  // Persist edits — debounced via React's state batching is enough here.
  useEffect(() => {
    if (Object.keys(localEdits).length === 0) {
      window.localStorage.removeItem(storageKey);
      return;
    }
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(localEdits));
    } catch {
      /* localStorage full / disabled — silently drop */
    }
  }, [localEdits, storageKey]);

  const records: AnyPreviewRecord[] = useMemo(
    () => baseRecords.map((r, i) => localEdits[i] ?? r),
    [baseRecords, localEdits],
  );

  const setRecord = (index: number, next: AnyPreviewRecord): void => {
    setLocalEdits((prev) => ({ ...prev, [index]: next }));
  };

  const { containerRef, onPairVisible, clear: clearCursor } = usePrepCursor({
    workflow: entry.workflow as "emergency-contact" | "oath-signature",
    runId,
    enabled: true,
    recordCount: records.length,
  });

  // Group records by sourcePage (preserve original-input ordering inside each group)
  const grouped = useMemo(() => {
    const map = new Map<number, Array<{ record: AnyPreviewRecord; originalIndex: number }>>();
    records.forEach((r, originalIndex) => {
      const page = (r as { sourcePage: number }).sourcePage;
      if (!map.has(page)) map.set(page, []);
      map.get(page)!.push({ record: r, originalIndex });
    });
    return Array.from(map.entries()).sort(([a], [b]) => a - b);
  }, [records]);

  const totalPages = grouped.length;
  const approvableRecords = useMemo(
    () => records.filter((r) => isApprovable(r)),
    [records],
  );
  const selectedCount = approvableRecords.filter((r) => r.selected).length;
  const summary = describeSummary(records);

  async function handleApprove() {
    if (submitting) return;
    setSubmitting(true);
    const approveUrl = isOath
      ? "/api/oath-signature/approve-batch"
      : "/api/emergency-contact/approve-batch";
    try {
      const resp = await fetch(approveUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parentRunId: runId, records }),
      });
      const body = (await resp.json()) as { ok?: boolean; error?: string; enqueued?: number };
      if (!resp.ok || !body.ok) {
        toast.error("Couldn't approve batch", {
          description: body.error ?? "Server error",
        });
        setSubmitting(false);
        return;
      }
      toast.success(
        `Queued ${body.enqueued ?? selectedCount} record${(body.enqueued ?? selectedCount) === 1 ? "" : "s"}`,
      );
      clearCursor();
      window.localStorage.removeItem(storageKey);
      onClose();
    } catch (err) {
      toast.error("Couldn't approve batch", {
        description: err instanceof Error ? err.message : "Network error",
      });
      setSubmitting(false);
    }
  }

  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        Couldn't parse prep row data.
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-border bg-card p-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted"
            aria-label="Back"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
          <FileText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="truncate text-sm font-semibold">
            {data.pdfOriginalName || "Prep review"}
          </span>
          <span className="rounded-full border border-border bg-secondary px-1.5 py-px font-mono text-[10px] text-muted-foreground">
            Review
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-muted-foreground">{summary}</span>
          <button
            onClick={onClose}
            className="h-7 rounded-md border border-border px-3 text-xs text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={handleApprove}
            disabled={submitting || selectedCount === 0}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md border border-primary bg-primary px-3 text-xs font-semibold text-primary-foreground",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {submitting && <Loader2 className="h-3 w-3 animate-spin" />}
            Approve {selectedCount}
          </button>
        </div>
      </div>

      {/* Scroll body */}
      <div ref={containerRef} className="flex-1 overflow-y-auto bg-secondary/30">
        {grouped.map(([page, group]) => {
          if (group.length === 1) {
            const { record, originalIndex } = group[0];
            return (
              <div
                key={page}
                data-pair-index={originalIndex}
                onMouseEnter={() => onPairVisible(originalIndex)}
              >
                <PrepReviewPair
                  workflow={entry.workflow as "emergency-contact" | "oath-signature"}
                  parentRunId={runId}
                  page={page}
                  formCard={renderFormCard({
                    record,
                    isOath,
                    totalPages,
                    onChange: (next) => setRecord(originalIndex, next),
                  })}
                />
              </div>
            );
          }
          // Multi-pair (sign-in sheet)
          const cards = group.map(({ record, originalIndex }, rowIdx) => (
            <div
              key={originalIndex}
              data-pair-index={originalIndex}
              onMouseEnter={() => onPairVisible(originalIndex)}
            >
              {renderFormCard({
                record,
                isOath,
                totalPages,
                rowOnPage: rowIdx + 1,
                totalRowsOnPage: group.length,
                onChange: (next) => setRecord(originalIndex, next),
              })}
            </div>
          ));
          return (
            <PrepReviewMultiPair
              key={page}
              workflow={entry.workflow as "emergency-contact" | "oath-signature"}
              parentRunId={runId}
              page={page}
              formCards={cards}
            />
          );
        })}
      </div>
    </div>
  );
}

function isApprovable(record: AnyPreviewRecord): boolean {
  const matchOk = record.matchState === "matched" || record.matchState === "resolved";
  const notUnknown = record.documentType !== "unknown";
  // Verification is best-effort — when stage 5 hasn't run we don't gate on
  // it. Once it lands, only `verified` qualifies.
  const verifyOk = record.verification ? record.verification.state === "verified" : true;
  return matchOk && notUnknown && verifyOk;
}

function describeSummary(records: AnyPreviewRecord[]): string {
  let verified = 0;
  let needsReview = 0;
  let toRemove = 0;
  for (const r of records) {
    if (r.documentType === "unknown") {
      toRemove += 1;
      continue;
    }
    if (r.verification && r.verification.state !== "verified") {
      needsReview += 1;
      continue;
    }
    if (r.matchState !== "matched" && r.matchState !== "resolved") {
      needsReview += 1;
      continue;
    }
    verified += 1;
  }
  const parts: string[] = [`${verified} verified`];
  if (needsReview > 0) parts.push(`${needsReview} needs review`);
  if (toRemove > 0) parts.push(`${toRemove} to remove`);
  return parts.join(" · ");
}

function renderFormCard(args: {
  record: AnyPreviewRecord;
  isOath: boolean;
  totalPages: number;
  rowOnPage?: number;
  totalRowsOnPage?: number;
  onChange: (r: AnyPreviewRecord) => void;
}): ReactNode {
  const r = args.record;
  const sourcePage = (r as { sourcePage: number }).sourcePage;
  const pageLocation = args.totalRowsOnPage
    ? `Page ${sourcePage} of ${args.totalPages}, Row ${args.rowOnPage} of ${args.totalRowsOnPage} in pile`
    : `Page ${sourcePage} of ${args.totalPages} in pile`;
  const recordName = args.isOath
    ? (r as OathPreviewRecord).printedName || "(no name)"
    : (r as PreviewRecord).employee.name || "(no name)";

  const matchStateBadge = (
    <span className="rounded-md border border-border bg-secondary px-1.5 py-px font-mono text-[10px] uppercase">
      {r.matchState}
    </span>
  );
  const verificationBadge = renderVerificationBadge(r);
  const isUnknown = r.documentType === "unknown";

  const removeFromPileBanner = isUnknown ? (
    <span>
      Page {sourcePage} doesn't match the expected form template — REMOVE
      FROM PILE.
    </span>
  ) : undefined;
  const addToPaperBanner =
    (r.originallyMissing?.length ?? 0) > 0 ? (
      <span>Add to paper: {r.originallyMissing!.join(", ")}</span>
    ) : undefined;
  const verificationBanner =
    r.verification && r.verification.state !== "verified"
      ? renderVerificationBanner(r.verification)
      : undefined;
  const signatureBanner = renderOathSignatureBanner(r, args.isOath);

  return (
    <PrepReviewFormCard
      pageLocation={pageLocation}
      recordName={recordName}
      matchStateBadge={matchStateBadge}
      verificationBadge={verificationBadge}
      signatureBadge={renderSignatureBadge(r, args.isOath)}
      documentTypeBadge={
        isUnknown ? (
          <span className="rounded-md border border-destructive/40 bg-destructive/10 px-1.5 py-px font-mono text-[10px] uppercase text-destructive">
            ⚠ unknown
          </span>
        ) : undefined
      }
      removeFromPileBanner={removeFromPileBanner}
      addToPaperBanner={addToPaperBanner}
      verificationBanner={verificationBanner}
      signatureBanner={signatureBanner}
      selected={r.selected}
      selectedDisabled={isUnknown}
      onSelectedChange={(next) =>
        args.onChange({ ...r, selected: next } as AnyPreviewRecord)
      }
    >
      {args.isOath ? (
        <OathReviewForm
          record={r as OathPreviewRecord}
          onChange={(next) => args.onChange(next)}
        />
      ) : (
        <EcReviewForm
          record={r as PreviewRecord}
          onChange={(next) => args.onChange(next)}
        />
      )}
    </PrepReviewFormCard>
  );
}

function renderVerificationBadge(r: { verification?: { state: string } }): ReactNode {
  if (!r.verification) return null;
  const palette: Record<string, string> = {
    verified: "border-success/40 bg-success/10 text-success",
    inactive: "border-destructive/40 bg-destructive/10 text-destructive",
    "non-hdh": "border-destructive/40 bg-destructive/10 text-destructive",
    "lookup-failed": "border-border bg-muted text-muted-foreground",
  };
  const label: Record<string, string> = {
    verified: "✓ HDH active",
    inactive: "⚠ inactive",
    "non-hdh": "⚠ non-HDH",
    "lookup-failed": "verify failed",
  };
  const cls = palette[r.verification.state] ?? palette["lookup-failed"];
  const text = label[r.verification.state] ?? r.verification.state;
  return (
    <span
      className={cn(
        "rounded-md border px-1.5 py-px font-mono text-[10px] uppercase",
        cls,
      )}
    >
      {text}
    </span>
  );
}

function renderVerificationBanner(v: Verification): ReactNode {
  const screenshotFilename = v.state !== "lookup-failed" ? v.screenshotFilename : "";
  const reason =
    v.state === "inactive"
      ? `Employee found but hrStatus = ${v.hrStatus} — auto-deselected.`
      : v.state === "non-hdh"
        ? `Employee found in ${v.department || "unknown dept"} — not HDH.`
        : v.state === "lookup-failed"
          ? `Person Org Summary lookup did not return a result: ${v.error}`
          : "";
  return (
    <span>
      Verification: {reason}
      {screenshotFilename && (
        <>
          {" "}
          <a
            href={`/screenshots/${encodeURIComponent(screenshotFilename)}`}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            View Person Org Summary screenshot
          </a>
        </>
      )}
    </span>
  );
}

function renderSignatureBadge(r: AnyPreviewRecord, isOath: boolean): ReactNode {
  if (!isOath) return undefined;
  const oath = r as OathPreviewRecord;
  if (oath.employeeSigned === false) {
    return (
      <span className="rounded-md border border-warning/40 bg-warning/10 px-1.5 py-px font-mono text-[10px] uppercase text-warning">
        ⚠ employee unsigned
      </span>
    );
  }
  if (oath.officerSigned === false) {
    return (
      <span className="rounded-md border border-warning/40 bg-warning/10 px-1.5 py-px font-mono text-[10px] uppercase text-warning">
        ⚠ officer unsigned
      </span>
    );
  }
  return undefined;
}

function renderOathSignatureBanner(
  r: AnyPreviewRecord,
  isOath: boolean,
): ReactNode {
  if (!isOath) return undefined;
  const oath = r as OathPreviewRecord;
  if (oath.employeeSigned === false) {
    return <span>Signature missing — employee did not sign.</span>;
  }
  if (oath.officerSigned === false) {
    return <span>Signature missing — authorized officer did not sign.</span>;
  }
  return undefined;
}
