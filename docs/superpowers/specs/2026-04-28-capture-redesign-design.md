# Capture Feature Redesign — Design

**Date:** 2026-04-28
**Status:** Draft, awaiting user review
**Scope:** Redesign the QR-code mobile capture feature to be (a) generic across workflows instead of oath-only, (b) restart-resilient via JSONL event log, (c) realtime via SSE, and (d) functionally richer on both operator and phone sides — without expanding scope into OCR (owned by sister emergency-contact pipeline) or generalizing OathPreviewRow.

## Goals

The capture feature shipped in commits `bd1fcc4`, `04ed731`, `72ce6c5`, `a6b5dd6` is architecturally clean (two-key sessionId+token, generic `onFinalize` callback, well-tested) but has eight concrete weaknesses that this redesign addresses, ranked by the user's explicit priority order: **speed > consistency > functionality > accuracy > scalability**.

| Axis | Today | After |
|---|---|---|
| **Speed** | 1 s polling for session state | Sub-100 ms SSE updates; parallel mobile uploads |
| **Consistency** | In-memory store dies on dashboard restart | JSONL event log replayed on boot; sessions survive restarts |
| **Functionality** | Delete-only thumbnails; no retake; HEIC unsupported; no resume on phone reload | Per-photo retake/replace, drag-reorder, mark-blank, HEIC client-side conversion, localStorage manifest, parallel uploads with retry/backoff |
| **Accuracy** | No quality feedback before bundling | Canvas-based blur detection on phone, badge in modal + finalize warning banner |
| **Scalability** | TopBar gate hard-coded to `workflow === "oath-signature"` | Generic `CaptureRegistry`; workflows opt in by registering `{ label, finalize, validate? }` at module load |

## Non-goals

- **OCR.** The sister emergency-contact pipeline owns OCR. Capture hands raw images to whatever finalize handler the workflow registers.
- **Generalizing `<OathPreviewRow>` into a workflow-agnostic `<PreviewRow>` framework.** Emergency-contact already has its own parallel preview implementation. Consolidation is a follow-up refactor; this redesign keeps OathPreviewRow oath-specific, only adapting it for the new finalize contract.
- **Multi-operator concurrent capture UX.** The architecture supports it (JSONL + SSE means a second tab observes the same state automatically) but this spec does not design collaborative editing of a single session.
- **getUserMedia document-scanner viewfinder** (Apple Notes-style auto-edge-detect). Native camera input stays the model — operators trust their phone camera and viewfinder edge-detection brings Safari/iOS quirks not worth the polish gain.
- **SQLite or other new persistence dependencies.** JSONL is consistent with the rest of the kernel.
- **Right-rail multi-session dashboard surface.** Modal stays the surface; the user explicitly chose modal over right-rail/floating-card alternatives.
- **Stepper/wizard modal flow.** Single-screen modal stays; no multi-step navigation for the operator.

## Locked decisions

| # | Question | Decision |
|---|---|---|
| 1 | Operating mode | Heavy-use solo operator; multi-workflow eventually; priorities: speed > consistency > functionality > accuracy > scalability |
| 2 | Workflow scope | Generic primitive — TopBar gate becomes a registry lookup |
| 3 | Dashboard surface | Modal (polished) — not right-rail, not floating cards |
| 4 | Modal shape | Live thumbnail mirror — operator sees photos arrive in real time |
| 5 | Phone side | Native camera + smart tray (per-photo retake/blur-warning/drag-reorder/parallel-upload/reload-resume) |
| 6 | Persistence | JSONL event log — append-only, replayed on boot |

## Architecture

### File layout

| File | Status | Purpose |
|---|---|---|
| `src/capture/server.ts` | **changed** | New endpoints + SSE emit on every state mutation |
| `src/capture/sessions.ts` | **changed** | Rename in-memory `Map` to `MemoryStore`; same public interface |
| `src/capture/qr.ts` | preserved | QR SVG generation |
| `src/capture/lan-ip.ts` | preserved | LAN IP selection (5-min cache) |
| `src/capture/pdf-bundle.ts` | preserved | pdf-lib bundling |
| `src/capture/mobile.html` | **rewritten** | Polished single-page capture UI (~600 LOC); native camera, retake, drag-reorder, blur detection, localStorage manifest, parallel uploads, HEIC polyfill |
| `src/capture/jsonl-store.ts` | **new** | JSONL-backed session store; appends to `.tracker/capture-{YYYY-MM-DD}.jsonl`; replays on boot |
| `src/capture/registry.ts` | **new** | `CaptureRegistry` — workflows register `{ workflow, label, finalize, validate? }` |
| `src/capture/sse.ts` | **new** | SSE channel multiplexing per dashboard tab; replaces 1 s polling |
| `src/capture/blur-detect.ts` | **new** | Canvas-based Laplacian-variance blur heuristic; runs on phone |
| `src/capture/heic.ts` | **new** | HEIC → JPEG conversion via `heic2any` polyfill (phone-side) |
| `src/dashboard/components/CaptureModal.tsx` | **changed** | Wider 2-col layout; left = QR/status, right = live thumbnail mirror; SSE-driven |
| `src/dashboard/components/CapturePhotoTile.tsx` | **new** | Thumbnail tile with blur badge, delete overlay, replace state |
| `src/dashboard/components/TopBarCaptureButton.tsx` | **changed** | Drop hard-coded oath gate; query registry endpoint |
| `src/tracker/dashboard.ts` | **changed** | `makeCaptureFinalize` becomes ~10 lines (registry dispatch); add `GET /api/capture/registry`, `POST /api/capture/extend`, `POST /api/capture/replace-photo`, `POST /api/capture/validate`, `GET /api/capture/sessions/stream` (SSE) |
| `src/workflows/oath-signature/index.ts` | **changed** | Calls `captureRegistry.register({...})` at module load (replaces switch case in dashboard.ts) |
| `src/capture/CLAUDE.md` | **updated** | New state machine, JSONL schema, registry contract, manual QA recipe |

### Module boundaries

```
┌──────────────────────────────────────────────────────────┐
│                    src/capture/                          │
│                                                          │
│  ┌─────────────┐    ┌──────────────┐                    │
│  │ registry.ts │    │   server.ts  │ ← HTTP + SSE       │
│  │             │    │              │                    │
│  │ register()  │    │ start/manif/ │                    │
│  │ get()       │    │ upload/      │                    │
│  │ list()      │    │ finalize/    │                    │
│  │ has()       │    │ extend/...   │                    │
│  └─────────────┘    └──────┬───────┘                    │
│         ▲                  │                            │
│         │                  ▼                            │
│  ┌──────┴──────┐    ┌──────────────┐    ┌────────────┐ │
│  │ Workflow    │    │  sessions.ts │    │ jsonl-     │ │
│  │ index.ts    │    │              │    │ store.ts   │ │
│  │ (oath-sig,  │    │ store iface  │◀───│ append +   │ │
│  │  emerg-ct)  │    │ + Memory     │    │ replay     │ │
│  └─────────────┘    │   Store      │    └────────────┘ │
│                     └──────────────┘                    │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│  │ qr.ts    │ │lan-ip.ts │ │pdf-bundle│ │ sse.ts   │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘   │
│                                                         │
│  ┌──────────┐ ┌──────────┐ ┌─────────────────┐         │
│  │heic.ts   │ │blur-detec│ │ mobile.html     │         │
│  │ (phone)  │ │ (phone)  │ │ (single-page)   │         │
│  └──────────┘ └──────────┘ └─────────────────┘         │
└─────────────────────────────────────────────────────────┘
```

`registry.ts` and `sessions.ts` have no dependencies on each other or on `server.ts`. `server.ts` is the only thing that wires them together. This makes both unit-testable in isolation.

## Data model

### Session state machine

```
   ┌──── created ────┐
   │                  ▼
[open] ──photo_added──→ [open]
   │  ←─photo_removed──┘
   │  ←─photo_replaced─┘ (new: retake)
   │
   ├── finalize_requested ──→ [finalizing] ──pdf_built──→ [finalized]
   │                              │            │
   │                              ▼            ▼
   │                          finalize_failed (terminal-with-error; new)
   │
   ├── discard ────────→ [discarded]
   └── (idle 15min) ───→ [expired]
```

Terminal states: `finalized`, `discarded`, `expired`, `finalize_failed`. The new state `finalize_failed` enables a Retry button in the modal — PDF and photos stay on disk, the registered finalize handler can be re-run.

### JSONL event schema

Append-only log at `.tracker/capture-{YYYY-MM-DD}.jsonl`. One JSON object per line. Every event has `{ ts, sessionId, type, ...payload }`. The session store is a pure reduction over these events.

| `type` | Payload | Emitted from |
|---|---|---|
| `session_created` | `{ workflow, contextHint?, expiresAt }` (+ optional `lanUrl, shortcode`) | store `create()` |
| `phone_connected` | `{ userAgent?, ip? }` | `handleManifest` (first hit) |
| `photo_added` | `PhotoSummary` (the full new photo: `{ index, filename, sizeBytes, mime, uploadedAt, blurScore?, blurFlagged? }`) | `handleUpload` |
| `photo_removed` | `{ photoIndex, source: "phone" \| "dashboard" \| "system" }` | `handleDeletePhoto` |
| `photo_replaced` | `{ photoIndex, oldFilename, newFilename, blurScore?, blurFlagged }` | `handleReplacePhoto` |
| `photos_reordered` | `{ fromIndex, toIndex, order: number[] }` (positions) | `handleReorder` |
| `extended` | `{ byMs, newExpiresAt }` | `handleExtend` |
| `finalize_requested` | `{ photoCount }` | store `setState("finalizing")` |
| `pdf_built` | `{ pdfPath }` (+ optional `pageCount, sizeBytes`) | post-bundle |
| `finalized` | `{ pdfPath, finalizeHandlerOk }` (+ optional `durationMs, parentRunId`) | store `setState("finalized")` |
| `finalize_failed` | `{ error, stage: "bundle" \| "handler" }` | error path |
| `discarded` | `{ reason?, source: "operator" \| "phone" \| "system" }` | store `setState("discarded")` |
| `expired` | — | sweep tick / `setState("expired")` |

#### `session_created` payload invariant (gap-4 amendment)

`session_created` MUST carry every field needed to reconstruct a fresh
`CaptureSessionInfo` without a follow-up snapshot round-trip — namely
`{ workflow, contextHint?, expiresAt }`. The reducer in
`useCaptureSession.ts` defaults `state: "open"`, `phoneConnectedAt: null`,
`photos: []`, and `createdAt: ev.ts`. Optional `lanUrl, shortcode` may be
added for observers that want to render the QR/shortcode of an already-
existing session, but they are NOT required for reconstruction.

`token` is NEVER echoed in any SSE event (see "Contracts & invariants" →
"Token never echoed in SSE"). The operator gets the token exactly once,
in the response to `POST /api/capture/start`.

### Boot replay

```
1. Find all .tracker/capture-*.jsonl files modified in last 24h
2. Stream-read in date order, group by sessionId
3. Reduce each session — drop terminal sessions, keep open + finalizing
4. Run sweepExpired() against rebuilt store
5. For sessions in `finalizing` state, re-run bundle + finalize handler (idempotent at workflow layer)
6. Resume serving requests
```

Replay cost is milliseconds for typical volumes (≤100 sessions/day × ~10 events). Boot is unaffected.

## API surface

### HTTP endpoints

| Method | Path | Status | Body / Result |
|---|---|---|---|
| POST | `/api/capture/start` | unchanged | `{ workflow, contextHint? }` → `{ ok, sessionId, token, captureUrl, qrSvg, shortcode, expiresAt }` |
| GET | `/api/capture/manifest/:token` | unchanged | → `{ ok, state, photos: PhotoSummary[], workflow, contextHint, expiresAt }` (was photo count; now array — see PhotoSummary below; also marks the phone as connected on first hit) |
| POST | `/api/capture/upload?token=` | unchanged | multipart `file` → `{ ok, photoIndex, totalPhotos, blurScore?, blurFlagged? }` |
| GET | `/api/capture/photos/:sessionId/:index` | **new** | streams the JPG/PNG/HEIC bytes for a stable photo id; `Cache-Control: no-cache, must-revalidate`; 404 if the session/photo isn't found or sessionId fails the UUID-shape regex (path-traversal guard) |
| POST | `/api/capture/replace-photo` | **new** | multipart with text fields `token`, `index` (stable photo id), optional `blurScore`, plus file part `file` → `{ ok, blurScore?, blurFlagged? }`. Old file is preserved on disk (timestamp-suffixed filename) for forensics. |
| POST | `/api/capture/reorder` | **new** | `{ token, fromIndex, toIndex }` (POSITIONS, not stable ids) → `{ ok, order: number[] }` (the new array order, photos identified by stable index) |
| POST | `/api/capture/delete-photo` | unchanged | `{ token, index }` (stable photo id) → `{ ok, totalPhotos }` |
| POST | `/api/capture/finalize` | unchanged | `{ token }` → `{ ok, sessionId }` (fire-and-forget bundling) |
| POST | `/api/capture/discard` | unchanged | `{ sessionId, reason? }` → `{ ok }` |
| GET | `/api/capture/sessions` | preserved (deprecation) | → `CaptureSessionInfo[]` (kept one release for backcompat; modal uses SSE) |
| GET | `/api/capture/sessions/stream` | **new** | SSE: `session-list` (snapshot) + `session-event` (each mutation) + `heartbeat` (15 s) |
| POST | `/api/capture/extend` | **new** | `{ sessionId, byMs? }` → `{ ok, newExpiresAt }`. `byMs` defaults to **5 × 60 × 1_000** (5 minutes) when omitted; values must be positive finite numbers. |
| POST | `/api/capture/validate` | **new** | `{ sessionId }` → `{ ok, warnings?, blockers? }` (default rules: empty-session blocker; >50 photo + >80 MB warnings — workflows can register richer rules later) |
| GET | `/api/capture/registry` | **new** | → `{ [workflow]: { label, contextHints? } }` (frontend metadata only; finalize stays server-side) |
| GET | `/capture-assets/heic2any.min.js` | **new** | streams `node_modules/heic2any/dist/heic2any.min.js` so the phone-side polyfill works on air-gapped LANs (no CDN call). 502 if the package isn't installed. |

### SSE channel

`GET /api/capture/sessions/stream` opens a long-lived event stream per dashboard tab.

```
event: session-list           (on connect — snapshot)
data: { sessions: CaptureSessionInfo[] }

event: session-event          (every state mutation)
data: { sessionId, type, payload }

event: heartbeat              (every 15 s — keep-alive)
data: { ts }
```

The modal subscribes only when open. Right-rail multi-session view (deferred) reuses the same stream.

### TypeScript interfaces

```ts
// src/capture/registry.ts
export interface CaptureWorkflowRegistration {
  workflow: string;
  label: string;
  contextHints?: string[];
  finalize: (input: FinalizeInput) => Promise<FinalizeResult>;
  validate?: (input: ValidationInput) => Promise<ValidationResult>;
}

export interface FinalizeInput {
  sessionId: string;
  pdfPath: string;
  pdfOriginalName: string;
  contextHint?: string;
  trackerDir: string;
  uploadsDir: string;
  rosterDir: string;
}

export interface FinalizeResult {
  parentRunId?: string;
  followUpUrl?: string;
}

export interface ValidationInput {
  photoCount: number;
  totalBytes: number;
  contextHint?: string;
}

export interface ValidationResult {
  ok: boolean;
  warnings?: string[];
  blockers?: string[];   // non-empty → finalize disabled
}

// src/capture/sessions.ts (additions)
export interface PhotoSummary {
  index: number;
  filename: string;
  sizeBytes: number;
  mime: string;
  uploadedAt: number;
  blurScore?: number;
  blurFlagged?: boolean;
}

export interface CaptureSessionEvent {
  ts: number;
  sessionId: string;
  type: string;        // see JSONL event types above
  payload: Record<string, unknown>;
}

export interface CaptureSessionStore {
  // unchanged surface...
  appendEvent(event: CaptureSessionEvent): void;
  replay(events: CaptureSessionEvent[]): void;
  subscribe(fn: (event: CaptureSessionEvent) => void): () => void;
}
```

## Generic registry contract

The redesign's heart. Today the dispatcher in `dashboard.ts:538-566` switches on `session.workflow`. After: workflows declare their participation, the dispatcher reads the registry.

### Opt-in pattern

```ts
// src/workflows/oath-signature/index.ts
import { captureRegistry } from "../../capture/registry.js";
import { runPaperOathPrepare } from "./prepare.js";

captureRegistry.register({
  workflow: "oath-signature",
  label: "Capture paper roster",
  contextHints: ["Roster batch A", "Roster batch B"],
  finalize: async ({ sessionId, pdfPath, pdfOriginalName, trackerDir, uploadsDir, rosterDir }) => {
    const result = await runPaperOathPrepare({ pdfPath, pdfOriginalName, rosterDir, uploadsDir, trackerDir });
    return { parentRunId: result.parentRunId };
  },
  validate: async ({ photoCount }) => {
    if (photoCount === 0) return { ok: false, blockers: ["No photos captured."] };
    if (photoCount > 50) return { ok: true, warnings: [`${photoCount} photos — bundle may be large.`] };
    return { ok: true };
  },
});
```

Adding emergency-contact later (out of scope here) follows the same pattern.

### Where registration runs

Module-load side effect at the workflow's barrel file. Every workflow already imports its barrel during dashboard server boot (registry of metadata, schemas), so registration runs in the same import chain. No explicit "load all capture handlers" step.

### Generic finalize dispatch

```ts
// src/tracker/dashboard.ts
async function dispatchFinalize(session: CaptureSession, ctx: FinalizeCtx) {
  const reg = captureRegistry.get(session.workflow);
  if (!reg) {
    log.warn(`capture finalize: no workflow registered for "${session.workflow}"`);
    sessionStore.appendEvent({ type: "finalize_failed", sessionId: session.sessionId,
      payload: { error: `unregistered workflow: ${session.workflow}`, stage: "handler" } });
    return;
  }
  try {
    const result = await reg.finalize({
      sessionId: session.sessionId,
      pdfPath: session.pdfPath!,
      pdfOriginalName: session.pdfOriginalName,
      contextHint: session.contextHint,
      trackerDir: ctx.trackerDir,
      uploadsDir: ctx.uploadsDir,
      rosterDir: ctx.rosterDir,
    });
    sessionStore.appendEvent({
      type: "finalized", sessionId: session.sessionId,
      payload: { pdfPath: session.pdfPath, durationMs: ctx.durationMs,
                 finalizeHandlerOk: true, parentRunId: result.parentRunId },
    });
  } catch (err) {
    sessionStore.appendEvent({ type: "finalize_failed", sessionId: session.sessionId,
      payload: { error: String(err), stage: "handler" } });
  }
}
```

### TopBar gate

```tsx
// src/dashboard/components/TopBarCaptureButton.tsx
const reg = useCaptureRegistration(activeWorkflow);   // SWR-style: GET /api/capture/registry
return reg ? <Button onClick={openModal}>{reg.label}</Button> : null;
```

## UI design (structural)

### Modal — operator side (~720px wide, 2-column grid)

**Left column (~240px):**
- 200×200 QR
- LAN URL (monospace, copy button)
- Shortcode (e.g. `4F-2K`) for manual entry if QR scan fails
- "📡 Phone connected" pill (when phone has fetched manifest at least once)
- Action row: `[Finalize]` (primary, disabled if validate blockers) `[Discard]`
- Expiry timer (`14:32`) with `extend` link

**Right column (1fr):**
- Header: "Live photos · N · drag to reorder · ✕ to delete"
- 4-col thumbnail grid; SSE-driven; click thumbnail → full-size overlay
- Blur badge (⚠) inline on flagged photos, with outline ring
- "Awaiting…" placeholder tile when grid not full
- Validation banner (warnings yellow, blockers red) below grid

### Phone — capture page

**Sticky header:** workflow label + connection pill + auto-saved indicator

**Photo grid (2-col, full bleed):**
- Each tile shows: index badge, status indicator (✓ uploaded / ↗ uploading / ✕ failed), blur badge if flagged, retake button on long-press
- "+" tile at the end opens native camera

**Sticky footer:**
- Primary: `[📷 Take photo]`
- Secondary CTA: `[✓ Done · upload N]` (changes shape based on count + validate state)
- Helper text: "Long-press a photo for retake / mark blank / delete"

**Persistence:**
- localStorage stores `{ token, manifest: PhotoSummary[] }` keyed by `captureToken`
- On reload, hydrate from localStorage, then reconcile with `GET /api/capture/manifest/:token`
- HEIC inputs auto-convert to JPEG via `heic2any` before upload

### OathPreviewRow — minor adjustment only

The component itself is unchanged. The only edit is upstream: instead of `dashboard.ts` dynamically importing `runPaperOathPrepare`, the registry routes finalize → `oath-signature/index.ts`'s registered handler. Behavior identical.

### Visual style — deferred to ui-ux-pro-max

The next step in the user's three-skill chain handles palette, typography, motion, empty/loading/error/expired modal states, and QR styling. This spec defines structure, hierarchy, and interactions only.

## Error handling + recovery

| Scenario | Behavior |
|---|---|
| **Dashboard restart mid-capture** | Boot replay rebuilds open + finalizing sessions. Phone's next request finds session intact. Photos already on disk. |
| **`finalizing` sessions on boot** | Re-run bundle + finalize handler. `pdf_built` is idempotent (overwrites file). Workflow handlers required to be idempotent (already true for oath-signature). |
| **Phone goes offline mid-upload** | Mobile-side localStorage retains manifest + token. On reconnect, reconcile via `GET /api/capture/manifest/:token`. Pending photos retry with backoff. |
| **Operator clicks Discard while phone uploading** | Server returns 409 on subsequent uploads. Phone displays "Session closed by operator." |
| **Finalize handler throws** | `finalize_failed` event. Modal shows Retry / Discard. PDF + photos preserved. |
| **JSONL append fails (disk full)** | 503 on the route. State mutation rolled back. Operator sees error toast. |
| **Phone reload after dashboard restart** | Phone re-fetches manifest using cached token; if valid (or extend has been called), session resumes. If expired, "Session expired — start a new capture from the dashboard." |
| **Two phones scan same QR** | Both work — token isn't single-use. Append-only log preserves the audit trail; concurrency is rare in heavy-use solo-operator mode. |

## Testing strategy

| Layer | Tests | Status |
|---|---|---|
| `src/capture/sessions.ts` | Existing 7 unit tests pass unchanged (interface stable) | preserved |
| `src/capture/jsonl-store.ts` | Replay round-trip · expired sweep · file rotation · corrupt-line skip · disk-full append failure | new |
| `src/capture/registry.ts` | Register/unregister · get-by-workflow · dispatch-missing-handler · validate hook propagation · concurrent registration safety | new |
| `src/capture/blur-detect.ts` | Sharp / blurry / black / overexposed fixtures | new |
| `src/capture/sse.ts` | Subscribe replay · unsubscribe cleanup · heartbeat cadence · multi-tab fan-out | new |
| `src/capture/heic.ts` | HEIC → JPEG round-trip on JSDOM (skip in CI if heic2any size is prohibitive) | new |
| `src/capture/server.ts` | Update existing tests for new endpoints (extend, replace-photo, validate) | adjusted |
| `tests/integration/capture-restart.test.ts` | End-to-end: write events → kill server → restart → verify state | **new — regression guard for the consistency win** |
| `src/dashboard/components/CaptureModal.test.tsx` | SSE-driven state · blur banner display · validate-blockers disable Finalize | new |
| Manual QA recipe in `src/capture/CLAUDE.md` | Restart · phone reload · concurrent two-phone · HEIC iPhone | updated |

## Migration plan

Single-PR friendly. Order matters because each step keeps the green-build invariant.

1. **JSONL store + replay** — Add `JsonlBackedStore` alongside `MemoryStore`. Plumb through `createSessionStore` factory. Production switches to JSONL by default; tests retain memory-only.
2. **Registry** — Add `captureRegistry`. Move oath-signature dispatch into `oath-signature/index.ts`. Replace `makeCaptureFinalize` switch with generic dispatcher. Add `GET /api/capture/registry` route.
3. **TopBar gate** — Drop hard-coded oath check; read registry endpoint via SWR-style hook.
4. **SSE channel** — Add `/api/capture/sessions/stream`. Refactor `CaptureModal` to subscribe. The legacy `GET /api/capture/sessions` poll route stays for the duration of this PR's review window so reviewers can sanity-check diffs against the previous behavior; remove in the same merge or in an immediate follow-up.
5. **Modal redesign** — Wider 2-column layout, thumbnail tile component, blur badges, validate banner, extend control.
6. **Phone redesign** — Per-photo retake, drag-reorder, mark-blank, parallel uploads, localStorage manifest, blur detection, HEIC polyfill. Single HTML file (no build step) ~600 LOC.
7. **New endpoints** — `POST /api/capture/extend`, `POST /api/capture/replace-photo`, `POST /api/capture/validate`. Wire to store + registry.
8. **Finalize-failed retry** — Modal Retry button when state is `finalize_failed`. Re-runs registered handler.
9. **CLAUDE.md updates** — `src/capture/CLAUDE.md` — new state machine, JSONL schema, registry contract, manual QA recipe.
10. **Regression integration test** — End-to-end restart-recovery.

Tasks 1+2 are sequential (registry depends on store factory). 3-7 are independently parallelizable once 1+2 are done. 8-10 are last.

## Implementation dispatch (model + concurrency)

Per the user's stated execution preferences (memory: `feedback_execution_model_preferences.md`):

| Task | Model | Why |
|---|---|---|
| 1. JSONL store + replay | **Opus** | Persistence layer; correctness expensive to redesign |
| 2. Registry | **Opus** | Contract design; type ergonomics matter for adoption |
| 3. TopBar gate | Sonnet | Mechanical refactor |
| 4. SSE channel | **Opus** | Multiplexing; subscriber lifecycle correctness |
| 5. Modal redesign | Sonnet | Visuals from spec |
| 6. Phone redesign | Sonnet | Single HTML file from spec |
| 7. New endpoints | Sonnet | Mechanical |
| 8. Finalize-failed retry | Sonnet | Small UI + endpoint |
| 9. CLAUDE.md updates | Sonnet | Documentation |
| 10. Regression integration test | **Opus** | Easy to write tests that pass for the wrong reasons |

**Parallel dispatch:** tasks 1+2 sequential. After they land, tasks 3, 4, 5, 6, 7 dispatch as parallel subagents in a single message (no shared state). Tasks 8, 9, 10 dispatch as parallel subagents after the core lands.

Opus share: ~30% (tasks 1, 2, 4, 10). Sonnet share: ~70%.

## Contracts & invariants

Implementers must hold these invariants — every test in the suite encodes at least one of them.

- **Append-only**: `CaptureSessionEvent` records are never mutated, never deleted. State changes happen by appending a new event. Boot-replay reduction is the source of truth for in-memory state.
- **Workflow-handler idempotency**: any function registered as `finalize` must be idempotent. Boot replay re-runs handlers for sessions that were `finalizing` when the dashboard restarted; double-execution must be safe.
- **Token never echoed in SSE**: `CaptureSessionInfo` payloads pushed over SSE include `sessionId` but never `token`. Token leaves the server only in the response to `POST /api/capture/start` and lives only on the operator's screen + the phone's URL.
- **Validate before Finalize**: the modal must call `POST /api/capture/validate` and respect blockers. The Finalize button is *visually* disabled when blockers exist; the server *also* re-runs validate on the finalize path as a defense-in-depth check.
- **Phone-side blur is heuristic, not authoritative**: the `blurFlagged` field is a UX hint. A blurred photo can still be uploaded and bundled — the operator decides. Server never rejects on blur.
- **Registration is idempotent**: `captureRegistry.register({ workflow, ... })` for an already-registered workflow replaces the prior registration. No throw. (Hot-reload safety.)
- **No cross-session token reuse**: a token is bound to exactly one `sessionId`. Tokens are 16-char base64url (96-bit entropy) — collision risk is practically zero for the scale we operate at.

## Out of scope / deferred (explicitly)

- Multi-operator concurrent capture UX
- Generalizing OathPreviewRow into `<PreviewRow>` framework
- getUserMedia document-scanner viewfinder
- SQLite or other new persistence dependencies
- Right-rail multi-session dashboard surface
- Stepper / wizard modal flow
- Server-side blur re-check (phone-side detection is enough; can add later if false-positive rate is high)
- OCR pipeline (sister emergency-contact session owns this)
- Telegram bot integration (separate feature; not part of capture)
- Visual style polish (palette, typography, motion) — handed to ui-ux-pro-max next
- ESLint rule for inline selectors (orthogonal; existing test guard suffices)
