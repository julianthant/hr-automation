# Workflows — Orchestration Layer

Multi-step workflow orchestration. Each subdirectory is a complete workflow that composes modules (auth, browser, UCPath, CRM, Kuali, Kronos).

## Creating a New Workflow

Follow this checklist exactly:

### 1. Workflow Directory Structure
```
src/workflows/{name}/
  schema.ts     — Zod input validation schema
  workflow.ts   — Main orchestration with withTrackedWorkflow
  tracker.ts    — Excel tracking (Excel-only, no trackEvent calls)
  config.ts     — Workflow-specific constants
  index.ts      — Barrel exports
  CLAUDE.md     — Module documentation (Files, Data Flow, Gotchas, Verified Selectors, Lessons Learned)
```

### 2. Required Patterns
- Wrap execution in `withTrackedWorkflow(workflowName, id, data, fn)`
- Use `setStep(step)` at each major phase transition
- Use `updateData(d)` to enrich entries with discovered data
- Use `withLogContext()` wrapping `withTrackedWorkflow` for log streaming
- Use shared auth modules (`fillSsoCredentials`, `pollDuoApproval`) — never inline auth
- Use `WorkflowSession.create()` for multi-browser workflows
- Use `Promise.allSettled` for parallel system queries

### 3. Dashboard Integration (MANDATORY)
After creating the workflow, update the dashboard:
1. Add to `WF_CONFIG` in `src/dashboard/components/types.ts`
2. Add step definitions matching your `setStep()` calls
3. Add to the "Step Tracking Per Workflow" table in root `CLAUDE.md`
4. Test: run `npm run dashboard`, trigger the workflow, verify entries appear

### 4. CLI Integration
Add the command to `src/cli.ts` using Commander pattern. Add both normal and `:dry` variants.

### 5. Documentation
- Create `CLAUDE.md` in the workflow directory
- Add to the Architecture section in root `CLAUDE.md`
- Add npm scripts to `package.json` and the Commands section in root `CLAUDE.md`

## Existing Workflows

| Workflow | CLI | Systems | Parallel? |
|----------|-----|---------|-----------|
| onboarding | `npm run start-onboarding` | CRM, UCPath, I9 | Yes (batch mode) |
| separations | `npm run separation` | Kuali, Old Kronos, New Kronos, UCPath (x2) | Yes (5 browsers) |
| eid-lookup | `tsx src/cli.ts eid-lookup` | UCPath, CRM (optional) | Yes (shared auth) |
| old-kronos-reports | `npm run kronos` | UKG | Yes (N workers) |
| work-study | `npm run work-study` | UCPath | No |

## Lessons Learned

*(Add entries here when workflow-level patterns or bugs are discovered — document what went wrong and the fix)*
