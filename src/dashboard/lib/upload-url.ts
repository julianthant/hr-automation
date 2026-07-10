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
 * - **Vite dev** (`opts.dev`, from `import.meta.env.DEV`): the PAGE port says
 *   nothing about the backend — Vite auto-increments off the canonical `:5173`
 *   when it's busy (another project's dev server on 5173 pushed the dashboard
 *   to 5174 in the live incident this fixed), while the proxy target stays the
 *   FIXED `:3838` (`vite.dashboard.config.ts`). So dev always uploads to
 *   `:3839`, regardless of where the page is served from. Deriving from the
 *   page port here mis-computed `5174 + 1 = 5175` — nothing listens there, so
 *   every upload died as a bare "Network error" (found live 2026-07-10).
 * - **Prod**: the page is served BY the backend, so `location.port` IS the main
 *   port → upload port = `port + 1` (default `3838 → 3839`; the e2e harness on
 *   `:3939` → `3940`, the ISS-001 fix).
 */
export function resolveUploadBaseUrl(
  loc: {
    protocol: string;
    hostname: string;
    port: string;
  },
  opts?: { dev?: boolean },
): string {
  const VITE_DEV_PORT = "5173";
  // Mirrors the fixed backend target in `vite.dashboard.config.ts`'s proxy
  // block (`/api` → http://localhost:3838) + 1.
  const FALLBACK_UPLOAD_PORT = 3839;
  if (opts?.dev) {
    return `${loc.protocol}//${loc.hostname}:${FALLBACK_UPLOAD_PORT}`;
  }
  // Prod: the serving port is the backend's main port. The canonical Vite port
  // and the standard-port deployment (empty port) fall back to the default
  // listener; a non-numeric port can't come from a real `window.location` but
  // is treated the same, fail-safe.
  const parsed = Number(loc.port);
  const uploadPort =
    loc.port === VITE_DEV_PORT || loc.port === "" || !Number.isInteger(parsed)
      ? FALLBACK_UPLOAD_PORT
      : parsed + 1;
  return `${loc.protocol}//${loc.hostname}:${uploadPort}`;
}
