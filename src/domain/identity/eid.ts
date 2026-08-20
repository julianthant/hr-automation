export function normalizeEid(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\D+/g, "");
}

export function isUcpathEmployeeId(value: string | number | null | undefined): boolean {
  return /^10\d{6}$/.test(normalizeEid(value));
}

export function normalizeUcpathEmployeeId(value: string | number | null | undefined): string {
  const eid = normalizeEid(value);
  return isUcpathEmployeeId(eid) ? eid : "";
}

export function displayEid(value: string | number | null | undefined): string {
  const eid = normalizeEid(value);
  return eid ? `EID ${eid}` : "";
}

/**
 * Parse an operator-supplied list of UCPath EIDs — the `data.notMatchEids`
 * channel ("these Person IDs were reviewed and are NOT this hire"). Accepts
 * comma / semicolon / whitespace separators, trims, de-duplicates, and keeps
 * ONLY well-formed EIDs (`isUcpathEmployeeId`); anything else is dropped so a
 * typo can never widen an override. Non-string input → [].
 */
export function parseEidList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const out: string[] = [];
  for (const part of value.split(/[\s,;]+/)) {
    // Strict on purpose: the raw token must BE an EID (no stray characters
    // stripped away), otherwise "10743545x" would silently become 10743545.
    if (/^10\d{6}$/.test(part) && !out.includes(part)) out.push(part);
  }
  return out;
}
