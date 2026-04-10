/**
 * Extract a human-readable message from an unknown caught value.
 * Replaces the repeated `err instanceof Error ? err.message : String(err)` pattern.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Common Playwright/workflow error patterns → concise dashboard-friendly messages. */
const ERROR_PATTERNS: [RegExp, string][] = [
  [/Target page, context or browser has been closed/i, "Browser closed unexpectedly"],
  [/browser has been disconnected/i, "Browser disconnected"],
  [/Page crashed/i, "Page crashed"],
  [/page\.goto.*Timeout (\d+)ms/i, "Page navigation timed out"],
  [/waiting for locator\('([^']+)'\).*Timeout/i, "Element not found: $1"],
  [/locator\.(click|fill|check|select).*Timeout (\d+)ms/i, "Timed out waiting for element"],
  [/waitForSelector.*Timeout/i, "Element did not appear in time"],
  [/waitForLoadState.*Timeout/i, "Page did not finish loading"],
  [/net::ERR_CONNECTION_REFUSED/i, "Connection refused — server unreachable"],
  [/net::ERR_NAME_NOT_RESOLVED/i, "DNS error — hostname not found"],
  [/net::ERR_INTERNET_DISCONNECTED/i, "No internet connection"],
  [/net::ERR_/i, "Network error"],
  [/frame was detached/i, "Page navigated away unexpectedly"],
  [/Execution context was destroyed/i, "Page reloaded during operation"],
  [/Protocol error.*Target closed/i, "Browser closed during operation"],
];

/**
 * Map a raw error to a concise, human-readable message for the dashboard.
 * Returns the cleaned message, or the original (truncated) if no pattern matches.
 */
export function classifyError(err: unknown): string {
  const raw = errorMessage(err);
  for (const [pattern, replacement] of ERROR_PATTERNS) {
    const match = raw.match(pattern);
    if (match) {
      // Support $1, $2 backreferences in replacement
      return replacement.replace(/\$(\d)/g, (_, i) => match[parseInt(i)] || "");
    }
  }
  // No pattern matched — return first line, truncated
  const firstLine = raw.split("\n")[0];
  return firstLine.length > 120 ? firstLine.slice(0, 117) + "..." : firstLine;
}
