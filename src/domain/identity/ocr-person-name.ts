import {
  displayPersonName,
  parseLastFirstName,
} from "./person-name.js";

export interface OcrNameParts {
  firstName: string;
  lastName: string;
  display: string;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Split a full name into first/last for OCR preview fields. */
export function splitOcrPersonName(fullName: string | null | undefined): OcrNameParts {
  const display = displayPersonName(fullName);
  if (!display) return { firstName: "", lastName: "", display: "" };

  const parsed = parseLastFirstName(display);
  if (parsed) {
    const middle = parsed.middleName ? ` ${parsed.middleName}` : "";
    return {
      firstName: `${parsed.firstName}${middle}`.trim(),
      lastName: parsed.lastName,
      display: parsed.display,
    };
  }

  const parts = display.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return {
      firstName: parts.slice(0, -1).join(" "),
      lastName: parts[parts.length - 1]!,
      display,
    };
  }

  return { firstName: display, lastName: "", display };
}

/** Resolve display name from split fields or a legacy full-name field. */
export function resolveOcrPersonDisplayName(parts: {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
}): string {
  const firstName = nonEmpty(parts.firstName);
  const lastName = nonEmpty(parts.lastName);
  if (firstName && lastName) {
    return displayPersonName(`${lastName}, ${firstName}`);
  }
  return displayPersonName(parts.fullName) || "";
}

/** Read first/last from a record, splitting legacy full-name fields when needed. */
export function readOcrPersonNameParts(parts: {
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
}): OcrNameParts {
  const firstName = nonEmpty(parts.firstName);
  const lastName = nonEmpty(parts.lastName);
  if (firstName || lastName) {
    return {
      firstName: firstName ?? "",
      lastName: lastName ?? "",
      display: resolveOcrPersonDisplayName(parts),
    };
  }
  return splitOcrPersonName(parts.fullName);
}

/** Stamp first/last (+ legacy full name) from a person-lookup outcome onto an OCR record. */
export function applyPersonLookupNameToOcrRecord(
  rec: Record<string, unknown>,
  data: Record<string, string> | undefined,
): void {
  const resolvedName = nonEmpty(data?.resolvedName) ?? nonEmpty(data?.searchName);
  if (!resolvedName) return;

  const { firstName, lastName, display } = splitOcrPersonName(resolvedName);
  if (!display) return;

  if ("employee" in rec && rec.employee && typeof rec.employee === "object") {
    const employee = rec.employee as Record<string, unknown>;
    employee.firstName = firstName;
    employee.lastName = lastName;
    employee.name = display;
    return;
  }

  if ("printedName" in rec || !("employee" in rec)) {
    rec.firstName = firstName;
    rec.lastName = lastName;
    rec.printedName = display;
  }
}
