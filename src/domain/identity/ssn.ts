/** Mask SSN for dashboard / log display: "***-**-1234". */
export function maskSsn(ssn: string | undefined | null): string {
  if (!ssn) return "";
  const digits = ssn.replace(/-/g, "");
  if (digits.length < 4) return "***";
  return `***-**-${digits.slice(-4)}`;
}
