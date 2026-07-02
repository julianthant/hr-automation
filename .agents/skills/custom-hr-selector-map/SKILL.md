---
name: custom-hr-selector-map
description: Guided loop for finding, adding, and verifying Playwright selectors in hr-automation. Enforces the registry-first rule and catalog regeneration to pass the architecture guard test.
---

# Selector Map

Use this skill whenever you need to find or add a selector. It enforces the selector discipline from `AGENTS.md`.

## Step 1 — Search first

Always search before mapping:

```bash
npm run selector:search "<your intent>"
```

- **Hit found** → USE IT. Do not remap. Record the FQN (e.g. `ucpath.jobData.compRateCodeInput`) and proceed.
- **No hit** → continue to Step 2.

Also check the relevant `src/systems/<system>/LESSONS.md` for prior failures on this intent.

## Step 2 — Map the live page

Open a `playwright-cli` session. It runs **headless by default** — omit `--headed` for autonomous verification (no display, no permission prompt); add `--headed` only when you need to watch. Verifying selectors is pre-authorized — don't pause to ask.

```bash
playwright-cli -s=mysel open "<url>"   # headless; add --headed only to watch
playwright-cli -s=mysel snapshot       # accessibility tree with ref IDs
playwright-cli -s=mysel fill e34 "test"
playwright-cli -s=mysel click e40
playwright-cli -s=mysel screenshot
```

For auth-gated pages (UCPath/CRM/Kuali/…), run `npm run sel:browser -- <login-url>` — it opens a headless session named `sel` with the `duo-autopilot/` extension loaded, which answers the Duo MFA ceremony itself (you still fill the SSO username/password from `.env`). Storage-state reuse is the fallback. Full recipe under "Verifying selectors" in the root `AGENTS.md`.

Notes:
- Refs: `e40` = main page, `f2e1` = element inside iframe #2.
- For UCPath: all content lives inside `#main_target_win0`. Use `getContentFrame(page)` — never query the outer page directly.
- For hidden-but-present elements: use `eval` with JS `.click()` instead of `click`.
- Dismiss the HR Tasks sidebar overlay before interacting with transaction forms.

Identify the best primary locator. Then build fallback chain (`.or()`, up to 6-deep) for any ID that mutates (PeopleSoft grid indices, tab-switch refreshes).

## Step 3 — Add to selectors.ts

Open `src/systems/<system>/selectors.ts` and add:

```ts
/**
 * <One-line description of what this selects and when it's visible>
 * @tags <comma-separated: form, grid, dropdown, button, modal, tab, input, etc.>
 * @verified 2026-05-06
 */
<namespaceName>.<functionName>: (frame: FrameLocator) =>
  frame.locator('<primary-selector>').or(frame.locator('<fallback-1>')),
```

Rules:
- Function must return `Locator` or `FrameLocator`, not a raw string.
- Never inline `page.locator("...")` outside `selectors.ts` — the architecture test rejects it.
- If the compound path is rooted in a registry locator (e.g. `row.locator("td").nth(1)`), add `// allow-inline-selector` at end of line.
- Bump the `// verified YYYY-MM-DD` date today.

## Step 4 — Regenerate the catalog

```bash
npm run selectors:catalog
```

This updates `src/systems/<system>/SELECTORS.md`. **Always run this after any change to `selectors.ts`**. The unit test `tests/unit/scripts/selectors/catalog.test.ts` will fail PRs that skip it.

## Step 5 — Append a LESSONS.md entry (if you hit a non-obvious failure)

If you discovered a non-obvious failure (wrong selector, timing issue, modal mask, iframe nesting), append to `src/systems/<system>/LESSONS.md`:

```md
## <Short title — what went wrong>

**Tried:** <what you tried>
**Failed because:** <root cause>
**Fix:** <what actually works>
**Tags:** <comma-separated tags matching the selector's @tags>
**Selector:** `<system>.<namespace>.<functionName>` (if applicable)
```

The lessons format test (`tests/unit/scripts/lessons-format.test.ts`) enforces the required subsections.

## Step 6 — Verify architecture guards

```bash
npm run test:architecture
```

Confirm:
- No inline-selector test failures (you added to `selectors.ts`, not inline).
- No catalog drift (you ran `npm run selectors:catalog`).

## Quick reference

| System | selectors.ts | LESSONS.md |
|---|---|---|
| UCPath | `src/systems/ucpath/selectors.ts` | `src/systems/ucpath/LESSONS.md` |
| CRM | `src/systems/crm/selectors.ts` | `src/systems/crm/LESSONS.md` |
| I9 | `src/systems/i9/selectors.ts` | `src/systems/i9/LESSONS.md` |
| Kuali | `src/systems/kuali/selectors.ts` | `src/systems/kuali/LESSONS.md` |
| Old Kronos | `src/systems/old-kronos/selectors.ts` | `src/systems/old-kronos/LESSONS.md` |
| New Kronos | `src/systems/new-kronos/selectors.ts` | `src/systems/new-kronos/LESSONS.md` |
| ServiceNow | `src/systems/servicenow/selectors.ts` | `src/systems/servicenow/LESSONS.md` |
| OnBase | `src/systems/onbase/selectors.ts` | `src/systems/onbase/LESSONS.md` |
| SharePoint | `src/systems/sharepoint/selectors.ts` | `src/systems/sharepoint/LESSONS.md` |
