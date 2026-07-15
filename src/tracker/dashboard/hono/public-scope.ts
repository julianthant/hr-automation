/**
 * Public/forwarded Capture route allowlist.
 *
 * The public listener owns a separate Hono app and consults this allowlist before
 * its Capture routes. The main dashboard app has its own Host/Origin/operator
 * authentication boundary and is never registered on the forwarded listener.
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
