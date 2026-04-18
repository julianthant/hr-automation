# Dashboard Workflow Runner

Date: 2026-04-18
Status: in-progress

## Goal

Let the operator launch any workflow from the dashboard UI instead of opening a terminal. Click "Run Workflow" → pick from the workflow registry → fill a schema-driven form → click ENGAGE → watch progress live in the same dashboard.

## Aesthetic direction (mission-control HUD)

Telemetry-console feel. Distinctive typography pair (NOT Inter/Roboto), single bold amber accent for the launch CTA, refined precision rather than maximalist. Drawer slides in from the right; existing dashboard is unchanged.

- Display: **Instrument Serif** italic — used sparingly for the drawer title and section labels.
- Mono: **Geist Mono** — labels, inputs, buttons, runId badges.
- Accent: **#F59E0B amber** for the ENGAGE button only. Distinct from the dashboard's existing primary (warm tan).
- Surface: deep `#0A0B0D` over `rgba(0,0,0,0.55)` blurred backdrop.
- Motion: 320ms `cubic-bezier(0.16, 1, 0.3, 1)` drawer slide; staggered field reveals at 40ms intervals.

## Constraints (non-negotiable)

- DO NOT modify any file under `src/workflows/<name>/` (selectors stay stable).
- DO NOT add npm dependencies. Use HeroUI, sonner, lucide-react that are already installed.
- `.js` import extensions on backend (NodeNext).
- Frontend tests are not standard practice in this repo — verification via `npm run build:dashboard` + manual smoke.
- Single-spawn-per-call; concurrency cap of 4.

## Phases

### Phase 0 — plan + skill invocation (this doc)

- Write this plan.
- Invoke `frontend-design:frontend-design` for typography/color/motion choices.

### Phase 1 — Backend: argv mapping + child-process registry + endpoints

**New files:**
- `src/tracker/runner.ts` — `RunnerRegistry` class.
  - `argvFor(workflow, input)` — declarative mapping table per workflow that converts validated input → `{ command, args }`. Each entry decides `npm` vs `tsx` and assembles the argv list.
  - `RunnerRegistry.spawn(workflow, args)` — spawns a child via `child_process.spawn`, tracks `Map<runId, ChildProcess>`, enforces concurrency cap of 4, returns `{ runId, pid }`.
  - `RunnerRegistry.cancel(runId)` — `child.kill('SIGTERM')`, returns `boolean`.
  - `RunnerRegistry.list()` — active runs.
  - `RunnerRegistry.cleanup()` — kills all on parent shutdown.
  - Spawn options: `cwd: process.cwd()`, `stdio: ['ignore', 'pipe', 'pipe']` (pipe so parent doesn't deadlock; we don't actually read it), `detached: false`.
  - Concurrency cap: `RunnerError` thrown when limit hit; HTTP layer translates to 429.

**Modified file:**
- `src/tracker/dashboard.ts` — add 4 routes:
  - `POST /api/workflows/:name/run` — body `{ input }`. Validates name in registry. Looks up argv mapping. Spawns. Returns 202 `{ runId, pid }` or 429/404/400.
  - `POST /api/runs/:runId/cancel` — kills child. Returns `{ cancelled }`.
  - `GET /api/runs/active` — returns `RunnerRegistry.list()`.
  - `GET /api/workflows/:name/schema` — reads `schemas/<name>.schema.json`, returns 200 or 404.
  - Wire `RunnerRegistry.cleanup()` into `stopDashboard()`.

**New tests:**
- `tests/unit/tracker/runner.test.ts` — argv mapping table-driven (one per workflow), concurrency cap, cancel behavior. Use a `node -e "setTimeout(()=>{}, 5000)"` helper as the spawnable child so we don't depend on a real workflow.
- `tests/unit/tracker/runner-endpoints.test.ts` — request handler tests for each endpoint (route function + mock child registry).

**Commit:** `feat(tracker): backend endpoints + child-process registry for dashboard-launched workflows`

### Phase 2 — Frontend: schema-driven runner drawer

**New files:**
- `src/dashboard/components/RunnerDrawer.tsx` — slide-in drawer (right). Header: "RUN WORKFLOW" in italic Instrument Serif. Workflow picker (HeroUI Select). When a workflow is chosen: fetch `/api/workflows/:name/schema`, render `SchemaForm`. Footer: amber ENGAGE button + small status pill that shows the spawned runId.
- `src/dashboard/components/SchemaForm.tsx` — JSON Schema → input renderer.
  - `string` → text input (HeroUI `Input`).
  - `string + format=email` → email input.
  - `string + pattern` → text input with HTML `pattern` attr.
  - `integer` / `number` → numeric input.
  - `boolean` → switch.
  - `array of strings` → tag-style chips with comma/Enter to add.
  - File-path heuristic (`/(file|path|yaml)$/i`) → text input + small "Choose…" file picker that returns the file's `name` (browsers don't expose absolute paths; we also let the user paste an absolute path manually).
  - Object / nested fieldsets → recurse.
- `src/dashboard/components/RunnerLauncher.tsx` — small amber-bordered button in the TopBar's right area. Toggles drawer.
- `src/dashboard/lib/schema-form-utils.ts` — pure helpers (`coerceValue`, `defaultForType`, `isFilePathKey`).

**Modified files:**
- `src/dashboard/index.html` — add Google Fonts link for Instrument Serif + Geist Mono.
- `src/dashboard/index.css` — extend Tailwind theme inline with new font families. Add a `.runner-glow` utility for the amber CTA.
- `src/dashboard/App.tsx` — mount `<RunnerLauncher>` and `<RunnerDrawer>` (controlled visibility state).
- `src/dashboard/components/TopBar.tsx` — accept the launcher as a slot OR mount the launcher in App.tsx beside the topbar. Pick the simpler option.

**Verification:** `npm run build:dashboard` succeeds. No frontend unit tests.

**Commit:** `feat(dashboard): runner drawer with schema-driven form and mission-control HUD aesthetic`

### Phase 3 — Polish

- **Recent runs**: `RunnerDrawer` reads/writes `localStorage.recentRuns:<workflow>` (last 5). Click a recent → re-applies the input. Each entry shows a relative time + "↻" replay icon.
- **Cancel button**: when a run was just spawned (drawer still open), show a CANCEL pill. POSTs to `/api/runs/:runId/cancel`.
- **Dry-run toggle**: a `[ dry ]` checkbox on workflows that support `:dry` script. Maps to the `:dry` npm script when checked.
- **Non-spawnable graceful**: if a workflow has no argv mapper, show a small "CLI-only — copy command" box with the suggested terminal command instead of a form.
- **Toast**: sonner notification on spawn success / spawn failure.
- **Survives reload**: spawned child is independent (child_process default).

**Commit:** `feat(dashboard): runner polish — recent runs, cancel, dry-run toggle`

### Phase 4 — Verification + smoke

- `npm run typecheck && npm run typecheck:all && npm test` exit 0.
- `npm run build:dashboard` exit 0; document bundle delta vs ~901 kB baseline.
- Smoke (no real Duo): start dashboard, open drawer, pick `work-study`, fill `emplId: 12345 / effectiveDate: 01/01/2026`, check dry-run, ENGAGE. Verify queue panel shows new entry, cancel works.

## Notes / risks

- The dashboard already correlates entries by `runId` derived from `${id}#${count+1}` in `withTrackedWorkflow`. The spawned child's `runId` will appear naturally — no kernel changes needed for runId propagation. (Confirmed by reading `src/tracker/jsonl.ts` and `src/core/workflow.ts`.)
- `npm` invocation differs by platform. `child_process.spawn('npm', ...)` requires `shell: true` on Windows, but the dev environment is macOS. Set `shell: false` and rely on `npm` being on PATH; if Windows support becomes a concern later, add platform detection.
- File-path arrays for `emergency-contact` (yaml) and `kronos-reports` (no args needed — uses `batch.yaml` from disk): emergency-contact takes a YAML path directly (the workflow's input schema is the parsed YAML, not the CLI args). Kronos takes no required args. The runner's argv mapping handles these CLI-shape mismatches.
- Concurrency cap = 4 mirrors the kronos worker default. Reasonable cap, can be lifted later.
