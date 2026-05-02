import type { Page } from "playwright";

export const HR_INQUIRY_FORM_URL =
  "https://support.ucsd.edu/esc?id=sc_cat_item&table=sc_cat_item&sys_id=d8af3ae8db4fe510b3187d84f39619bf";

/**
 * Navigate directly to the HR Inquiry form. Assumes the page is already
 * authenticated (loginToServiceNow ran earlier in the session).
 *
 * Uses `waitUntil: "domcontentloaded"` because ServiceNow's portal fires
 * a lot of background XHR even after the form is interactive — waiting
 * for full networkidle would add 5–10s of dead time to every run.
 */
export async function gotoHrInquiryForm(page: Page): Promise<void> {
  await page.goto(HR_INQUIRY_FORM_URL, { waitUntil: "domcontentloaded" });
}

/**
 * Verify the page title indicates we landed on the right form. Throws a
 * clear error if SSO redirected us somewhere else (session expired,
 * permission lost, etc.) — the handler can then catch + log + rethrow.
 */
export async function verifyOnInquiryForm(page: Page): Promise<void> {
  const title = await page.title();
  if (!title.includes("HR General Inquiry")) {
    throw new Error(
      `gotoHrInquiryForm: expected title to include "HR General Inquiry", got "${title}". URL: ${page.url()}`,
    );
  }
}
