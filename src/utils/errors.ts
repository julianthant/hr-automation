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
  // No pattern matched — return first line in full. Dashboard log-line
  // rendering handles long strings via `break-words`; truncating here
  // clips actionable details (e.g. "Last Day Worked cannot be in the
  // future: got '05/01/2026' ... not yet eligible for separation" gets
  // cut mid-word so operators can't read the full diagnosis).
  return raw.split("\n")[0];
}

export type PlaywrightErrorKind =
  | "timeout"
  | "timeout-disabled"
  | "timeout-hidden"
  | "timeout-intercepted"
  | "timeout-stale"
  | "navigation-interrupted"
  | "process-singleton"
  | "unknown";

export interface ClassifiedError {
  kind: PlaywrightErrorKind;
  summary: string;
  original: string;
}

/**
 * Classify a Playwright/browser automation error into a small kind-enum so
 * downstream logs + dashboards can group failures without string-matching
 * 2000-char error strings everywhere.
 */
export function classifyPlaywrightError(err: unknown): ClassifiedError {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const lower = msg.toLowerCase();

  if (lower.includes("processsingleton")) {
    return { kind: "process-singleton", summary: "Chrome profile lock held by another process", original: msg };
  }
  // nav-interrupted must be checked BEFORE detached — "frame was detached" contains "detached"
  if (lower.includes("err_aborted") || lower.includes("frame was detached") || lower.includes("navigation was aborted")) {
    return { kind: "navigation-interrupted", summary: "Navigation aborted mid-action", original: msg };
  }
  // NOT nested inside the timeout gate below — stale-DOM errors can surface
  // as plain "detached" messages without the word "Timeout" (e.g. during
  // navigation races). The "timeout-" name prefix is retained for caller
  // grouping consistency with the other timeout-* kinds.
  if (lower.includes("no longer attached to the dom") || lower.includes("detached")) {
    return { kind: "timeout-stale", summary: "Element detached from DOM before action completed", original: msg };
  }
  if (lower.includes("timeout")) {
    if (lower.includes("not enabled") || /\bdisabled\b/.test(lower)) {
      return { kind: "timeout-disabled", summary: "Element visible but disabled when timeout fired", original: msg };
    }
    if (lower.includes("intercepts pointer")) {
      return { kind: "timeout-intercepted", summary: "Another element intercepted the click (modal/overlay)", original: msg };
    }
    if (lower.includes("not visible") || lower.includes("hidden")) {
      return { kind: "timeout-hidden", summary: "Element never became visible", original: msg };
    }
    return { kind: "timeout", summary: "Generic timeout — no specific cause found in error body", original: msg };
  }

  return { kind: "unknown", summary: msg.slice(0, 120), original: msg };
}
