/**
 * Public-tunnel access scoping for the dashboard.
 *
 * The dashboard has NO authentication and, when a phone-Capture tunnel is active
 * (`CAPTURE_PUBLIC_URL` / `dashboard --tunnel`), its origin becomes reachable
 * from the public internet. Without scoping, that would expose the ENTIRE
 * dashboard — all PII, queue data, workflow controls, settings, logs, and
 * screenshots — to anyone who has (or guesses/leaks) the tunnel URL.
 *
 * This module restricts EXTERNAL (tunnel) requests to exactly the phone's
 * capture endpoints, each already gated server-side by the 96-bit per-session
 * token. Local operator access (localhost / LAN, no Cloudflare edge header) is
 * never treated as external, so the operator's own dashboard is unaffected.
 */

interface AllowRule {
  method: string;
  re: RegExp;
}

/**
 * The only paths a phone legitimately needs. Each mutation endpoint is
 * token-authenticated server-side (`getByToken`); `GET /capture/:token` and the
 * static asset are harmless. Operator-only capture endpoints — `start`
 * (creates sessions), `discard`, `validate`, `sessions` (lists all), `photos`
 * (sessionId-keyed), `registry` — are deliberately EXCLUDED: the phone never
 * calls them, and exposing `start` would let anyone spin up capture sessions.
 */
const PUBLIC_CAPTURE_ALLOW: readonly AllowRule[] = [
  { method: "GET", re: /^\/capture\/[^/]+$/ },
  { method: "GET", re: /^\/capture-assets\/[^/]+$/ },
  { method: "GET", re: /^\/api\/capture\/manifest\/[^/]+$/ },
  { method: "POST", re: /^\/api\/capture\/upload$/ },
  { method: "POST", re: /^\/api\/capture\/replace-photo$/ },
  { method: "POST", re: /^\/api\/capture\/delete-photo$/ },
  { method: "POST", re: /^\/api\/capture\/reorder$/ },
  { method: "POST", re: /^\/api\/capture\/finalize$/ },
];

/** True iff `method` + `path` is a phone-side capture endpoint safe to expose publicly. */
export function isPublicCaptureRequestAllowed(method: string, path: string): boolean {
  const m = method.toUpperCase();
  // CORS preflight carries no data and is answered by the OPTIONS handler.
  if (m === "OPTIONS") return true;
  return PUBLIC_CAPTURE_ALLOW.some((r) => r.method === m && r.re.test(path));
}

/** Lowercased host with any port stripped; handles bracketed IPv6 (`[::1]:3838`). */
function hostOnly(hostHeader: string | null | undefined): string | undefined {
  if (!hostHeader) return undefined;
  const h = hostHeader.trim().toLowerCase();
  const v6 = h.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (v6) return v6[1];
  return h.replace(/:\d+$/, "");
}

/**
 * Whether a request arrived via the public Capture origin (vs. local operator
 * access). External iff a public origin is configured AND the request either
 * carries a Cloudflare edge header (`cf-connecting-ip`, added to every proxied
 * request) OR its Host matches the public origin's host. Both signals are
 * present on a real cloudflared request; either alone is enough to fail safe.
 * A local request (localhost / LAN, no cf header, Host ≠ the public host) is
 * never external.
 */
export function isExternalCaptureRequest(opts: {
  hostHeader: string | null | undefined;
  publicUrl: string | undefined;
  cfConnectingIp: string | null | undefined;
}): boolean {
  if (!opts.publicUrl) return false;
  if (opts.cfConnectingIp) return true;
  let publicHost: string;
  try {
    publicHost = new URL(opts.publicUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostOnly(opts.hostHeader) === publicHost;
}
