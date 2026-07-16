# old-kronos — Selector Lessons

Structured record of selector mistakes and their fixes. Future Claude sessions should read this BEFORE re-mapping a selector. Before adding an entry, search for related guidance and update/merge stale or contradictory lessons; add a new bottom entry only for a genuinely new failure mode.

Each entry has the same shape so `npm run selector:search` can index it. Required fields: **Tried**, **Failed because**, **Fix**, **Tags**. Optional: **Selector** (if there's a registry entry), **References**.

---

## 2026-03-16 — `widgetFrame` name drifts and frames disappear after refresh

**Tried:** `page.frame({ name: "widgetFrame804" })` once at the top of the workflow, holding the reference.
**Failed because:** UKG sometimes hands out `widgetFrame803` or any other suffix, and a page refresh detaches the previous frame entirely. Held references throw `frame is detached` errors mid-workflow.
**Fix:** Always look the frame up fresh via `getGeniesIframe(page)` in `navigate.ts`. The helper has a 4-level fallback (exact name → query selector → `page.frames()` scan → full reload retry, up to 15 attempts). Plus an SSO-bounce probe via `ssoProbe.ssoField` that re-runs `loginToUKG()` if UKG kicked the session back to the SSO page.
**Selector:** `ssoProbe.ssoField` in `selectors.ts`
**Tags:** widgetframe, iframe, frame, refresh, sso, login, probe, retry

## 2026-03-16 — Date inputs require digit-by-digit typing

**Tried:** `dateInput.fill("03/15/2026")` to fill the timeframe selection date range.
**Failed because:** UKG date inputs use a custom JQX widget that does not consume the bulk fill — the field stays empty or accepts only partial values, then validation rejects the range.
**Fix:** Use the `setDateRange` helper in `navigate.ts`: triple-click to select existing text, press Delete, press Home, then type each digit with a 100 ms delay. The widget commits the value mid-typing.
**Selector:** `dateRange.dateInputs`, `dateRange.applyButton` in `selectors.ts`
**Tags:** date, input, fill, type, jqx, widget, range

## 2026-04-01 — Stale "Complete" row from previous run hijacks status polling

**Tried:** Polling the report status table immediately after clicking Run Report; matching the first row that read "Complete".
**Failed because:** UKG renders a previous run's "Complete" row at the top until the new row appears. The poll matched it and tried to View Report on stale results.
**Fix:** Two-phase polling. Phase 1: find the Running/Waiting row by TR id. Phase 2: poll *that specific row* by TR id until the row's status reads Complete. Skip the first match if it predates the click. Encoded in `waitForReportAndDownload` in `reports.ts`.
**Selector:** `reportsPage.checkStatusSelectors`, `reportsPage.refreshStatusSelectors` in `selectors.ts`
**Tags:** report, status, polling, stale, complete, running, view

## 2026-06-17 — `calendarButton` second `.or()` branch was malformed CSS

**Tried:** `button.btn.i.dropdown-toggle[title='Select Dates']` as the second fallback for the date range calendar button (treating `i` as an additional class selector).
**Failed because:** `i` in a CSS compound selector is a type-selector for `<i>` elements, not a class. The intent was `button.btn.dropdown-toggle[title='Select Dates']` (a button with those classes and title). As written, `button.btn.i.dropdown-toggle[title='Select Dates']` attempts to match an element that is simultaneously a `<button>`, a `<div class="btn">`, an `<i>`, and a `<div class="dropdown-toggle">` with that title — which never exists. This selector was called 22× with 10s timeouts so fixing it meaningfully reduces per-run cost when the primary branch misses.
**Fix:** Simplified second branch to `button[title='Select Dates']` — precise, robust, and avoids the class/type confusion. The primary branch (`button:has(i.icon-k-calendar)`) is unchanged. // NEEDS LIVE RE-VERIFY 2026-06-17
**Selector:** `dateRange.calendarButton` in `selectors.ts`
**Tags:** calendar, button, date-range, css, malformed, class, type-selector, fallback

## 2026-06-17 — `dismissModal` probe timeouts cost 3s per absent modal

**Tried:** `clickIfPresent(okBtn, { timeout: 3_000 })` and `clickIfPresent(closeBtn, { timeout: 3_000 })` — each probe runs 5+ times per document.
**Failed because:** When no modal is present both probes each wait the full 3s before returning false, spending up to 6s doing nothing per invocation.
**Fix:** Reduced both timeouts to 1_500ms. The 300ms preamble wait lets a real modal appear; 1.5s is more than enough to detect a rendered button. When a modal is present the click resolves in <200ms anyway — success-path latency is unchanged.
**Selector:** `modalDismiss.okButton`, `modalDismiss.closeButton` in `selectors.ts`
**Tags:** modal, dismiss, timeout, performance, clickIfPresent

## 2026-03-16 — Modal dialogs pop up between steps without warning

**Tried:** Driving the Genies grid (search, click row, Go To) without checking for modals.
**Failed because:** UKG randomly shows confirmation dialogs (timezone change, session warning, network notice) between steps. Subsequent clicks land on the modal and stall the workflow.
**Fix:** Call `dismissModal(page, iframe)` from `navigate.ts` before each interaction. The helper iterates through OK / Close button variants registered in `modalDismiss` and is best-effort — it is fine if no modal is present.
**Selector:** `modalDismiss.okButton`, `modalDismiss.closeButton` in `selectors.ts`
**Tags:** modal, dialog, dismiss, ok, close, between-steps

## 2026-06-17 — Audit screenshot of the timecard needs scroll-to-date-then-CENTERED-VIEWPORT, not fullPage

**Tried:** Capturing the Old Kronos timecard with the generic all-systems `ctx.screenshot` (which uses `Session.captureFullPage` → `page.screenshot({ fullPage: true })`) to record the latest worked date for the separations audit.
**Failed because:** The UKG timecard is a VIRTUAL-SCROLL grid living in a nested iframe — `fullPage` only renders the rows currently in the DOM, so off-screen dates (including the actual latest day if it scrolled out) never make it into the image. The shot also captured all 4 separation browsers in one event because no `systems` filter was set.
**Fix:** Added `scrollTimecardToDate(page, targetDate)` to `navigate.ts` (walks `page.frames()` to find the timecard iframe, matches the date cell — `cells[2]` text like "Mon 3/16" — and `scrollIntoView({ block: "center" })`), then take a VIEWPORT-only shot via `ctx.screenshot({ systems:['old-kronos'], centerSelector:'iframe', label:'old-kronos-last-worked-date' })`. `centerSelector` (kernel `Session.captureViewportCenteredOnElement`) captures the viewport, NOT fullPage. Best-effort: fires even if the row lookup missed. The row/date-cell selector mirrors `getTimecardLastDate` and is flagged `// NEEDS LIVE RE-VERIFY 2026-06-17` in `navigate.ts` — confirm against the live frame in the live phase.
**Tags:** screenshot, timecard, virtual-scroll, fullpage, viewport, scroll-to-date, center, iframe, audit

## 2026-07-16 — Period-switch verification uses the real selector value and rendered row bounds

**Tried:** Treating the Previous Pay Period link detaching as sufficient evidence that the timecard changed, while the `#timeframe-selector-input` value semantics and grid range remained unverified.
**Failed because:** A detached dropdown item proves only that the click registered; reading a stale period would silently parse the wrong employee dates. Broad inferred date windows also were not the actual visible range.
**Fix:** Live `playwright-cli` verification observed `#timeframe-selector-input` change from “Current Pay Period” to “Previous Pay Period” while rows changed from 7/05–7/18 to 6/21–7/04. Both the Genies frame and Timecards frame expose that same ID, so the switch first requires actual date-shaped timecard rows before using the registry locator for its DOM click/readback. `getVisibleTimecardMonthDays` uses the same discriminator and supplies the rendered endpoints to shared year resolution.
**Tags:** timecard, pay-period, selector, readback, visible-range, year, live-verified, fail-loud
