/**
 * Resolve the absolute base URL for PDF uploads from the page's `window.location`.
 *
 * Uploads go to a SEPARATE port from the SSE/API server — the dashboard's
 * dedicated upload listener, always `mainPort + 1` (see `uploadPort` in
 * `startDashboard`). A different port = a different browser origin = a separate
 * HTTP/1.1 connection pool, so a multi-second upload never competes with the
 * dashboard's ~6 long-lived SSE streams for Chrome's 6-connection-per-origin
 * budget. CORS is wildcard on the backend, so the cross-origin POST works
 * without preflight gymnastics.
 *
 * - **Prod**: the page is served BY the backend, so `location.port` IS the main
 *   port → upload port = `port + 1` (default `3838 → 3839`).
 * - **Vite dev**: the page is on the **canonical** `:5173` but the backend is
 *   the default `:3838`, so the upload listener is `:3839`. NOTE: this assumes
 *   the canonical Vite port — if `:5173` is busy Vite auto-increments (5174…)
 *   and this branch can't tell that apart from a prod backend. Pin it with
 *   `strictPort: true` in `vite.dashboard.config.ts` to keep the assumption safe.
 *
 * Previously this was a hardcoded `:3839`, correct ONLY on the default port
 * (3838 prod / 5173 dev). Any other serving port (e.g. a second dashboard for
 * the AI e2e harness on `:3939`, whose upload listener is `:3940`) misrouted
 * every upload to `:3839` — a DIFFERENT backend (ISS-001). Deriving the port
 * from the serving location fixes that while keeping the default-port behavior
 * byte-identical.
 */
export function resolveUploadBaseUrl(loc: {
  protocol: string;
  hostname: string;
  port: string;
}): string {
  const VITE_DEV_PORT = "5173";
  const FALLBACK_UPLOAD_PORT = 3839;
  // Vite dev (canonical :5173 → backend :3838 → upload :3839) and the
  // standard-port deployment (empty port) fall back to the default listener;
  // a non-numeric port can't come from a real `window.location` but is treated
  // the same, fail-safe. Every other serving port is a backend that serves the
  // page itself, so its upload listener is port + 1.
  const parsed = Number(loc.port);
  const uploadPort =
    loc.port === VITE_DEV_PORT || loc.port === "" || !Number.isInteger(parsed)
      ? FALLBACK_UPLOAD_PORT
      : parsed + 1;
  return `${loc.protocol}//${loc.hostname}:${uploadPort}`;
}
