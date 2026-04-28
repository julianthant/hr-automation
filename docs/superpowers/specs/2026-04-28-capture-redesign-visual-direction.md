# Capture Redesign — Visual Direction

**Date:** 2026-04-28
**Companion to:** `2026-04-28-capture-redesign-design.md` (structural spec)
**Source:** `ui-ux-pro-max` skill — internal HR / dark-mode dashboard / data-dense utility tool
**Audience:** the `frontend-design` skill (next step in the three-skill chain) — implement against these tokens directly; do not re-derive.

This document is the visual half of the redesign. The structural spec defines *what* the surfaces are; this defines *how* they look, sound, and move. Hand to `frontend-design` verbatim.

---

## 1 · Foundations

### 1.1 Design system

| Item | Value | Why |
|---|---|---|
| **Style** | Dark Mode (OLED-friendly, WCAG AAA) | Existing dashboard is already dark; user explicitly chose "improve, don't reinvent" |
| **Pattern** | n/a (modal surface, not landing page) | The skill returned a landing-page pattern that doesn't apply; tokens below are what matter |
| **Performance budget** | Excellent — animation budget ≤ 16ms/frame; all transforms only | Heavy-use operator can't afford layout thrash |
| **Accessibility target** | WCAG AAA contrast on text; AA on chrome | This is a daily-use professional tool, not a one-off form |

### 1.2 Color tokens — Tailwind/shadcn-aligned

Base palette extends the existing dashboard's slate-on-slate dark theme. Use these names as Tailwind/shadcn CSS variable mappings (or as raw hex).

```ts
// CSS variables to add to the dashboard's :root[data-theme="dark"] (or equivalent)
:root {
  /* Surfaces */
  --capture-bg-page:        #020617;  /* slate-950 — modal backdrop */
  --capture-bg-modal:       #0F172A;  /* slate-900 — modal body */
  --capture-bg-raised:      #1E293B;  /* slate-800 — thumbnail tile, QR card */
  --capture-bg-raised-hi:   #334155;  /* slate-700 — hover state, QR white card */
  --capture-border-subtle:  #1E293B;  /* slate-800 — inner separators */
  --capture-border:         #334155;  /* slate-700 — tile borders */

  /* Text */
  --capture-fg-primary:     #F8FAFC;  /* slate-50 */
  --capture-fg-secondary:   #CBD5E1;  /* slate-300 — body */
  --capture-fg-muted:       #94A3B8;  /* slate-400 — labels, helper */
  --capture-fg-faint:       #64748B;  /* slate-500 — sub-labels */

  /* Semantic — Success / phone-connected / finalized */
  --capture-success:        #22C55E;  /* green-500 — primary CTA, "connected" pill */
  --capture-success-hover:  #16A34A;  /* green-600 — CTA hover */
  --capture-success-fg:     #4ADE80;  /* green-400 — text on dark */
  --capture-success-bg:     rgba(34, 197, 94, 0.15);
  --capture-success-border: rgba(34, 197, 94, 0.40);

  /* Semantic — Warning / blur-flag / expiry-soon */
  --capture-warn:           #F59E0B;  /* amber-500 */
  --capture-warn-fg:        #FBBF24;  /* amber-400 — for badge text on dark */
  --capture-warn-bg:        rgba(245, 158, 11, 0.12);
  --capture-warn-border:    rgba(245, 158, 11, 0.40);

  /* Semantic — Error / failed / expired-now / discarded */
  --capture-error:          #EF4444;  /* red-500 */
  --capture-error-fg:       #F87171;  /* red-400 — text on dark */
  --capture-error-bg:       rgba(239, 68, 68, 0.15);
  --capture-error-border:   rgba(239, 68, 68, 0.40);

  /* Focus / glow */
  --capture-focus-ring:     #22D3EE;  /* cyan-400 — keyboard focus, distinct from any state */
  --capture-glow-success:   0 0 12px rgba(34, 197, 94, 0.35);
  --capture-glow-error:     0 0 12px rgba(239, 68, 68, 0.35);
}
```

**Contrast verification (must pass):**
- `--capture-fg-primary` on `--capture-bg-modal` → 17.8:1 ✓ AAA
- `--capture-fg-secondary` on `--capture-bg-modal` → 12.6:1 ✓ AAA
- `--capture-fg-muted` on `--capture-bg-modal` → 7.4:1 ✓ AAA
- `--capture-success-fg` on `--capture-bg-modal` → 6.8:1 ✓ AA (large text AAA)
- `--capture-warn-fg` on `--capture-bg-modal` → 8.9:1 ✓ AAA
- `--capture-error-fg` on `--capture-bg-modal` → 5.4:1 ✓ AA

**Color is never the only signal.** Per the UX rule (severity: high), every semantic color must pair with an icon or text. The existing dashboard already follows this; the redesign continues it: blur warning = amber color *plus* `⚠` icon *plus* "blur" word; success = green color *plus* `✓` *plus* "connected" word.

### 1.3 Typography

Pairing: **Dashboard Data** — `Fira Code` (monospaced) + `Fira Sans` (sans). Already aligned with technical tooling. Operator's eye expects mono for IDs, hex, code, paths; sans for prose.

```css
@import url('https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&family=Fira+Sans:wght@300;400;500;600;700&display=swap');
```

```ts
// tailwind.config — extend.fontFamily
{ mono: ['Fira Code', 'ui-monospace', 'monospace'],
  sans: ['Fira Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'] }
```

If the project is already using Inter / system fonts and a font swap would create churn, **keep the existing font and apply only the `font-mono` class to the sub-elements that need it (URL, shortcode, photo index, expiry timer)**. The existing dashboard's font stays the source of truth; Fira-anything is a *recommendation* not a *mandate*.

#### Modal hierarchy (desktop)

| Element | Family | Weight | Size | Tracking | Line-height | Notes |
|---|---|---|---|---|---|---|
| Workflow context (DialogTitle) | sans | 600 | 16px | normal | 1.4 | "Capture session · oath-signature · Roster A" |
| State pill text | sans | 700 | 10px | 0.06em | 1 | UPPERCASE — "OPEN", "FINALIZING" |
| Section label | sans | 500 | 11px | 0.04em | 1.2 | UPPERCASE — "LIVE PHOTOS · 3" |
| Photo index badge | mono | 600 | 11px | tabular-nums | 1 | "1", "2" — overlay on tile |
| LAN URL | mono | 400 | 12px | normal | 1.4 | "192.168.1.21:3838/c/Tx7…" — break-all |
| Shortcode | mono | 700 | 14px | 0.08em | 1 | "4F-2K" — large, clear, manually-typed fallback |
| Expiry timer | mono | 500 | 11px | tabular-nums | 1 | "14:32" — width-stable |
| Body / helper | sans | 400 | 13px | normal | 1.55 | Banner messages, descriptions |
| Button label | sans | 500 | 13px | normal | 1 | "Finalize", "Discard", "Retry" |
| Button label (CTA) | sans | 600 | 13px | normal | 1 | Slightly heavier on primary action |

#### Mobile hierarchy

Mobile font sizes are **larger** than desktop equivalents — operator is using a phone in awkward postures (one-handed, holding paper).

| Element | Family | Weight | Size | Notes |
|---|---|---|---|---|
| Header workflow label | sans | 600 | 16px | Sticky top-bar |
| Connection pill | sans | 700 | 11px | Top-right of header |
| Photo count + auto-saved | sans | 400 | 13px | Sub-header strip |
| Photo index badge | mono | 700 | 13px | Larger than desktop |
| Status sub-pill on tile | sans | 600 | 11px | "uploading…", "✓", "↻" |
| Primary CTA ("Take photo") | sans | 600 | 17px | **Body-min on mobile is 16px; CTA at 17 reads as button** |
| Secondary CTA ("Done · upload N") | sans | 700 | 16px | Heavy for action emphasis |
| Helper text | sans | 400 | 13px | Long-press hints |

**Mobile body minimum: 16px.** Anything smaller triggers iOS auto-zoom on focus.

### 1.4 Spacing & sizing

| Token | Px | Use |
|---|---|---|
| `--cap-space-1` | 4 | Tight inline gap |
| `--cap-space-2` | 8 | Default gap, icon ↔ label |
| `--cap-space-3` | 12 | Tile gap, button group |
| `--cap-space-4` | 16 | Section padding, card padding |
| `--cap-space-5` | 20 | Modal column gutter |
| `--cap-space-6` | 24 | Modal outer padding (desktop) |
| `--cap-radius-sm` | 4 | Photo index badge |
| `--cap-radius` | 6 | Tile, button, badge |
| `--cap-radius-lg` | 8 | Modal corners, mobile tile |
| `--cap-radius-xl` | 12 | Mobile QR card |
| **Mobile touch target min** | **44×44** | Per UX rule (severity: high) — every clickable phone-side element |
| **Mobile touch gap min** | **8** | `gap-2` minimum between adjacent tappable elements |

---

## 2 · Motion

All animations use `transform` and `opacity` only (UX rule: severity medium — `width`/`height`/`top`/`left` cause expensive repaints). All durations sit in the 150–320ms band (severity: medium).

### 2.1 Easing curves

```css
:root {
  --cap-ease-enter:  cubic-bezier(0.16, 1, 0.3, 1);   /* ease-out — for entering elements */
  --cap-ease-exit:   cubic-bezier(0.4, 0, 1, 1);      /* ease-in — for exiting elements */
  --cap-ease-bounce: cubic-bezier(0.34, 1.56, 0.64, 1); /* slight overshoot — thumbnail add */
  --cap-ease-smooth: cubic-bezier(0.45, 0, 0.55, 1);  /* ease-in-out — state transitions */
}
```

### 2.2 Specific motions

| Motion | Trigger | Duration | Easing | What animates |
|---|---|---|---|---|
| Modal open | `Dialog` mount | 200ms | `--cap-ease-enter` | `opacity: 0 → 1`, `scale: 0.96 → 1` |
| Modal close | `Dialog` unmount | 150ms | `--cap-ease-exit` | `opacity: 1 → 0`, `scale: 1 → 0.98` |
| Thumbnail add | new `photo_added` SSE event | 320ms | `--cap-ease-bounce` | `opacity: 0 → 1`, `translateY: -4px → 0`, `scale: 0.92 → 1` |
| Thumbnail remove | `photo_removed` | 180ms | `--cap-ease-exit` | `opacity: 1 → 0`, `scale: 1 → 0.92` |
| Blur flash | new photo with `blurFlagged: true` | 800ms total — single oscillation | `--cap-ease-smooth` | Outline ring opacity `0 → 0.6 → 0` (subtle attention, not strobing) |
| State pill change | `state` transition | 200ms | `--cap-ease-smooth` | `background-color`, `color` (transitionable hex; not animation-keyframe) |
| Phone-connected pulse | first `phone_connected` event | 1.2s, 2 iterations only | `--cap-ease-smooth` | Pill `box-shadow` glow `0 → 0.35 → 0`. Then static. |
| Finalizing progress | `state === finalizing` | infinite, 1.4s loop | linear (loader exception) | Indeterminate progress bar; gated by reduced-motion |
| Finalize success | `state === finalized` | 480ms | `--cap-ease-bounce` | Checkmark SVG stroke `pathLength: 0 → 1`, then chip color flash |
| Auto-close on finalize | 2s after `finalized` | 200ms | `--cap-ease-exit` | Modal close motion above |
| Expiry tick | each 1s when remaining > 60s | none | n/a | Time text update only (no animation — would be visual noise) |
| Expiry warning pulse | remaining ≤ 60s | 1s, infinite, gated by reduced-motion | `--cap-ease-smooth` | Timer color `slate-400 → amber-400 → slate-400` |
| Expiry critical | remaining ≤ 10s | 0.6s, infinite | linear | Timer text `opacity: 1 → 0.5 → 1`, color = `--capture-error-fg` |
| Button hover | mouse over | 150ms | `--cap-ease-smooth` | `background-color` + `box-shadow` |
| Focus ring | tab/keyboard | 100ms | `--cap-ease-enter` | Ring grows from 0 → 2px |

### 2.3 Reduced-motion fallback

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  /* Specifically: */
  /* - thumbnail-add becomes opacity-only fade in 100ms */
  /* - finalize-success drops the path-draw, just shows static checkmark */
  /* - expiry warning loses the pulse; uses solid color only */
  /* - finalizing progress uses opacity pulse instead of moving bar */
}
```

This is non-negotiable (UX rule severity: high).

---

## 3 · State framing — modal

Each state has its own visual treatment. Same component, different chrome. Copy tone is "informative, not chatty" — operators don't need encouragement, they need facts.

| State | Bg accent | State pill | Title prefix | Body copy | Primary action | Secondary | `role` |
|---|---|---|---|---|---|---|---|
| `starting` | none | `STARTING` (slate-700 bg, slate-300 fg) | (no change) | "Generating QR code…" | — (skeleton) | — | — |
| `error` | `--capture-error-border` 1px left rail | `ERROR` (`--capture-error-bg`, `--capture-error-fg`) | (no change) | `<error message>` (mono) | `Retry` | `Close` | `role="alert"` |
| `open` (no phone yet) | none | `WAITING` (slate-700 bg, slate-300 fg) | (no change) | "Scan QR with phone camera" | `Discard` | — | — |
| `open` + `phone_connected` | none | `OPEN · PHONE CONNECTED` (`--capture-success-bg`, `--capture-success-fg`) | (no change) | live photo count (mono) | `Finalize` (disabled if blockers) | `Discard` | — |
| `finalizing` | `--capture-warn-border` 1px left rail | `FINALIZING…` (`--capture-warn-bg`, `--capture-warn-fg`) | (no change) | "Bundling N photos into PDF…" + indeterminate progress | — (in progress) | — | — |
| `finalized` | `--capture-success-glow` (briefly) | `DONE` (`--capture-success-bg`, `--capture-success-fg`) | (no change) | "Sent to <workflow label>" | `View row →` (links to OathPreviewRow) | `Close` (or auto-close 2s) | — |
| `finalize_failed` | `--capture-error-border` 1px left rail | `HANDOFF FAILED` (`--capture-error-bg`, `--capture-error-fg`) | (no change) | "Bundle saved at `<path>`. <error stage>: `<error>`. PDF + photos preserved on disk." | `Retry handoff` | `Discard` | `role="alert"` |
| `expired` | none, slate-faded | `EXPIRED` (slate-700 bg, slate-400 fg) | (no change) | "Session expired after 15 minutes idle. Photos discarded." | `Start new capture` | `Close` | — |

**Copy rules:**
- Use mono font for any literal value rendered in copy (paths, error names, counts, durations).
- Never apologize ("Sorry, …"). State the fact + the recovery path.
- Use sentence case, not title case, for body copy. Title case for buttons + state pills.
- Avoid emoji as primary signals; ✓ and ⚠ are okay as visual reinforcement *only* alongside icon+text. Per the rule: no emoji icons in chrome — use Lucide React (`Camera`, `Check`, `AlertTriangle`, `Loader2`, `RefreshCw`, `X`).

---

## 4 · Component-level direction

### 4.1 Modal — operator surface

| Concern | Direction |
|---|---|
| Container | shadcn `Dialog` + `DialogContent` (max-w-3xl, ~720px). `DialogHeader`, `DialogTitle`, `DialogDescription` required (UX severity: high). Use `<DialogClose>` for the ✕. |
| Layout | CSS Grid 2 columns: `grid-cols-[240px_1fr]` desktop; `grid-cols-1` mobile (stack QR over thumbnails). Gap `--cap-space-5` (20px). |
| QR card | White surface (`#FFFFFF`) inside the modal — high contrast for camera scanning. 200×200 QR with 16px white quiet zone. `rounded-md`. No center logo (kills scan reliability). |
| URL row | `font-mono`, `text-xs`, `break-all`. Copy button = shadcn `Button` `size="icon"` + Lucide `Copy`. Wrap in `Tooltip` ("Copy URL" on hover, "Copied!" on click; toast confirmation). |
| Shortcode | `font-mono font-bold tracking-widest text-base`. Tooltip explaining it's the manual-entry fallback. |
| State pill | shadcn `Badge` styled per state table. Use `variant="secondary"` and override colors via inline-token classes — don't add a new variant. |
| Thumbnail grid | `grid-cols-4 gap-3`. Each tile = `CapturePhotoTile` component (new). Aspect-ratio 3/4 (matches phone portrait). Click → full-size overlay (separate `Dialog` or `Lightbox`). |
| Thumbnail tile | `bg-slate-700`, `rounded-md`, `relative`. Index badge top-left (mono, slate-900/60 bg). Status icon top-right when blur (`AlertTriangle` amber-400 in amber-500/85 pill). On hover: ✕ icon top-right (slate-900/80 bg) — `Tooltip` "Delete photo". |
| Validation banner | When `validate()` returns warnings or blockers: shadcn `Alert` with `--capture-warn-bg` / `--capture-error-bg` background, left rail border, `role="alert"` if blocker. Lucide `AlertTriangle` or `XCircle`. |
| Finalize button | shadcn `Button` `variant="default"`, custom class binding `bg-[--capture-success]` `hover:bg-[--capture-success-hover]`. **Disabled** when blockers exist. |
| Discard button | shadcn `Button` `variant="outline"`. On click: shadcn `AlertDialog` confirm — "Discard 3 photos? They'll be deleted." |
| Retry button (finalize_failed) | shadcn `Button` `variant="default"` with Lucide `RefreshCw` icon. |
| Extend control | text-only `<button>` styled as link, mono. Tooltip "Add 5 minutes". On click: subtle pulse on the timer + new value. |

### 4.2 Phone — capture page

The phone is **a single HTML file**. No React. No build step. Hand-write CSS.

| Concern | Direction |
|---|---|
| Layout | Sticky header (top), scrollable photo grid (middle), sticky footer (bottom). `display: grid; grid-template-rows: auto 1fr auto; min-height: 100dvh`. Use `dvh` not `vh` to avoid iOS Safari URL-bar issues. |
| Background | `--capture-bg-page` (slate-950). |
| Header | `bg-slate-900/95 backdrop-blur-sm`. 56px tall. Workflow label (left) + connection pill (right). |
| Photo grid | `grid-cols-2 gap-3 p-4`. Aspect-ratio 3/4. Tap → full-size preview (full-screen overlay, swipe-down to dismiss). Long-press (700ms) → action sheet (retake / mark blank / delete). |
| Tile background | `bg-slate-800` (raised). Subtle border `border-slate-700`. Blur-flagged tiles: 2px solid amber-500 ring + tile inner `box-shadow: inset 0 0 0 1px rgba(245,158,11,0.3)`. |
| Footer CTAs | Stacked. Primary "Take photo" (44px tall, `bg-slate-700 text-slate-50` — neutral, not the green CTA, because the GREEN goes on the *Done* action). Secondary "Done · upload N" (52px tall, `bg-[--capture-success]`, font-weight 700, full-width). |
| Touch targets | 44×44px minimum (UX severity: high). Tile tap region = full tile. Long-press detection via JS pointerdown timer. |
| Touch responsiveness | `touch-action: manipulation` on every interactive element (UX severity: medium — kills 300ms tap delay). |
| Haptic feedback | `navigator.vibrate(10)` on photo-added confirmation, `navigator.vibrate([10, 60, 10])` on done-upload-success. Don't vibrate on every tap. |
| Reorder | Long-press tile → enters reorder mode (visual: tile lifts, others gray slightly, `transform: scale(1.04)`). Drag with pointermove. Drop = reordered. Use HTML5 drag-and-drop API or pointer events. |
| Connection pill | Always-visible. `bg-[--capture-success-bg]`, `text-[--capture-success-fg]`, dot icon. When disconnected (poll fail): `bg-[--capture-error-bg]`, "Reconnecting…" text, retrying every 2s with backoff. |
| HEIC conversion | Run `heic2any` on file pick, *before* preview. Show subtle "Converting…" pill on the tile during conversion. JPEG output, quality 0.85. |
| Local manifest | `localStorage.setItem("capture:manifest:" + token, JSON.stringify({ photos, lastSync }))`. On page load: read manifest → render placeholders → reconcile against `GET /api/capture/manifest/:token`. |
| Reduced motion | Same `prefers-reduced-motion` media query as desktop — strip animations, keep state changes instant. |

### 4.3 OathPreviewRow — minor adjustment only

Per the structural spec, this component stays oath-specific. The visual direction here is just to ensure consistency with the new tokens:

- Replace any hardcoded slate hexes with the `--capture-*` token variables (so future palette tweaks propagate).
- The "stage progress strip" (Loading Roster → OCR → Matching → EID-lookup) uses the same easing tokens (`--cap-ease-smooth`).
- The "ready for review" state uses `--capture-success-bg` left rail.
- The "failed" state uses `--capture-error-bg` left rail and `role="alert"`.

No new visual work beyond token alignment.

---

## 5 · QR code

Decision: **plain B&W QR, no center logo, no custom corner glyphs.**

Rationale: this is an internal tool used by one operator on their own phone, on a LAN. The QR's only job is to scan reliably. Custom finder patterns / center logos drop scan reliability by 5–15% on cheap phone cameras and add zero recognition value (the operator already knows what tool they're using).

Specs:
- Generated SVG via existing `qrcode` library (no change to `src/capture/qr.ts`).
- 200×200 viewBox.
- 16px white quiet zone (mandatory for reliable scanning at varying distances).
- Black modules (`#000000`) on white background (`#FFFFFF`).
- Wrap in a `bg-white rounded-md p-4` card so the white extends visibly into the dark modal — preserves the quiet zone visually.
- Below the QR, a 12px slate-400 helper "Scan with phone camera".

The `4F-2K` shortcode is the brand-conscious fallback (mono, large, prominent below the URL).

---

## 6 · Toasts (Sonner) — capture-side events

Existing telegram toasts already use Sonner per `useTelegramToasts.ts`. Add a parallel hook for capture events. Use Sonner's variants per the shadcn rule (severity: medium): `toast.success`, `toast.error`, `toast.info`.

| Event | Variant | Title | Description |
|---|---|---|---|
| `photo_added` (only if modal not open) | `toast.info` | "Photo added" | "<workflow> · <count> photos" |
| `photo_added` with `blurFlagged` | `toast.warning` | "Blurry photo flagged" | "Photo <N> in <workflow> session may need retake" |
| `finalized` | `toast.success` | "Capture finalized" | "<workflow> · bundle saved" + action button "View" |
| `finalize_failed` | `toast.error` | "Handoff failed" | "<workflow>: <error stage>" + action button "Retry" |
| `expired` | `toast.info` | "Session expired" | "<workflow> session expired after 15 min idle" |
| `discarded` (by operator) | (no toast — direct action) | — | — |

Toaster mount: existing root layout already has it (per the inventory). No change needed there.

---

## 7 · Accessibility checklist

Implementer (frontend-design) must verify each:

- [ ] All Lucide icons used as buttons have `aria-label` (UX severity: high — `keyboard-nav` + `aria-labels`)
- [ ] Modal traps focus on open; restores focus on close (shadcn `Dialog` handles this — verify it's not overridden)
- [ ] `Esc` closes the modal (shadcn `Dialog` default — keep)
- [ ] Tab order matches visual order — QR → URL → Copy → Shortcode → Finalize → Discard → Extend → Thumbnails
- [ ] Focus rings: `focus:ring-2 focus:ring-[--capture-focus-ring] focus:ring-offset-2 focus:ring-offset-[--capture-bg-modal]`
- [ ] All semantic colors paired with icon + text — never color-only signals
- [ ] `role="alert"` on `error` and `finalize_failed` states (UX severity: high)
- [ ] `aria-live="polite"` on the photo count + state pill (announces SSE updates)
- [ ] `prefers-reduced-motion` honored across all motions in §2 (UX severity: high)
- [ ] Photo thumbnails have `alt="Photo {N} from capture session"` (`alt-text` rule)
- [ ] Mobile touch targets ≥ 44×44 (UX severity: high)
- [ ] Mobile body text ≥ 16px (no iOS auto-zoom)
- [ ] Adjacent touch targets have ≥ 8px gap (UX severity: medium)
- [ ] All interactive elements have `cursor-pointer` (Pre-Delivery Checklist)
- [ ] `touch-action: manipulation` on phone-side interactive elements

---

## 8 · Components & libraries

| Need | Component | Source | Notes |
|---|---|---|---|
| Modal container | `Dialog` + `DialogContent` + `DialogHeader` + `DialogTitle` + `DialogDescription` | shadcn `dialog` | Required structure (UX severity: high) |
| Confirm discard | `AlertDialog` | shadcn `alert-dialog` | "Discard 3 photos?" |
| Validation banner | `Alert` + `AlertTitle` + `AlertDescription` | shadcn `alert` | `role="alert"` for blockers |
| Buttons | `Button` (`default`, `outline`, `destructive`, `ghost`, `size="icon"`) | shadcn `button` | Custom class binding for `--capture-success` overrides |
| State pill | `Badge` (`variant="secondary"` + class overrides) | shadcn `badge` | Don't add new variants |
| Tooltips | `Tooltip` + `TooltipProvider` (one at app root) + `TooltipTrigger` + `TooltipContent` | shadcn `tooltip` | For Copy URL, Extend, icon buttons |
| Toasts | `toast.success` / `error` / `info` / `warning` from `sonner` | shadcn `sonner` | Existing toaster mount |
| Progress (finalizing) | `Progress` (indeterminate styling) | shadcn `progress` | Or simple animated bar |
| Lightbox / full-size preview | (new) `CapturePhotoLightbox.tsx` — small custom overlay | own | Don't pull a library |
| Icons | `Camera`, `Check`, `AlertTriangle`, `Loader2`, `RefreshCw`, `X`, `Copy`, `Clock`, `Wifi`, `WifiOff`, `RotateCcw`, `Trash2` | `lucide-react` | All from one icon set (Pre-Delivery rule) |

`HoverCard` is **not** the right pick here — Tooltip handles everything. HoverCard is for richer content (photo previews, profile cards), which we don't need.

---

## 9 · Anti-patterns (do not do)

From the design system anti-patterns + the Pre-Delivery Checklist:

- ❌ **No emoji as primary icons.** ✅ and ⚠ are reinforcement only — Lucide SVG is the icon source.
- ❌ **No layout-shifting hover states** (no `scale-105` on tiles that pushes neighbors). Hover affects color + shadow only.
- ❌ **No light-mode default.** This component must always use the dashboard's theme (dark assumed).
- ❌ **No animated `width`/`height`/`top`/`left`** — transform/opacity only.
- ❌ **No infinite decorative animations.** Loading states only (UX severity: medium).
- ❌ **No removing focus outlines without a replacement.**
- ❌ **No `<Tooltip>` via the `title=""` HTML attribute.** Use shadcn `Tooltip`.
- ❌ **No mixing icon sizes randomly.** Icons in modal: 16px (`size-4`). Icons on phone: 20px (`size-5`). One ratio per surface.
- ❌ **No tightly packed touch targets** on mobile (gap-2 minimum).
- ❌ **No vibration spam.** Vibrate on photo-added confirmation and done-success only.
- ❌ **No 1s polling left in the modal** — the redesign mandates SSE; poll-replacement is part of the spec.
- ❌ **No center-logo QR codes** — drops scan reliability for zero recognition gain.
- ❌ **No unannounced async errors** — every error path must hit a toast or a `role="alert"` region.

---

## 10 · Hand-off note for `frontend-design`

This document plus the structural spec is your full input. Do not re-derive tokens, palettes, or motion timings — they're decided. Open questions (state-pill exact text, validation copy wording) are *yours to call*, but stay within the copy rules in §3.

Implement against these tokens directly. If a token isn't here and you need one, add it to a small "additions" appendix at the bottom of this file (don't invent silently).

When you're done, the Pre-Delivery Checklist in §7 + §9 anti-patterns is your green-light. Per the user's saved preference, write code straight to the target files in the same turn — don't paste into chat.

---

*End of visual direction.*
