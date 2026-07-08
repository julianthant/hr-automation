const NOMINATIM_MIN_INTERVAL_MS = 1_100;

let lastNominatimCallAt = 0;

export async function waitForNominatimSlot(
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  const elapsed = now() - lastNominatimCallAt;
  if (elapsed < NOMINATIM_MIN_INTERVAL_MS) {
    await sleep(NOMINATIM_MIN_INTERVAL_MS - elapsed);
  }
  lastNominatimCallAt = now();
}

/** Test seam — reset the module-level Nominatim throttle clock. */
export function __resetNominatimRateLimitForTests(): void {
  lastNominatimCallAt = 0;
}
