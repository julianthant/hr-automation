# HR Automation — Improvements & Next Steps

**Date:** 2026-04-17
**State at writing:**
- Kernel shipped + 4 workflows migrated (work-study, emergency-contact, eid-lookup, onboarding single-mode).
- Subsystems A (selector registry), D (dashboard richness), C (CLAUDE.md conventions) all complete.
- 206 unit tests passing. Dashboard build green. All dry-runs green.
- Tags: `kernel-build-complete`, `kernel-migration-{work-study, emergency-contact, eid-lookup, onboarding-single}`, `subsystem-{a,c,d}-*-complete`.

Each item below is rated:
- **🔥 Quick wins** — high value, ≤ 1 day of work
- **⚡ Scheduled** — high value, 2–5 days
- **🧭 Initiatives** — high value, ≥ 1 week
- **💡 Speculative** — worth exploring, unknown payoff

---

## 1. Finish the refactor (loose ends)

### 🔥 1.1 Live-run verification for all migrated workflows
The 4 kernel workflows + A/D/C changes all shipped on typecheck + tests + dry-run. Duo-gated real runs are outstanding. Do one real run per workflow with dashboard open, confirm: all declared `detailFields` populate, step transitions fire, no silent regressions.

### 🔥 1.2 Annual dates configurable
`src/config.ts` has `ANNUAL_DATES` (end date `06/30/2026`). Source from an env var or a short YAML so fiscal-year roll doesn't need a code edit. 30-minute fix.

### ⚡ 1.3 Migrate kronos-reports to kernel (pool mode)
The kernel's pool mode is debt-fixed — wrap each item in `withTrackedWorkflow`. This migration should be straightforward because kronos-reports is already worker-pooled. Also moves `src/old-kronos-reports/` → tag `kernel-migration-kronos-reports`.


### ⚡ 1.4 Migrate separations to kernel (interleaved auth + phase parallelism)
The final boss. The kernel supports it via `authChain: "interleaved"` + `ctx.parallel`. The hard part is evaluating whether `newWindow/closeWindow` are actually needed (they're currently stub-throws) — probably not, but confirm by auditing `src/workflows/separations/workflow.ts` first.

### ⚡ 1.5 Migrate onboarding parallel mode
Today uses `workflow-legacy.ts` + `parallel.ts`. The missing kernel capability: "shared auth, per-worker-tab" pool mode. Each worker gets a new Page in a shared BrowserContext (not a fresh browser + new Duo each). This is the same pattern eid-lookup uses — generalize it into a kernel mode (`batch: { mode: "tab-pool" }`) or keep it as a helper.

### 🔥 1.6 Implement rehire path
Onboarding currently short-circuits with `status: "Rehire"` when a person is found in UCPath. Actually processing a rehire (new Smart HR "UC_REHIRE" template + fill existing EID) is a distinct workflow. Add `rehireWorkflow` or branch inside onboarding handler.

### 🔥 1.7 Prune stale `.tracker/` JSONL
Old JSONL files accumulate. Add `npm run clean:tracker` (or auto-trigger via `cleanOldTrackerFiles(7)`) to keep the dashboard snappy. 15-minute fix.

### 🔥 1.8 Dashboard bundle size
888 KB is larger than necessary for an internal tool. Code-split HeroUI components + lazy-load the LogPanel subtree. Expect 30–40% reduction. Nice-to-have.

---

## 2. New HR workflow automations (feature expansion)

### 🔥 2.1 Wage / title update
UCPath PayPath + Job Data edits for mid-year wage bumps or title changes. Similar shape to work-study. Batchable from a CSV of `emplId, newWage, effectiveDate, reason`.

### ⚡ 2.2 Position pool transfers
Move an employee from pool A to pool B (e.g. student → staff). Similar to work-study but broader field set.

### ⚡ 2.3 I9 renewals
I9 Complete periodically requires re-verification. Search I9 for expiring records, open each, complete re-verification.

### ⚡ 2.4 Timecard approvals batch
Old / New Kronos: bulk-approve submitted timecards for a given pay period. Today's reports workflow downloads PDFs; this one acts on them.

### ⚡ 2.5 Offer letter / separation paperwork generation
Template-driven document generation from extracted data. The data's already there (EmployeeData, SeparationData schemas). Output as PDF via a headless template engine (docxtemplater, react-pdf).

### ⚡ 2.6 Recruitment pipeline ingestion
ACT CRM has recruitment records. A workflow that walks the "Offers Sent" pipeline and flags stale offers (e.g. > 14 days without response).

### 🧭 2.7 Leave of absence / FMLA automation
More complex — involves multi-system coordination (UCPath, AiM, ServiceNow HR). Probably a separate subsystem.

### 🧭 2.8 Benefits enrollment orchestration
Annual open enrollment — walk new hires through benefits selection in UCPath. Requires UCPath Benefits module mapping + lots of conditional logic.

### 💡 2.9 Performance review tracking
If UCSD has a perf review system, scrape/populate review cycles. Depends on system access.

### 💡 2.10 Position reqs creation
Before onboarding: create a position req in whatever recruitment system feeds ACT CRM. Upstream of current automation.

---

## 3. Reliability & operational improvements

### 🔥 3.1 Adopt `ctx.retry` everywhere
`ctx.retry` now exists in the kernel. Migrate onboarding's workflow-local `retryStep` to `ctx.retry` (simplification). Add `ctx.retry` wrappers around flaky iframe loads in every migrated workflow.

### 🔥 3.2 Circuit breaker for PeopleSoft bad-day detection
When UCPath is slow/broken, workflows waste time retrying. Add a simple probe: if a known-good request (e.g. GET Person Search empty search) takes > 30s or 500s, abort the workflow early with a clean "UCPath unavailable — try again in 15 min" message.

### 🔥 3.3 Idempotency keys for Smart HR transactions
Today if a transaction is mid-created and the process crashes, re-running creates a duplicate. Add an idempotency key (hash of `emplId + effectiveDate + template`) stored in `.tracker/idempotency.jsonl`; before creating a new transaction, check if the same key succeeded recently.

### ⚡ 3.4 Session health mid-workflow
The kernel has `session.healthCheck(id)` but only batch mode uses it between items. Add an optional `ctx.healthCheck` call at the top of each `ctx.step` for long-running steps (would catch SAML session expiry mid-workflow).

### ⚡ 3.5 Replay from last successful step
When a workflow fails at step 5 of 7, re-running starts from step 1. Persist `{ runId, lastSuccessfulStep, data }` in a resumption index. Add `npm run resume <runId>`. Valuable for multi-minute workflows.

### ⚡ 3.6 PII masking in logs
SSN is partially masked in the dashboard but raw SSN still appears in `.screenshots/` PNGs and in extracted data logged at DEBUG. Add a log post-processor that replaces `\d{3}-\d{2}-\d{4}` → `***-**-****` before write.

### ⚡ 3.7 SIGTERM support
Kernel + tracker currently handle SIGINT (Ctrl+C). Docker/systemd/scheduled runs send SIGTERM. Wire the same teardown path.

### 🧭 3.8 Saga / rollback for multi-system workflows
Separations touches Kuali, Kronos, UCPath. If Step N fails, Steps 1..N-1 stay applied — producing inconsistent state. A saga pattern (compensating actions per step) would be a multi-week build but dramatically improves correctness.

---

## 4. Dashboard & observability

### 🔥 4.1 Step timing overlay
Dashboard already shows `firstLogTs`, `lastLogTs`. Compute per-step durations + show inline per step chip ("extraction: 12s, transaction: 45s"). The data is in JSONL already.

### 🔥 4.2 Failure drill-down
Click a failed entry → show: classified error, last 20 log lines, screenshot paths. The screenshot-on-failure feature from subsystem B already writes PNGs — just need to surface them.

### 🔥 4.3 Alert on failure patterns
If N consecutive workflow runs fail with the same classified error, emit a desktop notification (macOS `osascript display notification`). Catches systemic issues (Duo down, UCPath maintenance).

### ⚡ 4.4 Historical view + run search
Dashboard shows today. Add a date picker + search by emplId / name / docId across all time. Data is already in JSONL; just UI work.

### ⚡ 4.5 Aggregate stats
Simple dashboard tab: "this week: N onboardings, M separations, X% success rate, average step timings." Motivates investment in the flakiest spots.

### ⚡ 4.6 Failure-trigger selector warn feed
Subsystem A's `safeClick`/`safeFill` log `selector fallback triggered`. Pipe those to a dashboard panel — when fallbacks start matching regularly, the primary selector is stale.

### ⚡ 4.7 Dashboard: run diff view
Two runs for the same employee (e.g. retry) → show a diff of what each step produced. Useful for debugging nondeterministic failures.

### 💡 4.8 Voice cues for Duo
When a workflow is waiting on Duo, play a short audio cue (`osascript -e 'say "duo"'` on macOS). Small UX win for the operator's phone away from the laptop.

---

## 5. Platform & DX

### 🔥 5.1 CLI welcome / setup wizard
`npm run setup` that checks `.env` exists, validates creds (dry login), offers to install playwright browsers. First-use friction reducer.

### 🔥 5.2 Batch YAML JSON Schema
Emergency-contact's YAML batch is Zod-validated at runtime. Export the Zod schema → JSON Schema so the user's editor (VSCode) autocompletes. `npm run schema:export` writes it to `schemas/emergency-contact-batch.json`.

### ⚡ 5.4 Integration test sandbox
Stand up a minimal Playwright-against-a-mock-PeopleSoft fake (or a recorded HAR). Run actual kernel end-to-end against it. Replaces the dry-run-only gate that limits coverage today.

### ⚡ 5.5 Record/replay real runs
Capture a successful real run (Playwright trace) and store. Replay as regression test later. Would catch PeopleSoft UI changes within hours instead of at the next real run.

### ⚡ 5.6 Hot reload for workflow dev
`tsx --watch` already exists. Add a dev mode that reuses the open browser across restarts (re-import the module without re-authing). Cuts iteration time 10× when testing a new step.

### ⚡ 5.7 Fixture library for tests
`tests/fixtures/` with canonical `EmployeeData`, `SeparationData`, `LookupResult` samples. Every unit test reaches for these instead of inlining. Smaller tests, fewer drift sites.

### 🧭 5.8 Self-service web UI for HR staff
A React page (separate from the dashboard) where non-developer HR staff fill a form → workflow fires. Authenticated via SSO. Huge UX win but multi-week build.

### 🧭 5.9 API mode
Same workflows, callable via HTTP: `POST /api/workflows/onboarding { email }`. Enables integration with ServiceNow HR, Slack bots, etc.

---

## 6. Selector resilience (extends subsystem A)

### 🔥 6.1 Quarterly selector audit calendar reminder
Subsystem A stamped verified dates per selector. Add a lint / test that flags selectors verified > 90 days ago — a nudge to re-verify before they quietly break.

### ⚡ 6.2 Auto-promote fallback selectors
When `safeClick` logs "fallback matched" for selector X N times in a row across runs, auto-swap primary + fallback. A daily cron reads log warn stats, proposes a PR.

### ⚡ 6.3 Visual regression baseline
Record screenshots for each completed step, per-workflow. When a step's screenshot diverges significantly run-over-run (SSIM), flag it. Catches UCPath layout changes.

### 💡 6.4 Locator self-healing via LLM
On fallback-all-exhausted failure, send the page DOM + original selector intent ("find the textbox labeled 'Compensation Rate'") to Claude API with the accessibility tree. Suggest a new selector. Manual review before applying.

---

## 7. Compliance & security

### 🔥 7.1 Audit log
Every UCPath transaction leaves a trail already (UCPath has its own audit). But: record locally `{ user, timestamp, workflow, itemId, transactionId, step-by-step }` in a tamper-evident log (append-only, hash-chained). HR audits love this.

### ⚡ 7.2 Credential rotation reminder
`.env` has UCSD SSO creds. Password changes every N months. Add a date check ("password last updated 2026-02-01 — consider rotating") — stored in `.env.meta`.

### ⚡ 7.3 Role-based access (future multi-user)
If §5.8 or §5.9 ship, restrict which workflows each HR user can run. Start with a simple YAML allowlist.

### ⚡ 7.4 Data retention policy
Screenshots + tracker JSONL contain PII. Auto-purge screenshots > 30 days. Tracker > 90 days (configurable).

---

## 8. Developer experience inside this codebase

### 🔥 8.1 Kernel primer video/walkthrough
Root CLAUDE.md now has a text primer. Record a 10-minute Loom walking through `defineWorkflow` → handler → dashboard. Future onboarders (the user's successors) absorb it in minutes.

### 🔥 8.2 PR template
`.github/pull_request_template.md` with a new-workflow checklist: schema, systems, detailFields, CLAUDE.md, typecheck, tests, dry-run. Prevents drift.

### ⚡ 8.3 Lint rule for selectors
Subsystem A added a unit test to enforce selectors live only in `selectors.ts`. Promote to an ESLint rule for editor-time feedback.

### ⚡ 8.4 CLI command for scaffolding a new workflow
`npm run new:workflow <name>` → generates `src/workflows/<name>/` with schema.ts, workflow.ts, config.ts, CLAUDE.md, a skeleton test. Reduces the "is this really the right shape?" question.

### ⚡ 8.5 Dashboard "dev mode" — mock tracker data
A dev-only route that seeds fake workflow runs so the dashboard can be styled without running any real workflow. Useful for §4 improvements.

---

## 9. Nice-to-haves & long-shots

### 💡 9.1 LLM-assisted failure diagnosis
On a failed step, send the step name, error message, and last 20 log lines to Claude API. Produce a 1-paragraph "why did this fail?" explanation + suggested fix. Surface in dashboard.

### 💡 9.2 Workflow DAG visualization
Auto-render each workflow as a Mermaid diagram from `defineWorkflow.steps` + `ctx.parallel` calls. Documentation that stays in sync.

### 💡 9.3 HR metrics dashboard
Beyond workflow-run stats: time-to-fill, separations/month, EID count by dept. Pull from UCPath Queries. Separate product, but same orchestration bones.

### 💡 9.4 Chat interface
Slack/Teams bot: "@hr-automation onboard jane@ucsd.edu" → kicks off onboarding + streams progress. Nice but probably YAGNI.

### 💡 9.5 Voice control
"Hey UCPath, separate doc 12345" — speech-to-command layer. Novelty.

---

## Suggested priority order (if I were picking top 10)

1. **1.1 Live-run verification** — close the "we don't know if A/D/C actually work in prod" gap. Essential.
2. **1.2 Annual dates configurable** — tiny fix, annoyance removed for this year's roll.
3. **3.1 Adopt `ctx.retry` everywhere** — simplifies code, improves reliability, leverages kernel work just done.
4. **4.2 Failure drill-down in dashboard** — screenshots already land on disk; surface them.
5. **1.3 Migrate kronos-reports** — keeps the kernel arc moving; straightforward with pool mode fixed.
6. **1.6 Rehire path** — existing operational pain the current onboarding short-circuits on.
7. **3.2 Circuit breaker for PeopleSoft** — prevents wasted time during UCPath bad days.
8. **3.3 Idempotency keys** — prevents duplicate transactions.
9. **4.1 Step timing overlay** — first step toward understanding where time goes.

---

## Things explicitly NOT recommended right now

- **Self-service web UI / API mode (§5.8–5.9)** — big build, unclear ROI until you know which workflows other people actually want to trigger.
- **LLM-assisted debugging / diagnosis (§9.1, 6.4)** — novel but fragile. Ship after regular automation feels solid.
- **Saga/rollback pattern (§3.8)** — valuable but heavy. Defer until a bad incident justifies the cost.
- **Any rewrite of the kernel** — it's fresh, tested, works. Resist the urge to iterate prematurely. Use it for 3 months, then revisit.

---

## Credits

This list reflects the state of the repo after 40+ commits, 206 tests, and 8 git tags shipped between 2026-04-15 and 2026-04-17 across the B+E, A, D, C subsystems. Most items here were identified during subsystem audits or emerged from sketch-doc "open questions."
