import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Pencil,
  Search,
  X as XIcon,
  XCircle,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { PreviewRecord } from "./preview-types";
import { PreviewRecordEditForm } from "./PreviewRecordEditForm";

/**
 * A single OCR'd record inside the PreviewRow's review list. Renders a
 * one-line summary by default; clicking Edit expands an inline form.
 *
 * Visual states (per `matchState`):
 *   matched (form / roster)  → green badge, fully approvable
 *   resolved                 → blue badge, fully approvable
 *   lookup-running           → dim, spinner badge
 *   lookup-pending           → dim, neutral badge
 *   unresolved               → red badge, dim, edit-required-to-approve
 */
export interface PreviewRecordRowProps {
  record: PreviewRecord;
  onChange: (next: PreviewRecord) => void;
}

export function PreviewRecordRow({ record, onChange }: PreviewRecordRowProps) {
  const [editing, setEditing] = useState(false);

  const isApprovable =
    record.matchState === "matched" || record.matchState === "resolved";
  const isDim =
    record.matchState === "lookup-pending" ||
    record.matchState === "lookup-running" ||
    record.matchState === "unresolved";
  const checkboxDisabled = !isApprovable;

  return (
    <div
      className={cn(
        "relative flex items-start gap-3 px-3 py-2.5 transition-colors",
        record.selected && "bg-primary/5",
        record.selected && "before:content-[''] before:absolute before:left-0 before:top-0 before:bottom-0 before:w-0.5 before:bg-primary",
        !editing && "hover:bg-muted/30",
      )}
    >
      {/* Checkbox */}
      <Checkbox
        checked={record.selected && isApprovable}
        disabled={checkboxDisabled}
        onCheckedChange={(checked) =>
          onChange({ ...record, selected: checked === true })
        }
        aria-label={`Select ${record.employee.name}`}
        className="mt-0.5"
      />

      <div className="flex-1 min-w-0 space-y-1">
        {/* Top row: name + EID + badges + edit */}
        <div className="flex items-start justify-between gap-2">
          <div className={cn("flex-1 min-w-0", isDim && "opacity-60")}>
            <div className="flex items-baseline gap-2 truncate">
              <span className="text-sm font-semibold text-foreground truncate">
                {record.employee.name || "(no name)"}
              </span>
              <span className="text-xs font-mono text-muted-foreground">
                {record.employee.employeeId || (
                  <span className="text-muted-foreground/60">—</span>
                )}
              </span>
            </div>
            <div className="text-xs text-muted-foreground font-mono truncate">
              {summaryLine(record)}
            </div>
            {record.warnings.length > 0 && (
              <div className="text-xs text-warning font-mono flex items-center gap-1 mt-0.5">
                <AlertTriangle aria-hidden className="h-3 w-3 shrink-0" />
                <span className="truncate" title={record.warnings.join(" · ")}>
                  {record.warnings[0]}
                  {record.warnings.length > 1 && ` (+${record.warnings.length - 1} more)`}
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <MatchBadge record={record} />
            {record.addressMatch && record.matchSource === "roster" && (
              <AddressChip kind={record.addressMatch} />
            )}
            <button
              type="button"
              onClick={() => setEditing((s) => !s)}
              aria-label={editing ? "Close edit form" : "Edit record"}
              title={editing ? "Close" : "Edit record"}
              className={cn(
                "h-7 w-7 inline-flex items-center justify-center rounded-md",
                "text-muted-foreground hover:bg-muted hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "cursor-pointer",
              )}
            >
              {editing ? (
                <XIcon aria-hidden className="h-3.5 w-3.5" />
              ) : (
                <Pencil aria-hidden className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>

        {/* Inline edit form */}
        {editing && (
          <PreviewRecordEditForm
            record={record}
            onSave={(updated) => {
              onChange(updated);
              setEditing(false);
            }}
            onCancel={() => setEditing(false)}
          />
        )}
      </div>
    </div>
  );
}

function summaryLine(r: PreviewRecord): string {
  const parts: string[] = [];
  parts.push(r.emergencyContact.name || "(no contact)");
  if (r.emergencyContact.relationship) parts.push(`(${r.emergencyContact.relationship})`);
  const phone =
    r.emergencyContact.cellPhone ?? r.emergencyContact.homePhone ?? r.emergencyContact.workPhone;
  if (phone) parts.push(phone);
  return parts.join(" · ");
}

function MatchBadge({ record }: { record: PreviewRecord }) {
  const cls =
    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase whitespace-nowrap";
  const score = record.matchConfidence;

  switch (record.matchState) {
    case "matched": {
      if (record.matchSource === "roster" && score !== undefined && score < 0.9) {
        return (
          <span className={cn(cls, "bg-warning/15 text-warning")}>
            <CheckCircle2 aria-hidden className="h-2.5 w-2.5" />
            Fuzzy · {score.toFixed(2)}
          </span>
        );
      }
      return (
        <span className={cn(cls, "bg-success/15 text-success")}>
          <CheckCircle2 aria-hidden className="h-2.5 w-2.5" />
          {record.matchSource === "roster" ? "Matched · roster" : "Matched"}
        </span>
      );
    }
    case "resolved":
      return (
        <span className={cn(cls, "bg-primary/15 text-primary")}>
          <Search aria-hidden className="h-2.5 w-2.5" />
          Looked up
        </span>
      );
    case "lookup-running":
      return (
        <span className={cn(cls, "bg-muted text-muted-foreground")}>
          <Loader2 aria-hidden className="h-2.5 w-2.5 animate-spin motion-reduce:animate-none" />
          Searching…
        </span>
      );
    case "lookup-pending":
      return (
        <span className={cn(cls, "bg-muted text-muted-foreground")}>
          Pending lookup
        </span>
      );
    case "unresolved":
      return (
        <span className={cn(cls, "bg-destructive/15 text-destructive")}>
          <XCircle aria-hidden className="h-2.5 w-2.5" />
          Unresolved
        </span>
      );
    default:
      return (
        <span className={cn(cls, "bg-muted text-muted-foreground")}>
          {record.matchState}
        </span>
      );
  }
}

function AddressChip({ kind }: { kind: "match" | "differ" | "missing" }) {
  const cls =
    "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide whitespace-nowrap font-mono lowercase";
  switch (kind) {
    case "match":
      return <span className={cn(cls, "bg-muted text-muted-foreground")}>address: matches</span>;
    case "differ":
      return <span className={cn(cls, "bg-warning/15 text-warning")}>address: differs</span>;
    case "missing":
      return (
        <span className={cn(cls, "bg-muted/50 text-muted-foreground/70 line-through")}>
          address: missing
        </span>
      );
  }
}
