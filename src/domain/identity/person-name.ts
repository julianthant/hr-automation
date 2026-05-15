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

function titleCaseTokens(s: string): string {
  return s.split(/\s+/).filter(Boolean).map(titleCasePersonToken).join(" ");
}

/** Drops a single trailing "." (common after middle initials in OCR/CRM text). */
function stripTrailingDisplayPeriod(s: string): string {
  return s.replace(/\.\s*$/, "").trim();
}

export function displayPersonName(raw: string | null | undefined): string {
  if (!raw) return "";
  const trimmed = raw.trim().replace(/\s+/g, " ");
  const commaIdx = trimmed.indexOf(",");
  if (commaIdx === -1) {
    return stripTrailingDisplayPeriod(titleCaseTokens(trimmed));
  }
  const lastRaw = trimmed.slice(0, commaIdx).trim();
  const restRaw = trimmed.slice(commaIdx + 1).trim();
  if (!lastRaw || !restRaw) return stripTrailingDisplayPeriod(trimmed);
  return stripTrailingDisplayPeriod(`${titleCaseTokens(lastRaw)}, ${titleCaseTokens(restRaw)}`);
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

/**
 * Best-effort formatter for OCR/search text headed into PeopleSoft's Person
 * Org Summary, which expects "Last, First Middle". OCR often returns either
 * extra-comma variants ("Last, First, M") or natural full names
 * ("First M Last Last"). This keeps already-valid comma input stable and
 * applies a conservative full-name heuristic for delegated lookup.
 */
export function toLastFirstSearchName(raw: string | null | undefined): string {
  const display = displayPersonName(raw);
  if (!display) return "";
  if (display.includes(",")) {
    const [last, ...rest] = display.split(",").map((part) => part.trim()).filter(Boolean);
    if (!last || rest.length === 0) return display;
    return displayPersonName(`${last}, ${rest.join(" ")}`);
  }

  const parts = display.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return display;
  if (parts.length === 2) return displayPersonName(`${parts[1]}, ${parts[0]}`);

  const first = parts[0];
  const second = parts[1];
  const secondLooksLikeMiddleInitial = /^[A-Z]\.?$/i.test(second);
  if (secondLooksLikeMiddleInitial) {
    return displayPersonName(`${parts.slice(2).join(" ")}, ${first} ${second}`);
  }

  if (parts.length >= 4) {
    return displayPersonName(`${parts.slice(-2).join(" ")}, ${parts.slice(0, -2).join(" ")}`);
  }

  return displayPersonName(`${parts.slice(-1).join(" ")}, ${parts.slice(0, -1).join(" ")}`);
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
