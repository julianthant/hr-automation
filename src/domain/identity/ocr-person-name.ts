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
      lastName: parts[parts.length - 1],
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
  // Partial edits: prefer the part the operator typed over a stale fullName
  // (OCR often parks an EID in `name` — falling back would resurrect it).
  if (firstName) return displayPersonName(firstName) || firstName;
  if (lastName) return displayPersonName(lastName) || lastName;
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

/**
 * Merge an edited first/last patch into a record's current name fields.
 * Materializes BOTH displayed parts (a legacy fullName-only record gets its
 * split-derived counterpart written out, so editing one part never loses the
 * other) and resolves the display name from the merged parts.
 */
export function mergeOcrPersonNameParts(
  current: {
    firstName?: string | null;
    lastName?: string | null;
    fullName?: string | null;
  },
  patch: { firstName?: string; lastName?: string },
): { firstName: string; lastName: string; name: string } {
  const parts = readOcrPersonNameParts(current);
  const firstName = patch.firstName ?? parts.firstName;
  const lastName = patch.lastName ?? parts.lastName;
  return {
    firstName,
    lastName,
    // Operator edits own the composed name — do NOT pass `current.fullName`.
    // Clearing First Name when OCR put the EID in `name` used to snap the EID
    // right back into the input (felt uneditable).
    name: resolveOcrPersonDisplayName({ firstName, lastName }),
  };
}

/** True when a "name" is really an employee id (digits only, ≥5). */
function looksLikeEmployeeId(value: string): boolean {
  return /^\d{5,}$/.test(value.trim());
}

/**
 * Stamp first/last (+ legacy full name) from a person-lookup outcome onto an
 * OCR record. `printedName` is the PAPER side of the verify name check, so a
 * present value is never overwritten — only a blank/missing one is filled.
 * Returns the raw name source used (`resolvedName`, else a non-EID
 * `searchName`) so callers can reuse it (e.g. to stamp the found-side `name`)
 * instead of recomputing.
 */
export function applyPersonLookupNameToOcrRecord(
  rec: Record<string, unknown>,
  data: Record<string, string> | undefined,
): string | undefined {
  // Prefer a real resolved name. Falling back to searchName is fine for a
  // name-keyed lookup, but an EID-keyed verify passes the EID as searchName —
  // stamping that into first/last/name is what put "10778080" in First Name.
  const resolvedName = nonEmpty(data?.resolvedName);
  const searchName = nonEmpty(data?.searchName);
  const nameSource =
    resolvedName ??
    (searchName && !looksLikeEmployeeId(searchName) ? searchName : undefined);
  if (!nameSource) return undefined;

  const { firstName, lastName, display } = splitOcrPersonName(nameSource);
  if (!display) return nameSource;

  if ("employee" in rec && rec.employee && typeof rec.employee === "object") {
    const employee = rec.employee as Record<string, unknown>;
    employee.firstName = firstName;
    employee.lastName = lastName;
    employee.name = display;
    return nameSource;
  }

  if ("printedName" in rec || !("employee" in rec)) {
    rec.firstName = firstName;
    rec.lastName = lastName;
    if (typeof rec.printedName !== "string" || !rec.printedName.trim()) {
      rec.printedName = display;
    }
  }
  return nameSource;
}
