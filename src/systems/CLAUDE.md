# Systems — Playwright Browser Drivers

Each subdirectory is one external system: Playwright selectors, navigation helpers, and per-system auth. Browser drivers belong here; orchestration belongs in `src/workflows/`.

Per-system CLAUDE.md files for system-specific gotchas and lessons:
- `src/systems/ucpath/CLAUDE.md` — PeopleSoft UCPath (most complex; modal mask, frame nav, grid IDs)
- `src/systems/crm/CLAUDE.md` — ACT CRM (Salesforce)
- `src/systems/i9/CLAUDE.md` — I9 Complete
- `src/systems/kuali/CLAUDE.md` — Kuali Build
- `src/systems/old-kronos/CLAUDE.md` — UKG Kronos
- `src/systems/new-kronos/CLAUDE.md` — WFD/Dayforce
- `src/systems/servicenow/CLAUDE.md` — ServiceNow HR
- `src/systems/sharepoint/CLAUDE.md` — SharePoint

## Selector registry

Every Playwright selector lives in a per-system `selectors.ts`:

```
src/systems/ucpath/selectors.ts
src/systems/crm/selectors.ts
src/systems/i9/selectors.ts
src/systems/old-kronos/selectors.ts
src/systems/kuali/selectors.ts
src/systems/new-kronos/selectors.ts
src/systems/servicenow/selectors.ts
src/systems/sharepoint/selectors.ts
```

Selectors are functions returning `Locator` / `FrameLocator`, each carrying a `// verified YYYY-MM-DD` comment. Fallback chains (`.or()`) up to 6-deep are used where PeopleSoft grid IDs mutate or similar brittle anchors need hardening. Wrap invocations with `safeClick` / `safeFill` from `src/systems/common/` to log `log.warn("selector fallback triggered: <label>")` when the primary + fallbacks all miss.

Do **not** inline `page.locator("...")` in system `.ts` files — the `tests/unit/systems/inline-selectors.test.ts` guard rejects PRs that do. Compound paths rooted in registry locators (`row.locator("td").nth(1)`) are whitelisted via end-of-line `// allow-inline-selector` comments.

When you verify a selector via `playwright-cli snapshot`, bump its `// verified` date in `selectors.ts`. Never guess selectors — map the live page first.

## Selector intelligence artifacts

Three artifacts per system support adding new workflows without re-mapping selectors or repeating past mistakes:

- **`src/systems/<sys>/SELECTORS.md`** — auto-generated catalog of every selector this system exports. Each entry has the FQN (e.g. `smartHR.tab.personalData`), one-line summary from JSDoc, `@tags`, and a clickable line ref into `selectors.ts`. Regenerate after any selectors.ts change with `npm run selectors:catalog`. Committed so future Claude sessions see the catalog without running anything. A unit test (`tests/unit/scripts/selectors/catalog.test.ts`) gates drift — PRs that change selectors without regenerating fail there.
- **`src/systems/<sys>/LESSONS.md`** — structured selector lessons. Required subsections per H2: `**Tried:**`, `**Failed because:**`, `**Fix:**`, `**Tags:**` (plus optional `**Selector:**` and `**References:**`). `tests/unit/scripts/lessons-format.test.ts` enforces the shape. When you discover a non-obvious selector failure, search this file first, then update/merge stale related entries or add one new entry if the failure mode is genuinely new.
- **`src/systems/<sys>/common-intents.txt`** — hand-curated 5-10 typical intents per system. Useful reference when authoring a new workflow's CLAUDE.md `selector:search` examples.

The fuzzy search:

```bash
npm run selector:search "comp rate"
# → top hit: ucpath/jobData.compRateCodeInput (selector)
# → also: relevant lessons that touch the same intent
```

Workflow when adding or finding a selector:
1. `npm run selector:search "<your intent>"` — does a matching selector exist?
2. If yes, USE IT. Don't remap.
3. If no, check the per-system `LESSONS.md` for related failure modes.
4. Map a new selector via `playwright-cli`, add JSDoc + `@tags` + `// verified <date>` in `selectors.ts`, run `npm run selectors:catalog`.
5. If you hit a non-obvious failure on the way, append a lesson to `LESSONS.md`.

Each per-system `CLAUDE.md` links to its `LESSONS.md` + `SELECTORS.md` and embeds this loop verbatim.

## Selector discovery (playwright-cli)

Use `playwright-cli` (install: `npm install -g @playwright/cli@latest`) to map selectors before writing code:

```bash
playwright-cli -s=session open --headed <url>
playwright-cli -s=session snapshot              # view element refs
playwright-cli -s=session click e40             # click by ref ID
playwright-cli -s=session screenshot
playwright-cli -s=session close
```

After mapping, add to `src/systems/<system>/selectors.ts` with `// verified YYYY-MM-DD` comment. Run `npm run selectors:catalog` to sync.
