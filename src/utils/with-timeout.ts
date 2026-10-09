/**
 * Generic bounded-await helper. Wraps a promise so a hung dependency (a wedged
 * Playwright/CDP RPC, a stalled network call, …) can never block a caller
 * forever — the wrapped promise rejects with `TimeoutError` after `ms` if the
 * inner promise hasn't settled yet.
 *
 * Pure / side-effect-free apart from the timer itself, so it's unit-testable
 * with fake timers. Callers that need a hard fallback on timeout (e.g.
 * `Session.close` falling back to `killChromeHard`) should catch
 * `TimeoutError` specifically and NOT swallow other rejection reasons.
 *
 * The timer is `unref()`'d so an in-flight timeout can never keep the Node
 * process alive on its own — it does not create a leak if the caller never
 * awaits the result.
 */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`)
    this.name = 'TimeoutError'
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(label, ms))
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    // Forward settlement by REFERENCE (not `(err) => reject(err)`) — passing
    // `reject` straight through keeps the original rejection reason exactly
    // as-is without eslint's `prefer-promise-reject-errors` flagging an
    // `unknown`-typed call site.
    void promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}
