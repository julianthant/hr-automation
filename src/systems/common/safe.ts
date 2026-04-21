import type { Locator } from "playwright";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";

export interface SafeActionOpts {
  /**
   * Short human-readable label for log output. Required —
   * unlabeled instrumentation is worthless.
   */
  label: string;
  /** Playwright click/fill timeout. Default: 10_000ms. */
  timeout?: number;
  /**
   * Internal: threshold in ms above which a success is treated as
   * fallback-hit. Test-only escape hatch; default 3_000.
   */
  _slowThresholdMs?: number;
}

/**
 * Click a locator and log latency-based fallback inference.
 *
 * Playwright's `.or()` chains evaluate lazily: the first branch that finds a
 * matching element wins the click. From outside the library we can't tell
 * which branch matched — Playwright doesn't surface that. We use latency as a
 * proxy: a click that completes quickly (≤ `_slowThresholdMs`, default 3s)
 * almost certainly hit the primary selector; a click that completes slowly
 * (> threshold) likely exhausted the primary's timeout window and only
 * succeeded after a fallback branch matched — but a plain slow page load can
 * also push latency past 3s without any fallback involvement, so the message
 * hedges ("likely fallback-hit or page stall").
 *
 * Emitted signals (all three success/slow/failure cases share the
 * `selector fallback triggered: <label>` anchor so the dashboard's Selector
 * Health Panel can aggregate on label — see `SELECTOR_FALLBACK_RE` in
 * `src/tracker/dashboard.ts`):
 *   - success ≤ threshold  → `log.debug("<label>: clicked in Nms")`
 *   - success > threshold  → `log.warn("selector fallback triggered: <label> (click took Nms — likely fallback-hit or page stall)")`
 *   - failure              → `log.error("selector fallback triggered: <label> (click failed after Nms — <error message>)")` then re-throw
 */
export async function safeClick(
  locator: Locator,
  opts: SafeActionOpts,
): Promise<void> {
  const { label, timeout = 10_000, _slowThresholdMs = 3_000 } = opts;
  const start = Date.now();
  try {
    await locator.click({ timeout });
    const elapsed = Date.now() - start;
    if (elapsed > _slowThresholdMs) {
      log.warn(
        `selector fallback triggered: ${label} (click took ${elapsed}ms — likely fallback-hit or page stall)`,
      );
    } else {
      log.debug(`${label}: clicked in ${elapsed}ms`);
    }
  } catch (err) {
    log.error(
      `selector fallback triggered: ${label} (click failed after ${Date.now() - start}ms — ${errorMessage(err)})`,
    );
    throw err;
  }
}

/**
 * Fill a locator and log latency-based fallback inference. See `safeClick`
 * for the rationale; semantics are identical, substituting fill/filled/
 * "fill failed" for click/clicked/"click failed".
 */
export async function safeFill(
  locator: Locator,
  value: string,
  opts: SafeActionOpts,
): Promise<void> {
  const { label, timeout = 10_000, _slowThresholdMs = 3_000 } = opts;
  const start = Date.now();
  try {
    await locator.fill(value, { timeout });
    const elapsed = Date.now() - start;
    if (elapsed > _slowThresholdMs) {
      log.warn(
        `selector fallback triggered: ${label} (fill took ${elapsed}ms — likely fallback-hit or page stall)`,
      );
    } else {
      log.debug(`${label}: filled in ${elapsed}ms`);
    }
  } catch (err) {
    log.error(
      `selector fallback triggered: ${label} (fill failed after ${Date.now() - start}ms — ${errorMessage(err)})`,
    );
    throw err;
  }
}
