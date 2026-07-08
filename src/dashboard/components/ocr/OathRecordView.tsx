import type { OathPreviewRecord } from "./types";
import { RecordField, recordFieldMissing } from "./shared/RecordField";
import { MatchWarnings } from "./shared/MatchWarnings";
import {
  mergeOcrPersonNameParts,
  readOcrPersonNameParts,
} from "../../../domain/identity/ocr-person-name.js";

export interface OathRecordViewProps {
  record: OathPreviewRecord;
  onChange: (next: OathPreviewRecord) => void;
  onForceResearch?: (record: OathPreviewRecord) => void;
  isResearching?: boolean;
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
  const nameParts = readOcrPersonNameParts({
    firstName: record.firstName,
    lastName: record.lastName,
    fullName: record.printedName,
  });

  const setNameParts = (patch: { firstName?: string; lastName?: string }): void => {
    const merged = mergeOcrPersonNameParts(
      {
        firstName: record.firstName,
        lastName: record.lastName,
        fullName: record.printedName,
      },
      patch,
    );
    onChange({
      ...record,
      firstName: merged.firstName,
      lastName: merged.lastName,
      printedName: merged.name,
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <MatchWarnings
        matchState={record.matchState}
        warnings={record.warnings}
        matchConfidence={record.matchConfidence}
      />
      <RecordField label="Empl ID" missing={recordFieldMissing(record, "employeeId")}>
        <input
          type="text"
          value={record.employeeId}
          onChange={(e) => onChange({ ...record, employeeId: e.target.value })}
          className="form-input font-mono"
        />
      </RecordField>
      <div className="grid grid-cols-2 gap-3">
        <RecordField label="First Name" missing={recordFieldMissing(record, "printedName")}>
          <input
            type="text"
            value={nameParts.firstName}
            onChange={(e) => setNameParts({ firstName: e.target.value })}
            className="form-input"
          />
        </RecordField>
        <RecordField label="Last Name" missing={recordFieldMissing(record, "printedName")}>
          <input
            type="text"
            value={nameParts.lastName}
            onChange={(e) => setNameParts({ lastName: e.target.value })}
            className="form-input"
          />
        </RecordField>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <RecordField label="Date Signed" missing={recordFieldMissing(record, "dateSigned")}>
          <input
            type="text"
            value={formatOathDateForDisplay(record.dateSigned)}
            onChange={(e) =>
              onChange({ ...record, dateSigned: e.target.value || null })
            }
            placeholder="MM/DD/YYYY"
            className="form-input font-mono"
          />
        </RecordField>
        <RecordField label="Employee Signed?">
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
        </RecordField>
      </div>
      {officerApplicable && (
        <RecordField label="Officer Signed?">
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
        </RecordField>
      )}
    </div>
  );
}

function formatOathDateForDisplay(raw: string | null): string {
  if (!raw) return "";
  const trimmed = raw.trim();
  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(trimmed);
  if (!match) return raw;
  const month = Number.parseInt(match[1], 10);
  const day = Number.parseInt(match[2], 10);
  const yearRaw = Number.parseInt(match[3], 10);
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return raw;
  const year = match[3].length === 2 ? 2000 + yearRaw : yearRaw;
  return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`;
}
