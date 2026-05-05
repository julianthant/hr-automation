export function normalizeEid(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/\D+/g, "");
}

export function displayEid(value: string | number | null | undefined): string {
  const eid = normalizeEid(value);
  return eid ? `EID ${eid}` : "";
}
