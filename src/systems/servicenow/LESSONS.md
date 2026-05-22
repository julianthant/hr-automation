# ServiceNow Lessons Learned

## 2026-05-15 — HR Inquiry form interactions need selector-health wrappers

**Tried:** Driving the ServiceNow HR Inquiry form from `oath-upload` with direct locator clicks/fills.

**Failed because:** The selectors live in the ServiceNow system registry, but workflow-local calls without `safeClick` / `safeFill` labels are invisible to selector-health aggregation when fallbacks trigger.

**Fix:** Wrap ServiceNow form interactions with `safeClick` / `safeFill` labels prefixed `servicenow hr inquiry ...`; keep selector changes in `src/systems/servicenow/selectors.ts`.

**Tags:** servicenow, selector-health, safeClick, safeFill, oath-upload
