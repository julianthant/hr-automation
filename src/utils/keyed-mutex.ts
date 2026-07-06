/**
 * A tiny in-process async mutex keyed by string. `runExclusive(key, fn)`
 * serializes all callers sharing the same `key`: each waits for the prior
 * holder to finish before its `fn` runs, and the lock is released even if `fn`
 * throws. Different keys never contend.
 *
 * Single-process only — this is NOT a cross-process lock (use a DB predicate or
 * a lockfile for that). It exists for critical sections that must be atomic
 * within ONE Node process, e.g. the dashboard's enqueue-with-supersede path,
 * where the whole process owns enqueue.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<unknown>>()

  async runExclusive<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    // Chain onto the current tail for this key so callers run strictly in
    // arrival order. `.catch(() => {})` on the awaited predecessor keeps one
    // caller's rejection from cascading into the next waiter.
    const prior = this.tails.get(key) ?? Promise.resolve()
    const run = prior.catch(() => {}).then(() => fn())
    // Store a settled-tolerant tail so a rejected `fn` still lets the next
    // caller proceed; only clear the map entry when THIS run is the latest tail
    // (so we don't drop a newer waiter's chain).
    const tail = run.catch(() => {})
    this.tails.set(key, tail)
    try {
      return await run
    } finally {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}
