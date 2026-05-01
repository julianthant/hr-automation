import { Pencil, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import type { PreviewRecord } from "./types";
import { RELATIONSHIP_OPTIONS } from "./types";

export interface EcRecordViewProps {
  record: PreviewRecord;
  onChange: (next: PreviewRecord) => void;
  onForceResearch?: (record: PreviewRecord) => void;
  isResearching?: boolean;
}

const FIELD_LABELS = {
  emplId: "Empl ID",
  employeeName: "Lived Employee Name",
  contactName: "Contact Name",
  relationship: "Relationship",
  sameAddress: "Same address as employee",
  street: "Street",
  city: "City",
  state: "State",
  zip: "ZIP",
  cellPhone: "Cell Phone",
  homePhone: "Home Phone",
  workPhone: "Work Phone",
} as const;

function MissingFlag({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <span title="Was blank on paper — please add to physical form" className="inline-flex">
      <Pencil className="h-3 w-3 text-warning" aria-hidden />
    </span>
  );
}

function isMissing(record: PreviewRecord, fieldKey: string): boolean {
  return record.originallyMissing?.includes(fieldKey) ?? false;
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
 * Trimmed EC review form — only the fields the kernel workflow writes
 * back into UCPath plus identity for paper-pile matching. Fields the OCR
 * captures but UCPath doesn't update (PID, Job Title, Mail Code,
 * Supervisor, work/personal email, employee home address) are dropped
 * here even though they remain in the data layer for diagnostics.
 */
export function EcRecordView({ record, onChange, onForceResearch, isResearching }: EcRecordViewProps) {
  const sameAddress = record.emergencyContact.sameAddressAsEmployee;
  const address = record.emergencyContact.address ?? null;

  const setEmployee = (patch: Partial<PreviewRecord["employee"]>): void => {
    onChange({ ...record, employee: { ...record.employee, ...patch } });
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
      <Field
        label={FIELD_LABELS.employeeName}
        missing={isMissing(record, "employee.name")}
      >
        <input
          type="text"
          value={record.employee.name}
          onChange={(e) => setEmployee({ name: e.target.value })}
          className="form-input"
        />
      </Field>
      <Field
        label={FIELD_LABELS.emplId}
        missing={isMissing(record, "employee.employeeId")}
      >
        <input
          type="text"
          value={record.employee.employeeId}
          onChange={(e) => setEmployee({ employeeId: e.target.value })}
          className="form-input font-mono"
        />
      </Field>
      <Field
        label={FIELD_LABELS.contactName}
        missing={isMissing(record, "emergencyContact.name")}
      >
        <input
          type="text"
          value={record.emergencyContact.name}
          onChange={(e) => setContact({ name: e.target.value })}
          className="form-input"
        />
      </Field>
      <Field
        label={FIELD_LABELS.relationship}
        missing={isMissing(record, "emergencyContact.relationship")}
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
      </Field>
      <Field label={FIELD_LABELS.sameAddress}>
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
      </Field>
      {!sameAddress && (
        <div className="grid grid-cols-2 gap-3">
          <Field
            label={FIELD_LABELS.street}
            missing={isMissing(record, "emergencyContact.address.street")}
          >
            <input
              type="text"
              value={address?.street ?? ""}
              onChange={(e) => setAddress({ street: e.target.value })}
              className="form-input"
            />
          </Field>
          <Field label={FIELD_LABELS.city}>
            <input
              type="text"
              value={address?.city ?? ""}
              onChange={(e) => setAddress({ city: e.target.value })}
              className="form-input"
            />
          </Field>
          <Field label={FIELD_LABELS.state}>
            <input
              type="text"
              value={address?.state ?? ""}
              onChange={(e) => setAddress({ state: e.target.value })}
              className="form-input"
            />
          </Field>
          <Field label={FIELD_LABELS.zip}>
            <input
              type="text"
              value={address?.zip ?? ""}
              onChange={(e) => setAddress({ zip: e.target.value })}
              className="form-input font-mono"
            />
          </Field>
        </div>
      )}
      <div className="grid grid-cols-3 gap-3">
        <Field
          label={FIELD_LABELS.cellPhone}
          missing={isMissing(record, "emergencyContact.cellPhone")}
        >
          <input
            type="text"
            value={record.emergencyContact.cellPhone ?? ""}
            onChange={(e) => setContact({ cellPhone: e.target.value })}
            className="form-input font-mono"
          />
        </Field>
        <Field label={FIELD_LABELS.homePhone}>
          <input
            type="text"
            value={record.emergencyContact.homePhone ?? ""}
            onChange={(e) => setContact({ homePhone: e.target.value })}
            className="form-input font-mono"
          />
        </Field>
        <Field label={FIELD_LABELS.workPhone}>
          <input
            type="text"
            value={record.emergencyContact.workPhone ?? ""}
            onChange={(e) => setContact({ workPhone: e.target.value })}
            className="form-input font-mono"
          />
        </Field>
      </div>
    </div>
  );
}
