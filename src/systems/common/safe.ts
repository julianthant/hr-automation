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

interface ActionOpts extends SafeActionOpts {
  actionName: "click" | "fill";
  fn: () => Promise<void>;
}

/**
 * True when an error represents a deliberate operator cancellation rather than
 * a genuine selector miss / page problem. Two shapes reach this layer:
 *   - `AbortError` — Playwright rejects an in-flight call when the per-run
 *     `AbortSignal` (injected by the kernel's Page proxy) is aborted.
 *   - `CancelledError` — the kernel's typed cancel error (matched by name to
 *     avoid an upward `systems → core` import).
 * A "best-effort optional" helper like `clickIfPresent` must re-throw these so
 * the cancel propagates instead of being silently treated as "element absent"
 * (which would let a cancelled run keep walking its steps).
 */
function isCancellation(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "CancelledError");
}

async function instrumentedAction(opts: ActionOpts): Promise<void> {
  const { label, _slowThresholdMs = 3_000, actionName, fn } = opts;
  const start = Date.now();
  try {
    await fn();
    const elapsed = Date.now() - start;
    if (elapsed > _slowThresholdMs) {
      log.warn(
        `selector fallback triggered: ${label} (${actionName} took ${elapsed}ms — likely fallback-hit or page stall)`,
      );
    } else {
      log.debug(`${label}: ${actionName}ed in ${elapsed}ms`);
    }
  } catch (err) {
    log.error(
      `selector fallback triggered: ${label} (${actionName} failed after ${Date.now() - start}ms — ${errorMessage(err)})`,
    );
    throw err;
  }
}

export async function safeClick(locator: Locator, opts: SafeActionOpts): Promise<void> {
  const { timeout = 10_000 } = opts;
  return instrumentedAction({
    ...opts,
    actionName: "click",
    fn: () => locator.click({ timeout }),
  });
}

/**
 * Click the first matching element when a locator currently resolves.
 * Returns false for absent elements or click failures so optional UI affordances
 * can stay terse at call sites.
 */
export async function clickIfPresent(
  locator: Locator,
  opts: SafeActionOpts,
): Promise<boolean> {
  let count: number;
  try {
    count = await locator.count();
  } catch (err) {
    // count() can reject on cancel (signal injected by the Page proxy) — that
    // must propagate; any other count failure means "treat as absent". Still
    // log so a swallowed count() error (e.g. frame detached) isn't invisible.
    if (isCancellation(err)) throw err;
    log.debug(`${opts.label}: count() failed, treating as absent — ${errorMessage(err)}`);
    return false;
  }
  if (count === 0) return false;
  try {
    await safeClick(locator.first(), opts);
    return true;
  } catch (err) {
    // A cancel must propagate; a real selector miss / click failure stays terse.
    if (isCancellation(err)) throw err;
    return false;
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
  const { timeout = 10_000 } = opts;
  return instrumentedAction({
    ...opts,
    actionName: "fill",
    fn: () => locator.fill(value, { timeout }),
  });
}
