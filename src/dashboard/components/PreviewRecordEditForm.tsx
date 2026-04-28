import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { RELATIONSHIP_OPTIONS, type PreviewRecord } from "./preview-types";

/**
 * Inline edit form for a single PreviewRecord. Plain controlled state +
 * shape-validates on Save (no react-hook-form to keep bundle small).
 *
 * Persistence: edits are pushed to localStorage on every Save, keyed by
 * `parentRunId + recordIndex`. The parent (`PreviewRow`) reads the saved
 * map at mount and merges into its records before rendering, so reload
 * restores in-progress edits.
 */
export interface PreviewRecordEditFormProps {
  record: PreviewRecord;
  onSave: (updated: PreviewRecord) => void;
  onCancel: () => void;
}

interface FormState {
  employeeId: string;
  employeeName: string;
  contactName: string;
  relationship: string;
  phone: string;
  sameAddress: boolean;
  street: string;
  city: string;
  state: string;
  zip: string;
}

function recordToForm(r: PreviewRecord): FormState {
  return {
    employeeId: r.employee.employeeId ?? "",
    employeeName: r.employee.name ?? "",
    contactName: r.emergencyContact.name ?? "",
    relationship: r.emergencyContact.relationship ?? "",
    phone:
      r.emergencyContact.cellPhone ??
      r.emergencyContact.homePhone ??
      r.emergencyContact.workPhone ??
      "",
    sameAddress: r.emergencyContact.sameAddressAsEmployee,
    street: r.emergencyContact.address?.street ?? "",
    city: r.emergencyContact.address?.city ?? "",
    state: r.emergencyContact.address?.state ?? "",
    zip: r.emergencyContact.address?.zip ?? "",
  };
}

function formToRecord(prev: PreviewRecord, f: FormState): PreviewRecord {
  const sameAddress = f.sameAddress;
  const address = sameAddress
    ? null
    : f.street
      ? { street: f.street, city: f.city || null, state: f.state || null, zip: f.zip || null }
      : null;
  return {
    ...prev,
    employee: {
      ...prev.employee,
      employeeId: f.employeeId.trim(),
      name: f.employeeName.trim(),
    },
    emergencyContact: {
      ...prev.emergencyContact,
      name: f.contactName.trim(),
      relationship: f.relationship.trim(),
      cellPhone: f.phone.trim() || null,
      sameAddressAsEmployee: sameAddress,
      address,
    },
  };
}

function validate(f: FormState): Record<string, string> {
  const errs: Record<string, string> = {};
  if (!/^\d{5,}$/.test(f.employeeId)) {
    errs.employeeId = "Employee ID must be numeric, at least 5 digits.";
  }
  if (!f.contactName.trim()) {
    errs.contactName = "Contact name is required.";
  }
  if (!f.relationship.trim()) {
    errs.relationship = "Relationship is required.";
  }
  if (!f.sameAddress && f.street.trim()) {
    if (f.state && !/^[A-Z]{2}$/.test(f.state)) {
      errs.state = "Use a 2-letter USPS code (e.g. CA).";
    }
    if (f.zip && !/^\d{5}(-\d{4})?$/.test(f.zip)) {
      errs.zip = "Zip must be 5 digits or 5+4.";
    }
  }
  return errs;
}

export function PreviewRecordEditForm({
  record,
  onSave,
  onCancel,
}: PreviewRecordEditFormProps) {
  const [form, setForm] = useState<FormState>(() => recordToForm(record));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);

  // Re-seed when the underlying record changes (defensive — parent should
  // re-mount us on a new record, but in case it doesn't).
  useEffect(() => {
    setForm(recordToForm(record));
    setErrors({});
    setDirty(false);
  }, [record.employee.employeeId, record.sourcePage, record.employee.name]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    if (errors[String(key)]) {
      setErrors((prev) => {
        const next = { ...prev };
        delete next[String(key)];
        return next;
      });
    }
  }

  function handleSave(): void {
    const errs = validate(form);
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    onSave(formToRecord(record, form));
  }

  return (
    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-3 rounded-md border border-border bg-muted/30 p-3 text-sm">
      <Field
        label="Employee EID"
        error={errors.employeeId}
        mono
        suffix={<UCPathHint />}
      >
        <input
          type="text"
          inputMode="numeric"
          value={form.employeeId}
          onChange={(e) => set("employeeId", e.target.value)}
          placeholder="10001234"
          aria-invalid={!!errors.employeeId}
          className={inputCls(!!errors.employeeId, true)}
        />
      </Field>

      <Field label="Employee name">
        <input
          type="text"
          value={form.employeeName}
          onChange={(e) => set("employeeName", e.target.value)}
          className={inputCls(false, false)}
        />
      </Field>

      <Field label="Contact name" error={errors.contactName}>
        <input
          type="text"
          value={form.contactName}
          onChange={(e) => set("contactName", e.target.value)}
          aria-invalid={!!errors.contactName}
          className={inputCls(!!errors.contactName, false)}
        />
      </Field>

      <Field label="Relationship" error={errors.relationship} suffix={<UCPathHint />}>
        <select
          value={form.relationship}
          onChange={(e) => set("relationship", e.target.value)}
          aria-invalid={!!errors.relationship}
          className={cn(
            inputCls(!!errors.relationship, false),
            "appearance-none cursor-pointer pr-7",
          )}
        >
          <option value="" disabled>
            Select relationship
          </option>
          {RELATIONSHIP_OPTIONS.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Phone" mono>
        <input
          type="tel"
          value={form.phone}
          onChange={(e) => set("phone", e.target.value)}
          placeholder="(415) 555-1212"
          className={inputCls(false, true)}
        />
      </Field>

      <Field label="Same address as employee">
        <label className="flex items-center gap-2 h-8 cursor-pointer">
          <input
            type="checkbox"
            checked={form.sameAddress}
            onChange={(e) => set("sameAddress", e.target.checked)}
            className="h-4 w-4 cursor-pointer accent-primary"
          />
          <span className="text-xs text-muted-foreground">
            {form.sameAddress
              ? "Yes — UCPath will use the employee's address"
              : "No — fill the contact's address below"}
          </span>
        </label>
      </Field>

      {!form.sameAddress && (
        <>
          <div className="col-span-2">
            <Field label="Street">
              <input
                type="text"
                value={form.street}
                onChange={(e) => set("street", e.target.value)}
                className={inputCls(false, false)}
              />
            </Field>
          </div>
          <Field label="City">
            <input
              type="text"
              value={form.city}
              onChange={(e) => set("city", e.target.value)}
              className={inputCls(false, false)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-x-3">
            <Field label="State" error={errors.state} mono>
              <input
                type="text"
                value={form.state}
                onChange={(e) => set("state", e.target.value.toUpperCase().slice(0, 2))}
                placeholder="CA"
                aria-invalid={!!errors.state}
                className={inputCls(!!errors.state, true)}
                maxLength={2}
              />
            </Field>
            <Field label="Zip" error={errors.zip} mono>
              <input
                type="text"
                inputMode="numeric"
                value={form.zip}
                onChange={(e) => set("zip", e.target.value)}
                placeholder="90210"
                aria-invalid={!!errors.zip}
                className={inputCls(!!errors.zip, true)}
              />
            </Field>
          </div>
        </>
      )}

      <div className="col-span-2 mt-1 flex items-center justify-between border-t border-border pt-3">
        <span className="text-xs text-muted-foreground font-mono">
          {dirty ? "Saved locally · changes restore on reload" : " "}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className={cn(
              "h-8 px-3 text-sm font-medium rounded-md",
              "text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            )}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            className={cn(
              "h-8 px-3 text-sm font-medium rounded-md cursor-pointer",
              "bg-primary text-primary-foreground border border-primary",
              "hover:bg-primary/90",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
            )}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── helpers ───

function Field({
  label,
  error,
  mono,
  children,
  suffix,
}: {
  label: string;
  error?: string;
  mono?: boolean;
  children: React.ReactNode;
  suffix?: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1", mono && "font-mono")}>
      <span className="text-xs font-medium text-muted-foreground font-sans">{label}</span>
      <div className="relative">
        {children}
        {suffix && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none">
            {suffix}
          </div>
        )}
      </div>
      {error && (
        <span role="alert" className="text-xs text-destructive font-sans">
          {error}
        </span>
      )}
    </div>
  );
}

function inputCls(hasError: boolean, mono: boolean): string {
  return cn(
    "h-8 w-full px-2.5 text-sm rounded-md outline-none transition-colors bg-background",
    "border",
    hasError
      ? "border-destructive focus-visible:ring-2 focus-visible:ring-destructive"
      : "border-border focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30",
    mono && "font-mono",
    "disabled:opacity-50 disabled:cursor-not-allowed",
  );
}

function UCPathHint() {
  return (
    <span
      title="Maps to UCPath"
      aria-label="Maps to UCPath"
      className={cn(
        "inline-flex h-4 w-4 items-center justify-center rounded-full",
        "border border-muted-foreground/40 text-[8px] font-mono font-bold",
        "text-muted-foreground select-none",
      )}
    >
      UC
    </span>
  );
}
