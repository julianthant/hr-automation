# HR Automation Refactor — Review Request

**Audience:** independent reviewer (Opus 4.7) evaluating design soundness, execution strategy, and tradeoffs.
**Author:** Claude Opus 4.6 working with the repo owner.
**Date:** 2026-04-15.
**Ask:** Honest feedback — what's wrong, what's over-engineered, what's under-specified, what should be reordered, what should be dropped.

---

## 1. Context

### What the system is

`hr-automation` is a Playwright-based HR automation tool used at UCSD. It automates six HR workflows by driving headed browsers through legacy enterprise web apps (UCPath PeopleSoft, Kuali Build, Old/New Kronos, Salesforce-based CRM, I-9 Complete). Each workflow logs the user in (SSO + Duo MFA), navigates multiple internal systems, extracts data, fills forms, and writes tracker entries.

The six workflows:
1. **onboarding** — CRM → UCPath Smart HR hire transaction (UC_FULL_HIRE)
2. **separations** — Kuali extract → Kronos timecard checks → UCPath termination
3. **eid-lookup** — UCPath Person Org Summary name search, optional CRM cross-verify
4. **kronos-reports** — batch Time Detail PDF downloads from UKG
5. **work-study** — UCPath PayPath position/compensation updates
6. **emergency-contact** — batch Emergency Contact fill-in from YAML input

Runtime: Node + TypeScript (NodeNext ESM), tsx for execution, Playwright for browsers, Commander for CLI, Zod for input schemas, a React 19 dashboard (Vite + HeroUI + Tailwind) served via SSE from a Node backend. No framework — single-repo application.

### Scale

- ~20,000 lines of TypeScript across `src/`
- 5 per-system navigation modules (~1500 lines each)
- 6 workflow orchestration files (200–650 lines each)
- 150+ inline Playwright selectors scattered across modules
- Solo developer (the user) + Claude as collaborator

---

## 2. Problems identified (evidence-based survey)

A codebase survey at the start of this refactor found:

1. **`WorkflowSession` class** exists in `src/browser/session.ts` but **zero workflows use it**. Every workflow calls `launchBrowser()` directly with a different pattern — per-page (onboarding), tiled (separations), worker-pooled (kronos-reports, eid-lookup), reused-across-batch (emergency-contact).
2. **Auth-ready promise chains are copy-pasted** across multi-system workflows. Separations has ~50 lines of `.catch(() => {}).then(...)` plumbing to coordinate 4 sequential Duo MFAs while allowing work to start as each browser authenticates.
3. **Dashboard `WF_CONFIG` drifts from workflow code.** Step names live in two places (workflow handler + `src/dashboard/components/types.ts`); keeping them in sync is manual.
4. **Four files exceed 500 lines** — `ucpath/transaction.ts` (657), `eid-lookup/search.ts` (638), `separations/workflow.ts` (523), `old-kronos/navigate.ts` (514). Mostly because lifecycle/orchestration code lives next to business logic.
5. **`src/utils/` is a dumping ground** — `roster-verify.ts` and `sharepoint-download.ts` are emergency-contact-specific but live in shared utils.
6. **Error handling is inconsistent.** Only onboarding has retries. Separations swallows phase failures silently via `.catch(()=>{})`. Others crash on flakes.
7. **Dashboard event richness varies.** Onboarding emits 7 steps + 5 `updateData` calls; work-study emits 2 + minimal. Feels uneven in the UI.
8. **Selectors are entirely inline strings.** Only 2 files use `.or()` fallback chains despite PeopleSoft grid IDs mutating on page refresh.

---

## 3. User's prioritization (ranked)

Given the above, the user ranked concerns:

| Priority | Concern | Subsystem |
|----------|---------|-----------|
| **B** (sharpest) | Workflow code feels copy-pasted | Kernel |
| **A** | Selectors break on UI changes | Selector registry |
| **D** | Dashboard feels inconsistent | Dashboard richness |
| **E** | Directory structure feels wrong | Directory restructure |
| **C** (least) | Future Claude sessions drift off-pattern | CLAUDE.md conventions |

Within subsystem B, the annoyance ranking was:
1. Dashboard event wiring (`setStep`, `updateData`, `withLogContext`)
2. Browser setup (`launchBrowser`, tiling, sessionDir)
3. Batch mode plumbing (preAssignedRunId, reused browsers, between-item resets)
4. Error handling (retries, `classifyError`, SIGINT teardown)
5. Auth orchestration (least annoying — existing `sso-fields.ts` + `duo-poll.ts` helpers work)

---

## 4. The plan: 4 subsystem-level sessions

Rather than attempt one mega-refactor, we split into four subsystems, each with its own brainstorm → spec → plan → execute cycle:

| # | Subsystem | Scope | Status |
|---|-----------|-------|--------|
| **B + E** | Workflow kernel + directory restructure | Build `src/core/`. Migrate all 6 workflows. Rename per-system dirs to `src/systems/`. | Kernel done; 1/6 migrations in progress |
| **A** | Selector registry | Centralize selectors in `src/systems/<system>/selectors.ts` with `.or()` fallback chains | Not started |
| **D** | Dashboard richness | Standardize per-workflow `updateData` | Not started |
| **C** | CLAUDE.md conventions | Rewrite docs around the new kernel | Not started |

**Why decomposed:** A single spec covering all five would be vague and hard to execute. Each sub-project produces working, testable software on its own. A/D/C depend on the kernel existing, so B+E lands first.

**Why separate Claude sessions:** Context decay in long-running conversations hurts architectural reasoning. Each subsystem gets a fresh session for max-quality judgment. Durable memory (spec + plan + memory files) carries state across boundaries.

---

## 5. Subsystem B+E in detail (the one in flight)

### The kernel (`src/core/`)

**Declarative workflow API.** Each workflow becomes a single `defineWorkflow()` call:

```ts
export const separationsWorkflow = defineWorkflow({
  name: 'separations',
  systems: [
    { id: 'kuali',      login: loginToKuali },
    { id: 'oldKronos',  login: loginToUKG, sessionDir: 'ukg_session_sep' },
    { id: 'newKronos',  login: loginToNewKronos },
    { id: 'ucpath',     login: loginToUCPath },
  ],
  tiling: 'auto',
  authChain: 'interleaved',
  steps: ['launching','authenticating','kuali-extraction','kronos-search',
          'ucpath-job-summary','ucpath-transaction','kuali-finalization'] as const,
  schema: SeparationSchema,
  detailFields: ['firstName','lastName','emplId','docId'],
  handler: async (ctx, data) => {
    const sep = await ctx.step('kuali-extraction', () => extractKuali(await ctx.page('kuali')))

    const [oldK, newK, js] = await ctx.parallel({
      oldK: async () => searchOldKronos(await ctx.page('oldKronos'), sep.eid),
      newK: async () => searchNewKronos(await ctx.page('newKronos'), sep.eid),
      js:   async () => getJobSummary(await ctx.page('ucpath'), sep.eid),
    })

    const txId = await ctx.step('ucpath-transaction',
      () => runTermTransaction(await ctx.page('ucpath'), resolveDate(sep, oldK, newK)))

    await ctx.step('kuali-finalization',
      () => writeBackToKuali(await ctx.page('kuali'), txId))
  },
})
```

**Runner responsibilities** (all auto, all hidden from handlers):
- Schema validation before launching
- Parallel browser launch + tiling computation
- Sequential or interleaved auth chain with `.catch()` guards
- SIGINT handler (sync `failed` write + Chrome kill + `process.exit(1)`)
- Tracker lifecycle (`withTrackedWorkflow`, `withLogContext`)
- Step emission to tracker + dashboard
- Batch mode (sequential reused-browsers OR worker-pool)
- Between-item hooks (`'health-check' | 'reset-browsers' | 'navigate-home'`)
- `preEmitPending` (show full queue in dashboard before processing)
- Cleanup (close browsers, unregister SIGINT)

**Handler surface** (`ctx`):
- `ctx.page(id): Promise<Page>` — lazy accessor, awaits that system's auth-ready promise on first call
- `ctx.step<R>(name, fn): Promise<R>` — name typed to `steps: [...] as const`, typo = compile error
- `ctx.parallel({ a: fn, b: fn }): Promise<Record<key, PromiseSettledResult>>` — named-object parallel runner
- `ctx.updateData(patch)` — enrich tracker entry
- `ctx.log`, `ctx.runId`, `ctx.isBatch`, `ctx.session` (escape hatch)

### Directory moves

```
src/ucpath/      → src/systems/ucpath/      (with work-study migration)
src/crm/         → src/systems/crm/         (with onboarding migration)
src/i9/          → src/systems/i9/          (with onboarding migration)
src/old-kronos/  → src/systems/old-kronos/  (with kronos-reports migration)
src/kuali/       → src/systems/kuali/       (with separations migration)
src/new-kronos/  → src/systems/new-kronos/  (with separations migration)

Workflow-specific utils moved out of src/utils/:
  src/utils/roster-verify.ts      → src/workflows/emergency-contact/roster-verify.ts
  src/utils/sharepoint-download.ts → src/workflows/emergency-contact/sharepoint-download.ts

Deleted:
  src/browser/session.ts (unused WorkflowSession)
```

### Dashboard wiring

- Static `WF_CONFIG` in the frontend → **deleted**
- `defineWorkflow` registers metadata in a module-level registry at import time
- SSE backend exposes `GET /api/workflow-definitions`
- Frontend fetches once via `WorkflowsProvider` / `useWorkflows()` React Context
- Adding a workflow = 1 new file + 1 line in `cli.ts`; zero dashboard edits

---

## 6. Architecture decisions (with rationale — and counter-arguments)

Each decision below includes the reasoning and the plausible argument against it, so the reviewer can push back meaningfully.

### Decision 1: Declarative config over imperative function

**Picked:** `defineWorkflow({ config object, handler })` with `steps: [...] as const` as the typed source of truth.

**Reasoning:**
- User's #1 concern is dashboard drift. Steps-as-config makes drift a compile error.
- User's last concern was future Claude sessions. A config type signature is discoverable; conventions-in-prose are not.
- Separations (the hardest case) still fits cleanly via `ctx.parallel`.

**Counter-argument a reviewer might raise:**
- Config object is rigid for exploratory dev work. Imperative `runWorkflow(config, async (ctx) => {...})` would let you build workflows incrementally without pre-declaring step names.
- The typed `steps` tuple provides narrow value for the complexity cost. Every step-list edit requires touching config AND handler.
- Declarative config tempts adding more fields over time (`retries`, `timeout`, `onError`) until it's a tiny framework.

### Decision 2: `ctx.page(id): Promise<Page>` — explicit await, not proxy

**Picked:** User writes `const page = await ctx.page('ucpath')`.

**Reasoning:**
- Proxies produce confusing stack traces when misused.
- Explicit `Promise` is honest about the async wait for auth.
- Parallelism preserved when each task in `ctx.parallel` awaits its own page.

**Counter-argument:**
- Every handler line has `await ctx.page(X)` boilerplate. A proxy (`ctx.browsers.ucpath.click(...)`) would read cleaner.
- The "forget to await" footgun is real — returns `Promise`, which when passed to `page.click()` throws cryptic `TypeError: X.click is not a function`.

### Decision 3: Runtime registration, not codegen, for dashboard metadata

**Picked:** `defineWorkflow` registers into a `Map<string, Metadata>` at import time; SSE exposes `/api/workflow-definitions`; frontend fetches once.

**Reasoning:**
- No build-time tooling required. One fewer thing to break.
- Dashboard adapts to whatever workflows are registered — no codegen diff to review.

**Counter-argument:**
- Frontend now depends on an async fetch at mount. Adds a loading state.
- Type safety for step names across the frontend is lost (they're `string[]` coming from the wire).
- Codegen would produce a typed constant shippable as code.

### Decision 4: Directory structure stays module-based (not controllers/services)

**Picked:** Keep the existing `src/systems/<system>/` + `src/workflows/<name>/` shape. Add `src/core/`. Rename per-system dirs into `systems/`.

**Reasoning:**
- The CLI is the controller. There is no HTTP layer. "Services" would be a dumping ground.
- Current shape mirrors real systems (UCPath, Kuali, Kronos) — bugs get reported by system name, so the directory tree already matches how problems arrive.

**Counter-argument:**
- `systems/` is a rename that doesn't buy much — the old names were already self-documenting. Pure churn with no behavioral benefit.
- A reviewer from a web-backend background might still argue for `controllers/` + `services/` even in a CLI.

### Decision 5: Migration order — simplest first

**Picked:** work-study → emergency-contact → eid-lookup → kronos-reports → onboarding → separations.

**Reasoning:**
- Each migration validates the kernel incrementally. Break early on a simple workflow, not while debugging separations.
- Work-study (1 system, 2 steps) was the smallest possible kernel test.

**Counter-argument (and what actually happened):**
- **The user bumped onboarding up** because it's higher operational priority and they can verify it live while the other 5 can't be verified without business cost. New order: work-study (code complete) → onboarding → emergency-contact → eid-lookup → kronos-reports → separations.
- Doing simplest-first can feel like busywork when the real value sits further down the queue.
- Reviewer might argue: "Just do the hardest one first. If the kernel can do separations, it can do anything; if it can't, fix the kernel, not the workflow."

### Decision 6: Skip live verification for all Phase 2 migrations except onboarding

**Picked (per user's latest call):** Migrations ship on typecheck + tests + dry-run green. No "one real run with user watching" gate for work-study, emergency-contact, eid-lookup, kronos-reports, separations.

**Reasoning:**
- The user can't run work-study / eid-lookup / etc. in real conditions right now without operational cost.
- Onboarding will get live verification since the user has onboarding work to do anyway.
- Kernel itself has ~160 unit tests + integration test passing.

**Counter-argument:**
- Live Duo flow and live PeopleSoft quirks are the things tests can't catch. Real-run was the meaningful gate.
- Bugs surface later, mid-workflow, when the user actually needs the workflow and can't roll back easily.
- Reviewer should probably flag this as the single biggest risk in the plan.

### Decision 7: Known debt carried forward

Three debt items were deliberately left after Phase 1 kernel build, with gates:

| Debt | Gate | Reasoning |
|------|------|-----------|
| `runWorkflowBatch` sequential doesn't wrap each item in `withTrackedWorkflow` | Must fix before emergency-contact migration | Only batch workflows hit it; not worth building speculatively |
| `ctx.session.newWindow()` / `closeWindow()` are throw stubs | Must fix before separations migration | Only separations might need a 5th browser; TBD if even that |
| Tracker stringifies values (dates lose fidelity) | Fix any time during Phase 2 | Dashboard cosmetic; not a correctness issue |

**Counter-argument:**
- "Gates" are a fragile discipline. Easy to forget. Better to have blocked migrations (CI or checklist) or to fix all debt at kernel-time.
- Building speculatively-unused API (`newWindow`) is sometimes worth it to keep the abstraction coherent.

### Decision 8: No retries in kernel

**Picked:** Kernel has no retry primitive. Workflows that want retries (onboarding) keep their own `retryStep` helper.

**Reasoning:**
- Onboarding's retry is the only current use case. Don't abstract for n=1.
- Retry policies vary (backoff, per-step allowlist) — a built-in would be over-constrained.

**Counter-argument:**
- Duo MFA and PeopleSoft flakes are ubiquitous. Every workflow probably *should* have retries; we're just under-engineering our way out of it.
- A kernel-level `ctx.retry(fn, { attempts: 3 })` helper would be 10 lines and solve this once.

---

## 7. Current status (as of this writing)

```
✅ Spec written:        docs/superpowers/specs/2026-04-15-workflow-kernel-design.md
✅ Build plan written:  docs/superpowers/plans/2026-04-15-workflow-kernel-build-plan.md (23 tasks)
✅ Phase 1 executed:    Kernel shipped. Tag: kernel-build-complete.
                        src/core/ is 673 lines total (budget was ≤800).
                        160/160 unit tests passing. Typecheck clean.

🟡 Phase 2 in progress:
   ✅ work-study migration code landed (Tasks 1–2 + fix commit)
   ⏸ Task 3 (live verification) — SKIPPED per user call
   🟡 Task 4–5 (CLAUDE.md update + tag) — queued
   🔜 Onboarding migration plan exists at:
      docs/superpowers/plans/2026-04-15-migrate-onboarding-single-mode-plan.md
   ⬜ 4 more migrations after: emergency-contact, eid-lookup, kronos-reports, separations

⬜ Subsystem A (selectors) — not started
⬜ Subsystem D (dashboard) — not started
⬜ Subsystem C (CLAUDE.md) — not started
```

**Phase 1 deviations from the spec** (documented in `docs/superpowers/sessions/02-kernel-execution-checkpoint.md`):
1. `SystemSlot.browser: Browser | null` (needed to accommodate persistent-session return shape from `launchBrowser`)
2. `updateData` signature aligned with spec (`Partial<TData & Record<string, unknown>>` rather than intersection of partials)
3. SSE endpoint renamed to `/api/workflow-definitions` because `/api/workflows` was already taken
4. `WF_CONFIG` kept in frontend for UI-specific fields (`label`, `getName`, `getId`); only `steps` were swapped. Full elimination deferred to subsystem D.
5. `withTrackedWorkflow` invocation: plan had wrong signature; corrected during implementation. Adapter added for `Record<string, unknown>` → `Record<string, string>` because tracker only accepts string values.

---

## 8. Specific questions I want feedback on

Please push back on any of these if they seem wrong.

1. **Is the declarative kernel over-engineered for six workflows + one developer?** At what codebase size does this pay off? Would a thinner "helpers + conventions" approach (Option B from brainstorm) have been enough?

2. **Is skipping live verification for 4 of 6 migrations acceptable risk?** The kernel has unit + integration tests, dry-run works. But live Duo + PeopleSoft behavior is the bulk of real bugs. What's the honest cost of this call?

3. **Is the four-session split (separate Claude conversations per subsystem) over-process for a solo-dev refactor?** Context decay is real, but is it worth the handoff overhead (spec + plan + session prompts written per sub-project)?

4. **Is `src/ucpath/` → `src/systems/ucpath/` worth the churn?** The grouping prefix doesn't add information. Imports across the codebase all update. If this is pure cosmetic, should it be reverted?

5. **Migration order: simplest-first vs. most-critical-first?** The user overrode simplest-first to prioritize onboarding (real operational need). Does that signal the original order was wrong — should all migrations be priority-ordered by operational impact?

6. **Should the three debt items block migrations, not just "gate" them?** Are informal gates robust enough, or should they be CI checks / blocked task lists?

7. **Are there missing abstractions the kernel should own but doesn't?** Candidates: retries, timeouts, per-step screenshots on failure, explicit mid-workflow checkpoints for resume.

8. **Is the runtime-registration + fetch-on-mount pattern for dashboard metadata solid?** Or should this be codegen'd for type safety across the frontend boundary?

9. **Have we correctly scoped the remaining subsystems (A / D / C)?** Or should any of them be merged / split differently now that we know more from Phase 1?

10. **Is there an escape hatch we should add to the kernel before more migrations land?** Once migrations commit to the API, changing it is costly. If the kernel is missing something, now's the cheap time to add it.

---

## 9. Reference artifacts

For the reviewer to inspect:

| File | Purpose |
|------|---------|
| `docs/superpowers/specs/2026-04-15-workflow-kernel-design.md` | Authoritative architecture spec |
| `docs/superpowers/plans/2026-04-15-workflow-kernel-build-plan.md` | 23-task kernel build plan |
| `docs/superpowers/plans/2026-04-15-migrate-work-study-plan.md` | First migration plan (5 tasks) |
| `docs/superpowers/plans/2026-04-15-migrate-onboarding-single-mode-plan.md` | Onboarding migration plan (pre-written) |
| `docs/superpowers/sessions/02-kernel-execution-checkpoint.md` | Phase 1 closeout — what shipped + deviations + debt |
| `docs/superpowers/sessions/02b-phase2-migrations.md` | Phase 2 handoff for a fresh Claude session |
| `src/core/` | The kernel itself (types, workflow.ts, session.ts, stepper.ts, pool.ts, registry.ts) |
| `src/workflows/work-study/workflow.ts` | First workflow migrated to the kernel |

---

**Reviewer: please critique. Where is this wrong, over-built, under-built, or misordered?**
