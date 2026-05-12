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
