# SharePoint / Excel Online Module

Headed browser automation for downloading files from UCSD's SharePoint / OneDrive (Microsoft 365) — specifically the Excel Online viewer at `ucsdcloud-my.sharepoint.com/.../doc2.aspx`. Current consumer is the "Download onboarding spreadsheet" button in the dashboard queue header, which pulls a roster xlsx into `src/data/`.

## Files

- `selectors.ts` — **Selector registry** (Subsystem A). Grouped: `microsoft` (email prefill), `kmsi` (Stay-signed-in), `getExcelFrame` + `excelOnline` (WAC iframe handle + ribbon), `fileMenu` (backstage + Create a Copy / Export flyouts).

## Auth flow (verified 2026-04-22)

SharePoint pushes you through four auth layers. Every other workflow that talks to an SSO-backed Microsoft / UC system uses the same helpers, so REUSE them — do not re-implement login logic here.

1. **Microsoft AAD email prefill** (`login.microsoftonline.com/.../oauth2/authorize`) — sometimes skipped when cookies are warm.
   - `microsoft.emailInput(page).fill("${userId}@ucsd.edu")`
   - `microsoft.nextButton(page).click()`
2. **UCSD ADFS federation login** (`ad-wfs-aws.ucsd.edu/adfs/ls/`) — NOT the Shibboleth IdP at `a5.ucsd.edu` that UCPath / Kuali / Kronos / CRM use. Microsoft pre-populates the username via the `?username=` URL param; just fill the password and click Sign in.
   - `adfs.passwordInput(page).fill(password)`
   - `adfs.submitButton(page).click()`
   - See `handleAdfsLogin()` in `src/workflows/sharepoint-download/download.ts` for the canonical caller. Falls back to Shibboleth (`fillSsoCredentials` + `clickSsoSubmit`) if AAD ever routes us there instead — detection is URL-prefix based.
3. **Duo MFA** (`api-*.duosecurity.com/frame/frameless/v4/auth`).
   - `pollDuoApproval(page, { systemLabel: "SharePoint", successUrlMatch: (u) => u.includes("sharepoint.com") || u.includes("office.com") || u.includes("login.microsoftonline.com/kmsi"), timeoutSeconds: 180 })` from `src/auth/duo-poll.ts`. The poller already handles "Try Again" (Duo push timeout → resend) and "Yes, this is my device" (device-trust nudge) — do not duplicate.
4. **KMSI / "Stay signed in?"** (`login.microsoftonline.com/login.srf`).
   - `kmsi.noButton(page).click()` — always No. Let the persistent browser profile decide what to remember, not AAD.

## Download flow (inside the Excel Online iframe)

After KMSI, the page settles at `ucsdcloud-my.sharepoint.com/.../doc2.aspx`. The ribbon, workbook, and File backstage all live inside `iframe[name="WacFrame_Excel_0"]`. **Any selector that targets the ribbon or menu MUST be scoped to that FrameLocator** or the click silently no-ops.

```ts
const frame = getExcelFrame(page);
await excelOnline.fileButton(frame).click();          // open backstage
await fileMenu.createACopy(frame).hover();            // open flyout — must HOVER, not click
await fileMenu.downloadACopy(frame).click();          // fires browser download event → xlsx
```

### Why `Create a Copy → Download a Copy`, not `Export`

`fileMenu.export(frame)` opens a sibling flyout, but it only offers PDF / CSV / CSV UTF-8 / ODS — there is no "Download as Workbook" under Export. The xlsx download lives under **Create a Copy**, next to `Create a copy online`. Click the wrong one and you'll navigate to the New / Save-As wizard.

The hover-first pattern is critical: clicking `Create a Copy` (instead of hovering) triggers the default action ("Create a copy online"), which is a destructive no-op for our use case.

## Before mapping a new selector

1. Run `npm run selector:search "<your intent>"` and review top matches across all systems.
2. If a selector matches your intent, USE IT — do not map a new one.
3. Otherwise, add the selector function with JSDoc (one-line summary, `@tags`, `verified YYYY-MM-DD`), then run `npm run selectors:catalog` to regenerate [`SELECTORS.md`](./SELECTORS.md).

## Gotchas

- `iframe[name="WacFrame_Excel_0"]` — the trailing `_0` is a suffix for the Nth Excel viewer on the page. For single-doc views it's always `0`; if you ever embed multiple viewers the suffix increments.
- `excelOnline.coEditingBanner` can be used as a readiness probe but only fires when someone else has the workbook open. Don't depend on it for general page-ready detection; prefer `page.waitForLoadState("networkidle")` plus a small fixed wait.
- The File button's accessible name is `"File"` (exact). There's also a `Files` ribbon tab in some Office hosts — not in Excel Online, but keep `exact: true` defensively.
- Download triggers via a `page.on("download", ...)` event; the file streams into the Playwright CLI workspace's `.playwright-cli/` folder during CLI probing, but the real `downloadSharePointFile` helper uses `download.saveAs()` to land the bytes in `src/data/`.
- The dashboard button's endpoint (`POST /api/sharepoint-download/run`, handled by `buildSharePointRosterDownloadHandler` in `src/workflows/sharepoint-download/handler.ts`) holds a module-level in-flight lock — concurrent clicks get HTTP 409. Don't try to call the helper twice in parallel.

## Lessons Learned

- **2026-04-22: SharePoint federates through ADFS (`ad-wfs-aws.ucsd.edu`), not Shibboleth (`a5.ucsd.edu`).** Initial `loginToSharePoint` reused the Shibboleth-scoped SSO detection (`url.includes("a5.ucsd.edu") || input[name="j_username"]`) and `fillSsoCredentials` helper. For the SharePoint redirect chain, AAD actually hands off to UCSD's ADFS endpoint, which has a different form shape (`input[name="UserName"]` / `input[name="Password"]` / `#submitButton`). Detection fell through to "No SSO redirect — cached cookies" and the run failed the post-auth URL check. Fixed by adding `adfs.*` selectors + an ADFS branch in `handleAdfsLogin`. See `LESSONS.md` for the full write-up.
- **2026-04-22: Excel Online ribbon is iframe-scoped.** Mapped the full download flow via `playwright-cli -s=sp-roster`. Initial implementation's `page.getByRole("button", { name: /file/i })` returned 0 matches because the ribbon lives inside `iframe[name="WacFrame_Excel_0"]`. Wrapped every post-KMSI selector in `getExcelFrame(page)` and the click started working. Also discovered that `File → Download a Copy` is a flyout under `Create a Copy` (not a direct item), so the interaction is `hover(createACopy) → click(downloadACopy)`, not `click(File) → click(downloadACopy)`.
- **2026-04-22: Export flyout does NOT contain xlsx.** First instinct was to probe `File → Export → Download as Workbook`. Export only offers PDF / CSV / CSV UTF-8 / ODS. xlsx is under `Create a Copy`.
