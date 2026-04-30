# Capture + Run Modal Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the three capture-flow surfaces (`CaptureModal.tsx`, `RunModal.tsx`, `mobile.html`) into one minimalist "Editorial Calm" visual system per `docs/superpowers/specs/2026-04-30-capture-and-run-modal-redesign-design.md`.

**Architecture:** This is a **visual + layout refactor** with no backend or contract changes. Three React/HTML surfaces share one CSS-token palette (in `src/dashboard/index.css` for the dashboard, inline tokens for `mobile.html`). We migrate token values first (so existing component code keeps compiling), then restructure each surface, then delete unused tokens at the end. Verification is by `npm run typecheck`, manual dev-server inspection, and a shell-level grep that no removed tokens are referenced.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, lucide-react icons, vanilla HTML/CSS/JS for the phone view.

---

## File Structure

| File | Role | Action |
|---|---|---|
| `src/dashboard/index.css` | CSS variables + `@keyframes` for capture surfaces | Update token values, delete deprecated tokens, drop unused keyframes |
| `src/dashboard/components/CaptureModal.tsx` | Operator-side capture modal (1305 LOC) | Restructure layout, swap pills/glows for hairlines, 4-col action rhythm |
| `src/dashboard/components/CapturePhotoTile.tsx` | Per-tile thumb (173 LOC) | Drop filled status badges, mono caps text only, hairline-warm outline for blur |
| `src/dashboard/components/RunModal.tsx` | Operator-side PDF upload modal (418 LOC) | Restructure layout, hairline roster rows, 4-col action rhythm |
| `src/capture/mobile.html` | Phone-side single-file page (1250 LOC) | New header, second `<input type=file>` for Gallery, compact equal-size buttons, drop substrip + persistent helper |

No new files. No tests added — visual work; verification is manual + the existing typecheck guard. The repo has no React testing harness and the spec explicitly does not mandate adding one.

---

## Conventions

- **Commit per task.** Granular history makes any visual regression easy to bisect.
- **Tokens migrate, then code migrates.** Keep `--capture-*` names; only values change. Components stay compiling between tasks.
- **No new packages.** All work is within existing deps.
- **Verify after each task.** Either typecheck (TS files), `node --check` (JS), or `git diff --stat` (HTML/CSS).
- **Spec is the source of truth.** When a step references "the spec," it means `docs/superpowers/specs/2026-04-30-capture-and-run-modal-redesign-design.md`.

---

## Task 1 — Migrate `--capture-*` token values to neutral grayscale

**Files:**
- Modify: `src/dashboard/index.css:264-310` (`:root` block holding `--capture-*` tokens)

**Why first:** Token values change but token names stay. Every component still compiles and renders, just with the new palette. This isolates the palette change from the layout changes that follow.

- [ ] **Step 1: Read the current token block to confirm line numbers**

Run: `sed -n '260,310p' src/dashboard/index.css`

Expected: lines 268–306 contain the `--capture-*` declarations as listed in §6 of the spec.

- [ ] **Step 2: Replace the token values**

Edit `src/dashboard/index.css`. Find the `--capture-*` block (currently lines ~268–306) and replace it with:

```css
  /* ── Capture surfaces — Editorial Calm system (2026-04-30) ───────
     Neutral dark grayscale. No chromatic accents for "good" states.
     Outlined CTAs only. Token names retained from the previous warm-
     brown palette so existing component code keeps compiling; values
     reset to the neutral system per docs/superpowers/specs/
     2026-04-30-capture-and-run-modal-redesign-design.md §6. */
  --capture-bg-page: hsl(240 4% 4%);          /* #050507 */
  --capture-bg-modal: hsl(240 4% 7%);         /* #0e0e10 */
  --capture-bg-raised: hsl(240 4% 9%);        /* #131316 */
  --capture-bg-raised-hi: hsl(240 4% 12%);    /* #1c1c1f */
  --capture-border-subtle: hsl(240 3% 14%);   /* #232325 */
  --capture-border-strong: hsl(240 4% 18%);   /* #2c2c2e */
  --capture-border-cta: hsl(240 4% 28%);      /* #4a4a4c — primary outline */
  --capture-border-cta-strong: hsl(240 4% 42%); /* #6a6a6c — primary outline (brighter) */

  --capture-fg-primary: hsl(240 5% 96%);      /* #f5f5f7 */
  --capture-fg-secondary: hsl(240 4% 80%);    /* #c8c8cb */
  --capture-fg-body: hsl(240 4% 82%);         /* #d0d0d3 */
  --capture-fg-muted: hsl(240 4% 54%);        /* #8a8a8c */
  --capture-fg-faint: hsl(240 4% 44%);        /* #6e6e72 */

  /* Warm + error reduced to muted single-color hairline use only.
     No -bg / -fg variants — backgrounds are no longer tinted. */
  --capture-warn: hsl(38 50% 56%);            /* #d4a64a */
  --capture-error: hsl(0 50% 56%);            /* #d4544a */

  --capture-focus-ring: hsl(240 4% 42%);      /* matches border-cta-strong */
```

The lines for `--capture-success*`, `--capture-success-hover`, `--capture-success-fg`, `--capture-success-bg`, `--capture-success-border`, `--capture-warn-fg`, `--capture-warn-bg`, `--capture-warn-border`, `--capture-error-fg`, `--capture-error-bg`, `--capture-error-border`, `--capture-glow-success`, and `--capture-glow-error` should all be removed. Also remove the `--cap-ease-*` lines if present in the same block — wait, those are motion tokens; keep them.

Verify the `--cap-ease-*` lines (typically `--cap-ease-enter`, `--cap-ease-bounce`, `--cap-ease-smooth`) are still present after the edit.

- [ ] **Step 3: Compile-check by running typecheck**

Run: `npm run typecheck`

Expected: PASS. (The CSS edit doesn't affect TS, but this confirms the previous state is clean before the next task references TS files.)

- [ ] **Step 4: Visual smoke check**

Start the dashboard: `npm run dashboard` in one terminal.

Open http://localhost:5173. The page should load with no console errors. Buttons / panels using `--capture-*` will look broken (green CTAs gone, tinted bg pills gone) — that's expected; fixing them is the next several tasks.

Stop the server.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/index.css
git commit -m "refactor(capture): swap --capture-* token values to neutral grayscale

Names retained so callers keep compiling; values reset to the Editorial
Calm system. -success-/-warn-bg/-error-bg/-glow- token variants removed
since they're no longer used after the redesign. Subsequent commits
remove the now-stale callers."
```

---

## Task 2 — Drop unused `@keyframes` and CSS classes for capture surfaces

**Files:**
- Modify: `src/dashboard/index.css:315-380` (animation + utility blocks)

**Why:** The new system has no glow, no animated accent rail, no filled-pill pulse, no shake. Strip them so future readers don't think they're still used. Keep the thumb-enter and the expiry-color animations — they're still useful in the new design.

- [ ] **Step 1: Locate the keyframe block**

Run: `sed -n '310,400p' src/dashboard/index.css`

Identify these to remove:
- `@keyframes capture-success-pop` (lines ~331–336)
- `@keyframes capture-connected-pulse` (lines ~326–330)
- `@keyframes capture-finalizing-bar` (lines ~337–342)
- `@keyframes capture-pulse-fallback` (lines ~353+)
- The `--capture-fg-error` / `--capture-error-fg` classname rule near line 379 if any references the deleted tokens

Keep:
- `@keyframes capture-thumb-enter`
- `@keyframes capture-blur-flash` (still used by tile when blur-flagged)
- `@keyframes capture-expiry-warn` and `@keyframes capture-expiry-critical`
- All `--cap-ease-*` motion tokens

- [ ] **Step 2: Read each keyframe block to confirm before deleting**

Run: `grep -n "@keyframes capture-\|capture-anim-" src/dashboard/index.css`

Expected output: list of the keyframes; we'll keep `capture-thumb-enter`, `capture-blur-flash`, `capture-expiry-warn`, `capture-expiry-critical`. Remove the rest.

- [ ] **Step 3: Delete the unused keyframes**

For each of `capture-success-pop`, `capture-connected-pulse`, `capture-finalizing-bar`, `capture-pulse-fallback`: use Edit to delete the `@keyframes capture-X { ... }` block including the closing brace.

For each of `.capture-anim-success-pop`, `.capture-anim-connected-pulse`, `.capture-anim-finalizing-bar`: use Edit to delete the class rule.

Search to confirm: `grep -n "capture-anim-" src/dashboard/index.css` — should leave only `capture-anim-thumb-enter`, `capture-anim-blur-flash`, `capture-anim-expiry-warn`, `capture-anim-expiry-critical`.

- [ ] **Step 4: Confirm no inline references will break**

Run: `grep -rn "capture-anim-success-pop\|capture-anim-connected-pulse\|capture-anim-finalizing-bar\|capture-anim-pulse-fallback" src/`

Expected: still some hits in `src/dashboard/components/CaptureModal.tsx` — that's expected; Task 3 removes them.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/index.css
git commit -m "refactor(capture): remove unused keyframes for deprecated visual states

Drop success-pop, connected-pulse, finalizing-bar, and pulse-fallback
keyframes + their class wrappers. The new Editorial Calm system uses
only the thumb-enter, blur-flash, and expiry color-shift animations."
```

---

## Task 3 — `CaptureModal.tsx`: replace `ModalChrome` with the new header pattern

**Files:**
- Modify: `src/dashboard/components/CaptureModal.tsx:466-510` (`ModalChrome` component) and the `DialogContent` `style` block at lines ~374–392.

**Why:** The header is the foundation pattern that the rest of the modal layout hangs from. Land this first.

- [ ] **Step 1: Replace the `ModalChrome` component body**

Find the existing `function ModalChrome(...)` block and replace it with:

```tsx
function ModalChrome({ state, workflow, workflowLabel, contextHint }: ModalChromeProps) {
  void state; // accent rail removed — state-driven color is gone
  const tag = contextHint ?? workflowLabel ?? workflow;
  return (
    <DialogHeader className="grid gap-3 px-[38px] pt-[36px] pb-0">
      <div
        className="grid items-start gap-6"
        style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}
      >
        <div className="flex flex-col gap-1.5" style={{ maxWidth: 360 }}>
          <DialogTitle
            className="text-[15px] font-normal tracking-[-0.005em]"
            style={{ color: "var(--capture-fg-primary)" }}
          >
            Capture session
          </DialogTitle>
          <DialogDescription
            className="text-[12px] leading-[1.55]"
            style={{ color: "var(--capture-fg-muted)" }}
          >
            Scan the QR with your phone, capture pages, then tap Done.
          </DialogDescription>
        </div>
        <code
          className="font-mono text-[11px] whitespace-nowrap pt-[5px]"
          style={{ color: "var(--capture-fg-faint)" }}
        >
          {tag}
        </code>
      </div>
      <hr
        aria-hidden
        className="m-0 border-0"
        style={{ borderTop: "1px solid var(--capture-border-subtle)" }}
      />
    </DialogHeader>
  );
}
```

- [ ] **Step 2: Remove the now-unused `chromAccentColor` helper**

Find `function chromAccentColor(state: CaptureState): string | null { ... }` (lines ~512–524) and delete it entirely. It's not called any more.

- [ ] **Step 3: Update the `DialogContent` styles**

Find the JSX element `<DialogContent ... className="overflow-hidden p-0 sm:max-w-[760px]" ...>` and remove the `p-0` (we want default padding off, but the new ModalChrome supplies its own padding). Replace `className="overflow-hidden p-0 sm:max-w-[760px]"` with:

```tsx
className="overflow-hidden p-0 sm:max-w-[760px] gap-0"
```

(Adding `gap-0` so the DialogContent's flex/grid children don't get auto-spaced; new layout supplies its own gaps.)

Keep the existing `style={{ backgroundColor, borderColor, color }}` block.

- [ ] **Step 4: Update the body grid to drop the old left/right `240px 1fr` split**

The body layout still uses `LeftColumn` / `RightColumn` from the existing code. We retain those component names for the next two tasks. For now, change the body's `<div className="grid gap-5 p-6 pt-3" style={{ gridTemplateColumns: "240px 1fr" }}>` to:

```tsx
<div
  className="grid gap-9 px-[38px] pb-[26px] pt-[28px]"
  style={{ gridTemplateColumns: "192px 1fr", alignItems: "start" }}
>
```

(Wider gap, narrower QR column — matches the spec §3.3.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

Expected: PASS. (The interior of `LeftColumn` / `RightColumn` will still reference deleted tokens — those throw at runtime, not compile-time. The next tasks fix them.)

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/components/CaptureModal.tsx
git commit -m "feat(capture-modal): new header pattern + body grid

Drop animated accent rail and chromAccentColor helper. Title-block
constrained to max-width 360px so workflow tag has its own line on the
right. Body grid widens to 192px QR column + 36px gap per spec §3."
```

---

## Task 4 — `CaptureModal.tsx`: new `LeftColumn` (QR + shortcode + URL)

**Files:**
- Modify: `src/dashboard/components/CaptureModal.tsx:549-693` (`LeftColumn`), and the small helpers it uses (`StartingPanel`, `ErrorPanel`).

- [ ] **Step 1: Replace `LeftColumn` body**

Find `function LeftColumn(props) { ... }` and replace its body (everything between the destructuring and the closing brace, keeping the props signature) with:

```tsx
  if (state === "starting") return <StartingPanel />;
  if (state === "error") return <ErrorPanel message={error ?? "Couldn't start"} onRetry={onCloseAndStartNew} />;
  if (!started) return null;

  return (
    <div className="flex flex-col items-center gap-4">
      {/* QR — server-generated SVG; we control the input. */}
      <div
        className="rounded-[10px] p-[14px]"
        style={{ backgroundColor: "#FFFFFF", width: 192, height: 192 }}
        aria-label="QR code for capture URL"
        dangerouslySetInnerHTML={{ __html: started.qrSvg }}
      />

      {/* Shortcode */}
      <div
        className="font-mono text-[28px] font-light"
        style={{
          color: "var(--capture-fg-primary)",
          letterSpacing: "0.14em",
          lineHeight: 1.1,
        }}
        aria-label={`Manual entry shortcode ${started.shortcode}`}
      >
        {formatShortcode(started.shortcode)}
      </div>

      {/* URL field */}
      <div className="w-full">
        <div
          className="text-center font-sans text-[9.5px] uppercase tracking-[0.10em] mb-1.5 font-medium"
          style={{ color: "var(--capture-fg-faint)" }}
        >
          URL
        </div>
        <div
          className="flex items-baseline gap-3 py-2"
          style={{ borderBottom: "1px solid var(--capture-border-subtle)" }}
        >
          <code
            className="flex-1 truncate font-mono text-[11.5px]"
            style={{ color: "var(--capture-fg-body)" }}
            title={started.captureUrl}
          >
            {started.captureUrl}
          </code>
          <button
            type="button"
            aria-label="Copy URL"
            onClick={onCopy}
            className="font-sans text-[10px] cursor-pointer hover:underline focus-visible:outline-none focus-visible:ring-2"
            style={{
              color: "var(--capture-fg-muted)",
              backgroundColor: "transparent",
              border: 0,
              padding: 0,
              ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
            }}
          >
            Copy
          </button>
        </div>
      </div>
    </div>
  );
```

- [ ] **Step 2: Add the `formatShortcode` helper near the top of the file**

Below the `photoSrc` helper near line 74, add:

```tsx
/** Render the 5- or 6-char raw shortcode as `XX·XXX` for visual rhythm. */
function formatShortcode(s: string): string {
  if (s.length <= 3) return s;
  return `${s.slice(0, 2)}·${s.slice(2)}`;
}
```

- [ ] **Step 3: Replace `StartingPanel` body**

Find `function StartingPanel()` and replace with:

```tsx
function StartingPanel() {
  return (
    <div className="flex w-full flex-col items-center justify-center gap-3 py-12">
      <Loader2 aria-hidden className="h-6 w-6 animate-spin" style={{ color: "var(--capture-fg-muted)" }} />
      <span className="font-sans text-[12px]" style={{ color: "var(--capture-fg-muted)" }}>
        Generating QR code…
      </span>
    </div>
  );
}
```

- [ ] **Step 4: Replace `ErrorPanel` body**

Find `function ErrorPanel({ message, onRetry })` and replace with:

```tsx
function ErrorPanel({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex w-full flex-col gap-3 rounded-md p-3"
      style={{
        border: "1px solid var(--capture-border-subtle)",
        borderLeft: "2px solid var(--capture-error)",
        backgroundColor: "transparent",
      }}
    >
      <div
        className="flex items-center gap-1.5 font-sans text-[9.5px] uppercase tracking-[0.10em] font-medium"
        style={{ color: "var(--capture-fg-muted)" }}
      >
        <XOctagon aria-hidden className="h-3.5 w-3.5" />
        Error
      </div>
      <code className="font-mono text-[12px] leading-relaxed" style={{ color: "var(--capture-fg-body)" }}>
        {message}
      </code>
      <CtaButton variant="primary" onClick={onRetry}>
        <RefreshCw aria-hidden className="h-3.5 w-3.5" />
        Close
      </CtaButton>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/components/CaptureModal.tsx
git commit -m "feat(capture-modal): rewrite LeftColumn for Editorial Calm

QR (192×192), centered shortcode (28px / 300 weight / 0.14em),
hairline-bordered URL row with Copy link. Status pill + phone-status +
shortcode-as-card all gone — moved or simplified per spec §3.3."
```

---

## Task 5 — `CaptureModal.tsx`: new `RightColumn` (status + photos + actions)

**Files:**
- Modify: `src/dashboard/components/CaptureModal.tsx:1003-1080` (`RightColumn`), `1099-1118` (`statePillTone`), `1120-1135` (`PlaceholderTile`), `1137-1228` (`ValidationBanner`).

- [ ] **Step 1: Replace `RightColumn` body**

Find `function RightColumn(props) { ... }` and replace its body with:

```tsx
  if (state === "starting" || state === "error") {
    return (
      <div className="flex items-center justify-center" style={{ color: "var(--capture-fg-faint)" }}>
        <span className="font-mono text-xs">—</span>
      </div>
    );
  }

  const photos = info?.photos ?? [];
  const blurFlaggedCount = photos.filter((p) => p.blurFlagged).length;
  const sessionTerminal = isTerminal(state);
  const phoneConnected = info?.phoneConnectedAt != null;

  return (
    <div className="flex flex-col gap-[22px]">
      {/* STATUS */}
      <div>
        <div
          className="text-[9.5px] uppercase tracking-[0.10em] font-medium mb-1"
          style={{ color: "var(--capture-fg-faint)" }}
        >
          Status
        </div>
        <div className="flex items-center gap-2.5 py-1 text-[12px]" style={{ color: "var(--capture-fg-secondary)" }}>
          <span
            className="inline-block h-[5px] w-[5px] rounded-full shrink-0"
            style={{ backgroundColor: "var(--capture-fg-secondary)" }}
            aria-hidden
          />
          <span>{describeStatus(state, phoneConnected, photos.length)}</span>
        </div>
      </div>

      {/* PHOTOS */}
      <div>
        <div
          className="text-[9.5px] uppercase tracking-[0.10em] font-medium mb-2"
          style={{ color: "var(--capture-fg-faint)" }}
        >
          Live photos · <span className="font-mono tabular-nums">{photos.length}</span>
        </div>
        <div className="grid grid-cols-4 gap-2.5">
          {photos.map((p) => (
            <CapturePhotoTile
              key={`${p.index}-${p.uploadedAt}`}
              photo={p}
              imageSrc={started ? photoSrc(started.sessionId, p.index) : ""}
              onView={() => onPhotoView(p.index)}
              onDelete={sessionTerminal ? undefined : () => onPhotoDelete(p.index)}
              justArrived={p.index === arrivedIndex}
              disabled={sessionTerminal}
            />
          ))}
          {!sessionTerminal && photos.length < 4 && <PlaceholderTile />}
        </div>
      </div>

      {/* VALIDATION (warns/blockers) — only during open. */}
      <ValidationBanner
        validation={validation}
        blurFlaggedCount={blurFlaggedCount}
        photoCount={photos.length}
        active={state === "open"}
      />
    </div>
  );
```

- [ ] **Step 2: Add `describeStatus` helper near `formatShortcode`**

```tsx
function describeStatus(state: CaptureState, phoneConnected: boolean, photoCount: number): string {
  if (state === "finalizing") return "Bundling photos for handoff…";
  if (state === "finalized") return "Sent to handler. Closing automatically…";
  if (state === "finalize_failed") return "Couldn't send to handler.";
  if (state === "expired") return "Session expired.";
  if (state === "discarded") return "Session discarded.";
  if (!phoneConnected) return "Waiting for phone to scan QR.";
  if (photoCount === 0) return "Phone connected — awaiting photos.";
  return `Phone connected — ${photoCount} photo${photoCount === 1 ? "" : "s"} received.`;
}
```

- [ ] **Step 3: Delete `PhoneStatusPill`, `pillToneForState`, `StatePill`, `statePillTone`**

These are no longer called — `describeStatus` replaces them. Remove the entire bodies of:
- `function PhoneStatusPill(...) { ... }`
- `function pillToneForState(...) { ... }`
- `function StatePill({ state }: ...) { ... }`
- `function statePillTone(...) { ... }`

- [ ] **Step 4: Replace `PlaceholderTile`**

```tsx
function PlaceholderTile() {
  return (
    <div
      className="aspect-[3/4] rounded-md"
      style={{
        border: "1px solid var(--capture-border-subtle)",
        backgroundColor: "transparent",
      }}
      aria-hidden
    />
  );
}
```

(No "awaiting…" text — the placeholder reads as a quiet outlined cell.)

- [ ] **Step 5: Replace `ValidationBanner`**

```tsx
function ValidationBanner({
  validation,
  blurFlaggedCount,
  photoCount,
  active,
}: {
  validation: CaptureValidation | null;
  blurFlaggedCount: number;
  photoCount: number;
  active: boolean;
}) {
  if (!active) return null;
  const blockers = validation?.blockers ?? [];
  const warnings = validation?.warnings ?? [];

  if (blockers.length > 0) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md p-3"
        style={{
          border: "1px solid var(--capture-border-subtle)",
          borderLeft: "2px solid var(--capture-error)",
          backgroundColor: "transparent",
        }}
      >
        <XOctagon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--capture-fg-muted)" }} />
        <div className="flex flex-col gap-0.5">
          <span
            className="text-[9.5px] uppercase tracking-[0.10em] font-medium"
            style={{ color: "var(--capture-fg-muted)" }}
          >
            Can't finalize
          </span>
          <span className="font-sans text-[13px]" style={{ color: "var(--capture-fg-body)" }}>
            {blockers.join(" · ")}
          </span>
        </div>
      </div>
    );
  }

  const allWarnings = [
    ...warnings,
    ...(blurFlaggedCount > 0
      ? [`${blurFlaggedCount} photo${blurFlaggedCount === 1 ? "" : "s"} flagged as blurry — review before finalizing`]
      : []),
  ];
  if (allWarnings.length === 0 || photoCount === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 rounded-md p-3"
      style={{
        border: "1px solid var(--capture-border-subtle)",
        borderLeft: "2px solid var(--capture-warn)",
        backgroundColor: "transparent",
      }}
    >
      <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--capture-warn)" }} />
      <div className="flex flex-col gap-0.5">
        <span
          className="text-[9.5px] uppercase tracking-[0.10em] font-medium"
          style={{ color: "var(--capture-fg-muted)" }}
        >
          Heads up
        </span>
        <ul className="font-sans text-[13px] leading-relaxed" style={{ color: "var(--capture-fg-body)" }}>
          {allWarnings.map((w, i) => (
            <li key={i}>· {w}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/components/CaptureModal.tsx
git commit -m "feat(capture-modal): rewrite RightColumn for Editorial Calm

Status as plain text + ● dot (no filled pill); photos as 4-col grid
with hairline placeholder; validation banner uses transparent bg with
left-border accent. PhoneStatusPill / StatePill helpers removed."
```

---

## Task 6 — `CaptureModal.tsx`: 4-column action row + footer rewrite

**Files:**
- Modify: `src/dashboard/components/CaptureModal.tsx:812-928` (`ActionRow`, `FinalizingBar`), `931-987` (`ExpiryFooter`).

The action row is rendered separately from the photo grid in the existing code. We'll move it into the right column (after photos) so the 4-col rhythm is shared.

- [ ] **Step 1: Move `<ActionRow>` and `<ExpiryFooter>` calls**

In the original `LeftColumn`, `ActionRow` was rendered in the left rail along with `ExpiryFooter`. We want both rendered in the right column, after the photo grid + ValidationBanner. Find the `LeftColumn` body and remove the `<ActionRow ... />` and `<ExpiryFooter ... />` JSX calls. The component should now end with the URL field — no actions, no timer.

In the `RightColumn` body added in Task 5, append after the `<ValidationBanner>` (and before the closing `</div>` of the column root):

```tsx
      <ActionRow
        state={state}
        retrying={retrying}
        finalizeDisabled={finalizeDisabled}
        photoCount={photoCount}
        onFinalize={onFinalize}
        onRetryHandoff={onRetryHandoff}
        onDiscard={onDiscard}
        onCloseAndStartNew={onCloseAndStartNew}
      />
      <ExpiryFooter
        expiresAt={started?.expiresAt ?? 0}
        currentExpiresAt={info?.expiresAt ?? started?.expiresAt ?? 0}
        now={now}
        extending={extending}
        onExtend={onExtend}
        terminal={isTerminal(state)}
      />
```

- [ ] **Step 2: Update `RightColumnProps` to add the missing fields**

Add to `interface RightColumnProps`:

```ts
  retrying: boolean;
  finalizeDisabled: boolean;
  photoCount: number;
  extending: boolean;
  now: number;
  onFinalize: () => void;
  onRetryHandoff: () => void;
  onDiscard: () => void;
  onCloseAndStartNew: () => void;
  onExtend: () => void;
```

…and the parent that calls `<RightColumn ... />` (in the `CaptureModal` body) needs to thread those props through. Find the `<RightColumn ...>` call inside the main grid and add the missing props (they're already in scope from the `useState` / `useCallback` declarations).

- [ ] **Step 3: Update `LeftColumnProps` to drop the now-unused fields**

Remove `validation`, `validating`, `retrying`, `extending`, `onFinalize`, `onRetryHandoff`, `onDiscard`, `onCloseAndStartNew`, `onExtend`, `now`, `sseConnected` from `interface LeftColumnProps` if those props are no longer read inside the new `LeftColumn` body. Keep only what the new body uses.

The new `LeftColumnProps` should contain: `state`, `started`, `error`, `onCopy`, `onCloseAndStartNew` (still passed to `ErrorPanel` for "Close" retry).

Wait — `ErrorPanel` calls `onRetry` which we map to `onCloseAndStartNew`. Keep that prop in `LeftColumnProps`.

Update the parent's `<LeftColumn ... />` call to pass only the retained props.

- [ ] **Step 4: Replace `ActionRow` body for the 4-col rhythm**

Find `function ActionRow(props) { ... }` and replace its body with:

```tsx
  if (state === "open") {
    return (
      <div className="grid grid-cols-4 gap-2.5">
        <CtaButton
          variant="primary"
          onClick={onFinalize}
          disabled={finalizeDisabled}
          style={{ gridColumn: "span 3" }}
        >
          Finalize
        </CtaButton>
        <CtaButton variant="outline" onClick={onDiscard} style={{ gridColumn: "span 1" }}>
          Discard
        </CtaButton>
      </div>
    );
  }
  if (state === "finalizing") {
    return <FinalizingBar />;
  }
  if (state === "finalized") {
    return (
      <div
        className="flex flex-col gap-1.5 rounded-md p-3"
        style={{
          border: "1px solid var(--capture-border-subtle)",
          borderLeft: "2px solid var(--capture-border-cta-strong)",
          backgroundColor: "transparent",
        }}
      >
        <div
          className="flex items-center gap-1.5 text-[9.5px] uppercase tracking-[0.10em] font-medium"
          style={{ color: "var(--capture-fg-secondary)" }}
        >
          <CheckCircle2 aria-hidden className="h-4 w-4" />
          Done · sent to handler
        </div>
        <span className="font-mono text-xs" style={{ color: "var(--capture-fg-muted)" }}>
          Closing automatically…
        </span>
      </div>
    );
  }
  if (state === "finalize_failed") {
    return (
      <div className="grid grid-cols-4 gap-2.5">
        <CtaButton
          variant="primary"
          onClick={onRetryHandoff}
          disabled={retrying}
          style={{ gridColumn: "span 3" }}
        >
          {retrying ? (
            <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw aria-hidden className="h-3.5 w-3.5" />
          )}
          Retry handoff
        </CtaButton>
        <CtaButton variant="outline" onClick={onDiscard} style={{ gridColumn: "span 1" }}>
          Discard
        </CtaButton>
      </div>
    );
  }
  if (state === "expired" || state === "discarded") {
    return (
      <div className="grid grid-cols-4 gap-2.5">
        <CtaButton
          variant="primary"
          onClick={onCloseAndStartNew}
          style={{ gridColumn: "span 4" }}
        >
          Close
        </CtaButton>
      </div>
    );
  }
  void photoCount; // referenced by callers; reserved for future "Finalize · N" UI if it returns.
  return null;
```

- [ ] **Step 5: Replace `FinalizingBar` body**

```tsx
function FinalizingBar() {
  return (
    <div
      className="relative h-[1.5px] w-full overflow-hidden rounded-full"
      style={{ backgroundColor: "var(--capture-border-subtle)" }}
      role="progressbar"
      aria-label="Bundling photos"
      aria-busy="true"
    >
      <div
        className="absolute inset-y-0 left-0 w-1/2 rounded-full animate-[finalizing-strip_1.6s_var(--cap-ease-smooth)_infinite]"
        style={{ backgroundColor: "var(--capture-fg-body)" }}
      />
    </div>
  );
}
```

Then in `index.css`, append a single new keyframe near the surviving capture animations:

```css
@keyframes finalizing-strip {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(220%); }
}
```

- [ ] **Step 6: Replace `ExpiryFooter` body**

```tsx
function ExpiryFooter({
  expiresAt,
  currentExpiresAt,
  now,
  extending,
  onExtend,
  terminal,
}: {
  expiresAt: number;
  currentExpiresAt: number;
  now: number;
  extending: boolean;
  onExtend: () => void;
  terminal: boolean;
}) {
  if (terminal) return null;
  const remaining = Math.max(0, currentExpiresAt - now);
  const seconds = Math.ceil(remaining / 1_000);
  const mm = Math.floor(seconds / 60).toString().padStart(2, "0");
  const ss = (seconds % 60).toString().padStart(2, "0");
  const critical = seconds <= 10;
  const warning = !critical && seconds <= 60;

  return (
    <div
      className="flex items-center justify-between text-[11.5px] pt-3.5"
      style={{ borderTop: "1px solid var(--capture-border-subtle)", color: "var(--capture-fg-muted)" }}
    >
      <span className="flex items-center gap-2">
        <span
          className={cn(
            "font-mono tabular-nums transition-colors",
            warning && "capture-anim-expiry-warn",
            critical && "capture-anim-expiry-critical",
          )}
          style={{ color: "var(--capture-fg-secondary)" }}
        >
          {mm}:{ss}
        </span>
        <span>remaining</span>
      </span>
      <button
        type="button"
        onClick={onExtend}
        disabled={extending}
        className="font-sans text-[11.5px] cursor-pointer focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50"
        style={{
          color: "var(--capture-fg-secondary)",
          backgroundColor: "transparent",
          border: 0,
          padding: 0,
          ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
        }}
      >
        {extending ? "extending…" : "Extend"}
      </button>
      <span className="sr-only">Original expiry: {new Date(expiresAt).toLocaleTimeString()}</span>
    </div>
  );
}
```

- [ ] **Step 7: Replace `CtaButton` body**

Find `function CtaButton(...)` and replace with:

```tsx
function CtaButton({ variant, className, children, style, ...rest }: CtaButtonProps) {
  const isPrimary = variant === "primary";
  const base = cn(
    "inline-flex items-center justify-center gap-1.5 rounded-[7px] px-3.5 py-2.5 font-sans text-[12.5px] font-medium",
    "border transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
    "disabled:cursor-not-allowed disabled:opacity-100",
    "cursor-pointer",
    className,
  );
  const variantStyle = isPrimary
    ? {
        backgroundColor: "transparent",
        color: "var(--capture-fg-primary)",
        borderColor: "var(--capture-border-cta)",
      }
    : {
        backgroundColor: "transparent",
        color: "var(--capture-fg-muted)",
        borderColor: "var(--capture-border-subtle)",
      };
  const disabledStyle = rest.disabled
    ? {
        color: "var(--capture-fg-faint)",
        borderColor: "var(--capture-border-subtle)",
        cursor: "not-allowed",
      }
    : {};
  return (
    <button
      {...rest}
      className={base}
      style={{
        ...variantStyle,
        ...disabledStyle,
        ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
        ["--tw-ring-offset-color" as string]: "var(--capture-bg-modal)",
        ...style,
      }}
      onMouseOver={(e) => {
        if (!rest.disabled) {
          (e.currentTarget as HTMLButtonElement).style.borderColor = isPrimary
            ? "var(--capture-border-cta-strong)"
            : "var(--capture-border-cta)";
        }
        rest.onMouseOver?.(e);
      }}
      onMouseOut={(e) => {
        if (!rest.disabled) {
          (e.currentTarget as HTMLButtonElement).style.borderColor = isPrimary
            ? "var(--capture-border-cta)"
            : "var(--capture-border-subtle)";
        }
        rest.onMouseOut?.(e);
      }}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 8: Drop the trailing `void Camera` line**

The bottom of the file has `void Camera;` — leave it; it suppresses an import warning. (Skip if not present.)

- [ ] **Step 9: Typecheck + dev server smoke**

```
npm run typecheck
```

Expected: PASS.

Then:

```
npm run dashboard
```

Open http://localhost:5173. The `Run` button on the emergency-contact workflow opens RunModal (still old). Trigger a capture session via any oath-signature flow (or click the bypass button on a row that supports it). The capture modal should now render with:
- New header (title + sub left, mono `emergency-contact` right)
- 192px QR
- Big spaced shortcode under it
- Hairline-bordered URL row with Copy
- Status text with `●` dot
- 4-col photo grid + actions row aligned

Stop the server.

- [ ] **Step 10: Commit**

```bash
git add src/dashboard/components/CaptureModal.tsx src/dashboard/index.css
git commit -m "feat(capture-modal): 4-col action grid + new expiry footer

Move ActionRow + ExpiryFooter into RightColumn so they share the
photo grid's 4-col rhythm (Finalize spans 3, Discard spans 1).
Replace filled-success / glow / pulse styling on terminal state
banners with hairline-bordered, transparent-bg variants.

Add finalizing-strip keyframe — replaces the deleted
capture-finalizing-bar; runs on the new <FinalizingBar/>."
```

---

## Task 7 — `CapturePhotoTile.tsx`: hairline outline + remove filled badges

**Files:**
- Modify: `src/dashboard/components/CapturePhotoTile.tsx` (entire file).

- [ ] **Step 1: Read the current tile body** (already done in plan-time inspection; for the agent, run `cat`-equivalent via Read tool to get fresh state).

- [ ] **Step 2: Replace the rendered output**

Replace the JSX returned from `CapturePhotoTile` with:

```tsx
return (
    <div
      role={onView ? "button" : undefined}
      tabIndex={onView && !disabled ? 0 : -1}
      aria-label={`Photo ${photo.index + 1} from capture session${
        photo.blurFlagged ? " — flagged as blurry" : ""
      }`}
      onClick={() => !disabled && onView?.(photo.index)}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !disabled) {
          e.preventDefault();
          onView?.(photo.index);
        }
      }}
      className={cn(
        "group relative aspect-[3/4] overflow-hidden rounded-md",
        "transition-shadow",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        !disabled && "cursor-pointer hover:shadow-md",
        disabled && "opacity-60 cursor-not-allowed",
        justArrived && "capture-anim-thumb-enter",
      )}
      style={{
        backgroundColor: "var(--capture-bg-raised)",
        outlineColor: photo.blurFlagged ? "var(--capture-warn)" : "transparent",
        outlineWidth: photo.blurFlagged ? 1 : 0,
        outlineStyle: "solid",
        outlineOffset: -1,
        ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
      }}
    >
      {!imageError ? (
        <img
          src={imageSrc}
          alt={`Photo ${photo.index + 1}`}
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover"
          onError={() => setImageError(true)}
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center text-xs"
          style={{ color: "var(--capture-fg-faint)" }}
        >
          —
        </div>
      )}

      {/* Blur label (text-only, mono caps) — flashes once on transition. */}
      {photo.blurFlagged && (
        <span
          key={flashKey}
          className="capture-anim-blur-flash absolute right-1.5 bottom-1.5 font-sans text-[9px] uppercase tracking-[0.08em] font-medium"
          style={{ color: "var(--capture-warn)" }}
        >
          blurry
        </span>
      )}

      {/* Hover/focus delete overlay — outline-only. */}
      {onDelete && !disabled && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`Delete photo ${photo.index + 1}`}
              onClick={handleDelete}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") handleDelete(e);
              }}
              tabIndex={0}
              className={cn(
                "absolute right-1 top-1 inline-flex h-7 w-7 items-center justify-center rounded-full",
                "opacity-0 transition-opacity duration-150",
                "group-hover:opacity-100 focus-visible:opacity-100",
                "focus-visible:outline-none focus-visible:ring-2",
              )}
              style={{
                backgroundColor: "var(--capture-bg-modal)",
                color: "var(--capture-fg-secondary)",
                border: "1px solid var(--capture-border-strong)",
                ["--tw-ring-color" as string]: "var(--capture-focus-ring)",
              }}
            >
              <X aria-hidden className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Delete photo</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
```

- [ ] **Step 3: Remove the now-unused `AlertTriangle` import**

Edit the import line at the top: `import { AlertTriangle, X } from "lucide-react";` → `import { X } from "lucide-react";`.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/components/CapturePhotoTile.tsx
git commit -m "feat(capture-tile): hairline blur outline, drop index/badge fills

Photo index badge removed (desktop view is observation-only; phone
owns ordering). Blur indicator becomes a thin warm hairline outline
+ tiny 'blurry' caps label, replacing the filled orange pill. Delete
button becomes an outlined ghost circle."
```

---

## Task 8 — `RunModal.tsx`: header + dropzone + file row rewrite

**Files:**
- Modify: `src/dashboard/components/RunModal.tsx` (entire file).

- [ ] **Step 1: Replace the `<DialogContent>` body**

Find `<DialogContent>` and replace it with:

```tsx
      <DialogContent className="overflow-hidden p-0 sm:max-w-[640px] gap-0">
        <DialogHeader className="grid gap-3 px-[38px] pt-[36px] pb-0">
          <div
            className="grid items-start gap-6"
            style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}
          >
            <div className="flex flex-col gap-1.5" style={{ maxWidth: 360 }}>
              <DialogTitle className="text-[15px] font-normal tracking-[-0.005em]">
                Run Emergency Contact
              </DialogTitle>
              <DialogDescription className="text-[12px] leading-[1.55] text-muted-foreground">
                Upload a scanned PDF. We&apos;ll OCR it, match against the roster, then approve before queuing.
              </DialogDescription>
            </div>
            <code className="font-mono text-[11px] whitespace-nowrap pt-[5px] text-muted-foreground/70">
              emergency-contact
            </code>
          </div>
          <hr aria-hidden className="m-0 border-0 border-t border-border/60" />
        </DialogHeader>

        <div className="px-[38px] pt-[24px] pb-0 space-y-6">
          {/* PDF section — empty / file-row / progress */}
          <section>
            <div className="text-[9.5px] uppercase tracking-[0.10em] font-medium mb-2 text-muted-foreground/70">
              {file ? "PDF" : "Upload"}
            </div>
            {!file ? (
              <Dropzone
                fileInputRef={fileInputRef}
                dropRef={dropRef}
                onDrop={handleDrop}
                onPick={(p) => handleFileSelect(p)}
              />
            ) : progress !== null && submitting ? (
              <UploadProgress fileName={file.name} fileSize={file.size} progress={progress} />
            ) : (
              <FileRow file={file} onRemove={() => setFile(null)} />
            )}
          </section>

          {/* Roster section */}
          <section>
            <div className="text-[9.5px] uppercase tracking-[0.10em] font-medium mb-1 text-muted-foreground/70">
              Roster
            </div>
            <div>
              <RosterRow
                checked={rosterMode === "existing"}
                disabled={!hasRoster || submitting}
                onSelect={() => setRosterMode("existing")}
                label="Use latest roster"
                hint={
                  hasRoster && latestRoster
                    ? `Latest: ${latestRoster.filename} · ${formatBytes(latestRoster.bytes)}`
                    : "No roster on disk — pick the other option to fetch one."
                }
              />
              <RosterRow
                checked={rosterMode === "download"}
                disabled={submitting}
                onSelect={() => setRosterMode("download")}
                label="Download fresh from SharePoint"
                hint={
                  sharePoint.downloading
                    ? "Downloading roster from SharePoint…"
                    : sharePoint.error
                      ? `Error: ${sharePoint.error}`
                      : "Adds ~20s but guarantees current data."
                }
                last
              />
            </div>
          </section>

          {error && (
            <div
              role="alert"
              aria-live="polite"
              className="flex items-start gap-2 rounded-md p-3"
              style={{
                border: "1px solid var(--border)",
                borderLeft: "2px solid hsl(0 50% 56%)",
                backgroundColor: "transparent",
              }}
            >
              <AlertCircle aria-hidden className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
              <span className="text-[13px] text-foreground">{error}</span>
            </div>
          )}
        </div>

        <DialogFooter
          className="grid grid-cols-4 gap-2.5 border-t border-border/60 px-[38px] py-[18px] mt-[24px]"
        >
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!file || submitting}
            className={cn(
              "col-span-3 inline-flex items-center justify-center gap-1.5 rounded-[7px] px-3.5 py-2.5",
              "text-[12.5px] font-medium",
              "border border-border bg-transparent text-foreground",
              "hover:border-foreground/50",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
              "disabled:opacity-100 disabled:cursor-not-allowed disabled:text-muted-foreground/40 disabled:border-border/60",
              "cursor-pointer",
            )}
          >
            {submitting && progress !== null && progress < 100 ? (
              <>
                <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                Uploading…
              </>
            ) : submitting ? (
              <>
                <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                Starting…
              </>
            ) : (
              "Run"
            )}
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            className={cn(
              "col-span-1 inline-flex items-center justify-center rounded-[7px] px-3 py-2.5",
              "text-[12.5px] font-medium",
              "border border-border/60 bg-transparent text-muted-foreground",
              "hover:border-border hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
              "disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
            )}
          >
            Cancel
          </button>
        </DialogFooter>
      </DialogContent>
```

- [ ] **Step 2: Add the new sub-components at the bottom of the file**

After the existing `formatBytes` helper, add:

```tsx
function Dropzone({
  fileInputRef,
  dropRef,
  onDrop,
  onPick,
}: {
  fileInputRef: React.RefObject<HTMLInputElement>;
  dropRef: React.RefObject<HTMLLabelElement>;
  onDrop: (e: React.DragEvent<HTMLLabelElement>) => void;
  onPick: (file: File | null) => void;
}) {
  return (
    <label
      ref={dropRef}
      htmlFor="ec-pdf-input"
      onDragOver={(e) => {
        e.preventDefault();
        dropRef.current?.classList.add("bg-muted/30");
      }}
      onDragLeave={() => {
        dropRef.current?.classList.remove("bg-muted/30");
      }}
      onDrop={onDrop}
      className={cn(
        "flex flex-col items-center justify-center gap-2.5",
        "rounded-[10px] border border-dashed border-border/80 bg-transparent",
        "px-6 py-9 cursor-pointer transition-colors",
        "hover:bg-muted/30 hover:border-border",
        "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 ring-offset-card",
      )}
    >
      <input
        ref={fileInputRef}
        id="ec-pdf-input"
        type="file"
        accept="application/pdf,.pdf"
        className="sr-only"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
      <span
        className="inline-flex items-center justify-center rounded-full"
        style={{
          width: 38,
          height: 38,
          border: "1px solid var(--border)",
          color: "var(--muted-foreground)",
        }}
      >
        <UploadCloud aria-hidden className="h-4 w-4" />
      </span>
      <div className="text-[13px] text-foreground/90">Drag PDF here, or click to browse</div>
      <div className="text-[10.5px] text-muted-foreground/70 font-mono tracking-wide">
        PDF only · max 50 MB
      </div>
    </label>
  );
}

function FileRow({ file, onRemove }: { file: File; onRemove: () => void }) {
  return (
    <div
      className="flex items-center gap-3.5 rounded-[10px] px-4 py-3.5"
      style={{ border: "1px solid var(--border)", backgroundColor: "var(--muted)" }}
    >
      <span
        className="inline-flex items-center justify-center rounded-md shrink-0"
        style={{
          width: 32,
          height: 32,
          backgroundColor: "var(--background)",
          border: "1px solid var(--border)",
          color: "var(--foreground)",
        }}
      >
        <FileText aria-hidden className="h-4 w-4" />
      </span>
      <div className="flex-1 min-w-0 grid gap-0.5">
        <div className="text-[13px] truncate text-foreground">{file.name}</div>
        <div className="text-[10.5px] text-muted-foreground/70 font-mono">
          {formatBytes(file.size)}
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove file"
        title="Remove file"
        className={cn(
          "h-7 w-7 inline-flex items-center justify-center rounded-md",
          "text-muted-foreground hover:bg-muted hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "cursor-pointer",
        )}
      >
        <X aria-hidden className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function UploadProgress({
  fileName,
  fileSize,
  progress,
}: {
  fileName: string;
  fileSize: number;
  progress: number;
}) {
  return (
    <div
      className="rounded-[10px] px-4 py-3.5 space-y-2"
      style={{ border: "1px solid var(--border)", backgroundColor: "var(--muted)" }}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] truncate">{fileName}</span>
        <span className="text-[11px] font-mono text-muted-foreground/80">{progress}%</span>
      </div>
      <div className="h-[1.5px] w-full overflow-hidden rounded-full" style={{ backgroundColor: "var(--border)" }}>
        <div
          className="h-full transition-[width] motion-reduce:transition-none"
          style={{ width: `${progress}%`, backgroundColor: "var(--foreground)" }}
          aria-hidden
        />
      </div>
      <div className="text-[11px] text-muted-foreground/80" aria-live="polite" role="status">
        Uploading {formatBytes((fileSize * progress) / 100)} of {formatBytes(fileSize)}…
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Replace `RosterOption` with `RosterRow`**

Delete the existing `function RosterOption(...)` and add:

```tsx
function RosterRow({
  checked,
  disabled,
  onSelect,
  label,
  hint,
  last,
}: {
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
  label: string;
  hint: string;
  last?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-3.5 px-3.5 py-3 cursor-pointer transition-colors",
        !last && "border-b border-border/60",
        checked ? "bg-muted/40" : "hover:bg-muted/20",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      <span
        className="mt-1 inline-flex items-center justify-center shrink-0 relative"
        style={{
          width: 14,
          height: 14,
          borderRadius: "50%",
          border: "1px solid var(--border)",
        }}
        aria-hidden
      >
        {checked && (
          <span
            className="block rounded-full"
            style={{ width: 6, height: 6, backgroundColor: "var(--foreground)" }}
          />
        )}
      </span>
      <input
        type="radio"
        className="sr-only"
        checked={checked}
        disabled={disabled}
        onChange={() => !disabled && onSelect()}
      />
      <div className="flex-1 min-w-0">
        <div className="text-[12.5px] text-foreground">{label}</div>
        <div className="text-[10.5px] text-muted-foreground/70 font-mono mt-0.5 truncate">{hint}</div>
      </div>
    </label>
  );
}
```

- [ ] **Step 4: Remove the redundant inner `<div className="px-5 py-5 space-y-5">` wrapper**

The new `<DialogContent>` body in Step 1 already supplies its own padding directly under `<DialogHeader>` (the `px-[38px] pt-[24px] pb-0 space-y-6` div). The pre-existing wrapper at the same level should already be replaced by the new structure in Step 1. If the agent finds a duplicate `<div className="px-5 py-5 space-y-5">` still in the file, delete it.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Dev server smoke test**

```
npm run dashboard
```

Open http://localhost:5173, switch the workflow dropdown to `emergency-contact`, click the Run CTA in the TopBar.

Verify:
- Header shows "Run Emergency Contact" with `emergency-contact` mono tag on the right.
- Hairline divider under the header.
- Dropzone is hairline-dashed with circle-outline cloud icon.
- Drop or pick a small PDF — file row appears, with file-text icon + name + size + ×.
- Roster picker shows two radio rows separated by a hairline.
- Footer is a 4-col grid: `Run` 3-col, `Cancel` 1-col.

Stop the server.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/components/RunModal.tsx
git commit -m "feat(run-modal): rewrite for Editorial Calm

New header with workflow tag, hairline-dashed dropzone, file-row /
upload-progress shapes share the outer container so there's no layout
shift between states. RosterOption replaced by hairline RosterRow
matching the URL field treatment in the capture modal. Footer uses
4-col grid (Run spans 3, Cancel spans 1)."
```

---

## Task 9 — `mobile.html`: header restructure + remove substrip

**Files:**
- Modify: `src/capture/mobile.html` lines 14–380 (style block) and 382–434 (markup before script).

- [ ] **Step 1: Update the inline `:root` token block**

Find the `:root { ... }` block (lines ~20–50) and replace its contents with:

```css
    :root {
      --bg-page: #050507;
      --bg-modal: #0e0e10;
      --bg-raised: #131316;
      --bg-raised-hi: #1c1c1f;
      --border: #232325;
      --border-subtle: #1f1f21;
      --border-cta: #4a4a4c;
      --border-cta-strong: #6a6a6c;

      --fg-primary: #f5f5f7;
      --fg-secondary: #c8c8cb;
      --fg-body: #d0d0d3;
      --fg-muted: #8a8a8c;
      --fg-faint: #6e6e72;

      --warn: #d4a64a;
      --error: #d4544a;

      --focus-ring: #6a6a6c;

      --ease-enter:  cubic-bezier(0.16, 1, 0.3, 1);
      --ease-bounce: cubic-bezier(0.34, 1.56, 0.64, 1);
      --ease-smooth: cubic-bezier(0.45, 0, 0.55, 1);
    }
```

The previous warm `hsl(15 ...)` and `hsl(25 ...)` ladder is replaced. Tinted `*-bg`/`*-fg` variants are gone.

- [ ] **Step 2: Update the `header.bar` block**

Replace the `header.bar`, `.title`, and `.pill*` rules (lines ~70–106) with:

```css
    header.bar {
      position: sticky; top: 0; z-index: 10;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 12px;
      align-items: start;
      padding: 26px 18px 14px;
      background: rgba(14, 14, 16, 0.95);
      backdrop-filter: saturate(180%) blur(8px);
      -webkit-backdrop-filter: saturate(180%) blur(8px);
      border-bottom: 1px solid var(--border);
    }
    .title {
      display: grid; gap: 4px; min-width: 0;
    }
    .title h1 {
      margin: 0;
      font-size: 17px;
      font-weight: 400;
      line-height: 1.2;
      letter-spacing: -0.005em;
      color: var(--fg-primary);
    }
    .title .photo-count {
      font-size: 10px;
      color: var(--fg-muted);
      text-transform: uppercase;
      letter-spacing: 0.10em;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-feature-settings: 'tnum';
    }
    .pill {
      display: inline-flex; align-items: center; gap: 6px;
      padding-top: 4px;
      font-size: 10px;
      letter-spacing: 0.10em;
      text-transform: uppercase;
      font-weight: 500;
      color: var(--fg-secondary);
    }
    .pill .dot {
      width: 5px; height: 5px; border-radius: 50%;
      background: var(--fg-secondary);
      display: inline-block; flex-shrink: 0;
    }
    .pill.reconnecting { color: var(--fg-muted); }
    .pill.reconnecting .dot {
      background: var(--fg-muted);
      animation: blink 1.1s linear infinite;
    }
    .pill.session-closed { color: var(--fg-muted); }
    .pill.session-closed .dot { background: var(--fg-muted); }
    @keyframes blink { 50% { opacity: 0.35; } }
```

- [ ] **Step 3: Remove the `.substrip` block**

Delete the entire CSS rule for `.substrip` (and its `strong`/`saved`/`saved.dim` children). It's gone in v3 — the photo count moved to the header.

- [ ] **Step 4: Update tile + grid styling**

Find `.tile`, `.tile.blur-flagged`, `.tile.blank`, and the `.tile .badge*` rules (lines ~129–199) and replace with:

```css
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      align-items: start;
    }
    .tile {
      aspect-ratio: 3 / 4;
      position: relative;
      background: linear-gradient(135deg, #181819 0%, #131314 100%);
      border-radius: 6px;
      overflow: hidden;
      animation: tile-in 320ms var(--ease-bounce) both;
      transition: transform 180ms var(--ease-smooth);
      cursor: pointer;
    }
    .tile.blur-flagged {
      outline: 1px solid var(--warn);
      outline-offset: -1px;
    }
    .tile.dragging { transform: scale(1.04); z-index: 5; box-shadow: 0 8px 24px rgba(0,0,0,0.5); }
    .tile.drag-other { opacity: 0.6; }
    .tile img {
      width: 100%; height: 100%; object-fit: cover; display: block;
      pointer-events: none;
    }
    .tile.blank { background: #FFFFFF; }
    .tile.blank::after {
      content: "BLANK PAGE";
      position: absolute; inset: 0;
      display: grid; place-items: center;
      color: var(--fg-faint); font-size: 9px;
      text-transform: uppercase; letter-spacing: 0.10em; font-weight: 500;
    }
    @keyframes tile-in {
      from { opacity: 0; transform: translateY(-4px) scale(0.94); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    .tile .idx {
      position: absolute;
      bottom: 6px; left: 8px;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 11px;
      font-weight: 500;
      color: var(--fg-secondary);
      font-feature-settings: 'tnum';
    }
    .tile .status {
      position: absolute;
      bottom: 6px; right: 8px;
      font-size: 9px;
      color: var(--fg-muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 500;
    }
    .tile.blur-flagged .status { color: var(--warn); }
    .tile.pending { opacity: 0.55; }
```

The previous `.badge*` family (with `.badge.uploaded`, `.badge.pending`, `.badge.failed`, `.badge.converting`, `.badge.blur`) is replaced by `.idx` + `.status`. The script side (Task 10) will swap to those class names.

- [ ] **Step 5: Update `.add-tile`**

Replace the `.add-tile` block (lines ~201–216) with:

```css
    .add-tile {
      aspect-ratio: 3 / 4;
      border: 1px dashed var(--border-strong, #2c2c2e);
      border-radius: 6px;
      background: transparent;
      color: var(--fg-faint);
      display: grid; place-items: center;
      cursor: pointer;
      transition: border-color 180ms var(--ease-smooth), color 180ms var(--ease-smooth);
    }
    .add-tile .glyph { display: grid; place-items: center; gap: 2px; }
    .add-tile .plus { font-size: 24px; line-height: 1; font-weight: 200; }
    .add-tile .label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.12em; }
    .add-tile:focus-visible {
      outline: 1px solid var(--focus-ring);
      outline-offset: 2px;
    }
```

- [ ] **Step 6: Update `footer.actions` + buttons**

Replace `footer.actions`, `.btn`, `.btn-secondary`, `.btn-primary`, `.helper`, `input[type=file]` rules (lines ~218–263) with:

```css
    footer.actions {
      position: sticky; bottom: 0; z-index: 10;
      padding: 12px 16px calc(18px + env(safe-area-inset-bottom, 0px));
      background: rgba(14, 14, 16, 0.95);
      backdrop-filter: saturate(180%) blur(8px);
      -webkit-backdrop-filter: saturate(180%) blur(8px);
      border-top: 1px solid var(--border);
      display: grid; gap: 8px;
    }
    .add-row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .btn {
      width: 100%;
      padding: 9px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 500;
      border: 1px solid var(--border-cta);
      background: transparent;
      color: var(--fg-body);
      text-align: center;
      display: flex; align-items: center; justify-content: center; gap: 6px;
      cursor: pointer;
      transition: border-color 180ms var(--ease-smooth), color 180ms var(--ease-smooth);
    }
    .btn-primary {
      border-color: var(--border-cta-strong);
      color: var(--fg-primary);
    }
    .btn:disabled {
      border-color: var(--border);
      color: var(--fg-faint);
      cursor: not-allowed;
    }
    .btn:focus-visible { outline: 1px solid var(--focus-ring); outline-offset: 2px; }
    input[type=file] { position: absolute; left: -9999px; }
```

(`.helper` rule deleted — persistent helper text removed in v3.)

- [ ] **Step 7: Update `.banner` + `.success-screen` rules**

Replace `.banner.error`, `.banner.warn`, `.banner.info`, `.success-screen`, `.success-icon` (lines ~336–369) with:

```css
    .banner {
      padding: 12px 14px;
      border-radius: 8px;
      margin-bottom: 12px;
      font-size: 14px;
      line-height: 1.4;
      display: flex; align-items: flex-start; gap: 8px;
      background: transparent;
      border: 1px solid var(--border);
    }
    .banner.error { border-left: 2px solid var(--error); color: var(--fg-body); }
    .banner.warn { border-left: 2px solid var(--warn); color: var(--fg-body); }
    .banner.info { color: var(--fg-secondary); }

    .success-screen {
      display: none;
      flex-direction: column; align-items: center; justify-content: center;
      gap: 16px;
      padding: 48px 24px;
      text-align: center;
      animation: fade-in 260ms var(--ease-enter) both;
    }
    .success-screen.visible { display: flex; }
    .success-icon {
      width: 56px; height: 56px;
      border-radius: 50%;
      border: 1px solid var(--border-cta);
      display: grid; place-items: center;
      color: var(--fg-primary);
    }
    .success-icon svg { width: 24px; height: 24px; }
    .success-screen h2 { margin: 0 0 4px; font-size: 17px; font-weight: 400; color: var(--fg-primary); }
    .success-screen p { margin: 0; color: var(--fg-muted); font-size: 11.5px; line-height: 1.5; max-width: 220px; }
    @keyframes fade-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes blur-flash {
      0%, 100% { box-shadow: 0 0 0 0 rgba(212, 166, 74, 0); }
      50%      { box-shadow: 0 0 0 6px rgba(212, 166, 74, 0.40); }
    }
```

(The previous `pop` keyframe is replaced with `fade-in`. Update `blur-flash` color token from amber to warn.)

- [ ] **Step 8: Update body markup — header**

Find `<header class="bar" role="banner">` and its children (lines ~385–394) and replace with:

```html
  <header class="bar" role="banner">
    <div class="title">
      <h1 id="page-title">Capture</h1>
      <span class="photo-count"><span id="photo-count">0</span> <span id="photo-count-noun">photos</span></span>
    </div>
    <span class="pill" id="conn-pill" role="status" aria-live="polite">
      <span class="dot" aria-hidden="true"></span>
      <span id="conn-text">Connected</span>
    </span>
  </header>
```

(Drop `#workflow-label` and `#context-hint` IDs — gone with the workflow tag.)

- [ ] **Step 9: Drop the `<div class="substrip">` block**

Find the `<div class="substrip">…</div>` in `<main>` (lines ~397–400) and delete it. The `<main>` should now just contain `<div id="banner-host" aria-live="polite"></div>`, `<div class="grid" id="grid" role="list"></div>`, and `<div class="success-screen" id="success">…</div>`.

- [ ] **Step 10: Update success-screen markup**

Replace the `<div class="success-screen" id="success" role="status">…</div>` block with:

```html
    <div class="success-screen" id="success" role="status">
      <div class="success-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
      </div>
      <h2>Sent for processing</h2>
      <p>Your laptop has the photos. You can close this tab.</p>
    </div>
```

- [ ] **Step 11: Update footer markup — Camera + Gallery + Done**

Replace the entire `<footer class="actions" id="footer">…</footer>` block with:

```html
  <footer class="actions" id="footer">
    <div class="add-row">
      <label for="picker-camera" class="btn" id="take-btn">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"></path>
          <circle cx="12" cy="13" r="4"></circle>
        </svg>
        Camera
      </label>
      <input type="file" id="picker-camera" accept="image/*,image/heic,image/heif" capture="environment">
      <label for="picker-gallery" class="btn" id="gallery-btn">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2"></rect>
          <circle cx="8.5" cy="8.5" r="1.5"></circle>
          <polyline points="21 15 16 10 5 21"></polyline>
        </svg>
        Gallery
      </label>
      <input type="file" id="picker-gallery" accept="image/*,image/heic,image/heif" multiple>
    </div>
    <button class="btn btn-primary" id="done-btn" disabled>
      <span id="done-label">Done</span>
    </button>
  </footer>
```

(Two file inputs — Camera with `capture="environment"`, Gallery without it but with `multiple`. Both `<input>` are siblings of their `<label>` for accessibility / Safari compatibility.)

- [ ] **Step 12: Verify HTML parses**

Run: `node -e "require('fs').readFileSync('src/capture/mobile.html', 'utf8')"`

Expected: no error.

- [ ] **Step 13: Commit**

```bash
git add src/capture/mobile.html
git commit -m "feat(mobile-capture): header + grid + footer for Editorial Calm

New header layout: 'Capture' + photo-count subtext on the left, mono
caps connection pill on the right (workflow tag removed). Photo count
moved out of the substrip — substrip removed entirely. Filled status
badges replaced by mono '.idx' + '.status' caps text. Sent screen now
uses an outlined tick + fade-in (no filled green disc, no bouncy pop).

Footer becomes a 2-col Camera/Gallery row + full-width Done. Two
<input type=file> elements: Camera (capture=environment) and Gallery
(multiple, no capture). All buttons same compact size; Done's primary
status comes from a brighter outline only."
```

---

## Task 10 — `mobile.html`: script wiring for Gallery input + new badge markup

**Files:**
- Modify: `src/capture/mobile.html` lines ~474–end (the `<script>` block).

The script needs to:
1. Listen on `picker-camera` AND `picker-gallery` (was `picker`).
2. Update the `photo-count` element in the header (was bound to substrip).
3. Render tiles with `.idx` + `.status` classes (was `.badge*`).
4. No longer reference `workflowLabel`, `contextHint`, `savedStatus` DOM nodes.

- [ ] **Step 1: Update the `els` ref block**

Find `var els = { ... }` (lines ~489–515) and replace with:

```js
  var els = {
    pageTitle: document.getElementById("page-title"),
    photoCount: document.getElementById("photo-count"),
    photoCountNoun: document.getElementById("photo-count-noun"),
    connPill: document.getElementById("conn-pill"),
    connText: document.getElementById("conn-text"),
    bannerHost: document.getElementById("banner-host"),
    grid: document.getElementById("grid"),
    success: document.getElementById("success"),
    footer: document.getElementById("footer"),
    pickerCamera: document.getElementById("picker-camera"),
    pickerGallery: document.getElementById("picker-gallery"),
    takeBtn: document.getElementById("take-btn"),
    galleryBtn: document.getElementById("gallery-btn"),
    doneBtn: document.getElementById("done-btn"),
    doneLabel: document.getElementById("done-label"),
    sheet: document.getElementById("sheet"),
    sheetScrim: document.getElementById("sheet-scrim"),
    sheetPhotoNum: document.getElementById("sheet-photo-num"),
    sheetRetake: document.getElementById("sheet-retake"),
    sheetMarkBlank: document.getElementById("sheet-mark-blank"),
    sheetDelete: document.getElementById("sheet-delete"),
    sheetCancel: document.getElementById("sheet-cancel"),
    lightbox: document.getElementById("lightbox"),
    lightboxImg: document.getElementById("lightbox-img"),
    lightboxClose: document.getElementById("lightbox-close"),
  };
```

- [ ] **Step 2: Find every reference to deleted DOM ids and patch**

Run a search inside the script for `workflowLabel`, `contextHint`, `savedStatus`. For each:
- `els.workflowLabel.textContent = ...` lines: delete (no longer applicable; the page title is static "Capture").
- `els.contextHint.textContent = ...` lines: delete.
- `els.savedStatus.classList.toggle(...)` / `els.savedStatus.textContent = ...`: delete.

Search inside the script for the previous `.badge.idx`, `.badge.status`, `.badge.blur` class names (these are class strings in the JS that creates tile DOM). Update tile creation to use `<span class="idx">` and `<span class="status">` per the new CSS in Task 9.

Specifically, find the tile-render function (likely `renderGrid()` or `renderTile()` — search for `addBadge` or `class="badge`). For the badges:
- Index badge → `<span class="idx">${index + 1}</span>`
- Status text → `<span class="status">${statusLabel}</span>` (where statusLabel is the lowercased word: `pending`, `failed`, `converting`, `blurry`)
- Remove the `<span class="badge blur">…</span>` element entirely; the `.tile.blur-flagged` outline + `.status` showing `blurry` covers it.

- [ ] **Step 3: Wire up both file inputs**

Find the existing `els.picker.addEventListener("change", …)` block and split it into two:

```js
  els.pickerCamera.addEventListener("change", function (e) {
    handleFiles(e.target.files);
    e.target.value = "";
  });
  els.pickerGallery.addEventListener("change", function (e) {
    handleFiles(e.target.files);
    e.target.value = "";
  });

  function handleFiles(files) {
    if (!files || files.length === 0) return;
    if (state.pickerMode && state.pickerMode.indexOf("retake-") === 0) {
      // Retake flow can only consume one file; ignore extras.
      var idx = parseInt(state.pickerMode.slice("retake-".length), 10);
      if (Number.isFinite(idx)) replacePhoto(idx, files[0]);
      state.pickerMode = "add";
      return;
    }
    for (var i = 0; i < files.length; i++) addPhoto(files[i]);
  }
```

(If the existing code already has a generic `addPhoto(file)` function plus a `replacePhoto(idx, file)` retake hook, the above wires them. If those names differ, agent: search and adapt — keep the same behavior, just route both inputs through one `handleFiles`.)

- [ ] **Step 4: Update the photo-count display path**

Find the existing `updateCounts()` (or `updateSubstrip()`) function. Update it to:

```js
  function updateCounts() {
    var n = state.photos.length;
    els.photoCount.textContent = String(n);
    els.photoCountNoun.textContent = n === 1 ? "photo" : "photos";
    var canFinalize = n > 0 && state.sessionState === "open";
    els.doneBtn.disabled = !canFinalize;
    // The previous .substrip 'auto-saved' element is gone.
  }
```

Make sure every place that previously updated the substrip now calls `updateCounts()` (or call this from existing `render()` /`reconcileManifest()` paths).

- [ ] **Step 5: Update the Done button to drop the count**

Find any place that sets `els.doneLabel.textContent = "Done · " + n` (or similar) and change it to `els.doneLabel.textContent = "Done"`.

- [ ] **Step 6: Test the page parses by booting the dashboard**

Run: `npm run dashboard`

Open http://localhost:5173. Open a capture session (oath-signature or any workflow that triggers `CaptureModal`). On the laptop, copy the `capture.local/...` URL from the modal — open it in a phone browser via the same LAN, OR use Chrome DevTools' device emulation to open it as a phone.

Verify on the phone view:
- Header shows "Capture" + "0 photos", `● Connected` mono caps right.
- No `emergency-contact` tag visible.
- No substrip below the header.
- Empty state shows the "Add the first photo" panel (only after Step 7 below adds it). Until then, the empty page is just a blank grid + footer — that's fine for this commit.
- Footer: Camera + Gallery side-by-side, Done full-width below.
- Tap Camera — OS camera UI opens.
- Tap Gallery — Photo Library picker opens (no camera).
- Pick / shoot 2-3 photos — they appear in the grid; header updates to "3 photos."
- Done button enables once at least one photo lands.

Stop the server.

- [ ] **Step 7: Commit**

```bash
git add src/capture/mobile.html
git commit -m "feat(mobile-capture): wire Camera + Gallery inputs + count to header

Two <input type=file> handlers route through handleFiles; Gallery
omits 'capture=environment' and accepts 'multiple'. Photo count
binds to the new .photo-count span in the header. Tile DOM uses
.idx / .status (was .badge family). DOM refs to the deleted
workflow-label / context-hint / saved-status nodes are removed."
```

---

## Task 11 — `mobile.html`: empty state for "Add the first photo"

**Files:**
- Modify: `src/capture/mobile.html` — main markup + a tiny JS toggle.

- [ ] **Step 1: Add empty-state CSS**

In the `<style>` block, after the `.grid` rule, add:

```css
    .empty-state {
      display: none;
      flex-direction: column; align-items: center; justify-content: center;
      gap: 14px;
      padding: 56px 24px 24px;
      text-align: center;
    }
    .empty-state.visible { display: flex; }
    .empty-state .icon-wrap {
      width: 56px; height: 56px;
      border-radius: 50%;
      border: 1px solid var(--border-strong, #2c2c2e);
      display: grid; place-items: center;
      color: var(--fg-faint);
    }
    .empty-state h2 {
      margin: 0;
      font-size: 14px; font-weight: 400; color: var(--fg-body);
    }
    .empty-state p {
      margin: 0; font-size: 11.5px; color: var(--fg-muted);
      line-height: 1.5; max-width: 220px;
    }
```

- [ ] **Step 2: Add markup**

In `<main>`, before `<div class="grid">`, insert:

```html
    <div class="empty-state" id="empty-state">
      <div class="icon-wrap" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"></path>
          <circle cx="12" cy="13" r="4"></circle>
        </svg>
      </div>
      <h2>Add the first photo</h2>
      <p>Take pages with your camera, or pick existing scans from your photo library.</p>
    </div>
```

- [ ] **Step 3: Wire the toggle**

In the script's `els` block, add `emptyState: document.getElementById("empty-state")`.

In the function that updates the grid (likely `render()` or wherever new photos get appended), append:

```js
  els.emptyState.classList.toggle("visible", state.photos.length === 0 && state.sessionState === "open");
  els.grid.style.display = state.photos.length === 0 ? "none" : "grid";
```

- [ ] **Step 4: Smoke**

Restart `npm run dashboard`, open the capture URL on the phone view (or via DevTools device emulation). Empty state shows when 0 photos. Disappears when first photo lands. Done stays disabled.

- [ ] **Step 5: Commit**

```bash
git add src/capture/mobile.html
git commit -m "feat(mobile-capture): empty state — 'Add the first photo'"
```

---

## Task 12 — Final cleanup: delete now-unused tokens + verify acceptance criteria

**Files:**
- Modify: `src/dashboard/index.css` (delete dead tokens) + grep across `src/`.

- [ ] **Step 1: Grep for dead tokens still referenced anywhere**

Run:

```
grep -rn "var(--capture-success" src/ ; \
grep -rn "var(--capture-warn-bg\|--capture-warn-fg\|--capture-warn-border" src/ ; \
grep -rn "var(--capture-error-bg\|--capture-error-fg\|--capture-error-border" src/ ; \
grep -rn "var(--capture-glow" src/
```

Expected: no output. Any hits indicate a missed call site — fix it inline before deleting tokens.

- [ ] **Step 2: Delete the unused token declarations from `index.css` if any remain**

Tokens that should already have been removed in Task 1 / 2:
- `--capture-success`, `--capture-success-hover`, `--capture-success-fg`, `--capture-success-bg`, `--capture-success-border`
- `--capture-warn-fg`, `--capture-warn-bg`, `--capture-warn-border`
- `--capture-error-fg`, `--capture-error-bg`, `--capture-error-border`
- `--capture-glow-success`, `--capture-glow-error`

If grep at Step 1 finds none, no change needed. If any remain in `index.css`, delete them.

- [ ] **Step 3: Run typecheck + a unit-test smoke**

Run:

```
npm run typecheck && npm run test --silent
```

Expected: typecheck PASS, all existing unit tests still PASS. (Tests are server/handler-level — none assert against the styles touched here.)

- [ ] **Step 4: Acceptance-criteria walkthrough**

Run `npm run dashboard`. Manually verify each item in §10 of the spec:

1. Both desktop modals render in C theme — no green CTAs, no warm-brown bg, all dividers are 1px hairlines. ✓
2. Header pattern matches across both modals — title-block max-width 360px, workflow tag mono on the right with one clean line. ✓
3. Action row 4-col rhythm holds — Finalize/Run primary spans 3 cols, Discard/Cancel ghost spans 1 col. ✓
4. CaptureModal photo grid scales — at 12 photos, 3 rows × 4 cols, action row stays anchored. ✓
5. RunModal dropzone → file-row → progress flow uses the same outer container shape. ✓
6. Phone header shows "Capture / N photos" left, `● connected` right; no `emergency-contact` tag. ✓
7. Phone footer: Camera + Gallery + Done; all three buttons same size; Done's primary status is outline-brightness only. ✓
8. Phone Gallery button opens the OS photo library on iOS (no camera) and the file picker on Android. ✓ (manual)
9. Sent screen shows an outlined tick (no filled green disc, no bouncy pop). ✓
10. Blurry photo shows a thin warm hairline outline + tiny "blurry" caps label. ✓
11. No `--capture-success-*`, `--capture-warn-bg`, `--capture-error-bg`, or `--capture-glow-*` tokens are read anywhere in `src/`. ✓ (Step 1)

If anything fails, fix it inline and re-run.

- [ ] **Step 5: Final commit**

```bash
git add -A src/dashboard/index.css
git commit -m "chore(capture): finalize Editorial Calm migration

All deprecated tokens deleted; acceptance criteria from spec §10
verified against a running dashboard. Three surfaces — CaptureModal,
RunModal, mobile.html — now share one neutral grayscale + hairline
visual system. No backend changes."
```

If Step 1 found nothing and Step 2 was a no-op, this commit may be empty — `git commit --allow-empty` with the same message is acceptable, or skip and consider Task 11's commit the close.

---

## Self-Review Notes

**Spec coverage:**

- §1 Goals — covered by all tasks (visual identity, one system, dark dashboard alignment, no regressions).
- §2 Visual system tokens — Task 1 + 2.
- §3 CaptureModal — Tasks 3, 4, 5, 6.
- §3.5 State coverage — Task 6 (action row variants per state).
- §4 RunModal — Task 8.
- §5 Phone view — Tasks 9, 10, 11.
- §6 Token consolidation — Tasks 1, 12.
- §7 What stays unchanged — implicit (none of the tasks touch backend, API, or state machines).
- §8 Out of scope — implicit; no tasks added for any of those items.
- §9 Files touched — exactly the five files listed; the test file mention is a "if exists" — none exists, so nothing to update.
- §10 Acceptance criteria — Task 12 walkthrough.

**Type/name consistency:**

- `CapturePhotoTile` props unchanged.
- `CaptureModalProps` unchanged.
- `RunModalProps` unchanged.
- `LeftColumnProps` / `RightColumnProps` change — narrowed/expanded; both updated in the same task (Task 6).
- `CtaButton` signature unchanged.
- New helpers: `formatShortcode`, `describeStatus` — defined where they're used (Tasks 4, 5).
- New sub-components: `Dropzone`, `FileRow`, `UploadProgress`, `RosterRow` — all defined in Task 8.

No placeholders, no TBDs.
