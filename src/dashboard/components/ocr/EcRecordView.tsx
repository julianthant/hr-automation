import type { PreviewRecord } from "./types";
import { RELATIONSHIP_OPTIONS } from "./types";
import { RecordField, recordFieldMissing } from "./shared/RecordField";
import { MatchWarnings } from "./shared/MatchWarnings";
import {
  mergeOcrPersonNameParts,
  readOcrPersonNameParts,
} from "../../../domain/identity/ocr-person-name.js";

export interface EcRecordViewProps {
  record: PreviewRecord;
  onChange: (next: PreviewRecord) => void;
  onForceResearch?: (record: PreviewRecord) => void;
  isResearching?: boolean;
}

const FIELD_LABELS = {
  emplId: "Empl ID",
  employeeFirstName: "First Name",
  employeeLastName: "Last Name",
  contactName: "Contact Name",
  relationship: "Relationship",
  sameAddress: "Same address as employee",
  street: "Street",
  city: "City",
  state: "State",
  zip: "ZIP",
  country: "Country",
  cellPhone: "Cell Phone",
  homePhone: "Home Phone",
  workPhone: "Work Phone",
} as const;


/**
 * Trimmed EC review form — only the fields the kernel workflow writes
 * back into UCPath plus identity for paper-pile matching. Fields the OCR
 * captures but UCPath doesn't update (PID, Job Title, Mail Code,
 * Supervisor, work/personal email, employee home address) are dropped
 * here even though they remain in the data layer for diagnostics.
 */
export function EcRecordView({ record, onChange }: EcRecordViewProps) {
  const sameAddress = record.emergencyContact.sameAddressAsEmployee;
  const address = record.emergencyContact.address ?? null;
  const employeeNameParts = readOcrPersonNameParts({
    firstName: record.employee.firstName,
    lastName: record.employee.lastName,
    fullName: record.employee.name,
  });

  const setEmployee = (patch: Partial<PreviewRecord["employee"]>): void => {
    onChange({ ...record, employee: { ...record.employee, ...patch } });
  };
  const setEmployeeName = (patch: { firstName?: string; lastName?: string }): void => {
    const merged = mergeOcrPersonNameParts(
      {
        firstName: record.employee.firstName,
        lastName: record.employee.lastName,
        fullName: record.employee.name,
      },
      patch,
    );
    setEmployee({
      firstName: merged.firstName,
      lastName: merged.lastName,
      name: merged.name,
    });
  };
  const setContact = (patch: Partial<PreviewRecord["emergencyContact"]>): void => {
    onChange({
      ...record,
      emergencyContact: { ...record.emergencyContact, ...patch },
    });
  };
  const setAddress = (patch: Partial<NonNullable<PreviewRecord["emergencyContact"]["address"]>>): void => {
    setContact({
      address: { ...(address ?? { street: "" }), ...patch },
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <MatchWarnings
        matchState={record.matchState}
        warnings={record.warnings}
        matchConfidence={record.matchConfidence}
      />
      <div className="grid grid-cols-2 gap-3">
        <RecordField
          label={FIELD_LABELS.employeeFirstName}
          missing={recordFieldMissing(record, "employee.name")}
        >
          <input
            type="text"
            value={employeeNameParts.firstName}
            onChange={(e) => setEmployeeName({ firstName: e.target.value })}
            className="form-input"
          />
        </RecordField>
        <RecordField
          label={FIELD_LABELS.employeeLastName}
          missing={recordFieldMissing(record, "employee.name")}
        >
          <input
            type="text"
            value={employeeNameParts.lastName}
            onChange={(e) => setEmployeeName({ lastName: e.target.value })}
            className="form-input"
          />
        </RecordField>
      </div>
      <RecordField
        label={FIELD_LABELS.emplId}
        missing={recordFieldMissing(record, "employee.employeeId")}
      >
        <input
          type="text"
          value={record.employee.employeeId}
          onChange={(e) => setEmployee({ employeeId: e.target.value })}
          className="form-input font-mono"
        />
      </RecordField>
      <RecordField
        label={FIELD_LABELS.contactName}
        missing={recordFieldMissing(record, "emergencyContact.name")}
      >
        <input
          type="text"
          value={record.emergencyContact.name}
          onChange={(e) => setContact({ name: e.target.value })}
          className="form-input"
        />
      </RecordField>
      <RecordField
        label={FIELD_LABELS.relationship}
        missing={recordFieldMissing(record, "emergencyContact.relationship")}
      >
        <select
          value={record.emergencyContact.relationship}
          onChange={(e) => setContact({ relationship: e.target.value })}
          className="form-input"
        >
          {!RELATIONSHIP_OPTIONS.includes(record.emergencyContact.relationship) && (
            <option value={record.emergencyContact.relationship}>
              {record.emergencyContact.relationship || "(blank)"}
            </option>
          )}
          {RELATIONSHIP_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </RecordField>
      <RecordField label={FIELD_LABELS.sameAddress}>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={sameAddress}
            onChange={(e) => setContact({ sameAddressAsEmployee: e.target.checked })}
            className="h-4 w-4"
          />
          <span className="text-xs text-muted-foreground">
            Use the employee's home address
          </span>
        </label>
      </RecordField>
      {!sameAddress && (
        <div className="grid grid-cols-2 gap-3">
          <RecordField
            label={FIELD_LABELS.street}
            missing={recordFieldMissing(record, "emergencyContact.address.street")}
          >
            <input
              type="text"
              value={address?.street ?? ""}
              onChange={(e) => setAddress({ street: e.target.value })}
              className="form-input"
            />
          </RecordField>
          <RecordField label={FIELD_LABELS.city}>
            <input
              type="text"
              value={address?.city ?? ""}
              onChange={(e) => setAddress({ city: e.target.value })}
              className="form-input"
            />
          </RecordField>
          <RecordField label={FIELD_LABELS.state}>
            <input
              type="text"
              value={address?.state ?? ""}
              onChange={(e) => setAddress({ state: e.target.value })}
              className="form-input"
            />
          </RecordField>
          <RecordField label={FIELD_LABELS.zip}>
            <input
              type="text"
              value={address?.zip ?? ""}
              onChange={(e) => setAddress({ zip: e.target.value })}
              className="form-input font-mono"
            />
          </RecordField>
          <RecordField label={FIELD_LABELS.country}>
            <input
              type="text"
              value={address?.country ?? ""}
              onChange={(e) => setAddress({ country: e.target.value })}
              className="form-input font-mono uppercase"
              placeholder="US, CN, GB…"
            />
          </RecordField>
        </div>
      )}
      <div className="grid grid-cols-3 gap-3">
        <RecordField
          label={FIELD_LABELS.cellPhone}
          missing={recordFieldMissing(record, "emergencyContact.cellPhone")}
        >
          <input
            type="text"
            value={record.emergencyContact.cellPhone ?? ""}
            onChange={(e) => setContact({ cellPhone: e.target.value })}
            className="form-input font-mono"
          />
        </RecordField>
        <RecordField label={FIELD_LABELS.homePhone}>
          <input
            type="text"
            value={record.emergencyContact.homePhone ?? ""}
            onChange={(e) => setContact({ homePhone: e.target.value })}
            className="form-input font-mono"
          />
        </RecordField>
        <RecordField label={FIELD_LABELS.workPhone}>
          <input
            type="text"
            value={record.emergencyContact.workPhone ?? ""}
            onChange={(e) => setContact({ workPhone: e.target.value })}
            className="form-input font-mono"
          />
        </RecordField>
      </div>
    </div>
  );
}
