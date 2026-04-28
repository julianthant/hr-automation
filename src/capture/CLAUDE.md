# Capture Module — `src/capture/`

Generic mobile-photo upload primitive. Operator clicks a button on the dashboard, gets a QR code, scans on phone, takes photos, taps Done. Photos bundle to a single PDF at `.tracker/uploads/{sessionId}.pdf` that downstream workflows feed to `ocrDocument()` (in `src/ocr/`).

## Files

- `index.ts` — public barrel
- `sessions.ts` — `createSessionStore({ now })` — in-memory session store with 15-min idle expiry, terminal-state stickiness, photo append/remove
- `pdf-bundle.ts` — `bundlePhotosToPdf(paths, outPath)` via pdf-lib (JPG + PNG)
- `lan-ip.ts` — `pickLanIp()` chooses first non-internal IPv4 from `os.networkInterfaces()`, 5-min cache
- `qr.ts` — `qrSvgFor(url)` wraps the qrcode npm lib
- `server.ts` — pure route handlers (returns `{status, body}`); `handleStart`, `handleManifest`, `handleUpload`, `handleDeletePhoto`, `handleFinalize`, `handleDiscard`
- `mobile.html` — static mobile UI served at `/capture/:token`

## Public API

```ts
import { createSessionStore, handleStart } from "src/capture";

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
    sweepExpired (15-min idle)
       ↓
    expired (terminal)
```

Terminal states: `finalized`, `discarded`, `expired`. `setState` ignores transitions out of terminal — once a session is done, it stays done.

## Two-key lookup

- `sessionId` (UUID v4) — operator-side. Returned to the dashboard from `/api/capture/start`. Used to discard, list, or look up sessions on the dashboard side.
- `token` (16-char base64url, 96 bits entropy) — phone-side. Embedded in the QR URL. Used by `/capture/:token`, `/api/capture/manifest/:token`, `/api/capture/upload?token=`, `/api/capture/delete-photo`, `/api/capture/finalize`.

The phone never learns the sessionId; the dashboard never echoes the token after the initial `start` response. Single-purpose secret per side.

## Gotchas

- **Mobile camera input on iOS** uses HEIC by default. `pdf-lib` doesn't decode HEIC. Workaround for now: tell operator to set Camera → Formats → Most Compatible. Long-term: add `heic2any` mobile-side polyfill that converts HEIC→JPEG before upload.
- **LAN IP changes** when the operator swaps networks (Ethernet ↔ WiFi). The 5-min cache means a stale IP could keep showing in the QR for up to 5 min after a switch. Workaround: restart the dashboard, or call `__resetLanIpCacheForTests()` from a debug route (TODO).
- **Sessions are in-memory** — restarting the dashboard loses all open sessions. There's no persistence today; if you add it later, the hook is the dashboard startup function next to the existing tracker cleanup calls.
- **`onFinalize` is fire-and-forget**: HTTP returns 200 immediately, the bundle runs in the background. If the bundle or `onFinalize` throws, the session goes `discarded` and the photos stay on disk for forensics.
- **Token leak** is the primary security risk. Mitigations: 16-char random tokens (96-bit entropy, unguessable), 15-min idle expiry, no token re-issue on expiry. Not an external-facing tool — LAN-only by design; operator's WiFi is the boundary.
- **`onFinalize` is a no-op today** in `src/tracker/dashboard.ts` (`captureNoopFinalize`). Feature 4 (`feature/oath-dual-mode`) replaces it with a per-workflow registry lookup so oath paper-mode receives the bundled PDF and runs `runPaperOathPrepare`.

## Test recipe

```ts
import { createSessionStore } from "src/capture";

beforeEach(() => {
  let now = 1_000_000;
  const store = createSessionStore({ now: () => now });
  // ...
});
```

Image-bundling tests via `bundlePhotosToPdf` need a real JPEG/PNG fixture — pdf-lib's UPNG/JpegEmbedder rejects hand-rolled hex buffers. The current tests cover the empty-input + missing-file + magic-header path; add multi-page tests once a fixture lands in `tests/fixtures/`.

## Lessons Learned

- **2026-04-28: Module landed.** Backend-only — React dashboard panel deferred to follow-up. mobile.html is vanilla JS, ~150 LOC; iPhone HEIC is not handled today (operator sets Camera → Most Compatible). pdf-lib chosen over `pdf-kit` for zero-config buffer-in/buffer-out.
- **2026-04-28: pdf-lib image-fixture testing pain.** Hex-buffer mock JPEGs fail UPNG/JpegEmbedder validation. Decided to test the function shape (empty, ENOENT, magic-header) and rely on integration / manual smoke for the multi-photo bundle path. Adding `sharp` or `canvas` just for tests is too heavy.
