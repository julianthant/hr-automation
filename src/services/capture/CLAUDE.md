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

- **Mobile camera input on iOS** uses HEIC by default. `pdf-lib` doesn't decode HEIC. Workaround for now: tell operator to set Camera → Formats → Most Compatible. Long-term: add `heic2any` mobile-side polyfill that converts HEIC→JPEG before upload.
- **LAN IP changes** when the operator swaps networks (Ethernet ↔ WiFi). The 5-min cache means a stale IP could keep showing in the QR for up to 5 min after a switch. Workaround: restart the dashboard, or call `__resetLanIpCacheForTests()` from a debug route (TODO).
- **Phone can't reach the laptop's LAN IP** (Tailscale-only host, CGNAT 100.x range, separate WiFi from the operator). Set `CAPTURE_PUBLIC_URL` (full origin, e.g. `https://abc.trycloudflare.com`) before `npm run dashboard` and the QR points there instead of `http://${lanIp}:${port}`. Pairs with any HTTP tunnel pointed at `localhost:3838`. Trailing slash tolerated. `lanIp:port` is still the default when the env var is unset, so production LAN deployments need no change.
- **Easiest tunnel path**: `npm run dashboard:tunneled` (requires `brew install cloudflared`). Wraps `scripts/dashboard-tunneled.sh` — starts an anonymous Cloudflare quick tunnel pointed at `localhost:3838`, captures the fresh `https://*.trycloudflare.com` URL, exports it as `CAPTURE_PUBLIC_URL`, then runs `npm run dashboard`. Ctrl+C kills both. The script passes `--config /dev/null --origincert /dev/null` so the quick tunnel doesn't accidentally inherit a pre-existing named-tunnel cred-file from `~/.cloudflared/`, which produces edge-side 404s if it does.
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

- **2026-06-22: Capture finalize must REGISTER the bundled PDF to get a `pdfFileId` (ISS-009).** `makeCaptureFinalize` (`src/tracker/dashboard/capture-state.ts`) handed the bundled PDF to `buildOcrPrepareHandler(...)({ pdfPath, ... })` with NO `pdfFileId`. The OCR orchestrator REQUIRES it now (legacy page-images path removed — it throws `OCR: pdfFileId is required`), and that throw was swallowed by `handleFinalize`'s `onFinalize` catch in `src/services/capture/server.ts`, so a capture finalize produced NO operation/OCR-prep row at all. Fix: `makeCaptureFinalize` now registers the PDF via `registerLocalFile` (content-hash `fileId`) + warms `ensurePdfPageCache`, mirroring the OCR/oath-upload upload routes, and passes `pdfFileId` to prepare. The `onFinalize` catch was changed from `catch {}` to `log.warn(...)` (fail loud — a thrown onFinalize means no row, the operator must see why). Pinned by `tests/unit/tracker/dashboard-hono-capture.test.ts` ("…passes a non-empty pdfFileId (ISS-009)"). Lesson: any code path feeding the shared OCR prepare must register the PDF first — the upload routes do (`registerLocalFile` → `pdfFileId`); capture was the lone path that didn't.
- **2026-06-19: Capture dirs MUST key off the active tracker root, never a hardcoded `.tracker/` literal (ISS-002).** `CAPTURE_PHOTOS_DIR`/`CAPTURE_UPLOADS_DIR` in `src/tracker/dashboard/capture-state.ts` were the string literals `.tracker/captures` / `.tracker/uploads`, so under any non-default `HRAUTO_TRACKER_DIR` (the e2e stub lane, or any isolated deploy) the photo bundle + PDF landed in the REAL `.tracker/` while `makeCaptureFinalize` ran OCR prepare against the configured tracker dir — the finalize succeeded but produced NO operation/OCR-prep row (the bundled PDF was where prepare couldn't see it), and e2e artifacts leaked into real history. Now both derive from `PATHS.trackerDir` via the new `capturesDir(dir)`/`uploadsDir(dir)` helpers in `src/tracker/paths.ts` (the "never re-spell `.tracker/<subdir>` as a string literal" rule applies here too). Pinned by `tests/unit/tracker/capture-tracker-dir.test.ts`.
- **2026-04-28: Module landed.** Backend-only — React dashboard panel deferred to follow-up. mobile.html is vanilla JS, ~150 LOC; iPhone HEIC is not handled today (operator sets Camera → Most Compatible). pdf-lib chosen over `pdf-kit` for zero-config buffer-in/buffer-out.
- **2026-04-28: pdf-lib image-fixture testing pain.** Hex-buffer mock JPEGs fail UPNG/JpegEmbedder validation. Decided to test the function shape (empty, ENOENT, magic-header) and rely on integration / manual smoke for the multi-photo bundle path. Adding `sharp` or `canvas` just for tests is too heavy.
