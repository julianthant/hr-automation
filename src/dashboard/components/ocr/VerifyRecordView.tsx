import { Check, Search, X } from "lucide-react";
import type { VerifyCheck, VerifyPreviewRecord } from "./types";

export interface VerifyRecordViewProps {
  record: VerifyPreviewRecord;
  /** Unused — read-only view; kept for registry signature parity. */
  onChange?: (next: VerifyPreviewRecord) => void;
}

function FormKindChip({ formKind }: { formKind: VerifyPreviewRecord["formKind"] }) {
  if (formKind === "oath") {
    return (
      <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-wide text-primary">
        Oath
      </span>
    );
  }
  if (formKind === "emergency-contact") {
    return (
      <span className="rounded border border-border bg-muted px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Emergency Contact
      </span>
    );
  }
  return (
    <span className="rounded border border-destructive/30 bg-destructive/10 px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-wide text-destructive">
      Unknown
    </span>
  );
}

function SourceBadge({ source }: { source: VerifyCheck["source"] }) {
  if (!source) return null;
  const label =
    source === "crm"
      ? "CRM"
      : source === "ucpath"
        ? "UCPath"
        : source === "i9"
          ? "I-9"
          : source === "paper"
            ? "Paper"
            : source;
  return (
    <span className="shrink-0 rounded border border-border bg-muted px-1 py-px font-mono text-[10px] uppercase text-muted-foreground">
      {label}
    </span>
  );
}

function CheckRow({ check }: { check: VerifyCheck }) {
  const isPresentOrFound = check.status === "present" || check.status === "found";
  const value = check.status === "present" ? check.paperValue : check.foundValue;

  return (
    <div
      className={`flex items-start gap-3 rounded-md px-3 py-2.5 ${
        check.status === "found"
          ? "bg-blue-500/5 ring-1 ring-blue-500/20"
          : check.status === "missing"
            ? "bg-destructive/5"
            : "bg-transparent"
      }`}
    >
      {/* Status icon */}
      <div className="mt-px shrink-0">
        {check.status === "present" && (
          <Check className="h-3.5 w-3.5 text-success" aria-label="Present on paper" />
        )}
        {check.status === "found" && (
          <Search className="h-3.5 w-3.5 text-blue-500" aria-label="Looked up" />
        )}
        {check.status === "missing" && (
          <X className="h-3.5 w-3.5 text-destructive" aria-label="Not found" />
        )}
      </div>

      {/* Label + value */}
      <div className="min-w-0 flex-1">
        <span className="block font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {check.label}
        </span>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5">
          {isPresentOrFound && value ? (
            <>
              <span
                className={`truncate text-sm font-medium ${
                  check.status === "found" ? "text-foreground" : "text-foreground/80"
                }`}
              >
                {value}
              </span>
              {check.status === "present" && (
                <span className="shrink-0 text-xs text-muted-foreground">(on paper)</span>
              )}
              {check.status === "found" && <SourceBadge source={check.source} />}
            </>
          ) : (
            <span className="text-sm text-muted-foreground/60">— not found</span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Read-only completeness report for a verify OCR record. Shows each check
 * from `record.checks` so the operator can copy "found" values onto the
 * physical form before filing.
 */
export function VerifyRecordView({ record }: VerifyRecordViewProps) {
  const checks = record.checks ?? [];
  const resolvedName =
    record.name || (typeof record.printedName === "string" ? record.printedName : null) || "(no name)";
  const hasWarnings =
    record.matchState === "unresolved" || (record.warnings?.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-3">
      {/* Record header */}
      <div className="flex flex-wrap items-center gap-2">
        <FormKindChip formKind={record.formKind} />
        <span className="min-w-0 truncate text-sm font-semibold text-foreground">
          {resolvedName}
        </span>
        {record.employeeId ? (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {record.employeeId}
          </span>
        ) : null}
      </div>

      {/* Warning line */}
      {hasWarnings && (
        <div className="text-xs text-muted-foreground/80">
          {record.matchState === "unresolved" && (
            <span className="mr-2">Could not resolve employee.</span>
          )}
          {record.warnings?.map((w, i) => (
            <span key={i}>{w}</span>
          ))}
        </div>
      )}

      {/* Completeness checklist */}
      {checks.length === 0 ? (
        <p className="text-xs text-muted-foreground/60">No completeness checks available.</p>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Completeness Report
          </p>
          <div className="flex flex-col gap-1">
            {checks.map((check) => (
              <CheckRow key={check.key} check={check} />
            ))}
          </div>
          {checks.some((c) => c.status === "found") && (
            <p className="mt-1 text-xs text-muted-foreground/70">
              Write <span className="font-medium text-blue-500">looked-up</span> values onto the physical form.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
