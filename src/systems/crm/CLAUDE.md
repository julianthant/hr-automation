# CRM Module

ACT CRM (Salesforce) automation: employee search, navigation, and field extraction from Visualforce pages.

## Before mapping a new selector

1. Run `npm run selector:search "<your intent>"` and review the top matches across all systems.
2. If a selector matches your intent, USE IT — do not map a new one.
3. If [`LESSONS.md`](./LESSONS.md) has a relevant entry, read it first to avoid repeating a known failure.
4. Otherwise, map a new selector following the conventions in [`selectors.ts`](./selectors.ts):
   a. Add the selector function with JSDoc (one-line summary, `@tags`, `verified YYYY-MM-DD`).
   b. Run `npm run selectors:catalog` to regenerate [`SELECTORS.md`](./SELECTORS.md).
   c. If you discovered a non-obvious failure mode along the way, append a lesson to [`LESSONS.md`](./LESSONS.md) following its template.
   d. Verify the inline-selector test still passes: `npx vitest run tests/unit/systems/inline-selectors.test.ts`.

See [`SELECTORS.md`](./SELECTORS.md) for the auto-generated catalog of every selector this module exports.

Example intents for `npm run selector:search`: [`common-intents.txt`](./common-intents.txt).

## Gotchas

- **`ONB_SearchOnboardings?q=` is a FUZZY relevance search, not an exact match.** A numeric EID that belongs to nobody still returns a plausible-but-wrong person (live-confirmed 2026-07-02: `?q=99999999` → "Ngo, Thienan"; `?q=00000000` → 5 unrelated rows), and only a truly junk query (`?q=zzqxjunk`) returns zero rows. So "≥1 result" is NOT proof the record belongs to the target, and "0 results" is NOT a reliable "no record" signal for a real EID. **Any EID-driven lookup must open the matched record and confirm its `UCPath Employee ID` field equals the target EID before trusting it** (see `oath-signature/crm-verify.ts` — `extractField(page, "UCPath Employee ID")` gate). A real EID returns exactly the right single row.
- **Onboarding history reader** (`history.ts` — `readOnboardingOathHistory` / pure `findOathSignedTransition` + `parseCrmHistoryTimestamp`): reads the `ONB_ShowOnboardingHistory` `ProcessStageText` transition log (a `table.detailList`; data rows are `Date | Created By | Field | Old Value | New Value`). The oath is signed the moment a row transitions **to** `"Witness Ceremony Oath New Hire Signed"` (`WITNESS_OATH_NEW_HIRE_SIGNED`); that row's Date cell (`M/D/YYYY H:MM AM/PM`) is the authoritative signature timestamp. **Match the NEW VALUE column only** — the same string is the OLD value of the next (HR-Counter-Signed) row. Navigate via `navigateToSection(page, "Onboarding History")` (direct URL, `CRM_SECTION_URLS`) or the `onboardingHistory.showHistoryButton`.
- Hardcoded column indices in search results: "Offer Sent On" is column index 1
- Date parsing is lenient (`new Date(dateText)`) — silently skips invalid dates
- If all dates are unparseable, throws a distinct error: "CRM returned search rows but no parsable Offer Sent On date — check table format or locale" (separate from the genuine zero-row "No search results found" error)
- `extractField` supports five strategies: two verified Visualforce (`<th>`/`<td>` label → following `<td>`), one broader any-cell variant, one row-scoped last-cell fallback, and one Salesforce Lightning (`slds-form-element`) fallback. Strategies 3–5 are UNVERIFIED against the live CRM DOM (added 2026-06-07; need a live re-verify)
- Each extraction strategy has a 500 ms timeout (reduced from 2 000 ms on 2026-06-07); present elements resolve near-instantly, so only absent fields pay the full per-attempt cost
- `navigateToSection` regex doesn't escape special chars in section names
- `CRM_SECTION_URLS` currently only has "UCPath Entry Sheet" — missing sections fall back to slower click navigation
- Always waits for `networkidle` after navigation (conservative but slower)
- `idocs-download.ts` exports `downloadCrmIdocsDocuments` and `DEFAULT_CRM_DOC_INDICES` — a direct-fetch / PDF.js-bypass path for downloading onboarding PDFs from the CRM iDocs viewer (`/iDocsForSalesforce/…`). Use this instead of navigating the PDF.js UI when you need raw PDF bytes.
- `onboarding-records.ts` exports `searchCrmOnboardingResultRows` (scrape the `?q=` search grid) and `extractCrmOnboardingRecord` (navigate to a record + extract its fields) — the low-level onboarding search/extract driver, promoted out of `src/workflows/person-lookup/crm-search.ts` (2026-07-08). `extractCrmOnboardingRecord` never returns a "blank" record: a **post-navigation identity sanity check** throws when either (a) the page redirected off the CRM host (`navigatedToCrmRecordHost` — a session-timeout/login redirect) or (b) the extracted record has no identifying data at all (`hasIdentifyingCrmData` — name, PPS ID, and UCPath Employee ID all blank). This replaced a dead `CrmRecord | null` return type that never actually returned `null` — a broken navigation used to silently produce an empty-ish record for the caller to act on. Person-lookup's `crm-search.ts` still owns query-strategy orchestration (which query to try, which record to prefer) on top of these primitives.

## Lessons Learned

- **2026-07-08: Person Lookup's CRM search/scrape promoted to `onboarding-records.ts`, with a post-navigation identity sanity check.** `src/workflows/person-lookup/crm-search.ts` used to hand-roll `page.goto` + an inline `table tbody tr` scrape + a record-page extractor that was typed `Promise<CrmRecord | null>` but never actually returned `null` — a failed/redirected navigation silently produced a mostly-blank record that flowed downstream unverified (root CLAUDE.md "Fail loud" — "acting on whatever record loaded"). Moved to `onboarding-records.ts` (`searchCrmOnboardingResultRows` / `extractCrmOnboardingRecord`), added `search.resultRowCells` / `search.resultRowNameLink` to the selector registry (replacing the inline `.locator("table tbody tr")`/`.locator("td")` calls), and added the sanity check described above (throws instead of returning null). person-lookup's EID-path record filter (`ucpathEmployeeId === emplId`) is unchanged — it is a genuine "fuzzy search returned the wrong-but-real person" outcome, not a broken-navigation outcome, so it still soft-filters (triggering the existing name-search fallback) rather than throwing.
- **2026-07-02: CRM `?q=` search is fuzzy — a wrong-EID lookup silently returns a wrong person; gate on the record's `UCPath Employee ID`.** Added the onboarding-history reader (`history.ts`) + `onboardingHistory` selectors + the `"Onboarding History"` `CRM_SECTION_URLS` mapping for oath-signature's CRM verification. Live-mapped on EID 10883906 / 10883915: the history grid is `table.detailList` with 5-direct-cell data rows; the oath-signed event is the `→ "Witness Ceremony Oath New Hire Signed"` transition. Because the search is fuzzy (see Gotchas), the reader is only ever reached after `verifyOathInCrm` confirms the opened record's `UCPath Employee ID` equals the target EID — never trust a bare search hit.
