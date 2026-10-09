## Summary

<!-- 1-3 bullet points: what changed and why -->

## Type of change

- [ ] Bug fix
- [ ] New feature (existing workflow)
- [ ] New workflow
- [ ] Kernel / infrastructure change
- [ ] Selectors / system module update
- [ ] Dashboard / tracker change
- [ ] Docs / CLAUDE.md update only

## New workflow checklist (if applicable)

- [ ] `defineWorkflow({ name, label, getName, getId, systems, steps, schema, detailFields, ... })` declared in `src/workflows/<name>/workflow.ts`
- [ ] Workflow registered (auto via `defineWorkflow`)
- [ ] CLI command added in `src/cli.ts` (normal + `:dry`)
- [ ] Workflow CLAUDE.md created with Files / Data Flow / Gotchas / Lessons sections
- [ ] Added to "Step Tracking Per Workflow" table in root `CLAUDE.md`
- [ ] Dry-run prints planned action without launching browser
- [ ] Per-system selectors (if new) co-located in `src/systems/<system>/selectors.ts` with verified-date comments

## Verification

- [ ] `npm run typecheck && npm run typecheck:all` exit 0
- [ ] `npm test` passes (note new test count if any added)
- [ ] `npm run build:dashboard` succeeds (if frontend touched)
- [ ] Affected dry-runs exit 0
- [ ] Live run completed by reviewer (if Duo-gated workflow)

## Test plan

<!-- How a reviewer should verify the change -->
