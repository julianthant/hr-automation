# ServiceNow Lessons Learned

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
