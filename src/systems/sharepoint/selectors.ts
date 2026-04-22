import type { Page, Locator, FrameLocator } from "playwright";

/**
 * SharePoint / Microsoft 365 / Excel Online selector registry.
 *
 * Covers the three distinct auth/UI layers the "Download onboarding
 * spreadsheet" dashboard button has to traverse:
 *
 *   1. Microsoft AAD login (login.microsoftonline.com) — email prefill step
 *      before UCSD Shibboleth SSO hands off.
 *   2. Post-Duo KMSI ("Stay signed in?") interstitial on login.srf.
 *   3. Excel Online viewer (ucsdcloud-my.sharepoint.com/.../doc2.aspx) which
 *      wraps the ribbon / workbook inside `iframe[name="WacFrame_Excel_0"]`.
 *
 * UCSD Shibboleth username/password and Duo polling live in
 * `src/auth/sso-fields.ts` + `src/auth/duo-poll.ts` and are shared with every
 * other system, so they're intentionally NOT duplicated here. Call sites
 * should compose:
 *
 *   microsoft.emailInput / microsoft.nextButton
 *     → fillSsoCredentials + clickSsoSubmit
 *     → pollDuoApproval({ systemLabel: "SharePoint", ... })
 *     → kmsi.noButton
 *     → excelOnline.getFrame + file.* + copyFlyout.*
 *
 * Verified end-to-end on 2026-04-22 via playwright-cli against the
 * ApplicantByProposedStartDate workbook at ucsdcloud-my.sharepoint.com.
 */

// ─── Microsoft AAD login (email prefill step) ───────────────────────────────

export const microsoft = {
  /**
   * Email textbox on the Microsoft sign-in page. Primary is the CSS fallback
   * (`input[name="loginfmt"]` / `input[type="email"]`) because the
   * accessible name varies by tenant ("Enter your email, phone, or Skype.").
   * verified 2026-04-22
   * @tags microsoft, login, email, textbox
   */
  emailInput: (page: Page): Locator =>
    page
      .locator('input[type="email"]')
      .or(page.locator('input[name="loginfmt"]')),

  /**
   * "Next" button on the Microsoft email step. Falls back to a generic submit
   * input since some tenants render the button as `<input type="submit">`.
   * verified 2026-04-22
   * @tags microsoft, login, next, button
   */
  nextButton: (page: Page): Locator =>
    page
      .getByRole("button", { name: /^next$/i })
      .or(page.locator('input[type="submit"][value*="Next" i]'))
      .or(page.locator('input[type="submit"]')),
};

// ─── UCSD ADFS federation login (`ad-wfs-aws.ucsd.edu/adfs/ls/`) ───────────
//
// For SharePoint / OneDrive, UCSD federates Microsoft AAD through an ADFS
// endpoint (`ad-wfs-aws.ucsd.edu`) instead of the Shibboleth IdP at
// `a5.ucsd.edu` used by UCPath / CRM / Kuali. The form is visually simpler:
// a pre-populated "User Account" textbox (Microsoft passes the email through
// on the URL), a "Password" textbox, and a "Sign in" button. After submit it
// hands off to the normal Duo frame — the same `pollDuoApproval` /
// `requestDuoApproval` helpers work against it unchanged.
//
// Field names (`UserName` / `Password` / `#submitButton`) are stable ADFS
// defaults and are reused across every UC federated ADFS tenant, so the
// primary selectors below are safe.

export const adfs = {
  /**
   * "User Account" textbox on the ADFS sign-in page. Usually pre-populated
   * by Microsoft via the `?username=` URL parameter; we still explicitly
   * re-fill it defensively in case the hand-off ever misses. Primary is the
   * stable name attribute; fallbacks are the DOM id and the accessible name.
   * verified 2026-04-22
   * @tags adfs, ucsd, sharepoint, username, textbox, login
   */
  usernameInput: (page: Page): Locator =>
    page
      .locator('input[name="UserName"]')
      .or(page.locator("#userNameInput"))
      .or(page.getByRole("textbox", { name: /User Account/i })),

  /**
   * "Password" textbox on the ADFS sign-in page.
   * verified 2026-04-22
   * @tags adfs, ucsd, sharepoint, password, textbox, login
   */
  passwordInput: (page: Page): Locator =>
    page
      .locator('input[name="Password"]')
      .or(page.locator("#passwordInput"))
      .or(page.getByRole("textbox", { name: /^password$/i })),

  /**
   * "Sign in" submit button on the ADFS sign-in page.
   * verified 2026-04-22
   * @tags adfs, ucsd, sharepoint, submit, sign-in, button, login
   */
  submitButton: (page: Page): Locator =>
    page
      .locator("#submitButton")
      .or(page.getByRole("button", { name: /^sign in$/i })),
};

// ─── "Keep me signed in?" (KMSI) interstitial — post-Duo ────────────────────

export const kmsi = {
  /**
   * "No" button on the "Stay signed in?" / KMSI prompt (login.srf). We always
   * click No so the persistent context decides what to remember, not AAD.
   * verified 2026-04-22
   * @tags microsoft, kmsi, stay-signed-in, no, button
   */
  noButton: (page: Page): Locator =>
    page
      .getByRole("button", { name: /^no$/i })
      .or(page.locator('input[type="button"][value="No"]'))
      .or(page.locator('input[type="submit"][value="No"]')),

  /**
   * "Yes" button on the KMSI prompt. Not currently clicked by any workflow —
   * kept for parity + future reuse.
   * verified 2026-04-22
   * @tags microsoft, kmsi, stay-signed-in, yes, button
   */
  yesButton: (page: Page): Locator =>
    page.getByRole("button", { name: /^yes$/i }),

  /**
   * "Don't show this again" checkbox on the KMSI prompt. Unchecked by
   * default — kept for parity + future reuse.
   * verified 2026-04-22
   * @tags microsoft, kmsi, dont-show-again, checkbox
   */
  dontShowAgainCheckbox: (page: Page): Locator =>
    page.getByRole("checkbox", { name: /don.?t show this again/i }),
};

// ─── Excel Online viewer (everything below is inside the WAC iframe) ───────

/**
 * Returns the Excel Online FrameLocator. The ribbon, file menu, and workbook
 * body all live inside `iframe[name="WacFrame_Excel_0"]` on doc2.aspx — every
 * post-auth interaction MUST go through this frame or selectors resolve to
 * nothing. verified 2026-04-22
 * @tags excel, iframe, frame, wac
 */
export function getExcelFrame(page: Page): FrameLocator {
  return page.frameLocator('iframe[name="WacFrame_Excel_0"]');
}

export const excelOnline = {
  /**
   * File button on the Excel Online ribbon (opens the backstage menu).
   * `exact: true` avoids matching "File menu", "File tab", etc.
   * verified 2026-04-22
   * @tags excel, ribbon, file, button
   */
  fileButton: (f: FrameLocator): Locator =>
    f.getByRole("button", { name: "File", exact: true }),

  /**
   * Co-editing banner ("X is now editing the workbook"). Used only as a
   * readiness probe — when visible, the ribbon has finished hydrating.
   * verified 2026-04-22
   * @tags excel, coedit, banner, readiness
   */
  coEditingBanner: (f: FrameLocator): Locator =>
    f.getByText(/is now editing the workbook/i),
};

// ─── File menu (backstage) → Create a Copy → Download a Copy ──────────────

export const fileMenu = {
  /**
   * "Create a Copy" menuitem in the File backstage. Must be HOVERED (not
   * clicked) to open the submenu containing "Download a Copy". Clicking
   * navigates to "Create a copy online" instead.
   * verified 2026-04-22
   * @tags excel, file-menu, create-a-copy, menuitem, backstage
   */
  createACopy: (f: FrameLocator): Locator =>
    f.getByRole("menuitem", { name: "Create a Copy" }),

  /**
   * "Download a Copy" menuitem — in the "Create a Copy" flyout. THIS is the
   * xlsx download path. Triggering it fires the browser's `download` event.
   * verified 2026-04-22
   * @tags excel, file-menu, download, xlsx, workbook, menuitem
   */
  downloadACopy: (f: FrameLocator): Locator =>
    f.getByRole("menuitem", { name: "Download a Copy" }),

  /**
   * "Export" menuitem — opens a flyout with non-xlsx download options only
   * (PDF / CSV / CSV UTF-8 / ODS). The xlsx download is NOT here despite the
   * name — that lives under "Create a Copy → Download a Copy".
   * verified 2026-04-22
   * @tags excel, file-menu, export, menuitem, backstage
   */
  export: (f: FrameLocator): Locator =>
    f.getByRole("menuitem", { name: "Export" }),

  /**
   * "Download as PDF" — inside the Export flyout.
   * verified 2026-04-22
   * @tags excel, export, download, pdf, menuitem
   */
  downloadAsPdf: (f: FrameLocator): Locator =>
    f.getByRole("menuitem", { name: "Download as PDF" }),

  /**
   * "Download as CSV UTF-8" — inside the Export flyout.
   * verified 2026-04-22
   * @tags excel, export, download, csv, utf8, menuitem
   */
  downloadAsCsvUtf8: (f: FrameLocator): Locator =>
    f.getByRole("menuitem", { name: "Download as CSV UTF-8" }),

  /**
   * "Download as CSV" — inside the Export flyout.
   * verified 2026-04-22
   * @tags excel, export, download, csv, menuitem
   */
  downloadAsCsv: (f: FrameLocator): Locator =>
    f.getByRole("menuitem", { name: "Download as CSV" }),

  /**
   * "Download as ODS" — inside the Export flyout.
   * verified 2026-04-22
   * @tags excel, export, download, ods, menuitem
   */
  downloadAsOds: (f: FrameLocator): Locator =>
    f.getByRole("menuitem", { name: "Download as ODS" }),
};
