import os from "node:os";

/**
 * Pure: pick the first non-internal IPv4 from a network-interfaces map.
 * Exported separately so tests don't have to mock os.networkInterfaces.
 */
export function pickLanIpFrom(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): string | undefined {
  for (const ifaces of Object.values(interfaces)) {
    if (!ifaces) continue;
    for (const ni of ifaces) {
      if (ni.internal) continue;
      if (ni.family !== "IPv4") continue;
      return ni.address;
    }
  }
  return undefined;
}

let _cached: string | undefined;
let _cachedAt = 0;
const CACHE_TTL_MS = 5 * 60_000;

/**
 * Pick a LAN-routable IPv4 for the dashboard host. Cached for 5 min so the
 * QR code URL is stable across rapid sessions. Returns undefined if no
 * non-internal IPv4 exists (operator should plug in or use localhost).
 */
export function pickLanIp(now: () => number = Date.now): string | undefined {
  if (_cached && now() - _cachedAt < CACHE_TTL_MS) return _cached;
  const ip = pickLanIpFrom(os.networkInterfaces());
  if (ip) {
    _cached = ip;
    _cachedAt = now();
  }
  return ip;
}

/** Test escape hatch — clears the cache between tests. */
export function __resetLanIpCacheForTests(): void {
  _cached = undefined;
  _cachedAt = 0;
}
