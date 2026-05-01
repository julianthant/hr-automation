import { Pencil } from "lucide-react";
import type { ReactNode } from "react";
import type { OathPreviewRecord } from "./types";

export interface OathRecordViewProps {
  record: OathPreviewRecord;
  onChange: (next: OathPreviewRecord) => void;
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
export function OathRecordView({ record, onChange }: OathRecordViewProps) {
  const officerApplicable =
    record.officerSigned !== null && record.officerSigned !== undefined;

  return (
    <div className="flex flex-col gap-3">
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
