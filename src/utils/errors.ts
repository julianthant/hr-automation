/**
 * Extract a human-readable message from an unknown caught value.
 * Replaces the repeated `err instanceof Error ? err.message : String(err)` pattern.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Turn a Playwright locator failure into the missing control.
 * `locator.waitFor: Timeout 15000ms exceeded` becomes "Can't find Search button"
 * or "Can't fill Empl ID field" when the call log names the control.
 */
export function describeLocatorFailure(raw: string): string | null {
  if (/waitForSelector/i.test(raw) && /timeout/i.test(raw)) return "Can't find the control";
  const action = raw.match(/locator\.(waitFor|click|dblclick|fill|check|uncheck|selectOption|press|hover)\b/i)?.[1]?.toLowerCase();
  if (!action || !/timeout/i.test(raw)) return null;

  const role = raw.match(/getByRole\(\s*['"]([^'"]+)['"][^)]*name:\s*['"]([^'"]+)['"]/i);
  const rolePattern = raw.match(/getByRole\(\s*['"]([^'"]+)['"][^)]*name:\s*\/([^/]+)\/[a-z]*/i);
  let target = "";
  const roleHit = role ?? rolePattern;
  if (roleHit) {
    const kind = roleHit[1].toLowerCase();
    const name = roleHit[2].replace(/\\/g, "").trim();
    const noun = kind === "button" ? "button"
      : kind === "link" ? "link"
      : kind === "checkbox" ? "checkbox"
      : kind === "textbox" || kind === "combobox" || kind === "searchbox" ? "field"
      : kind;
    target = `${name} ${noun}`.replace(/\s+/g, " ").trim();
  } else {
    const named = raw.match(/getBy(?:Label|Placeholder|Text|Title)\(\s*['"]([^'"]+)['"]/i)?.[1];
    const locators = [...raw.matchAll(/locator\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]);
    target = (named ?? locators.at(-1) ?? "").trim();
  }
  if (!target) target = action === "fill" ? "the field" : "the control";

  if (action === "fill") return `Can't fill ${target}`;
  if (action === "selectoption") return `Can't choose ${target}`;
  if (action === "check" || action === "uncheck") return `Can't check ${target}`;
  if (action === "click" || action === "dblclick" || action === "press" || action === "hover") return `Can't find ${target}`;
  return `Can't find ${target}`;
}

/** Common Playwright/workflow error patterns → concise dashboard-friendly messages. */
const ERROR_PATTERNS: [RegExp, string][] = [
  [/Target page, context or browser has been closed/i, "Browser closed unexpectedly"],
  [/browser has been disconnected/i, "Browser disconnected"],
  [/Page crashed/i, "Page crashed"],
  [/page\.goto.*Timeout (\d+)ms/i, "Page did not load"],
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
 * Subset of ERROR_PATTERNS whose classified messages indicate a browser/context
 * closure. Derived from ERROR_PATTERNS so the two cannot drift: adding a new
 * browser-closed shape to ERROR_PATTERNS automatically includes it here.
 */
const BROWSER_CLOSED_MESSAGES = new Set([
  "Browser closed unexpectedly",
  "Browser disconnected",
  "Browser closed during operation",
]);
const BROWSER_CLOSED_ENTRIES = ERROR_PATTERNS.filter(([, msg]) =>
  BROWSER_CLOSED_MESSAGES.has(msg),
);
/** Raw Playwright regexes that mean the browser/page/context is gone. */
const BROWSER_CLOSED_RAW_PATTERNS = BROWSER_CLOSED_ENTRIES.map(([pat]) => pat);

export interface ClassifyErrorOpts {
  /** When known, appended to browser-closed messages for operator triage. */
  systemId?: string
}

/** True when the raw error is Playwright's "target/browser/context closed" shape. */
export function isBrowserClosedError(err: unknown): boolean {
  const raw = errorMessage(err)
  return BROWSER_CLOSED_RAW_PATTERNS.some((pattern) => pattern.test(raw))
}

function appendSystemId(message: string, systemId: string | undefined): string {
  if (!systemId) return message
  const isBrowserClosed = BROWSER_CLOSED_ENTRIES.some(([, msg]) => message.startsWith(msg))
  return isBrowserClosed ? `${message} (${systemId})` : message
}

/**
 * Map a raw error to a concise, human-readable message for the dashboard.
 * Returns the cleaned message, or the original (truncated) if no pattern matches.
 */
export function classifyError(err: unknown, opts?: ClassifyErrorOpts): string {
  const raw = errorMessage(err);
  const locatorCause = describeLocatorFailure(raw);
  if (locatorCause) return locatorCause;
  for (const [pattern, replacement] of ERROR_PATTERNS) {
    const match = raw.match(pattern);
    if (match) {
      // Support $1, $2 backreferences in replacement
      const base = replacement.replace(/\$(\d)/g, (_, i: string) => match[parseInt(i)] || "");
      return appendSystemId(base, opts?.systemId)
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
  const msg = err == null ? "" : errorMessage(err);
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
