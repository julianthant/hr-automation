export interface ParsedLastFirstName {
  lastName: string;
  firstName: string;
  middleName: string | null;
  display: string;
}

export function titleCasePersonToken(token: string): string {
  return token
    .split(/([-' ])/)
    .map((part) => {
      if (part === "-" || part === "'" || part === " ") return part;
      if (part.length === 0) return part;
      return part[0].toUpperCase() + part.slice(1).toLowerCase();
    })
    .join("");
}

export function displayPersonName(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim().replace(/\s+/g, " ");
  const commaIdx = trimmed.indexOf(",");
  if (commaIdx === -1) {
    return trimmed
      .split(" ")
      .filter(Boolean)
      .map(titleCasePersonToken)
      .join(" ");
  }
  const lastRaw = trimmed.slice(0, commaIdx).trim();
  const restRaw = trimmed.slice(commaIdx + 1).trim();
  if (!lastRaw || !restRaw) return trimmed;
  const last = lastRaw.split(/\s+/).map(titleCasePersonToken).join(" ");
  const rest = restRaw.split(/\s+/).filter(Boolean).map(titleCasePersonToken).join(" ");
  return `${last}, ${rest}`;
}

/**
 * Format a "First [Middle] Last" full name into "Last, First [Middle]" using
 * a known last name as the split anchor. Idempotent on already-comma-formatted
 * input. Falls back to the trimmed full name when the last name doesn't match
 * the trailing tokens.
 */
export function toLastFirstName(
  fullName: string | null | undefined,
  lastName: string | null | undefined,
): string {
  if (!fullName) return "";
  const fn = fullName.trim().replace(/\s+/g, " ");
  if (!fn) return "";
  if (fn.includes(",")) return displayPersonName(fn);
  const ln = (lastName ?? "").trim().replace(/\s+/g, " ");
  if (!ln) return displayPersonName(fn);
  const escaped = ln.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const trailing = new RegExp(`\\s+${escaped}$`, "i");
  if (!trailing.test(fn)) return displayPersonName(fn);
  const rest = fn.replace(trailing, "").trim();
  if (!rest) return displayPersonName(fn);
  return displayPersonName(`${ln}, ${rest}`);
}

export function parseLastFirstName(raw: string | null | undefined): ParsedLastFirstName | null {
  const display = displayPersonName(raw);
  const commaIdx = display.indexOf(",");
  if (commaIdx === -1) return null;
  const lastName = display.slice(0, commaIdx).trim();
  const rest = display.slice(commaIdx + 1).trim();
  if (!lastName || !rest) return null;
  const parts = rest.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return {
    lastName,
    firstName: parts[0],
    middleName: parts.length > 1 ? parts.slice(1).join(" ") : null,
    display,
  };
}

export function canonicalPersonNameKey(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizePersonNameForCompare(
  raw: string | null | undefined,
  opts: { lettersOnly?: boolean } = {},
): string {
  if (!raw) return "";
  const lower = raw.toLowerCase();
  const cleaned = opts.lettersOnly ? lower.replace(/[^a-z\s]/g, "") : lower;
  return cleaned.replace(/\s+/g, " ").trim();
}
