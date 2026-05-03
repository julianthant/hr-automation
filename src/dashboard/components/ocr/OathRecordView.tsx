import { Pencil, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import type { OathPreviewRecord } from "./types";

export interface OathRecordViewProps {
  record: OathPreviewRecord;
  onChange: (next: OathPreviewRecord) => void;
  onForceResearch?: (record: OathPreviewRecord) => void;
  isResearching?: boolean;
}

function isMissing(record: OathPreviewRecord, fieldKey: string): boolean {
  return record.originallyMissing?.includes(fieldKey) ?? false;
}

function MissingFlag({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <span title="Was blank on paper — please add to physical form" className="inline-flex">
      <Pencil className="h-3 w-3 text-warning" aria-hidden />
    </span>
  );
}

function Field({
  label,
  missing,
  children,
}: {
  label: string;
  missing?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="inline-flex items-center gap-1.5 font-mono text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
        <MissingFlag visible={missing ?? false} />
      </span>
      {children}
    </label>
  );
}

/**
 * Oath review form — Empl ID, Printed Name, Date Signed, Employee
 * Signed?, Officer Signed? (only when applicable). Sign-in sheet rows
 * have `officerSigned: null` — we hide the field rather than show
 * Yes/No/N/A so the form scans cleanly for the 90% case.
 */
export function OathRecordView({ record, onChange, onForceResearch, isResearching }: OathRecordViewProps) {
  const officerApplicable =
    record.officerSigned !== null && record.officerSigned !== undefined;

  return (
    <div className="flex flex-col gap-3">
      {onForceResearch && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => onForceResearch(record)}
            disabled={isResearching}
            title="Re-run eid-lookup for this record"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            <RotateCw className="h-3 w-3" aria-hidden />
          </button>
        </div>
      )}
      <MatchSourceBadge record={record} />
      <WhyThisMatch record={record} />
      <Field label="Empl ID" missing={isMissing(record, "employeeId")}>
        <input
          type="text"
          value={record.employeeId}
          onChange={(e) => onChange({ ...record, employeeId: e.target.value })}
          className="form-input font-mono"
        />
      </Field>
      <Field label="Printed Name" missing={isMissing(record, "printedName")}>
        <input
          type="text"
          value={record.printedName}
          onChange={(e) => onChange({ ...record, printedName: e.target.value })}
          className="form-input"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date Signed" missing={isMissing(record, "dateSigned")}>
          <input
            type="text"
            value={record.dateSigned ?? ""}
            onChange={(e) =>
              onChange({ ...record, dateSigned: e.target.value || null })
            }
            placeholder="MM/DD/YYYY"
            className="form-input font-mono"
          />
        </Field>
        <Field label="Employee Signed?">
          <select
            value={record.employeeSigned ? "yes" : "no"}
            onChange={(e) =>
              onChange({ ...record, employeeSigned: e.target.value === "yes" })
            }
            className="form-input"
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </Field>
      </div>
      {officerApplicable && (
        <Field label="Officer Signed?">
          <select
            value={record.officerSigned ? "yes" : "no"}
            onChange={(e) =>
              onChange({ ...record, officerSigned: e.target.value === "yes" })
            }
            className="form-input"
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </Field>
      )}
    </div>
  );
}

function MatchSourceBadge({ record }: { record: OathPreviewRecord }) {
  const source = record.matchSource ?? "unknown";
  const palette: Record<string, string> = {
    roster: "border-success/40 bg-success/10 text-success",
    "form-eid": "border-success/40 bg-success/10 text-success",
    llm: "border-warning/40 bg-warning/10 text-warning",
    "eid-lookup": "border-primary/40 bg-primary/10 text-primary",
    manual: "border-border bg-muted text-muted-foreground",
    unknown: "border-border bg-muted text-muted-foreground",
  };
  const label: Record<string, string> = {
    roster: "Match: roster",
    "form-eid": "Match: EID on form",
    llm: "Match: LLM",
    "eid-lookup": "Match: eid-lookup",
    manual: "Match: manual",
    unknown: "Match: pending",
  };
  return (
    <span
      className={`w-fit rounded-md border px-1.5 py-px font-mono text-[10px] uppercase ${palette[source] ?? palette.unknown}`}
    >
      {label[source] ?? label.unknown}
    </span>
  );
}

function WhyThisMatch({ record }: { record: OathPreviewRecord }) {
  const source = record.matchSource;
  const candidates = record.rosterCandidates ?? [];
  if (!source || (source === "manual" && candidates.length === 0)) return null;
  if (source === "roster" && candidates.length === 0) return null;

  return (
    <details className="rounded-md border border-border bg-secondary/20 px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium text-muted-foreground">Why this match?</summary>
      <div className="mt-2 flex flex-col gap-1 text-muted-foreground">
        {source === "roster" && record.matchConfidence !== undefined && (
          <div>Algorithmic top score: <span className="font-mono">{record.matchConfidence.toFixed(2)}</span></div>
        )}
        {source === "form-eid" && (
          <div>EID extracted directly from the form: <span className="font-mono">{record.employeeId}</span></div>
        )}
        {source === "llm" && (
          <>
            <div>LLM disambiguator picked: <span className="font-mono">{record.employeeId || "(none)"}</span> (confidence {record.matchConfidence?.toFixed(2) ?? "?"})</div>
            {candidates.length > 0 && (
              <ul className="ml-4 list-disc">
                {candidates.slice(0, 5).map((c) => (
                  <li key={c.eid} className={c.eid === record.employeeId ? "font-semibold text-foreground" : ""}>
                    <span className="font-mono">{c.eid}</span> — {c.name} (algorithmic {c.score.toFixed(2)})
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {source === "manual" && (
          <div>No automatic match — type the EID below from the source page.</div>
        )}
        {(record.warnings ?? []).length > 0 && (
          <ul className="mt-1 ml-4 list-disc">
            {record.warnings!.slice(0, 3).map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}
      </div>
    </details>
  );
}
