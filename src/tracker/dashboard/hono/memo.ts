export type TtlMemoized<TArgs extends unknown[], TResult> =
  ((...args: TArgs) => TResult) & { reset: () => void };

// Maximum number of distinct keys retained simultaneously. Sized for
// ~10 workflows × ~2 dates (today + a historical date) across up to
// a handful of concurrent SSE clients. Oldest entry is evicted on overflow
// using Map insertion-order LRU (delete-on-hit + re-set, same as parseCache).
const TTL_MEMO_MAX_ENTRIES = 16;

export function ttlMemoize<TArgs extends unknown[], TResult>(
  ttlMs: number,
  keyFn: (...args: TArgs) => string,
  fn: (...args: TArgs) => TResult,
): TtlMemoized<TArgs, TResult> {
  const cache = new Map<string, { computedAt: number; value: TResult }>();

  const memoized = ((...args: TArgs) => {
    const key = keyFn(...args);
    const now = Date.now();
    const entry = cache.get(key);
    if (entry && now - entry.computedAt < ttlMs) {
      // Bump to most-recent position (LRU hit).
      cache.delete(key);
      cache.set(key, entry);
      return entry.value;
    }
    const value = fn(...args);
    // Delete-then-set so re-compute of an existing key bumps its position.
    cache.delete(key);
    cache.set(key, { computedAt: now, value });
    // Evict oldest entry when capacity is exceeded.
    if (cache.size > TTL_MEMO_MAX_ENTRIES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    return value;
  }) as TtlMemoized<TArgs, TResult>;

  memoized.reset = () => {
    cache.clear();
  };
  return memoized;
}
