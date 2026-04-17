import type { Locator } from "playwright";
import { log } from "../../utils/log.js";

export interface SafeActionOpts {
  /**
   * Short human-readable label for log output when the action fails. Required —
   * unlabeled instrumentation is worthless.
   */
  label: string;
  /** Playwright click/fill timeout. Default: 10_000ms. */
  timeout?: number;
}

/**
 * Click a locator and, on timeout, log a selector-fallback warning.
 *
 * Playwright's `.or()` chains evaluate lazily: the first branch that finds a
 * matching element wins the click. When ALL branches of an `.or()` chain time
 * out, Playwright throws a `TimeoutError`. We can't distinguish "primary took
 * the click" from "fallback took the click" at runtime from outside — Playwright
 * doesn't surface which branch matched.
 *
 * What we CAN detect: the click failed entirely. That's the signal worth
 * broadcasting — a fallback-chain click that raises TimeoutError means the
 * primary selector AND its fallbacks are all stale.
 *
 * We emit `log.warn("selector fallback triggered: <label>")` on failure BEFORE
 * re-throwing the error, so dashboards and log streams capture the label.
 * Best-effort: if logging itself fails, we swallow and re-throw the original
 * error. No stall path.
 */
export async function safeClick(
  locator: Locator,
  opts: SafeActionOpts,
): Promise<void> {
  const { label, timeout = 10_000 } = opts;
  try {
    await locator.click({ timeout });
  } catch (err) {
    try {
      log.warn(`selector fallback triggered: ${label}`);
    } catch {
      // instrumentation failure is never fatal
    }
    throw err;
  }
}

/**
 * Fill a locator and, on timeout, log a selector-fallback warning. See
 * `safeClick` for the semantics of this instrumentation.
 */
export async function safeFill(
  locator: Locator,
  value: string,
  opts: SafeActionOpts,
): Promise<void> {
  const { label, timeout = 10_000 } = opts;
  try {
    await locator.fill(value, { timeout });
  } catch (err) {
    try {
      log.warn(`selector fallback triggered: ${label}`);
    } catch {
      // instrumentation failure is never fatal
    }
    throw err;
  }
}
