# old-kronos — Selector Lessons

Append-only record of selector mistakes and their fixes. Future Claude sessions should read this BEFORE re-mapping a selector. New entries go at the bottom.

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

## 2026-03-16 — Modal dialogs pop up between steps without warning

**Tried:** Driving the Genies grid (search, click row, Go To) without checking for modals.
**Failed because:** UKG randomly shows confirmation dialogs (timezone change, session warning, network notice) between steps. Subsequent clicks land on the modal and stall the workflow.
**Fix:** Call `dismissModal(page, iframe)` from `navigate.ts` before each interaction. The helper iterates through OK / Close button variants registered in `modalDismiss` and is best-effort — it is fine if no modal is present.
**Selector:** `modalDismiss.okButton`, `modalDismiss.closeButton` in `selectors.ts`
**Tags:** modal, dialog, dismiss, ok, close, between-steps
