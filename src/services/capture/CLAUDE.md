# Capture Service — `src/services/capture/`

Generic mobile-photo upload primitive. Operator clicks a button on the dashboard, gets a QR code, scans on phone, takes photos, taps Done. Photos bundle to a single PDF at `.tracker/uploads/{sessionId}.pdf` that downstream workflows feed to `ocrDocument()` (in `src/services/ocr/`).

## Public API

```ts
import { createSessionStore, handleStart } from "src/services/capture";

const store = createSessionStore();
const result = await handleStart(
  { workflow: "oath-signature", contextHint: "Roster — 2026-04-28" },
  {
    store,
    lanIp: "192.168.1.50",
    port: 3838,
    onFinalize: async (s) => { /* OCR pipeline */ },
  },
);
// result.body = { ok, sessionId, token, captureUrl, qrSvg }
```

## Lifecycle

```
operator                  dashboard backend                  phone
────────                  ─────────────────                  ─────
"Capture" button click  → POST /api/capture/start
                          ← { sessionId, captureUrl, qrSvg }
QR shown to operator
                                                             scan QR
                                                             ↓
                          GET /capture/:token             ← mobile.html
                          ↑ camera button tapped
                          POST /api/capture/upload         (per photo)
                          ↑ Done tapped
                          POST /api/capture/finalize
                          → bundle PDF, fire onFinalize
                          → state: finalized
                          page swaps to "✅ Sent"
```

## State machine

```
open ──upload──► open ──finalize──► finalizing ──bundle ok──► finalized
   ↘                                            ↘──bundle fail──► discarded
    discard                                       (terminal)
       ↓
    discarded (terminal)
   ↘
    sweepExpired / stale read (idle expiry)
       ↓
    expired (terminal)
```

Terminal states: `finalized`, `discarded`, `expired`. `setState` ignores transitions out of terminal — once a session is done, it stays done.

Idle expiry is backend-enforced, not just UI copy: store reads (`getById`/`getByToken`/`listAll`) expire stale open sessions before returning them, and the dashboard server calls `captureStore.sweepExpired()` in its 15s sweep loop. New sessions get a 15-minute pre-phone window; the first manifest hit marks the phone connected and switches activity refreshes to a 60-minute idle window. Upload/replace/reorder refresh expiry from current time; finalizing sessions do not expire mid-handoff.

## Two-key lookup

- `sessionId` (UUID v4) — operator-side. Returned to the dashboard from `/api/capture/start`. Used to discard, list, or look up sessions on the dashboard side.
- `token` (16-char base64url, 96 bits entropy) — phone-side. Embedded in the QR URL. Used by `/capture/:token`, `/api/capture/manifest/:token`, `/api/capture/upload?token=`, `/api/capture/delete-photo`, `/api/capture/finalize`.

The phone never learns the sessionId; the dashboard never echoes the token after the initial `start` response. Single-purpose secret per side.

## Gotchas

- **Mobile camera input on iOS** uses HEIC by default and `pdf-lib` can't decode HEIC. Handled mobile-side: `mobile.html` lazy-loads `heic2any` (served from `/capture-assets/heic2any.min.js`) and converts HEIC/HEIF → JPEG before upload, so the operator no longer needs Camera → Formats → Most Compatible. The "Most Compatible" setting remains a fallback only if the client-side conversion fails to load.
- **LAN IP changes** when the operator swaps networks (Ethernet ↔ WiFi). The 5-min cache means a stale IP could keep showing in the QR for up to 5 min after a switch. Workaround: restart the dashboard, or call `__resetLanIpCacheForTests()` from a debug route (TODO).
- **Phone can't reach the laptop's LAN IP** (Tailscale-only host, CGNAT 100.x range, separate WiFi from the operator). Set `CAPTURE_PUBLIC_URL` (full origin, e.g. `https://abc.trycloudflare.com`) before `npm run dashboard` and the QR points there instead of `http://${lanIp}:${port}`. Pairs with any HTTP tunnel pointed at `localhost:3838`. Trailing slash tolerated. `lanIp:port` is still the default when the env var is unset, so production LAN deployments need no change. **The QR no longer fails silently in this case:** `handleStart` classifies the resolved LAN IP (`classifyLanIp` / `isPhoneUnreachableLanIp` in `lan-ip.ts`) and, when it falls back to a phone-unreachable range (**CGNAT 100.64/10** or **link-local 169.254/16**) with no `CAPTURE_PUBLIC_URL`, returns a `reachabilityWarning` string in the start response (also `log.warn`'d server-side). The capture panel renders it as an amber banner under the QR ("The QR points to … which a phone usually can't reach. Run `npm run dashboard:tunneled` …"). `pickLanIpFrom` also now **prefers an RFC1918 private address** over a CGNAT/other one that a Docker/VPN/CGNAT interface might get enumerated first — it only falls back to (and warns about) an unreachable address when there is no private LAN IPv4 at all.
- **Auto-tunnel is built into `npm run dashboard`** (requires `brew install cloudflared`; `src/services/capture/tunnel.ts` + the CLI wiring in `src/cli.ts`). When the resolved LAN IP is phone-unreachable (CGNAT/link-local, or absent) and no `CAPTURE_PUBLIC_URL` is set, the dashboard starts a **fresh, throwaway anonymous quick tunnel** on the side (`startQuickTunnel(port)`) and sets `process.env.CAPTURE_PUBLIC_URL` to the assigned `https://*.trycloudflare.com` before any Capture opens — so the QR is reachable with zero operator steps. A normal private-LAN start does NOT tunnel (stays fully local). Flags: `--tunnel` forces it on (this is what `npm run dashboard:tunneled` now runs — the old `scripts/dashboard-tunneled.sh` was deleted), `--no-tunnel` forces it off. **Isolation:** `--config /dev/null --origincert /dev/null` + `TUNNEL_ORIGIN_CERT=/dev/null` mean it can NEVER pick up a named tunnel / account cert from `~/.cloudflared/` — every run is a brand-new anonymous tunnel, never a pre-existing named one. **Two gotchas that WILL bite:** (1) cloudflared prints its own API host `https://api.trycloudflare.com` in log/error lines, so the URL parser (`extractQuickTunnelUrl`) must **exclude `api.`** — a naive `*.trycloudflare.com` match grabs it and every phone request 404s (this was the actual "not found" bug). (2) Anonymous TryCloudflare **rate-limits** quick-tunnel creation per IP and the registration endpoint is occasionally slow (`failed to request quick Tunnel: … context deadline exceeded`), so `startQuickTunnel` retries (default 2) and falls back to the LAN IP + reachability warning if all attempts fail. For a **reliable, non-rate-limited** setup, point `CAPTURE_PUBLIC_URL` at a stable named tunnel/origin instead (explicit `CAPTURE_PUBLIC_URL` always wins over the auto quick tunnel).
- **Security: the public tunnel is SCOPED to phone endpoints only** (`src/tracker/dashboard/hono/public-scope.ts`, wired as the first middleware in `hono/app.ts`). The dashboard has NO auth, so a live tunnel would otherwise expose the whole thing (PII, queue, controls, settings) to anyone with the URL. The middleware treats a request as **external** when a public origin is configured (`CAPTURE_PUBLIC_URL`) AND it carries a Cloudflare edge header (`cf-connecting-ip`) OR its `Host` matches the public origin — and for external requests allows ONLY the phone's token-gated endpoints (`GET /capture/:token`, `/capture-assets/*`, `GET /api/capture/manifest/:token`, `POST` upload/replace-photo/delete-photo/reorder/finalize); everything else → 404. Operator-only capture routes (`start`/`discard`/`validate`/`sessions`/`photos`/`registry`) are external-blocked too — the phone never needs them. Local operator access (localhost/LAN, no cf header) is never external, so the dashboard is unaffected. Adding a NEW phone-side endpoint means adding it to `PUBLIC_CAPTURE_ALLOW`. Pinned by `tests/unit/tracker/dashboard/public-scope.test.ts` + verified live (external `/` and `/api/entries` → 404, `/capture/:token` + valid-token manifest → 200).
- **Sessions are in-memory** — restarting the dashboard loses all open sessions. There's no persistence today; if you add it later, the hook is the dashboard startup function next to the existing tracker cleanup calls.
- **`onFinalize` is fire-and-forget**: HTTP returns 200 immediately, the bundle runs in the background. If the bundle or `onFinalize` throws, the session goes `discarded` and the photos stay on disk for forensics.
- **Token leak** is the primary security risk. Mitigations: 16-char random tokens (96-bit entropy, unguessable), backend-enforced idle expiry (15 min before phone connection, 60 min after connection/activity), no token re-issue on expiry. The UI intentionally does not show a countdown/Extend affordance; expired sessions surface as terminal and require starting a new capture.
- **`onFinalize` dispatch lives in `src/tracker/dashboard/capture-state.ts`** (`makeCaptureFinalize`). Every capture routes the bundled PDF through the shared `buildOcrPrepareHandler` (`/api/ocr/prepare`). The OCR `formType` is resolved **declaratively** from the workflow's `captureRegistrations` entry — no per-workflow `if` branch. **To add capture to a workflow: add ONE `captureRegistrations` entry with `{ label, formType }`** (e.g. `"my-workflow": { label: "Capture …", formType: "oath" }`). The `ocr` workflow is the lone exception — it has no entry and carries its operator-picked `formType` on the session, which `makeCaptureFinalize` falls back to. A workflow with neither a registration nor a `session.formType` logs a warn and leaves the PDF on disk.

## Test recipe

```ts
import { createSessionStore } from "src/services/capture";

beforeEach(() => {
  let now = 1_000_000;
  const store = createSessionStore({ now: () => now });
  // ...
});
```

Image-bundling tests via `bundlePhotosToPdf` need a real JPEG/PNG fixture — pdf-lib's UPNG/JpegEmbedder rejects hand-rolled hex buffers. The current tests cover the empty-input + missing-file + magic-header path; add multi-page tests once a fixture lands in `tests/fixtures/`.

## Lessons Learned

- **2026-07-01: The capture QR silently encoded an unreachable CGNAT address — now detected + warned (`lan-ip.ts` reachability classifier).** Symptom reported as "the capture QR code is not working properly": the phone SCANS the QR fine but the page never loads. Root cause: on a machine whose only non-internal IPv4 is a **CGNAT `100.64.0.0/10`** lease (the WiFi `en0` here was `100.64.71.114`; also happens on Tailscale-only hosts / mobile hotspots / some ISPs), `pickLanIpFrom` returned that address and the QR encoded `http://100.64.71.114:<port>/…`, which a phone on a normal network can't reach — and the dashboard gave **no signal at all** that the QR was dead. (The server binds all interfaces via `listen(port)` with no host arg, so the bind was never the issue; the log's "http://localhost" is display-only.) Fix has three parts: (1) pure `classifyLanIp(ip)` → `private|cgnat|link-local|loopback|other` + `isPhoneUnreachableLanIp(ip)` (flags cgnat/link-local/loopback); (2) `pickLanIpFrom` now **prefers an RFC1918 private address** over a CGNAT/other one enumerated first (helps machines that have BOTH a Docker/VPN iface and a real LAN), falling back to the first eligible only when no private exists — so all existing tests (which used private IPs first) stay green; (3) `handleStart` emits a `reachabilityWarning` (in the start response + `log.warn`) when it falls back to an unreachable IP with no `CAPTURE_PUBLIC_URL`, which the capture panel renders as an amber banner pointing at `npm run dashboard:tunneled`. The actual operator fix for a CGNAT/isolated network is still the tunnel (`CAPTURE_PUBLIC_URL`) — code can't make a CGNAT laptop reachable, only stop it failing silently. `CAPTURE_PUBLIC_URL` was also missing from `.env.example` (added). Pinned by `tests/unit/services/capture/lan-ip.test.ts` (classifier + private-preference + CGNAT-only fallback) and `server-start.test.ts` (warning present for CGNAT, absent for private / when publicUrl wins). UI verified headless against real `dashboard:prod` (`.screenshots/capture-reachability/01-warning-banner.png`).
- **2026-07-01: Auto-tunnel wired into `npm run dashboard`; the old bash tunnel script's URL parser was the "not found" 404.** Follow-up to the reachability lesson above — the operator didn't want to remember `dashboard:tunneled` ("start it on the side / by default") and was getting a "not found error" from it. Two findings: (1) **the 404 root cause** was `scripts/dashboard-tunneled.sh` extracting the tunnel URL with `grep -oE "https://[a-z0-9-]+\.trycloudflare\.com" | head -1`, which matches **`https://api.trycloudflare.com`** (cloudflared prints its own API host in log/error lines) instead of the assigned `https://<words>.trycloudflare.com` — especially when registration transiently times out, leaving ONLY the api host in the log. `CAPTURE_PUBLIC_URL` then became `https://api.trycloudflare.com` → every phone request 404'd. (2) **anonymous TryCloudflare is rate-limited** per IP + the registration endpoint is flaky, so a fresh tunnel needs retries and can't be assumed to always come up. Fix: deleted the bash script; added `src/services/capture/tunnel.ts` (`startQuickTunnel` + the pure, `api.`-excluding `extractQuickTunnelUrl`) and wired it into the `dashboard` CLI command — it auto-starts a fresh isolated quick tunnel ONLY when `pickLanIp()` is unreachable (or `--tunnel`) and no `CAPTURE_PUBLIC_URL` is set, sets `process.env.CAPTURE_PUBLIC_URL`, and tears the tunnel down on SIGINT/SIGTERM/exit; falls back to the LAN + warning if cloudflared is missing or every retry fails. `dashboard:tunneled` = `dashboard --tunnel`. The tunnel is isolated (`--config /dev/null --origincert /dev/null` + `TUNNEL_ORIGIN_CERT=/dev/null`) so it never uses a named tunnel in `~/.cloudflared/`. Pinned by `tests/unit/services/capture/tunnel.test.ts` (the `api.`-exclusion + banner-extraction). Verified live: an isolated quick tunnel served `/capture/:token` with HTTP 200 (`districts-reaches-saved-slideshow.trycloudflare.com`), and the dashboard auto-detected the CGNAT IP and attempted the tunnel; repeated test-spawns then hit the anonymous rate limit (expected) and fell back cleanly.
- **2026-06-22: Capture finalize must REGISTER the bundled PDF to get a `pdfFileId` (ISS-009).** `makeCaptureFinalize` (`src/tracker/dashboard/capture-state.ts`) handed the bundled PDF to `buildOcrPrepareHandler(...)({ pdfPath, ... })` with NO `pdfFileId`. The OCR orchestrator REQUIRES it now (legacy page-images path removed — it throws `OCR: pdfFileId is required`), and that throw was swallowed by `handleFinalize`'s `onFinalize` catch in `src/services/capture/server.ts`, so a capture finalize produced NO operation/OCR-prep row at all. Fix: `makeCaptureFinalize` now registers the PDF via `registerLocalFile` (content-hash `fileId`) + warms `ensurePdfPageCache`, mirroring the OCR/oath-upload upload routes, and passes `pdfFileId` to prepare. The `onFinalize` catch was changed from `catch {}` to `log.warn(...)` (fail loud — a thrown onFinalize means no row, the operator must see why). Pinned by `tests/unit/tracker/dashboard-hono-capture.test.ts` ("…passes a non-empty pdfFileId (ISS-009)"). Lesson: any code path feeding the shared OCR prepare must register the PDF first — the upload routes do (`registerLocalFile` → `pdfFileId`); capture was the lone path that didn't.
- **2026-06-19: Capture dirs MUST key off the active tracker root, never a hardcoded `.tracker/` literal (ISS-002).** `CAPTURE_PHOTOS_DIR`/`CAPTURE_UPLOADS_DIR` in `src/tracker/dashboard/capture-state.ts` were the string literals `.tracker/captures` / `.tracker/uploads`, so under any non-default `HRAUTO_TRACKER_DIR` (the e2e stub lane, or any isolated deploy) the photo bundle + PDF landed in the REAL `.tracker/` while `makeCaptureFinalize` ran OCR prepare against the configured tracker dir — the finalize succeeded but produced NO operation/OCR-prep row (the bundled PDF was where prepare couldn't see it), and e2e artifacts leaked into real history. Now both derive from `PATHS.trackerDir` via the new `capturesDir(dir)`/`uploadsDir(dir)` helpers in `src/tracker/paths.ts` (the "never re-spell `.tracker/<subdir>` as a string literal" rule applies here too). Pinned by `tests/unit/tracker/capture-tracker-dir.test.ts`.
- **2026-04-28: Module landed.** Backend-only — React dashboard panel deferred to follow-up. mobile.html is vanilla JS; pdf-lib chosen over `pdf-kit` for zero-config buffer-in/buffer-out. (iPhone HEIC was not handled at landing; it is now converted client-side via `heic2any` before upload — see the HEIC gotcha above.)
- **2026-04-28: pdf-lib image-fixture testing pain.** Hex-buffer mock JPEGs fail UPNG/JpegEmbedder validation. Decided to test the function shape (empty, ENOENT, magic-header) and rely on integration / manual smoke for the multi-photo bundle path. Adding `sharp` or `canvas` just for tests is too heavy.
