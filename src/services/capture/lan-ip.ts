import os from "node:os";

/** How a phone on a typical network would reach a given IPv4 address. */
export type LanIpClass = "private" | "cgnat" | "link-local" | "loopback" | "other";

/**
 * Pure: classify an IPv4 address by phone-reachability.
 * - `private`    RFC1918 (10/8, 172.16/12, 192.168/16) — reachable on the same LAN.
 * - `cgnat`      100.64.0.0/10 carrier-grade NAT — a phone generally CANNOT reach it.
 * - `link-local` 169.254.0.0/16 — self-assigned, not routable.
 * - `loopback`   127.0.0.0/8.
 * - `other`      anything else (treated as routable/public).
 */
export function classifyLanIp(ip: string): LanIpClass {
  const parts = ip.split(".").map((n) => Number.parseInt(n, 10));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return "other";
  }
  const [a, b] = parts;
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  return "other";
}

/**
 * True when a phone on a normal network is unlikely to reach this address —
 * CGNAT (100.64/10) and link-local (169.254/16), plus loopback. This is the
 * signal behind the operator "the QR points at an unreachable address" warning
 * and the `CAPTURE_PUBLIC_URL` / tunnel hint.
 */
export function isPhoneUnreachableLanIp(ip: string): boolean {
  const cls = classifyLanIp(ip);
  return cls === "cgnat" || cls === "link-local" || cls === "loopback";
}

/**
 * Pure: pick the best non-internal IPv4 from a network-interfaces map.
 * Exported separately so tests don't have to mock os.networkInterfaces.
 *
 * Prefers an RFC1918 **private** address (reachable by a phone on the same LAN)
 * over a CGNAT / link-local / other address that a Docker, VPN, or CGNAT
 * interface might otherwise get enumerated first. Falls back to the first
 * eligible address when no private one exists, so the QR still carries *a* URL
 * (the caller warns that it may be unreachable — see `isPhoneUnreachableLanIp`).
 */
export function pickLanIpFrom(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): string | undefined {
  const candidates: string[] = [];
  for (const ifaces of Object.values(interfaces)) {
    if (!ifaces) continue;
    for (const ni of ifaces) {
      if (ni.internal) continue;
      if (ni.family !== "IPv4") continue;
      candidates.push(ni.address);
    }
  }
  if (candidates.length === 0) return undefined;
  return candidates.find((ip) => classifyLanIp(ip) === "private") ?? candidates[0];
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
