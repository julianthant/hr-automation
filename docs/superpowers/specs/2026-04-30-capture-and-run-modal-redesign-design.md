# Capture + Run Modal redesign — visual + interaction spec

**Date:** 2026-04-30
**Surfaces:** `src/dashboard/components/CaptureModal.tsx` · `src/dashboard/components/RunModal.tsx` · `src/capture/mobile.html`
**One-line:** Adopt a single "Editorial Calm" visual system across all three capture surfaces — dark, hairline-organized, no chromatic accents, outlined CTAs, 4-column action rhythm.

---

## 1. Goals

1. **Professional, minimalistic look** across the three capture-flow surfaces (operator-side capture modal, operator-side PDF upload modal, phone-side capture page).
2. **One visual system** — the three surfaces should read as one product. Tokens, type scale, accent strategy, and motion language all match.
3. **Match the rest of the dashboard's dark theme** without re-introducing the warm-brown `--capture-*` palette as a separate world. The new system collapses into the same neutral dark grayscale used by the rest of the app.
4. **Carry forward** every existing state and interaction. No regressions in capability — only visual + layout changes.

## 2. Visual system — "Editorial Calm" (C)

The chosen direction (referred to as "C" in brainstorming). Defining traits:

| Property | Value |
|---|---|
| Background | `#0e0e10` modal surface, `#050507` page-level shadow, `#131316` raised field |
| Border | `#232325` (hairline, default), `#2c2c2e` (subtle), `#4a4a4c` (CTA outline), `#6a6a6c` (primary CTA outline brighter) |
| Foreground | `#f5f5f7` primary, `#d0d0d3` body, `#c8c8cb` secondary, `#8a8a8c` muted, `#6e6e72` faint |
| Type | Inter (sans), JetBrains Mono (mono); titles `15px / 400 weight / -0.005em letter-spacing`; body `12px`; micro-labels all-caps `9.5px / 0.10em letter-spacing` |
| Dividers | Hairline `1px solid #232325` (no shadows, no bg-tint to separate sections) |
| CTAs | Outlined only — no filled green primary. Primary = brighter outline (`#4a4a4c`–`#6a6a6c`). Ghost = subtle outline (`#232325`). Disabled = faint outline (`#232325`) and faint text (`#4a4a4c`) |
| Accents | None for "good" states. Warm hairline outline (`#d4a64a`) for blurry/warning. Error states keep a single hairline border in the muted error tone (no filled background banners). |

**Removed from the previous design:**

- The separate `--capture-*` warm-brown palette (deprecated; tokens consolidate to neutral grayscale).
- Filled green success disc on phone "Sent" screen → outlined tick.
- Tinted background pills for status (`bg-success-bg + colored text`) → plain text + `●` mono dot.
- Filled green primary CTA on phone footer → outlined.
- 4-deep `.or()` selector-style accent rails (top of capture modal, animated colored rails per state) → single hairline divider under the header, no animated rail.

## 3. Operator-side capture modal — `CaptureModal.tsx`

### 3.1 Layout

**Width:** `max-width: 760px` (was 760px — preserved)
**Padding:** `36px 38px 26px` (was `p-0` with `pt-3`)
**Layout:** horizontal — QR + URL on the left, status + photos + actions on the right.

```
┌─────────────────────────────────────────────────────────────┐
│ Capture session                              emergency-contact │ ← header
│ Scan the QR with your phone, capture pages, then tap Done.    │   (sub max-width 360px)
├─────────────────────────────────────────────────────────────┤   ← hairline
│                                                                │
│  ┌──────┐    STATUS                                            │
│  │ QR   │    ● Phone connected — 3 photos received             │
│  │      │                                                      │
│  └──────┘    LIVE PHOTOS · 3                                   │
│   X9·Q4K     ┌──┐ ┌──┐ ┌──┐ ┌╶╶┐                              │
│              │  │ │  │ │  │ │  │                              │
│  URL         └──┘ └──┘ └──┘ └╶╶┘                              │
│  ──────                                                        │
│  capture.local/X9Q4K2M     copy                                │
│                                                                │
│  [        Finalize             ] [ Discard ]    ← 4-col grid │
│                                                                │
├─────────────────────────────────────────────────────────────┤   ← hairline
│ 04:32 remaining                                       Extend │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Header

- Two-column: `grid-template-columns: minmax(0, 1fr) auto`.
- **Left** ("title block"): `max-width: 360px` so subtext wraps short.
  - Title: `Capture session` · 15px / 400 / -0.005em.
  - Sub: `Scan the QR with your phone, capture pages, then tap Done.` · 12px / muted.
- **Right** ("workflow tag"): `emergency-contact` (or whatever workflow is active) — JetBrains Mono · 11px · `#6e6e72` · `padding-top: 5px` to baseline-align. `white-space: nowrap`.
- Hairline divider below the header.

### 3.3 Body — left column (192px)

- **QR code:** 192×192px, white background, 14px padding, 10px border-radius. Generated server-side (existing).
- **Shortcode:** below QR, JetBrains Mono / 28px / 300 weight / 0.14em letter-spacing / `#f5f5f7`. Center-aligned. Format: `X9·Q4K`.
- **URL row:**
  - All-caps micro-label `URL` (centered above the field, 9.5px / 0.10em).
  - Field: hairline `border-bottom: 1px solid #232325`, 8px vertical padding, no background, no box. Mono URL on the left flexing, "Copy" link on the right (`#8a8a8c`, 10px).

### 3.4 Body — right column

- **Status section:**
  - Micro-label `STATUS`.
  - Status row: `●` (5px dot, `#c8c8cb`) + text "Phone connected — 3 photos received" · 12px / `#c8c8cb`. No background, no border. The dot is grayscale; we communicate state with text content, not color.

- **Photos section:**
  - Micro-label `LIVE PHOTOS · {count}`.
  - 4-column grid, 3:4 tile aspect ratio, 5px border-radius, `gap: 10px`.
  - Filled tile: `linear-gradient(135deg, #181819 0%, #131314 100%)`.
  - Placeholder tile (next pending slot): `1px solid #232325` (hairline), transparent background.
  - **No** index-number badge (the desktop view is observation-only; the phone owns ordering UI).
  - Blurry photos: `outline: 1px solid #d4a64a` (warm), no overlay tint.
  - Click → existing lightbox (unchanged).

- **Actions row:** 4-column grid mirrors the photo grid above it.
  - `Finalize` — primary button, `grid-column: span 3` (left).
  - `Discard` — ghost button, `grid-column: span 1` (right).
  - Primary button: `transparent bg`, `1px solid #4a4a4c`, `#f5f5f7` text, `12.5px / 500`, `padding: 10px 14px`, `border-radius: 7px`. Disabled: `border-color #232325`, `color #4a4a4c`.
  - Ghost: same shape, `border #232325`, `color #8a8a8c`.
  - Aligned vertically — every line in the right column lands on the same 4-column rhythm.

### 3.5 Footer — expiry

- Hairline above (`border-top: 1px solid #232325; padding-top: 14px`).
- Layout: `display: flex; justify-content: space-between`.
- Left: `04:32 remaining` (mono numerals, `#c8c8cb`; "remaining" in `#8a8a8c`).
- Right: `Extend` (link-style, `#c8c8cb`, no underline default, underlines on hover).
- Critical-time animation: when `<10s`, the timer color shifts to `#d4a64a` only; no shake or pulse.

### 3.6 State coverage

The state machine itself is unchanged (`starting | error | open | finalizing | finalized | finalize_failed | expired | discarded`). Visual treatment per state:

| State | Header | Right column | Action row | Footer |
|---|---|---|---|---|
| `starting` | unchanged | spinner (32px, `border-top-color: #d0d0d3`) + "Generating QR code…" | hidden | hidden |
| `error` | unchanged | hairline-bordered alert: `1px solid #232325`, mono error text + "Close" outlined button | hidden | hidden |
| `open` | unchanged | photo grid + status row | Finalize (3) + Discard (1) | timer + Extend |
| `finalizing` | unchanged | grid stays visible (faded to 60% opacity) | replaced by progress bar (1.5px tall hairline `#d4a64a`) | hidden |
| `finalized` | unchanged | grid stays visible | replaced by hairline-bordered "Done · sent to handler / Closing automatically…" | hidden |
| `finalize_failed` | unchanged | grid + "Couldn't send to handler" mono text | "Retry handoff" primary + Discard ghost | hidden |
| `expired` | unchanged | grid (50% opacity) + "Session expired" muted text | single "Close" primary spanning full width | hidden |
| `discarded` | unchanged | "Session discarded" muted text | single "Close" primary spanning full width | hidden |

The previous animated-color top accent rail is removed for every state.

## 4. Operator-side run modal — `RunModal.tsx`

### 4.1 Layout

**Width:** `max-width: 640px`.
**Padding:** `36px 38px 26px`.
**Header pattern:** identical to capture modal — title-block max-width 360px, workflow tag `emergency-contact` mono on the right.

```
┌──────────────────────────────────────────────────────┐
│ Run Emergency Contact                emergency-contact│
│ Upload a scanned PDF. We'll OCR it, match against...  │
├──────────────────────────────────────────────────────┤
│                                                       │
│  PDF                                                  │
│  ┌─────────────────────────────────────────────┐     │ ← dropzone or
│  │  ⬆  Drag PDF here, or click to browse        │     │   file row
│  │     PDF only · max 50 MB                     │     │
│  └─────────────────────────────────────────────┘     │
│                                                       │
│  ROSTER                                               │
│  ○ Use latest roster                                  │
│    Latest: ONBOARDING_ROSTER.xlsx · 2.4 MB           │
│  ─────                                                │
│  ○ Download fresh from SharePoint                     │
│    Adds ~20s but guarantees current data.            │
│                                                       │
├──────────────────────────────────────────────────────┤
│ [        Run                    ] [ Cancel ]          │
└──────────────────────────────────────────────────────┘
```

### 4.2 Dropzone (empty state)

- Hairline-dashed border: `1px dashed #2c2c2e`.
- Padding `38px 24px`. No background. Hover: `border-color #3a3a3c` + `background #131316`.
- Icon: 38px circle outline, `1px solid #2c2c2e`, lucide `upload-cloud` glyph centered (`#8a8a8c`).
- Primary text: `Drag PDF here, or click to browse` · 13px / `#d0d0d3` / 400.
- Meta: `PDF only · max 50 MB` · 10.5px / mono / `#6e6e72`.

### 4.3 File row (after pick)

- Replaces the dropzone in-place.
- `1px solid #2c2c2e` border, `border-radius: 10px`, `background #131316`, `padding 14px 16px`.
- Layout: `[icon-square 32×32]  [name + size]  [× remove]`.
- Icon: `1px solid #2c2c2e` rounded square, lucide `file-text` glyph.
- Name: 13px / `#f5f5f7` (truncates with ellipsis).
- Size: 10.5px / mono / `#6e6e72` — format: `3.2 MB · 12 pages` (page-count is best-effort; falls back to `3.2 MB` when unknown).
- Remove button: 28×28px ghost square, `×` glyph, hover bg `#1c1c1f`.

### 4.4 Upload progress (replaces file row during upload)

- Same outer container shape as the file row.
- File name + percentage on top row (`13px / mono` percentage on right).
- Hairline progress bar: 1.5px tall, `background #232325`, fill `#d0d0d3`, animates linearly.
- Aria-live status text: `Uploading 1.6 MB of 3.2 MB…`.

### 4.5 Roster picker

- Replaces the previous boxed shadcn radio look.
- Block layout: micro-label `ROSTER` then two `roster-row`s separated by hairlines.
- Row: 12px vertical padding, hover bg `#131316`, checked bg `#131316`.
- Radio: 14px circle, `1px solid #4a4a4c`. Checked → inner 6px disc `#f5f5f7`.
- Label: 12.5px / `#d0d0d3`. Hint (mono / 10.5px / `#6e6e72`): roster filename or "Adds ~20s but guarantees current data."
- Disabled state: 50% opacity, hint reads "No roster on disk — pick the other option to fetch one."

### 4.6 Action row

- Hairline divider above (`padding-top: 14px`).
- 4-column grid: `Run` primary spans 3 cols (left), `Cancel` ghost spans 1 col (right).
- Same button tokens as capture modal.
- `Run` disabled when no file selected (`border-color: #232325; color: #4a4a4c`).
- During submit: `Run` shows lucide `loader-2` spin glyph + `Uploading…` or `Starting…`.

### 4.7 Error banner

- When set, replaces nothing — appears between roster picker and action row.
- Hairline-bordered alert: `1px solid #232325`, no filled background. Optional left-only `border-left: 2px solid #d4a64a` for warnings or `2px solid #6a6a6c` for plain errors.
- 13px / `#d0d0d3` text. lucide `alert-circle` glyph (`#d4a64a` for warn, `#8a8a8c` for plain).

## 5. Phone-side — `mobile.html`

### 5.1 Header

- Two-column: `grid-template-columns: 1fr auto`.
- **Left:**
  - Title: `Capture` · 17px / 400 / `#f5f5f7`.
  - Subtext: `{N} photos` (mono caps · 10px · `#8a8a8c`). Live-updates with the photo count.
  - **Workflow tag is removed entirely** from the phone view — the operator already knows what they queued; the phone shouldn't re-state it.
- **Right:**
  - Connection pill: `●` 5px dot + `connected` (mono caps · 10px · `#c8c8cb`). The dot is grayscale.
  - Disconnected variants: `connected` → `reconnecting…` / `expired` / `closed by operator` / `sent`. Dot stays grayscale; reconnecting animates opacity 35→100% blink.
- Hairline divider below the header.

### 5.2 Empty state (no photos yet)

- Centered panel:
  - 56px circle outline (`1px solid #2c2c2e`) with lucide `camera` glyph (`#6e6e72`).
  - Heading: `Add the first photo` · 14px / `#d0d0d3`.
  - Sub: `Take pages with your camera, or pick existing scans from your photo library.` · 11.5px / `#8a8a8c` / max-width 200px / centered.
- Footer: same Camera + Gallery buttons (Done disabled).

### 5.3 Photo grid

- 2 columns. Tiles: 3:4 aspect, 6px border-radius, no border. Background: same vertical gradient as desktop.
- **Per-tile elements:**
  - Bottom-left mono number (`1`, `2`, …) — 11px / `#c8c8cb`.
  - Bottom-right status text (only when non-default): `pending`, `failed`, `converting`, `blurry` — 9px caps / `#8a8a8c`.
  - **Blank** state: white tile + centered uppercase `BLANK PAGE` (9px / `#6e6e72`).
  - **Blurry** state: `outline: 1px solid #d4a64a; outline-offset: -1px` + `blurry` mono caps label.
  - **Pending** state: opacity 0.55.
- Add tile: dashed `1px dashed #2c2c2e`, transparent, `+` (24px / 200 weight) + `add` (9px caps).
- The previous filled-color status badges (filled green "uploaded", filled orange "blur", filled red "failed") are removed in favor of the muted text + outline approach.

### 5.4 Footer

- Sticky bottom, hairline divider above, `padding: 12px 16px 18px`.
- Two stacked rows:
  1. `[ Camera ] [ Gallery ]` — 2-column grid with 8px gap. Both ghost-outlined buttons.
  2. `[       Done       ]` — full-width primary button (brighter outline).
- All three buttons are the **same size**: `padding: 9px 12px`, `font-size: 12px`, `font-weight: 500`, `border-radius: 8px`. Done's primary status comes from a brighter border (`#6a6a6c`), not extra padding.
- Done is disabled (`border-color: #232325; color: #4a4a4c`) when there are no photos or when `state !== "open"`.
- The previous persistent helper-text "Long-press a photo for retake · mark blank · delete" is removed. The long-press gesture itself stays. (Tooltip-style first-time onboarding can be added later if needed; out of scope.)

### 5.5 File-input wiring

- Camera button: `<input type="file" accept="image/*,image/heic,image/heif" capture="environment">` (existing).
- Gallery button: `<input type="file" accept="image/*,image/heic,image/heif">` — **no `capture` attribute** so iOS Safari shows the "Photo Library" picker. Chrome Android shows the Files picker.
- Both inputs are visually hidden (existing `position: absolute; left: -9999px`); buttons act as `<label>` for them.
- Both inputs feed the same `addPhotos(files)` upload pipeline that the existing single input feeds.

### 5.6 Finalizing state

- Replaces the photo grid with a centered panel:
  - 38px spinner (`1.5px solid #232325; border-top-color: #d0d0d3; spin 1.1s linear`).
  - Label: `Bundling photos…` · 13px / `#d0d0d3`.
  - Sub: `Sending {N} pages to your laptop. Hang tight.` · 11px / `#6e6e72` / max-width 200px / centered.
- Footer is hidden during finalizing.

### 5.7 Sent state (`finalized`)

- Replaces the photo grid with a centered panel:
  - 56px circle outline (`1px solid #4a4a4c`) with lucide `check` glyph (24px / `#f5f5f7`).
  - Heading: `Sent for processing` · 17px / 400.
  - Sub: `Your laptop has the photos. You can close this tab.` · 11.5px / `#8a8a8c`.
- Connection pill flips to `sent` (grayscale).
- Footer is hidden.
- The previous bouncy `pop` animation on a filled green disc is replaced with a gentle fade-in (200ms ease).

### 5.8 Action sheet (long-press menu)

- Visual treatment matches the C system: solid `#0e0e10` modal bg, `1px solid #232325`, hairline rows separating actions.
- Actions unchanged: Retake / Replace with blank page / Delete (danger). Each row 56px tall, 16px font.
- The "danger" delete row keeps a single muted red text color (`#d4544a`), no filled background.
- Cancel button: standalone row at the bottom, same height, `font-weight: 700`.

### 5.9 Banner (errors / session closed)

- Same hairline-bordered banner pattern as the desktop:
  - `1px solid #232325`, no filled background.
  - Optional `border-left: 2px solid #d4a64a` (warn) or `#d4544a` (error).
  - 14px text / `#d0d0d3`.

## 6. Token consolidation

The existing `--capture-*` palette in `src/dashboard/index.css` and the `:root` block in `src/capture/mobile.html` are retained as a transitional layer but their values shift to the new neutral grayscale. Mapping:

| Old token | New value |
|---|---|
| `--capture-bg-modal` | `hsl(240 4% 7%)` (≈ `#0e0e10`) |
| `--capture-bg-raised` | `hsl(240 4% 9%)` (≈ `#131316`) |
| `--capture-bg-raised-hi` | `hsl(240 4% 12%)` (≈ `#1c1c1f`) |
| `--capture-border-strong` | `hsl(240 4% 18%)` (≈ `#2c2c2e`) |
| `--capture-border-subtle` | `hsl(240 3% 14%)` (≈ `#232325`) |
| `--capture-fg-primary` | `hsl(240 5% 96%)` (≈ `#f5f5f7`) |
| `--capture-fg-secondary` | `hsl(240 4% 80%)` (≈ `#c8c8cb`) |
| `--capture-fg-muted` | `hsl(240 4% 54%)` (≈ `#8a8a8c`) |
| `--capture-fg-faint` | `hsl(240 4% 44%)` (≈ `#6e6e72`) |
| `--capture-success` (green) | **deleted** — primary-CTA outline uses `--capture-fg-primary` and a brighter border `#6a6a6c` |
| `--capture-success-bg`, `--capture-success-fg` | **deleted** — status pills are gone |
| `--capture-warn` | `hsl(38 50% 56%)` (≈ `#d4a64a`) — kept, only used as a hairline outline color |
| `--capture-warn-bg`, `--capture-warn-fg` | **deleted** |
| `--capture-error` | `hsl(0 50% 56%)` (≈ `#d4544a`) — kept, only used as muted text color and a hairline `border-left` |
| `--capture-error-bg`, `--capture-error-fg` | **deleted** |
| `--capture-glow-success` | **deleted** — no glows in C |
| `--cap-ease-*` | retained (motion language unchanged) |

## 7. What stays unchanged

- Backend SSE wiring (`useCaptureSession`, the registration → upload → finalize flow, expiry/extend).
- All API routes (`/api/capture/start`, `/api/capture/upload`, `/api/capture/finalize`, `/api/capture/discard`, `/api/capture/extend`, `/api/capture/delete-photo`, `/api/capture/manifest/:token`).
- The state machine in `src/capture/sessions.ts`.
- File-input model, HEIC handling, manifest persistence.
- `useSharePointDownload` hook in `RunModal`.
- `/api/emergency-contact/prepare` multipart endpoint.
- Existing localStorage-based manifest persistence in mobile.html.
- Existing long-press gesture timing (700ms) and the action-sheet behavior.

## 8. Out of scope (deferred)

- Light-mode token variants. The whole dashboard is dark-only; if light mode lands later, this spec gets a counterpart palette.
- Tablet-specific phone view variations.
- First-time-only onboarding tooltips replacing the persistent long-press helper text.
- Animations beyond the existing `cap-ease-smooth/enter/bounce` set. No new motion is being added.
- Internationalization of strings (English-only; existing string-shape preserved).
- Replacement of the `--capture-*` token names with a unified namespace (e.g. `--surface-*`). Names stay; values change. Renaming is a separate refactor.

## 9. Files touched (summary)

| File | Change |
|---|---|
| `src/dashboard/components/CaptureModal.tsx` | Rewrite layout per §3. Remove animated accent rail, status pills, glow utilities. Replace `LeftColumn`/`RightColumn` body with the new horizontal grid + 4-col actions. |
| `src/dashboard/components/CapturePhotoTile.tsx` | Adjust to remove filled status badges; mono number + caps status text only. Keep the existing arrived-bounce animation primitives. |
| `src/dashboard/components/RunModal.tsx` | Rewrite per §4. Replace `RosterOption` with the hairline `roster-row` shape. Drop the shadcn radio component look. |
| `src/dashboard/index.css` | Update `--capture-*` token values per §6. Delete unused tokens. Drop accent-rail keyframes. |
| `src/capture/mobile.html` | Restyle per §5. Add the second `<input type=file>` for Gallery (no `capture` attribute). Wire both labels through `addPhotos`. Remove substrip. Reposition photo count to header subtext. Drop persistent long-press helper. |
| `tests/unit/dashboard/CaptureModal.test.tsx` (if exists) | Update fixture screenshots / assertions targeting layout / state classes. |

## 10. Acceptance criteria

A reviewer should be able to verify:

1. **Both desktop modals render in C theme** — no green CTAs, no warm-brown bg, all dividers are 1px hairlines.
2. **Header pattern matches across both modals** — title-block max-width 360px, workflow tag `emergency-contact` mono on the right with one clean line.
3. **Action row 4-col rhythm holds** — Finalize/Run primary spans 3 cols, Discard/Cancel ghost spans 1 col, both align to the photo grid above (capture only).
4. **CaptureModal photo grid scales** — at 12 photos, 3 rows × 4 cols, no clipping, action row stays anchored.
5. **RunModal dropzone → file-row → progress** flow uses the same outer container shape (no layout shift).
6. **Phone header** shows "Capture / N photos" left, `● connected` right; no `emergency-contact` tag.
7. **Phone footer** shows Camera + Gallery side-by-side then Done full-width; all three buttons are the same size; Done's primary status is visible via outline brightness only.
8. **Phone Gallery button** opens the OS photo library on iOS (no camera) and the file picker on Android.
9. **Sent screen** shows an outlined tick (no filled green disc, no bouncy pop animation).
10. **Blurry photo** shows a thin warm hairline outline + tiny "blurry" caps label, not a filled orange overlay.
11. **No `--capture-success-*`, `--capture-warn-bg`, `--capture-error-bg`, or `--capture-glow-*` tokens are read anywhere in `src/`** after the migration.

## 11. Risks

- **Color reduction may make state changes harder to scan.** Mitigation: state changes always also change the textual content (`Phone connected → Bundling photos… → Sent`), and the warm hairline outline still flags blurry photos. Can be revisited if operators report missing the bright-green "good" feedback.
- **Mobile gallery upload + HEIC handling.** Some Android devices return URIs that the existing pipeline (which assumes a Blob) handles fine; iOS Safari returns a File for both inputs, so HEIC conversion uses the same `heic2any` polyfill path. Risk of unexpected MIME types from gallery picks (HEIC variants, very large images). Mitigation: keep the existing 50MB cap and the per-image polyfill chain unchanged.
- **The `--capture-*` tokens are read by other components.** Search before deleting any token — `mobile.html` and `CapturePhotoTile` both reference them.
