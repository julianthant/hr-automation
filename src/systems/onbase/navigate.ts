import type { Page, FrameLocator } from "playwright";
import { ONBASE_URL } from "../../config.js";
import { log } from "../../utils/log.js";
import { safeClick, safeFill } from "../common/index.js";
import { onbaseSelectors } from "./selectors.js";
import {
  classifyOnbasePage,
  onbaseStateNeedsReauth,
  OnbasePageStateError,
} from "./page-state.js";

/** OnBase document type for Emergency Contact imports. */
export const ONBASE_EC_DOCUMENT_TYPE = "X_HR_Emergency Contact";
/** File Type option to select for PDF imports. */
export const ONBASE_PDF_FILE_TYPE = "PDF (.pdf)";
/** Keyset that autofills every keyword from the UCPath ID. */
export const ONBASE_EMPLOYEE_LOOKUP_KEYSET = "Employee Lookup";
/** Constant Document Name for Emergency Contact docs. */
export const ONBASE_EC_DOCUMENT_NAME = "EMERGENCY CONTACT INFORMATION";

/**
 * Required ("red") keyword labels on the Emergency Contact import. The
 * Employee Lookup keyset autofills all of these EXCEPT Document Name; the
 * handler verifies they are non-empty before enabling Import.
 */
export const ONBASE_REQUIRED_KEYWORDS = [
  "UCPath ID",
  "Last Name",
  "First Name",
  "Document Name",
  "Department Name",
  "Department Code",
  "Vice Chancellor",
  "Vice Chancellor Code",
] as const;

/** Keyword labels that are dataset-backed comboboxes (not plain textboxes). */
const COMBOBOX_KEYWORDS = new Set<string>([
  "Department Name",
  "Department Code",
  "Vice Chancellor",
  "Vice Chancellor Code",
]);

function importFrame(page: Page): FrameLocator {
  return onbaseSelectors.importForm.frame(page);
}

/** How many fresh NavPanel navigations to try before giving up. */
const NAV_PANEL_RECOVERY_ATTEMPTS = 3;

/**
 * Backoff before recovery re-navigation N (ms). The first retry is immediate
 * (the common transient 403/ViewState clears on a plain reload); later retries
 * back off so a rate-limited or contention-held NavPanel isn't hammered.
 */
const NAV_PANEL_RECOVERY_BACKOFF_MS = [0, 2_000, 5_000] as const;

/** Pages that already carry the beforeunload dialog guard. */
const dialogGuardedPages = new WeakSet<Page>();

/**
 * Auto-accept `beforeunload` dialogs on the OnBase page, once per Page.
 *
 * Navigating away from the Import form with document(s) still queued fires a
 * native "unsaved documents" beforeunload confirm (captured live 2026-07-02).
 * Without a dialog listener Playwright auto-DISMISSES it — which cancels the
 * navigation, so the kernel's between-items `resetUrl` goto (or a recovery
 * re-nav after a mid-form failure) times out. Accepting lets the navigation
 * proceed; the queue is page-scoped, so nothing is filed by leaving. All other
 * dialog types keep Playwright's default dismiss behavior.
 */
export function installOnbaseDialogGuard(page: Page): void {
  if (dialogGuardedPages.has(page)) return;
  dialogGuardedPages.add(page);
  page.on("dialog", (dialog) => {
    if (dialog.type() === "beforeunload") {
      dialog.accept().catch(() => undefined);
    } else {
      dialog.dismiss().catch(() => undefined);
    }
  });
}

/**
 * Ensure NavPanel is loaded with the nine-squares Main Menu visible.
 *
 * OnBase (a load-balanced ASP.NET cluster) intermittently serves a transient
 * error/reset page at the normal NavPanel URL instead of the app — a ViewState
 * MAC failure (farm affinity loss), an IIS 403, or the form reset back to
 * Document Retrieval. Rather than blind-wait for the Main Menu until timeout,
 * classify the page and recover:
 *   - `authenticated`                → done.
 *   - session death (`login` /
 *     `session-closed`)              → throw so the kernel retry re-authenticates.
 *   - `viewstate-error` / `forbidden`
 *     / `unknown`                    → re-navigate NavPanel.aspx fresh (a clean
 *                                      GET rebuilds ViewState on the current
 *                                      node) and re-probe, up to N attempts.
 */
async function ensureNavPanelReady(page: Page): Promise<void> {
  const mainMenu = onbaseSelectors.nav.mainMenuButton(page);

  for (let attempt = 1; attempt <= NAV_PANEL_RECOVERY_ATTEMPTS; attempt++) {
    const state = await classifyOnbasePage(page);
    if (state === "authenticated") return;
    if (onbaseStateNeedsReauth(state)) {
      throw new OnbasePageStateError(state, "openImportDocument");
    }

    const backoff =
      NAV_PANEL_RECOVERY_BACKOFF_MS[attempt - 1] ??
      NAV_PANEL_RECOVERY_BACKOFF_MS[NAV_PANEL_RECOVERY_BACKOFF_MS.length - 1];
    if (backoff > 0) await page.waitForTimeout(backoff);

    log.step(
      `OnBase: NavPanel not ready (${state}) — reloading NavPanel.aspx (${attempt}/${NAV_PANEL_RECOVERY_ATTEMPTS})`,
    );
    await page
      .goto(ONBASE_URL, { waitUntil: "domcontentloaded", timeout: 15_000 })
      .catch(() => undefined);
    await mainMenu
      .waitFor({ state: "visible", timeout: 15_000 })
      .catch(() => undefined);
  }

  // Exhausted the fresh-nav budget — surface the real landing state, not a
  // blind Main-Menu timeout.
  const finalState = await classifyOnbasePage(page);
  if (finalState !== "authenticated") {
    throw new OnbasePageStateError(finalState, "openImportDocument");
  }
}

/**
 * Open the Import Document screen: nine-squares Main Menu → Import Document,
 * then wait for the import form (UCPath ID field) to render.
 */
/** Menu-click → form-render attempts before giving up. */
const IMPORT_MENU_ATTEMPTS = 3;

export async function openImportDocument(page: Page): Promise<void> {
  log.step("OnBase: opening Import Document...");
  installOnbaseDialogGuard(page);
  await ensureNavPanelReady(page);

  const frame = importFrame(page);
  const formField = onbaseSelectors.importForm.ucpathIdInput(frame);
  const menuItem = onbaseSelectors.nav.importDocumentMenuItem(page);

  // The Main Menu's items render BEFORE their click handlers attach — an
  // instant click lands on a visible-but-inert item and the panel silently
  // stays on Document Retrieval (captured live 2026-07-02: menu clicked in
  // 47ms, item in 59ms, form never rendered). So: settle after opening the
  // menu, then VERIFY the form actually rendered, re-clicking if not.
  for (let attempt = 1; attempt <= IMPORT_MENU_ATTEMPTS; attempt++) {
    // A prior inert click can leave the menu open with the item still visible —
    // re-clicking the launcher would toggle it closed, so only open when needed.
    if (!(await menuItem.isVisible().catch(() => false))) {
      await safeClick(onbaseSelectors.nav.mainMenuButton(page), {
        label: "onbase.nav.mainMenuButton",
        timeout: 10_000,
      });
      await page.waitForTimeout(600);
    }
    await safeClick(menuItem, {
      label: "onbase.nav.importDocumentMenuItem",
      timeout: 10_000,
    });

    const rendered = await formField
      .waitFor({ state: "visible", timeout: attempt === IMPORT_MENU_ATTEMPTS ? 15_000 : 7_000 })
      .then(() => true)
      .catch(() => false);
    if (rendered) {
      await clearLeftoverQueuedDocuments(page);
      log.step("OnBase: Import Document form ready");
      return;
    }
    log.warn(
      `OnBase: Import Document form did not render after the menu click (attempt ${attempt}/${IMPORT_MENU_ATTEMPTS}) — re-clicking`,
    );
  }
  throw new Error(
    "OnBase: Import Document form did not render after repeated Main Menu clicks",
  );
}

/**
 * Remove any document(s) still sitting in the right-hand Document Queue.
 *
 * The queue is page-scoped (a fresh Import Document load starts empty), but a
 * kernel retry re-runs on the SAME page — a file attached by a failed prior
 * attempt is still queued, and clicking Import would file it alongside this
 * attempt's file (a duplicate). Fails loud if the queue won't empty.
 */
async function clearLeftoverQueuedDocuments(page: Page): Promise<void> {
  const queueFrame = onbaseSelectors.documentQueue.frame(page);
  const removeButtons = onbaseSelectors.documentQueue.removeButtons(queueFrame);
  let leftover: number;
  try {
    leftover = await removeButtons.count();
  } catch (err) {
    // A count() failure is NOT the same as an empty queue — swallowing it to 0
    // would silently skip the clear-out below and risk filing a leftover
    // document as a duplicate. Fail loud instead.
    throw new Error(
      `OnBase: could not read the Document Queue to check for leftover documents — refusing to attach (duplicate-import risk): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (leftover === 0) return;

  log.warn(
    `OnBase: ${leftover} document(s) left queued by a prior attempt — removing before attach`,
  );
  // Each Remove re-renders the queue; re-resolve and click the first until empty.
  for (let i = 0; i < leftover + 2; i++) {
    if ((await removeButtons.count().catch(() => 0)) === 0) return;
    await removeButtons.first().click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
  }
  if ((await removeButtons.count().catch(() => 0)) > 0) {
    throw new Error(
      "OnBase: could not clear leftover queued document(s) — refusing to attach (duplicate-import risk)",
    );
  }
}

/**
 * Select the Document Types dropdown option (e.g. X_HR_Emergency Contact),
 * then wait for the keyword panel to finish rebuilding. Changing the type
 * re-renders the whole keyword section with fresh DOM nodes (verified live
 * 2026-07-02) — interacting mid-rebuild races a detached panel.
 */
export async function selectDocumentType(page: Page, label: string): Promise<void> {
  const frame = importFrame(page);
  await onbaseSelectors.importForm.documentTypesSelect(frame).selectOption({ label });
  await onbaseSelectors.importForm.ucpathIdInput(frame).waitFor({
    state: "visible",
    timeout: 10_000,
  });
  log.step(`OnBase: document type → ${label}`);
}

/** Select the File Type dropdown option (e.g. PDF (.pdf)). */
export async function selectFileType(page: Page, label: string): Promise<void> {
  const frame = importFrame(page);
  await onbaseSelectors.importForm.fileTypeSelect(frame).selectOption({ label });
  log.step(`OnBase: file type → ${label}`);
}

/** Ensure the Keyset Lookup is the autofill keyset (idempotent). */
export async function ensureKeyset(
  page: Page,
  keyset: string = ONBASE_EMPLOYEE_LOOKUP_KEYSET,
): Promise<void> {
  const frame = importFrame(page);
  const select = onbaseSelectors.importForm.keysetLookupSelect(frame);
  const current = await select.inputValue().catch(() => "");
  // `<select>` inputValue is the option value; compare against the label too.
  if (current !== keyset) {
    await select.selectOption({ label: keyset }).catch(async () => {
      await select.selectOption(keyset);
    });
    log.step(`OnBase: keyset → ${keyset}`);
  }
}

/** An in-memory file payload for the OnBase file picker. */
export interface OnbaseFilePayload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

/**
 * Attach the file to import (the person's single-page PDF). Accepts either a
 * path on disk or an in-memory payload (the handler splits one page out of the
 * combined PDF and uploads the bytes directly — no temp file).
 *
 * Not fire-and-forget: the attach is confirmed by the file's row appearing in
 * the right-hand Document Queue panel (status "Pending Import") — the same
 * signal an operator watches for. Throws (kernel-retryable) if the row never
 * lands, instead of letting a silent attach failure surface later as a
 * disabled Import button.
 */
export async function chooseFile(
  page: Page,
  file: string | OnbaseFilePayload,
): Promise<void> {
  const frame = importFrame(page);
  const fileName = typeof file === "string" ? (file.split("/").pop() ?? file) : file.name;
  await onbaseSelectors.importForm.fileInput(frame).setInputFiles(file);

  const queueFrame = onbaseSelectors.documentQueue.frame(page);
  const queuedRow = onbaseSelectors.documentQueue.queuedRow(queueFrame, fileName);
  try {
    await queuedRow.first().waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    throw new Error(
      `OnBase: attached ${fileName} but it never appeared in the Document Queue — upload did not land`,
    );
  }
  log.step(`OnBase: attached file ${fileName} (queued Pending Import)`);
}

/** Dismiss the "No matching records" alert, then close the Employee Lookup dialog. */
async function closeKeysetDialog(page: Page, dismissNoMatch: boolean): Promise<void> {
  if (dismissNoMatch) {
    await onbaseSelectors.keysetLookup
      .noMatchOkButton(page)
      .click({ timeout: 3_000 })
      .catch(() => undefined);
  }
  await onbaseSelectors.keysetLookup
    .closeButton(page)
    .click({ timeout: 3_000 })
    .catch(() => undefined);
}

/**
 * Outcome of the Employee Lookup keyset modal for one UCPath ID.
 * - `selected` — a matching employee was selected; keywords populated.
 * - `no-match` — OnBase reported "No matching records were found". A DATA
 *   problem (bad/mis-OCR'd UCPath ID), terminal for import: Department /
 *   Vice-Chancellor come ONLY from the keyset.
 *
 * A stalled postback (neither result within the deadline) or a selection whose
 * keywords never populate is NOT an outcome — those THROW, so the kernel
 * retries the item instead of mislabeling a slow cluster as "person not found".
 */
export type KeysetLookupResult = "selected" | "no-match";

/**
 * How many times to click "Select Employee" before declaring the selection
 * postback dead. A click can be swallowed while the results grid's async
 * postback is still re-rendering (live 2026-07-17); each attempt waits 4s for
 * the dialog to close before re-clicking.
 */
const SELECT_EMPLOYEE_CLICK_ATTEMPTS = 3;

/**
 * Run the OnBase **Employee Lookup keyset** for one UCPath ID via its MODAL.
 *
 * There is NO inline autofill on Tab (the old `enterUcpathIdAndTab` assumption
 * was wrong — verified live 2026-07-02). The key-icon beside "Keyset Lookup"
 * opens an "Employee Lookup" dialog whose search form lives in a nested
 * `ReverseKeysetLookup.aspx` iframe. We fill the modal's OWN UCPath ID field,
 * click Find, and on a match the result row auto-selects so "Select Employee"
 * enables — clicking it closes the dialog and autofills every keyword on the
 * import form (Last/First Name, Department + code, Vice Chancellor + code, …).
 */
export async function lookupEmployeeViaKeyset(
  page: Page,
  ucpathId: string,
  timeoutMs = 20_000,
): Promise<KeysetLookupResult> {
  const frame = importFrame(page);
  // The UCPath ID is itself a required keyword we already have from OCR; set it
  // on the form up front so a matched selection just confirms it.
  await safeFill(onbaseSelectors.importForm.ucpathIdInput(frame), ucpathId, {
    label: "onbase.importForm.ucpathIdInput",
    timeout: 10_000,
  });

  // Open the Employee Lookup modal via the key-icon.
  await safeClick(onbaseSelectors.importForm.keysetApplyButton(frame), {
    label: "onbase.importForm.keysetApplyButton",
    timeout: 10_000,
  });
  await onbaseSelectors.keysetLookup
    .dialog(page)
    .waitFor({ state: "visible", timeout: 10_000 });

  // Fill the modal's OWN UCPath ID field + Find.
  const modal = onbaseSelectors.keysetLookup.frame(page);
  await safeFill(onbaseSelectors.keysetLookup.ucpathIdInput(modal), ucpathId, {
    label: "onbase.keysetLookup.ucpathIdInput",
    timeout: 10_000,
  });
  await safeClick(onbaseSelectors.keysetLookup.findButton(modal), {
    label: "onbase.keysetLookup.findButton",
    timeout: 10_000,
  });
  log.step(`OnBase: Employee Lookup Find for UCPath ID ${ucpathId}`);

  const selectBtn = onbaseSelectors.keysetLookup.selectEmployeeButton(page);
  const noMatch = onbaseSelectors.keysetLookup.noMatchMessage(page);
  const lastName = onbaseSelectors.importForm.keywordInput(frame, "Last Name");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await noMatch.isVisible({ timeout: 400 }).catch(() => false)) {
      log.warn(`OnBase: Employee Lookup found no match for UCPath ID ${ucpathId}`);
      await closeKeysetDialog(page, true);
      return "no-match";
    }
    if (await selectBtn.isEnabled({ timeout: 400 }).catch(() => false)) {
      // The Select Employee click can land while the results grid's async
      // postback is still re-rendering, and OnBase swallows it — the dialog
      // stays open with the row still highlighted and no keyword ever
      // populates (captured live 2026-07-17: failure screenshot showed the
      // dialog open 8s+ after the click was logged). The dialog CLOSING is the
      // observable proof the selection postback fired, so click → confirm the
      // dialog closed → re-click the SAME button (bounded) while it hasn't.
      const dialog = onbaseSelectors.keysetLookup.dialog(page);
      let dialogClosed = false;
      for (let attempt = 1; attempt <= SELECT_EMPLOYEE_CLICK_ATTEMPTS; attempt++) {
        await safeClick(selectBtn, {
          label: "onbase.keysetLookup.selectEmployeeButton",
          timeout: 10_000,
        });
        dialogClosed = await dialog
          .waitFor({ state: "hidden", timeout: 4_000 })
          .then(
            () => true,
            () => false, // still visible after the wait — checked right below
          );
        if (dialogClosed) break;
        log.warn(
          `OnBase: Select Employee click did not close the Employee Lookup dialog for UCPath ID ${ucpathId} (attempt ${attempt}/${SELECT_EMPLOYEE_CLICK_ATTEMPTS}) — re-clicking`,
        );
      }
      if (!dialogClosed) {
        // Leave a clean page for the retry replay, then fail loud — the
        // selection postback never fired, so nothing was autofilled.
        await closeKeysetDialog(page, false);
        throw new Error(
          `OnBase: Select Employee for UCPath ID ${ucpathId} never closed the Employee Lookup dialog after ${SELECT_EMPLOYEE_CLICK_ATTEMPTS} clicks — selection postback did not fire`,
        );
      }
      // Dialog closed and keywords populate — confirm Last Name lands. The
      // settle window is capped by the caller's overall budget.
      const settle = Date.now() + Math.min(8_000, timeoutMs);
      while (Date.now() < settle) {
        const v = await lastName.inputValue().catch(() => "");
        if (v.trim()) {
          log.step(`OnBase: keyset selected employee (Last Name = ${v.trim()})`);
          return "selected";
        }
        await page.waitForTimeout(400);
      }
      // The employee EXISTS (a row was selected) — an unpopulated form is a
      // page/postback failure, not a data miss. Throw so the kernel retries
      // instead of reporting a false "not found in Employee Lookup".
      throw new Error(
        `OnBase: selected employee for UCPath ID ${ucpathId} but keywords did not populate — retrying from a fresh form`,
      );
    }
    await page.waitForTimeout(400);
  }

  // Neither a match nor a no-match landed in time — the keyset postback stalled
  // (slow cluster / ViewState). That is a PAGE failure, not "person not found":
  // close the dialog and throw so the kernel retries on a fresh form.
  await closeKeysetDialog(page, false);
  throw new Error(
    `OnBase: Employee Lookup returned neither a match nor no-match for UCPath ID ${ucpathId} within ${Math.round(timeoutMs / 1000)}s — keyset postback stalled`,
  );
}

/** Read the current value of each required ("red") keyword field. */
export async function readRequiredKeywordValues(
  page: Page,
): Promise<Record<string, string>> {
  const frame = importFrame(page);
  const out: Record<string, string> = {};
  for (const label of ONBASE_REQUIRED_KEYWORDS) {
    const locator = COMBOBOX_KEYWORDS.has(label)
      ? onbaseSelectors.importForm.keywordCombobox(frame, label)
      : onbaseSelectors.importForm.keywordInput(frame, label);
    out[label] = (await locator.inputValue().catch(() => "")).trim();
  }
  return out;
}

/** Fill a single keyword field (textbox or dataset combobox) by label. */
export async function fillKeyword(page: Page, label: string, value: string): Promise<void> {
  const frame = importFrame(page);
  const locator = COMBOBOX_KEYWORDS.has(label)
    ? onbaseSelectors.importForm.keywordCombobox(frame, label)
    : onbaseSelectors.importForm.keywordInput(frame, label);
  await safeFill(locator, value, {
    label: `onbase.importForm.keyword:${label}`,
    timeout: 10_000,
  });
}

/** Set the Document Name keyword (the one required field the keyset omits). */
export async function setDocumentName(
  page: Page,
  value: string = ONBASE_EC_DOCUMENT_NAME,
): Promise<void> {
  const frame = importFrame(page);
  await safeFill(onbaseSelectors.importForm.documentNameInput(frame), value, {
    label: "onbase.importForm.documentNameInput",
    timeout: 10_000,
  });
  log.step(`OnBase: document name → ${value}`);
}

/** True if the Import button is enabled right now (single sample — see waitForImportEnabled). */
export async function isImportEnabled(page: Page): Promise<boolean> {
  const frame = importFrame(page);
  return onbaseSelectors.importForm.importButton(frame).isEnabled().catch(() => false);
}

/**
 * Wait for the Import button to enable, polling to `timeoutMs`.
 *
 * Enablement tracks the ATTACH (the button enables once a document is queued,
 * even with keywords still blank — verified live 2026-07-02), and it commits
 * via an async postback — a single sample right after the last fill can read a
 * transient disabled state and fail a perfectly valid import. Keyword
 * completeness is enforced separately by `readRequiredKeywordValues`.
 */
export async function waitForImportEnabled(
  page: Page,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isImportEnabled(page)) return true;
    await page.waitForTimeout(400);
  }
  return isImportEnabled(page);
}

/** Click the Import button to submit the document. */
export async function clickImport(page: Page): Promise<void> {
  const frame = importFrame(page);
  await safeClick(onbaseSelectors.importForm.importButton(frame), {
    label: "onbase.importForm.importButton",
    timeout: 15_000,
  });
  log.step("OnBase: Import clicked");
}
