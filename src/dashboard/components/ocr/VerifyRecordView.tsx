import { Check, RotateCw, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  verifyCheckLookupKind,
  type VerifyCheck,
  type VerifyLookupKind,
  type VerifyPreviewRecord,
} from "./types";

export interface VerifyRecordViewProps {
  record: VerifyPreviewRecord;
  /** Unused — read-only view; kept for registry signature parity. */
  onChange?: (next: VerifyPreviewRecord) => void;
  /**
   * Re-run ONE background lookup for this record (`/api/ocr/verify-relookup`).
   * Wired only for failed (`missing`) lookup-backed checks.
   */
  onRelookup?: (lookup: VerifyLookupKind) => void;
  /** Which lookups are currently re-running for this record. */
  relookupPending?: ReadonlySet<VerifyLookupKind>;
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

/**
 * Re-run button for a failed lookup check. Spins + disables while the lookup
 * is in flight (the request stays open for the whole lookup, so the row
 * re-emits with patched data when it resolves).
 */
function RelookupButton({
  label,
  pending,
  onClick,
}: {
  label: string;
  pending: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      title={pending ? `Re-running ${label} lookup…` : `Re-run ${label} lookup`}
      aria-label={pending ? `Re-running ${label} lookup` : `Re-run ${label} lookup`}
      className={cn(
        "inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground outline-none transition-colors",
        "hover:border-primary/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-card",
        "disabled:cursor-wait disabled:opacity-60",
      )}
    >
      <RotateCw
        className={cn("h-3 w-3", pending && "animate-spin motion-reduce:animate-none")}
        aria-hidden
      />
    </button>
  );
}

function CheckRow({
  check,
  onRelookup,
  relookupPending,
}: {
  check: VerifyCheck;
  onRelookup?: (lookup: VerifyLookupKind) => void;
  relookupPending?: ReadonlySet<VerifyLookupKind>;
}) {
  const isPresentOrFound = check.status === "present" || check.status === "found";
  const value = check.status === "present" ? check.paperValue : check.foundValue;

  // Option A: only FAILED (missing) lookup-backed checks get a retry button.
  const lookupKind = check.status === "missing" ? verifyCheckLookupKind(check.key) : null;
  const canRelookup = lookupKind !== null && onRelookup !== undefined;
  const pending = lookupKind !== null && (relookupPending?.has(lookupKind) ?? false);

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-md px-3 py-2.5",
        check.status === "found"
          ? "bg-info/5 ring-1 ring-info/20"
          : check.status === "missing"
            ? "bg-destructive/5"
            : "bg-transparent",
      )}
    >
      {/* Status icon */}
      <div className="mt-px shrink-0">
        {check.status === "present" && (
          <Check className="h-3.5 w-3.5 text-success" aria-label="Present on paper" />
        )}
        {check.status === "found" && (
          <Search className="h-3.5 w-3.5 text-info" aria-label="Looked up" />
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
                className={cn(
                  "truncate text-sm font-medium",
                  check.status === "found" ? "text-foreground" : "text-foreground/80",
                )}
              >
                {value}
              </span>
              {check.status === "present" && (
                <span className="shrink-0 text-xs text-muted-foreground">(on paper)</span>
              )}
              {check.status === "found" && <SourceBadge source={check.source} />}
            </>
          ) : (
            <span
              className="text-sm text-muted-foreground"
              aria-live={pending ? "polite" : undefined}
            >
              {pending ? "Looking up…" : "— not found"}
            </span>
          )}
          {canRelookup && (
            <RelookupButton
              label={check.label}
              pending={pending}
              onClick={() => onRelookup!(lookupKind)}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Read-only completeness report for a verify OCR record. Shows each check
 * from `record.checks` so the operator can copy "found" values onto the
 * physical form before filing. Failed (`missing`) lookup-backed checks carry a
 * ↻ retry that re-runs just that lookup for this record.
 */
export function VerifyRecordView({ record, onRelookup, relookupPending }: VerifyRecordViewProps) {
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
              <CheckRow
                key={check.key}
                check={check}
                onRelookup={onRelookup}
                relookupPending={relookupPending}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
