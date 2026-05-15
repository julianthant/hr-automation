export type TtlMemoized<TArgs extends unknown[], TResult> =
  ((...args: TArgs) => TResult) & { reset: () => void };

export function ttlMemoize<TArgs extends unknown[], TResult>(
  ttlMs: number,
  keyFn: (...args: TArgs) => string,
  fn: (...args: TArgs) => TResult,
): TtlMemoized<TArgs, TResult> {
  let cache: { key: string; computedAt: number; value: TResult } | null = null;
  const memoized = ((...args: TArgs) => {
    const key = keyFn(...args);
    const now = Date.now();
    if (cache && cache.key === key && now - cache.computedAt < ttlMs) {
      return cache.value;
    }
    const value = fn(...args);
    cache = { key, computedAt: now, value };
    return value;
  }) as TtlMemoized<TArgs, TResult>;
  memoized.reset = () => {
    cache = null;
  };
  return memoized;
}
