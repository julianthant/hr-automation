import type { Page } from "playwright";
import { onboardingHistory } from "./selectors.js";

/**
 * Look up an employee's "Witness Ceremony Oath New Hire Signed" timestamp
 * in CRM's onboarding history.
 *
 * Two-step lookup, both via direct URL navigation (no clicks needed):
 *   1. /hr/ONB_SearchOnboardings?q=<EID>  → first result's record id
 *   2. /hr/ONB_ShowOnboardingHistory?id=<RECORD_ID>  → audit log table
 *
 * Returns the date in `MM/DD/YYYY` format (UCPath's expected
 * OathSignatureInputSchema shape) or `null` if no matching row exists
 * yet — that case is normal for an in-flight onboarding where the oath
 * hasn't been signed.
 *
 * Verified live against EID 10873611 (Jasmine Ochoa) on 2026-04-28.
 */
export async function lookupOathSignatureDate(
  page: Page,
  emplId: string,
): Promise<string | null> {
  // ── 1. Search by EID
  await page.goto(
    `https://act-crm.my.site.com/hr/ONB_SearchOnboardings?q=${encodeURIComponent(emplId)}`,
    { waitUntil: "networkidle" },
  );

  const resultLink = onboardingHistory.firstResultLink(page);
  const href = await resultLink.getAttribute("href").catch(() => null);
  if (!href) return null;
  // href is "/hr/ONB_ViewOnboarding?id=a1ZVr000004U6yXMAS"
  const idMatch = href.match(/[?&]id=([A-Za-z0-9]+)/);
  if (!idMatch) return null;
  const recordId = idMatch[1];

  // ── 2. Open the history page (deep link — bypasses the "Show
  // Onboarding History" button so we don't need its Visualforce-mutated
  // input name)
  await page.goto(
    `https://act-crm.my.site.com/hr/ONB_ShowOnboardingHistory?id=${encodeURIComponent(recordId)}`,
    { waitUntil: "networkidle" },
  );

  // ── 3. Find the row whose New Value (cell index 4) is the
  // "signed" state and return its Date (cell index 0)
  const rawDate = await onboardingHistory
    .historyRows(page)
    .evaluateAll((rows) => {
      for (const r of rows) {
        const cells = r.querySelectorAll("td.dataCell");
        if (cells.length < 5) continue;
        const newVal = (cells[4] as HTMLElement).innerText.trim();
        if (newVal === "Witness Ceremony Oath New Hire Signed") {
          return (cells[0] as HTMLElement).innerText.trim();
        }
      }
      return null;
    })
    .catch(() => null);
  if (!rawDate) return null;
  return formatCrmDateAsMmDdYyyy(rawDate);
}

/**
 * Convert CRM's "M/D/YYYY h:mm AM/PM" date format (no leading zeros) to
 * the `MM/DD/YYYY` format `OathSignatureInputSchema` expects. Returns
 * `null` if the input doesn't match the expected pattern.
 *
 * Examples:
 *   "4/27/2026 1:26 PM"  → "04/27/2026"
 *   "10/3/2026 11:00 AM" → "10/03/2026"
 *
 * Pure function — exported for unit tests.
 */
export function formatCrmDateAsMmDdYyyy(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (!m) return null;
  const mm = m[1].padStart(2, "0");
  const dd = m[2].padStart(2, "0");
  const yyyy = m[3];
  return `${mm}/${dd}/${yyyy}`;
}
