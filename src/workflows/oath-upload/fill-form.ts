import type { Locator, Page } from "playwright";
import { basename } from "node:path";
import { safeClick, safeFill } from "../../systems/common/index.js";
import { hrInquiry } from "../../systems/servicenow/selectors.js";
import { log } from "../../utils/log.js";

export interface HrInquiryFormValues {
  subject: string;
  description: string;
  specifically: string;
  category: string;
  attachmentPath: string;
}

/**
 * Read back a Select2 v3 choice anchor's displayed text and confirm it
 * matches what we tried to select. Only called from the Enter-to-accept
 * fallback (when the typed result never surfaced in the dropdown) — a blind
 * keypress has no other confirmation that the highlighted match was the
 * intended one, and an unverified value would silently ride into the
 * submitted ticket. Fails loud instead (root CLAUDE.md "no unverified
 * silent fallbacks").
 */
async function assertSelect2Choice(
  fieldLabel: string,
  choice: Locator,
  expected: string,
): Promise<void> {
  const shown = ((await choice.textContent().catch(() => null)) ?? "").trim();
  if (!shown || !shown.toLowerCase().includes(expected.trim().toLowerCase())) {
    throw new Error(
      `fillHrInquiryForm: ${fieldLabel} readback mismatch after Enter-to-accept — expected "${expected}", Select2 choice shows "${shown}"`,
    );
  }
}

/**
 * Fill the HR Inquiry form fields and attach the PDF. Does NOT click
 * Submit — the caller does that as a separate step so post-submit
 * verification stays explicit.
 */
export async function fillHrInquiryForm(page: Page, v: HrInquiryFormValues): Promise<void> {
  await safeFill(hrInquiry.subjectInput(page), v.subject, {
    label: "servicenow hr inquiry subject",
  });
  await safeFill(hrInquiry.descriptionInput(page), v.description, {
    label: "servicenow hr inquiry description",
  });

  // Specifically — ServiceNow Select2 v3 typeahead. The accessible combobox is
  // an OFFSCREEN focusser; the visible `a.select2-choice` intercepts clicks, so
  // click the choice anchor to open the drop, type into the drop's search box,
  // then click the matching result. If the result doesn't surface (different
  // ServiceNow build / layout drift), press Enter to accept the highlighted
  // match; otherwise keep the typed free-text (some configs accept it).
  await safeClick(hrInquiry.specificallyChoice(page), {
    label: "servicenow hr inquiry specifically combobox",
  });
  await safeFill(hrInquiry.select2DropSearch(page, "Specifically"), v.specifically, {
    label: "servicenow hr inquiry specifically",
  });
  // Wait for the typeahead to filter results (debounced) before attempting
  // the click, instead of a blind pause; non-throwing — the try/catch below
  // already handles a genuine miss via the Enter-to-accept fallback.
  await hrInquiry.select2ResultOption(page, "Specifically", v.specifically)
    .waitFor({ state: "visible", timeout: 2_000 })
    .catch(() => {});
  try {
    await safeClick(hrInquiry.select2ResultOption(page, "Specifically", v.specifically), {
      timeout: 3_000,
      label: "servicenow hr inquiry specifically option",
    });
  } catch {
    log.warn(
      `[oath-upload] Specifically dropdown didn't surface "${v.specifically}" — pressing Enter to accept the highlighted match`,
    );
    await page.keyboard.press("Enter").catch(() => {});
    await assertSelect2Choice("Specifically", hrInquiry.specificallyChoice(page), v.specifically);
  }

  // Category — Select2 v3 combobox. Try selectOption first (works if ServiceNow
  // renders a native <select>); fall back to the same Select2 choice→search→
  // option pattern as Specifically.
  const catInput = hrInquiry.categoryInput(page);
  try {
    await catInput.selectOption({ label: v.category }, { timeout: 3_000 });
  } catch {
    await safeClick(hrInquiry.categoryChoice(page), {
      label: "servicenow hr inquiry category combobox",
    });
    await safeFill(hrInquiry.select2DropSearch(page, "Category"), v.category, {
      label: "servicenow hr inquiry category",
    });
    // Wait for the typeahead to filter results (debounced) before attempting
    // the click, instead of a blind pause; non-throwing — the try/catch below
    // already handles a genuine miss via the Enter-to-accept fallback.
    await hrInquiry.select2ResultOption(page, "Category", v.category)
      .waitFor({ state: "visible", timeout: 2_000 })
      .catch(() => {});
    try {
      await safeClick(hrInquiry.select2ResultOption(page, "Category", v.category), {
        timeout: 3_000,
        label: "servicenow hr inquiry category option",
      });
    } catch {
      await page.keyboard.press("Enter").catch(() => {});
      await assertSelect2Choice("Category", hrInquiry.categoryChoice(page), v.category);
    }
  }

  // Attachment — set on the hidden file input directly. Bypasses the
  // visible "Choose a file" button that would surface an OS picker.
  const attachmentName = basename(v.attachmentPath);
  await hrInquiry.fileInput(page).setInputFiles(v.attachmentPath);

  // Verify the attachment actually registered before returning — a fixed
  // sleep with no check would let the caller submit with the PDF MISSING if
  // the upload lagged or silently failed (fail loud, root CLAUDE.md).
  // needs-live: `hrInquiry.attachmentConfirmationText` is a generic
  // filename-text heuristic (attachment widgets normally surface the
  // uploaded filename), not a confirmed ServiceNow attachment-confirmation
  // element — stopgap pending live verification via playwright-cli.
  try {
    await hrInquiry.attachmentConfirmationText(page, attachmentName).waitFor({
      state: "visible",
      timeout: 10_000,
    });
  } catch {
    throw new Error(
      `fillHrInquiryForm: attached "${attachmentName}" but no confirmation of the upload appeared on the form — submitting now would file the ticket with the attachment MISSING`,
    );
  }
}

/**
 * Click Submit and read the resulting redirect URL for the new ticket
 * number. ServiceNow redirects to `?id=ticket&number=HRC0XXXXXX`.
 * Throws if the post-submit URL doesn't carry the expected param.
 */
export async function submitAndCaptureTicketNumber(page: Page): Promise<string> {
  const before = page.url();
  await safeClick(hrInquiry.submitButton(page), {
    label: "servicenow hr inquiry submit",
  });
  await page
    .waitForURL(
      (url) => url.toString() !== before && url.toString().includes("number="),
      { timeout: 60_000 },
    )
    .catch(() => {
      /* fall through to a direct URL probe — waitForURL may exit on a stale event */
    });

  const url = page.url();
  const num = parseTicketNumberFromUrl(url);
  if (!num) {
    throw new Error(
      `submitAndCaptureTicketNumber: no number= param in post-submit URL "${url}"`,
    );
  }
  return num;
}

/** Pure helper — parse `number=HRC0XXXXXX` from a ServiceNow redirect URL. */
export function parseTicketNumberFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const n = u.searchParams.get("number");
    if (n && /^HRC\d{6,}$/.test(n)) return n;
    return null;
  } catch {
    return null;
  }
}
