import type { Page } from "playwright";
import { ActionPlan } from "../../systems/ucpath/action-plan.js";
import { log } from "../../utils/log.js";
import { readExistingContactNames } from "../../systems/ucpath/personal-data.js";
import { emergencyContact as emergencyContactSelectors } from "../../systems/ucpath/selectors.js";
import { dismissPeopleSoftModalMask } from "../../systems/common/modal.js";
import { normalizePersonNameForCompare } from "../../domain/identity/person-name.js";
import { mapRelationship } from "./config.js";
import { levenshteinDistance } from "../../services/matching/index.js";
import type { EmergencyContactRecord } from "./schema.js";

export interface EmergencyContactContext {
  /** Employee name as discovered on the UCPath page. */
  employeeName: string;
}

/**
 * Best-effort PeopleSoft processing-spinner wait, adapted from
 * `ucpath.waitForPeopleSoftProcessing` (which targets a `FrameLocator`) for
 * use directly on this `Page` — Emergency Contact's `uc_deep_link=1` URL
 * renders OUTSIDE the HR Tasks iframe (see `buildEmergencyContactPlan`'s
 * JSDoc), so there is no `FrameLocator` to hand that helper. Same spinner
 * anchors; always resolves (never throws) since the spinner may not appear
 * for every postback — a checkbox/select toggle that doesn't round-trip the
 * server just returns immediately.
 * NEEDS LIVE VERIFY: confirm these anchors actually render on the deep-link
 * (non-iframed) Emergency Contact page the same way they do inside HR Tasks.
 */
async function waitForContactPagePostback(page: Page, timeoutMs = 3_000): Promise<void> {
  const processingSelector =
    "#processing, #WAIT_win0, .ps_box-processing, [id*='PROCESSING']"; // allow-inline-selector
  try {
    const probe = page.locator(processingSelector).first(); // allow-inline-selector
    await probe.waitFor({ state: "visible", timeout: 800 });
    await probe.waitFor({ state: "hidden", timeout: timeoutMs });
  } catch {
    // Spinner did not appear or already disappeared — fine.
  }
}


export interface ContactMatch {
  /** The existing contact's name as it appears on the UCPath record. */
  name: string;
  /** Levenshtein distance on normalized names. 0 = exact, > 2 = no match. */
  distance: number;
  /** True iff distance === 0. */
  isExact: boolean;
}

/**
 * Pure matcher — finds the closest fuzzy match for a target name within a
 * list of existing contact names. Uses Levenshtein on normalized forms.
 * Returns null if no candidate is within distance 2.
 *
 * Distance 0 = exact (typically "skip — already current").
 * Distance 1-2 = fuzzy (typically "demote existing primary, add new as primary").
 * > 2 = treat as no match.
 */
export function pickBestContactMatch(
  existingNames: readonly string[],
  targetName: string,
): ContactMatch | null {
  const targetNorm = normalizePersonNameForCompare(targetName, { lettersOnly: true });
  let best: ContactMatch | null = null;
  for (const candidate of existingNames) {
    const norm = normalizePersonNameForCompare(candidate, { lettersOnly: true });
    const distance = levenshteinDistance(norm, targetNorm);
    if (distance > 2) continue;
    if (!best || distance < best.distance) {
      best = { name: candidate, distance, isExact: distance === 0 };
    }
  }
  return best;
}

/**
 * UCPath-side wrapper — reads existing contact names off the page, then
 * delegates to pickBestContactMatch.
 *
 * Returns:
 *   - `null` when no existing contact is within fuzzy-match distance.
 *   - `{ name, distance: 0, isExact: true }` for an exact match (skip).
 *   - `{ name, distance: 1|2, isExact: false }` for a fuzzy match
 *     (workflow should demote the existing primary and add new as primary).
 */
export async function findExistingContactDuplicate(
  page: Page,
  targetName: string,
): Promise<ContactMatch | null> {
  const existing = await readExistingContactNames(page);
  log.step(`Existing contacts on record: [${existing.join(" | ") || "none"}]`);
  return pickBestContactMatch(existing, targetName);
}

/**
 * Build the ActionPlan for filling + saving a single emergency-contact record.
 *
 * Assumes `navigateToEmergencyContact(page, emplId)` already loaded the editor.
 * All field selectors are top-level (`page.getByRole(...)`) because we use the
 * `uc_deep_link=1` URL which opens outside the HR Tasks iframe.
 *
 * Plan (verified 2026-04-14 on EID 10872384):
 *   1. Click "Add a new row at row 1" → inserts blank row as row 1.
 *   2. Fill Contact Name.
 *   3. Primary Contact checkbox (always checked per form convention).
 *   4. Select Relationship (mapped via RELATIONSHIP_MAP).
 *   5. Same Address as Employee — if batch says not-same, uncheck + open Edit
 *      Address modal + fill Address 1/City/State/Postal + OK.
 *   6. Fill Phone (cell > home > work preference).
 *   6. Fill Phone.
 *
 * Save is NOT in this plan — the caller's "save" ctx.step performs the UCPath
 * Save click so the dashboard timeline reflects actual save wall-clock time.
 * The duplicate-guard is also NOT here — call `findExistingContactDuplicate`
 * in workflow.ts before building the plan, and skip plan execution if present.
 */
/**
 * Expand the contact scroll to View All so EVERY row's fields are in the DOM.
 *
 * 2026-08-05 root cause of the whole batch failure: the scroll pages one row
 * at a time, so after "Add a new row" the role-based `.first()` selectors
 * interacted with whichever row PeopleSoft happened to render after each
 * postback — fills scattered across two rows, and Save always saw a blank
 * required field somewhere. In View All mode (live-probed) a filled name
 * SURVIVES a real checkbox postback, so the paging was the entire mechanism.
 * The link is absent/says "View 1" when already expanded — both are no-ops.
 */
export async function ensureAllContactRowsVisible(page: Page): Promise<void> {
  const link = emergencyContactSelectors.viewAllLink(page);
  if (await link.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await link.click({ timeout: 5_000 });
    await waitForContactPagePostback(page, 3_000);
  }
}

/**
 * Pick the scroll row the new contact will be written into, in View All mode.
 *
 * A person with NO contacts gets one blank placeholder row from PeopleSoft —
 * use it directly. Clicking "Add a new row" in that state (what the old plan
 * always did) creates a SECOND blank row, and Save can then never pass:
 * whichever row the fills land on, the other blank row still fails the
 * required-field edit ("Highlighted fields are required. (15,30)"). Only when
 * every existing row already has a name (real saved contacts) is add-row
 * needed — and the new blank row is then found by the same scan.
 */
export async function prepareTargetContactRow(page: Page): Promise<number> {
  await ensureAllContactRowsVisible(page);

  const blankRow = async (): Promise<number | null> => {
    const count = await emergencyContactSelectors.contactNameInputs(page).count();
    for (let i = 0; i < count; i++) {
      const el = emergencyContactSelectors.contactNameAt(page, i);
      if ((await el.count()) === 0) continue;
      if ((await el.inputValue({ timeout: 5_000 })).trim() === "") return i;
    }
    return null;
  };

  let row = await blankRow();
  if (row !== null) {
    log.step(`Using existing blank contact row $${row} (no add-row needed)`);
    return row;
  }

  log.step("All existing contact rows are populated — adding a new row");
  await dismissPeopleSoftModalMask(page);
  await emergencyContactSelectors.addNewRowButton(page).click({ timeout: 10_000 });
  await waitForContactPagePostback(page, 3_000);
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
  await ensureAllContactRowsVisible(page);

  row = await blankRow();
  if (row === null) {
    throw new Error(
      "Emergency contact: no blank contact row found after Add a new row — refusing to overwrite an existing contact.",
    );
  }
  return row;
}

/**
 * Fill the target row's Contact Name and READ IT BACK. Throws if the value
 * did not stick — a blank required field is never allowed to reach Save.
 * Deliberately NO blur: live-probed 2026-08-05, a plain fill() sticks and
 * survives real postbacks, while a forced blur fires `addchg_win0` and
 * discards the un-committed row. Filled LAST in the plan regardless.
 */
export async function fillContactNameAndVerify(
  page: Page,
  name: string,
  row: number,
): Promise<void> {
  const field = emergencyContactSelectors.contactNameAt(page, row);
  await field.fill(name, { timeout: 10_000 });
  const actual = (await field.inputValue({ timeout: 5_000 })).trim();
  if (actual !== name.trim()) {
    throw new Error(
      `Emergency contact: Contact Name did not persist after fill on row $${row} — expected "${name}", field reads "${actual}". ` +
        `Refusing to continue so Save cannot fail on a blank required field.`,
    );
  }
}

/**
 * Save-readiness assertion, immediately before the Save click: the contact
 * name must be present on SOME row, and NO row may have a blank Contact Name
 * (a blank row is a guaranteed "Highlighted fields are required. (15,30)"
 * refusal). Row-agnostic on purpose — it checks the page, not our bookkeeping.
 */
export async function assertContactNameStillPresent(page: Page, name: string): Promise<void> {
  const inputs = emergencyContactSelectors.contactNameInputs(page);
  const count = await inputs.count();
  const values: string[] = [];
  for (let i = 0; i < count; i++) {
    values.push((await inputs.nth(i).inputValue({ timeout: 5_000 }).catch(() => "")).trim());
  }
  const want = normalizePersonNameForCompare(name);
  if (!values.some((v) => normalizePersonNameForCompare(v) === want)) {
    throw new Error(
      `Emergency contact: "${name}" is not present in any Contact Name field before Save — rows read [${values.join(", ")}]. ` +
        `A page postback must have discarded the fill; failing loud instead of letting Save reject.`,
    );
  }
  const blanks = values.filter((v) => v === "").length;
  if (blanks > 0) {
    throw new Error(
      `Emergency contact: ${blanks} contact row(s) have a BLANK Contact Name before Save — UCPath will refuse with ` +
        `"Highlighted fields are required. (15,30)". Rows read [${values.join(", ")}].`,
    );
  }
}

export function buildEmergencyContactPlan(
  record: EmergencyContactRecord,
  page: Page,
  _ctx: EmergencyContactContext,
): ActionPlan {
  const plan = new ActionPlan();
  const contact = record.emergencyContact;

  // The scroll row every later step writes into. Resolved by step 1 at
  // RUNTIME (View All + blank-row scan — see `prepareTargetContactRow`), so
  // it is a shared mutable binding, not a constant.
  let targetRow = -1;
  const row = () => {
    if (targetRow < 0) throw new Error("Emergency contact: target row used before it was prepared");
    return targetRow;
  };

  // 1. Expand to View All and pick the target row. For a person with no
  // contacts this is PeopleSoft's own blank placeholder row — clicking
  // "Add a new row" there (the old behaviour) created a second blank row that
  // made Save structurally impossible. Add-row happens ONLY when every
  // existing row already holds a real contact.
  plan.add("Prepare target contact row (View All + blank-row scan)", async () => {
    await dismissPeopleSoftModalMask(page);
    targetRow = await prepareTargetContactRow(page);
  });

  // NOTE: Contact Name is filled LAST (step 7), not here.
  //
  // 2026-08-05: the interactive fields below each round-trip a PeopleSoft
  // postback that re-renders the scroll. With the paging removed (View All)
  // and every selector row-anchored, a re-render can no longer retarget a
  // write — but the name still goes last so nothing posts back after it, and
  // it is re-verified immediately before Save.

  // 3. Primary Contact checkbox.
  plan.add("Set Primary Contact", async () => {
    const cb = emergencyContactSelectors.primaryContactAt(page, row());
    if (contact.primary) {
      const checked = await cb.isChecked({ timeout: 5_000 }).catch(() => false);
      if (!checked) await cb.check({ timeout: 5_000 });
    } else {
      const checked = await cb.isChecked({ timeout: 5_000 }).catch(() => false);
      if (checked) await cb.uncheck({ timeout: 5_000 });
    }
    // Checkbox toggles can round-trip a PeopleSoft postback; wait for the
    // processing spinner (if any) to settle rather than a blind pause.
    await waitForContactPagePostback(page, 2_000);
  });

  // 4. Relationship.
  const relationshipLabel = mapRelationship(contact.relationship);
  plan.add(
    `Select Relationship: "${contact.relationship}" -> "${relationshipLabel}"`,
    async () => {
      await emergencyContactSelectors
        .relationshipAt(page, row())
        .selectOption({ label: relationshipLabel }, { timeout: 10_000 });
      // A relationship change can round-trip a postback; wait for the
      // processing spinner (if any) to settle rather than a blind pause.
      await waitForContactPagePostback(page, 3_000);
    },
  );

  // 5. Same Address as Employee + manual-address fallback.
  // Treat (sameAddressAsEmployee=false, address=null) as same-address — the
  // schema transform normally rewrites this, but the guard here is defense
  // in depth for any caller that bypasses Zod.
  const wantsSameAddress = contact.sameAddressAsEmployee || !contact.address;
  plan.add(
    wantsSameAddress
      ? 'Check "Same Address as Employee"'
      : 'Uncheck "Same Address as Employee" and enter manual address',
    async () => {
      const sameAddrCb = emergencyContactSelectors.sameAddressAt(page, row());
      const checked = await sameAddrCb.isChecked({ timeout: 5_000 }).catch(() => false);

      if (wantsSameAddress) {
        if (!checked) await sameAddrCb.check({ timeout: 5_000 });
        // Checking "Same Address" can round-trip a postback (it hides/disables
        // the manual-address section); wait for the spinner to settle.
        await waitForContactPagePostback(page, 3_000);
        if (!contact.sameAddressAsEmployee && !contact.address) {
          log.step(
            "sameAddressAsEmployee=false + address=null — defensive fallback to same-as-employee",
          );
        }
        return;
      }

      if (checked) {
        await sameAddrCb.uncheck({ timeout: 5_000 });
        await waitForContactPagePostback(page, 3_000);
      }
      // The row's "Edit Address" button opens the shared DERIVED_ADDRESS modal.
      await emergencyContactSelectors
        .editAddressButtonAt(page, row())
        .waitFor({ state: "visible", timeout: 4_000 })
        .catch(() => {});

      // Unreachable in practice (wantsSameAddress is true when address is null),
      // but kept as a final safety net.
      if (!contact.address) {
        log.step("sameAddressAsEmployee=false but no address in record — leaving blank");
        return;
      }

      const addr = contact.address;
      await dismissPeopleSoftModalMask(page);
      await emergencyContactSelectors.editAddressButtonAt(page, row())
        .click({ timeout: 10_000 });
      // Wait for the Edit Address modal's first field before filling it.
      await emergencyContactSelectors
        .address1Input(page)
        .waitFor({ state: "visible", timeout: 4_000 });

      if (addr.street) {
        await emergencyContactSelectors.address1Input(page)
          .fill(addr.street, { timeout: 10_000 });
      }
      if (addr.city) {
        await emergencyContactSelectors.cityInput(page)
          .fill(addr.city, { timeout: 10_000 });
      }
      if (addr.state) {
        await emergencyContactSelectors.stateInput(page)
          .fill(addr.state, { timeout: 10_000 });
      }
      if (addr.zip) {
        await emergencyContactSelectors.postalInput(page)
          .fill(addr.zip, { timeout: 10_000 });
      }

      await dismissPeopleSoftModalMask(page);
      await emergencyContactSelectors.editAddressOkButton(page)
        .click({ timeout: 10_000 });
      // Wait for the Edit Address modal to close (its Address 1 field
      // detaches/hides) before falling through to the existing networkidle wait.
      await emergencyContactSelectors
        .address1Input(page)
        .waitFor({ state: "hidden", timeout: 5_000 })
        .catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      // The modal OK posts back and re-renders the scroll — make sure the
      // all-rows view survived it before later row-anchored writes.
      await ensureAllContactRowsVisible(page);
    },
  );

  // 6. Phone.
  const primaryPhone = contact.cellPhone || contact.homePhone || contact.workPhone;
  if (primaryPhone) {
    plan.add(`Fill Phone: ${primaryPhone}`, async () => {
      await emergencyContactSelectors
        .phoneAt(page, row())
        .fill(primaryPhone, { timeout: 10_000 });
      await page.waitForTimeout(500);
    });
  } else {
    log.step("No phone number in record — skipping phone fill");
  }

  // 7. Contact Name — ALWAYS LAST, after every postback-triggering field, and
  // read back to prove it stuck. Outside the phone branch — a record with no
  // phone still needs its name.
  plan.add(`Fill Contact Name: ${contact.name}`, async () => {
    await fillContactNameAndVerify(page, contact.name, row());
  });

  return plan;
}

/**
 * Read the loaded Emergency Contact editor's header row text — UCPath renders it
 * as "Person ID <emplId> <Employee Name> Emergency Contact". This is the page's
 * OWN identity (distinct from anything the operator typed), used both to extract
 * the display name and as the pre-fill identity gate's `extract` source.
 * Returns `null` when the header has not rendered yet — a RETRYABLE state the
 * gate polls on, not a verdict. A count/innerText exception (frame detached,
 * strict-mode violation) is left to propagate so the gate reports a clear
 * "could not read the displayed identity" rather than a false miss.
 *
 * 2026-08-05: this previously returned `""` and swallowed a thrown `count()`
 * via `.catch(() => 0)`. Both collapsed "I could not read the header" into
 * "the header is not there" — and because the gate sampled only once, a header
 * that was still rendering read as a hard identity mismatch.
 *
 * 2026-08-05 (root cause): the real defect was the LOCATOR, not timing. It
 * anchored on the "Person ID" LABEL and walked to its parent
 * (`#win0divPERSON_NPC_VW_EMPLIDlbl`), whose text is the bare string
 * "Person ID" — PeopleSoft renders a display-only field's label and value as
 * SIBLING divs, so the value is unreachable from the label's parent. The gate
 * then correctly reported "the expected identity was not found on the page"
 * because no EID was in the string it was handed. Adding `pollMs` could never
 * fix that: every sample read the same label. The header is now composed from
 * the VALUE elements directly, keeping the same
 * `Person ID <emplId> <Name> Emergency Contact` shape that `extractEmployeeName`
 * parses and the gate matches on.
 */
export async function readEmergencyContactPersonIdRow(page: Page): Promise<string | null> {
  const idEl = emergencyContactSelectors.personIdValue(page);
  if ((await idEl.count()) === 0) return null;
  const emplId = (await idEl.innerText({ timeout: 3_000 })).trim();
  if (!emplId) return null;

  const nameEl = emergencyContactSelectors.personNameValue(page);
  const name = (await nameEl.count()) > 0
    ? (await nameEl.innerText({ timeout: 3_000 })).trim()
    : "";

  return `Person ID ${emplId}${name ? ` ${name}` : ""} Emergency Contact`;
}

/**
 * Pull the employee's display name from the Emergency Contact page header.
 * UCPath shows it as a generic div alongside "Person ID <emplId>".
 */
export async function extractEmployeeName(
  page: Page,
  ctx: EmergencyContactContext,
): Promise<void> {
  try {
    const rowText = await readEmergencyContactPersonIdRow(page);
    if (!rowText) return;
    const match = rowText.match(/Person ID\s+\d+\s+([A-Za-z][A-Za-z .'-]+?)\s+Emergency Contact/);
    if (match && match[1]) {
      ctx.employeeName = match[1].trim();
    }
  } catch {
    // Best-effort
  }
}
