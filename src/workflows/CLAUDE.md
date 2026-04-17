# Workflows — Orchestration Layer

Multi-step workflow orchestration. Each subdirectory is a complete workflow that composes modules (auth, browser, UCPath, CRM, Kuali, Kronos).

## Creating a New Workflow

Follow this checklist exactly:

### 1. Workflow Directory Structure
```
src/workflows/{name}/
  schema.ts     — Zod input validation schema
  workflow.ts   — Main orchestration with withTrackedWorkflow
  config.ts     — Workflow-specific constants
  index.ts      — Barrel exports
  CLAUDE.md     — Module documentation (Files, Data Flow, Gotchas, Verified Selectors, Lessons Learned)
```

**Do NOT create `tracker.ts` Excel writers for new workflows.** The dashboard JSONL (emitted automatically by `withTrackedWorkflow` + `updateData`) is the only observability the user wants. Skip `appendRow` / `ColumnDef` / `.xlsx` files. Existing workflows (onboarding, work-study, eid-lookup, kronos, separations) still have `tracker.ts` — leave them alone, but do not add new ones.

### 2. Required Patterns
- Wrap execution in `withTrackedWorkflow(workflowName, id, data, fn)`
- Use `setStep(step)` at each major phase transition
- Use `updateData(d)` to enrich entries with discovered data
- Use `withLogContext()` wrapping `withTrackedWorkflow` for log streaming
- Use shared auth modules (`fillSsoCredentials`, `pollDuoApproval`) — never inline auth
- Use `Session.launch()` from `src/core/` for multi-browser workflows (via `defineWorkflow` handler)
- Use `Promise.allSettled` for parallel system queries

### 3. Dashboard Integration (MANDATORY)
The dashboard now reads all UI metadata from the server-side registry — no `WF_CONFIG` edit needed. After creating the workflow:
1. Kernel workflows: add `label`, `getName`, `getId`, and labeled `detailFields` inside `defineWorkflow({ ... })`. Every key in `detailFields` should be populated by at least one `ctx.updateData({ [key]: ... })` call before the workflow returns (a runtime `log.warn` fires if not).
2. Legacy (non-kernel) workflows: call `defineDashboardMetadata({ name, label, steps, systems, detailFields })` at module load in the workflow's `index.ts`.
3. Add to the "Step Tracking Per Workflow" table in root `CLAUDE.md`.
4. Test: run `npm run dashboard`, trigger the workflow, verify entries appear.

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
| separations | `npm run separation` | Kuali, Old Kronos, New Kronos, UCPath (x2) | Yes (5 browsers, batch sequential) |
| eid-lookup | `tsx src/cli.ts eid-lookup` | UCPath, CRM (optional) | Yes (shared auth) |
| old-kronos-reports | `npm run kronos` | UKG | Yes (N workers) |
| work-study | `npm run work-study` | UCPath | No |

## Lessons Learned

- **2026-04-10: Batch mode pattern for sequential processing** — For workflows that reuse browser sessions across multiple items (e.g. separations), the pattern is: (1) pre-emit `pending` for all items with pre-assigned `runId`s, (2) launch/auth browsers once, (3) process each item sequentially passing `preAssignedRunId` to `withTrackedWorkflow`. Use `onCleanup` callback for browser teardown after the last item.
- **2026-04-10: ensurePageHealthy() before each phase** — SAML errors and session expiry can happen silently between phases. Each major phase (extraction, transaction, finalization) should call `ensurePageHealthy()` to check for error pages before proceeding. Without this, the workflow fails with cryptic selector errors instead of a clear "session expired" message.
