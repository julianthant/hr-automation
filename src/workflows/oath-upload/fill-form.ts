import type { Page } from "playwright";
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

  // Specifically — ServiceNow typeahead. Click to focus, type, wait for
  // suggestion list, click matching option. If the option doesn't surface
  // (different ServiceNow build, layout drift), keep the typed text as
  // free-text (some configurations accept it).
  const specInput = hrInquiry.specificallyInput(page);
  await safeClick(specInput, { label: "servicenow hr inquiry specifically combobox" });
  await safeFill(specInput, v.specifically, { label: "servicenow hr inquiry specifically" });
  await page.waitForTimeout(800);
  const specOption = page.getByRole("option", { name: v.specifically }).first();
  try {
    await safeClick(specOption, {
      timeout: 3_000,
      label: "servicenow hr inquiry specifically option",
    });
  } catch {
    log.warn(
      `[oath-upload] Specifically dropdown didn't surface "${v.specifically}" — keeping free-text`,
    );
  }

  // Category — combobox. Try selectOption first (semantic <select>); fall
  // back to typeahead pattern if it isn't a <select>.
  const catInput = hrInquiry.categoryInput(page);
  try {
    await catInput.selectOption({ label: v.category }, { timeout: 3_000 });
  } catch {
    await safeClick(catInput, { label: "servicenow hr inquiry category combobox" });
    await safeFill(catInput, v.category, { label: "servicenow hr inquiry category" });
    await page.waitForTimeout(500);
    const catOption = page.getByRole("option", { name: v.category }).first();
    try {
      await safeClick(catOption, {
        timeout: 3_000,
        label: "servicenow hr inquiry category option",
      });
    } catch {
      /* fall through — accept whatever the combobox decided */
    }
  }

  // Attachment — set on the hidden file input directly. Bypasses the
  // visible "Choose a file" button that would surface an OS picker.
  await hrInquiry.fileInput(page).setInputFiles(v.attachmentPath);
  await page.waitForTimeout(1_000); // upload latency
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
