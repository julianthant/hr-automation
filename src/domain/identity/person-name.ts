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
