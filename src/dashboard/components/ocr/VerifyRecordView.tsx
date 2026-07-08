import { Check, Lock, RotateCw, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  verifyCheckLookupKind,
  type VerifyCheck,
  type VerifyLookupKind,
  type VerifyPreviewRecord,
} from "./types";
import {
  deriveLookupInProgress,
  deriveLookupProgressLabel,
  type OcrRecordLookupTracker,
} from "./lookup-status";
import { MatchWarnings } from "./shared/MatchWarnings";

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
  /** Current row-level lookup state from the OCR preview wrapper. */
  lookupTracker?: OcrRecordLookupTracker;
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

/** One-line tally beside the report caption: `N on paper · N looked up · N gaps`. */
function summarizeChecks(checks: VerifyCheck[]): string {
  const onPaper = checks.filter((c) => c.status === "present").length;
  const looked = checks.filter((c) => c.status === "found").length;
  const gaps = checks.filter((c) => c.status === "missing").length;
  return `${onPaper} on paper · ${looked} looked up · ${gaps} ${gaps === 1 ? "gap" : "gaps"}`;
}

function CheckRow({
  check,
  onRelookup,
  relookupPending,
  lookupTracker,
}: {
  check: VerifyCheck;
  onRelookup?: (lookup: VerifyLookupKind) => void;
  relookupPending?: ReadonlySet<VerifyLookupKind>;
  lookupTracker?: OcrRecordLookupTracker;
}) {
  // Record exists but the operator's account can't view it — render "Unable to
  // access" (warning tone) instead of a hard "— not found".
  const unavailable = check.status === "missing" && check.unavailable === true;

  // Option A: only FAILED (missing) lookup-backed checks get a retry button.
  const lookupKind = check.status === "missing" ? verifyCheckLookupKind(check.key) : null;
  const canRelookup = lookupKind !== null && onRelookup !== undefined;
  const pending = lookupKind !== null && (relookupPending?.has(lookupKind) ?? false);
  const lookupInProgress =
    check.status === "missing" &&
    !pending &&
    deriveLookupInProgress(lookupTracker, check.key);
  const lookupProgressLabel = deriveLookupProgressLabel(lookupTracker, check.key);
  const missingText = pending
    ? "Looking up…"
    : lookupInProgress
      ? `${lookupProgressLabel}…`
      : (check.missingLabel ?? "— not found");

  // FOUND — the actionable rows the operator transcribes onto the paper form.
  // Lift them into a small raised card (bg-card + ring + shadow) so the
  // "copy these" data physically pops off the recessed report body.
  if (check.status === "found") {
    return (
      <div className="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2.5 shadow-sm ring-1 ring-border/60">
        <Search className="h-3.5 w-3.5 shrink-0 text-info" aria-label="Looked up" />
        <div className="min-w-0 flex-1">
          <span className="block font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {check.label}
          </span>
          <span className="mt-0.5 block truncate text-sm font-semibold text-foreground">
            {check.foundValue ?? "—"}
          </span>
        </div>
        <SourceBadge source={check.source} />
      </div>
    );
  }

  // UNAVAILABLE — the record exists but the operator's account can't view it.
  // Give it a bordered card like the looked-up rows (so it reads as a real,
  // blocked value rather than a quiet gap), but warning-toned to distinguish
  // "couldn't access" from a confident lookup.
  if (unavailable) {
    return (
      <div className="flex items-center gap-3 rounded-md border border-warning/35 bg-warning/[0.07] px-3 py-2.5 ring-1 ring-warning/20">
        <Lock className="h-3.5 w-3.5 shrink-0 text-warning" aria-label="Unable to access" />
        <div className="min-w-0 flex-1">
          <span className="block font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {check.label}
          </span>
          <span
            className="mt-0.5 block truncate text-sm font-medium text-warning"
            aria-live={pending || lookupInProgress ? "polite" : undefined}
          >
            {pending ? "Looking up…" : lookupInProgress ? `${lookupProgressLabel}…` : "Unable to access"}
          </span>
        </div>
        {canRelookup && (
          <RelookupButton label={check.label} pending={pending} onClick={() => onRelookup(lookupKind)} />
        )}
      </div>
    );
  }

  // PRESENT / MISSING — stay flat and quiet on the recessed body.
  const presentValue = check.status === "present" ? check.paperValue : null;
  return (
    <div className="flex items-start gap-3 px-3 py-1.5">
      {/* Status icon */}
      <div className="mt-px shrink-0">
        {check.status === "present" && (
          <Check className="h-3.5 w-3.5 text-success" aria-label="Present on paper" />
        )}
        {check.status === "missing" && (pending || lookupInProgress) ? (
          <Search className="h-3.5 w-3.5 text-info" aria-label="Lookup in progress" />
        ) : check.status === "missing" ? (
          <X className="h-3.5 w-3.5 text-destructive" aria-label="Not found" />
        ) : null}
      </div>

      {/* Label + value */}
      <div className="min-w-0 flex-1">
        <span className="block font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {check.label}
        </span>
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5">
          {check.status === "present" && presentValue ? (
            <>
              <span className="truncate text-sm text-foreground/75">{presentValue}</span>
              <span className="shrink-0 text-xs text-muted-foreground">(on paper)</span>
            </>
          ) : (
            <span
              className={cn(
                "text-sm",
                pending || lookupInProgress ? "text-info" : "text-muted-foreground",
              )}
              aria-live={pending || lookupInProgress ? "polite" : undefined}
            >
              {missingText}
            </span>
          )}
          {canRelookup && (
            <RelookupButton
              label={check.label}
              pending={pending}
              onClick={() => onRelookup(lookupKind)}
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
 *
 * Report "Option B" (Elevated actionable cards): the body is a recessed card
 * (`bg-secondary/30`); the looked-up (`found`) rows the operator transcribes
 * lift into small raised cards so the actionable data pops, while on-paper
 * confirmations and gaps stay flat and quiet.
 */
export function VerifyRecordView({ record, onRelookup, relookupPending, lookupTracker }: VerifyRecordViewProps) {
  const checks = record.checks ?? [];

  // The record's document-type chip + name + EID are rendered by the card's
  // shared nav header (`PrepReviewRecordNav`) — the name in the title, the
  // document-type chip in place of the old ordinal, the EID in the "Employee
  // ID" completeness check below. So this body renders only the confidence
  // badge + warning line + the completeness report (no duplicated header).
  // `matchConfidence` is only populated for a standalone oath/EC record
  // projected read-only via `readonly-record.ts` (a native `verify` run has
  // no LLM-disambiguation confidence of its own) — so a post-hoc audit of an
  // approved record can still see the confidence it was matched at.
  return (
    <div className="flex flex-col gap-3">
      <MatchWarnings
        matchState={record.matchState}
        warnings={record.warnings}
        matchConfidence={record.matchConfidence}
      />

      {/* Completeness checklist — recessed body, raised found rows. */}
      {checks.length === 0 ? (
        <p className="text-xs text-muted-foreground/60">No completeness checks available.</p>
      ) : (
        <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-secondary/30 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="font-mono text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Completeness Report
            </p>
            <p className="font-mono text-[10.5px] tabular-nums text-muted-foreground/80">
              {summarizeChecks(checks)}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            {checks.map((check) => (
              <CheckRow
                key={check.key}
                check={check}
                onRelookup={onRelookup}
                relookupPending={relookupPending}
                lookupTracker={lookupTracker}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
