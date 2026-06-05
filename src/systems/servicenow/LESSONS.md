# ServiceNow Lessons Learned

## 2026-06-04 — `.select2-drop-active` is NOT unique; scope the drop search by field name

**Tried:** `select2DropSearch` = `page.locator(".select2-drop-active input.select2-input")` and `select2ResultOption` = `.select2-drop-active .select2-result-label` filtered by text — relying on the JSDoc claim that Select2 v3 keeps only one drop active at a time.

**Failed because:** False for this ServiceNow build. After the `Specifically:` drop is used and `Category:` is opened, BOTH drops keep `class="select2-drop-active"` AND both keep their search input (`input.select2-input`) in the DOM (`aria-expanded="true"` on both). `.select2-drop-active input.select2-input` then resolves to 2 elements and `locator.fill` dies: `strict mode violation: ... resolved to 2 elements` — so `fill-form` failed on `Category` and the oath-upload ticket never filed (run `ou-120730-30e8`, 2026-06-04).

**Fix:** Scope by the per-drop search input's accessible name, which is unique and stable: `Select Specifically:` / `Select Category:` (note the `Select ` prefix — distinct from the choice anchor's `Specifically:` / `Category:`). `select2DropSearch(page, fieldLabel)` → `getByRole("combobox", { name: \`Select ${fieldLabel}:\` })`. `select2ResultOption(page, fieldLabel, label)` scopes the `.select2-result-label` rows to that field's own `.select2-drop` ancestor (xpath from the search input), so it can't pick a row out of a sibling field's lingering-active drop. Callers in `oath-upload/fill-form.ts` pass `"Specifically"` / `"Category"`. Verified against the strict-mode DOM dump from the failing run (the form is behind UCSD SSO+Duo, so the run's error is the authoritative live snapshot).

**Selector:** `hrInquiry.select2DropSearch`, `hrInquiry.select2ResultOption`

**Tags:** servicenow, select2, combobox, typeahead, drop-active, strict-mode, oath-upload

## 2026-06-02 — "Specifically:"/"Category:" are Select2 v3, not plain comboboxes

**Tried:** `hrInquiry.specificallyInput` = `getByRole("combobox", { name: "Specifically:" })`, then click → type → click option.

**Failed because:** The HR Inquiry typeahead is **Select2 v3**. The accessible combobox resolves to an OFFSCREEN focusser (`input.select2-focusser.select2-offscreen`); the visible widget is a sibling `a.select2-choice` that **intercepts pointer events**. Clicking the focusser times out after 10s ("element intercepts pointer events" / `click failed after 10009ms`), so `fill-form` never finished and the ticket never filed.

**Fix:** Interact with the Select2 widget the way Select2 v3 expects — click the visible `a.select2-choice` anchor to open the drop, type into the open drop's search box, then click the matching result row. New registry selectors: `specificallyChoice` / `categoryChoice` (the `.select2-choice` anchor, scoped via the offscreen combobox's shared `.select2-container` ancestor), `select2DropSearch` (the `.select2-drop-active input.select2-input`), and `select2ResultOption(page, label)` (a `.select2-result-label` filtered by text). `specificallyInput`/`categoryInput` are kept only as the accessible-name anchors. `Category` still tries native `selectOption` first, then falls back to the same Select2 path.

**Selector:** `hrInquiry.specificallyChoice`, `hrInquiry.select2DropSearch`, `hrInquiry.select2ResultOption`

**Tags:** servicenow, select2, combobox, typeahead, offscreen-focusser, pointer-intercept, oath-upload

## 2026-05-15 — HR Inquiry form interactions need selector-health wrappers

**Tried:** Driving the ServiceNow HR Inquiry form from `oath-upload` with direct locator clicks/fills.

**Failed because:** The selectors live in the ServiceNow system registry, but workflow-local calls without `safeClick` / `safeFill` labels are invisible to selector-health aggregation when fallbacks trigger.

**Fix:** Wrap ServiceNow form interactions with `safeClick` / `safeFill` labels prefixed `servicenow hr inquiry ...`; keep selector changes in `src/systems/servicenow/selectors.ts`.

**Tags:** servicenow, selector-health, safeClick, safeFill, oath-upload
