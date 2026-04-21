# Stability Polish — Design Spec

**Date:** 2026-04-21
**Author:** Claude (Opus 4.7, 1M context)
**Scope:** Multi-sub-project sweep addressing user's `notes.md` + inconsistencies found in audit of today's (2026-04-20) run logs.
**Status:** Design

## 1. Motivation

The user ran two onboardings and several separations on 2026-04-20. Both workflows failed in different ways. Logs + codebase audit surfaced:

- Silent data loss in separations (empty transaction number written to Kuali)
- Multi-process browser collisions (ProcessSingleton errors)
- Stale Kendo modal blocking I9 create link
- Save-and-Submit clicked while disabled
- Dashboard screenshot thumbnail broken + rendered in the wrong place
- Auth-chip timer inconsistently blank

Plus a CLI ergonomics request (`npm run onboarding a b c`) and a UI tweak (auth dropdown → hover tooltip). A few smaller items round out the list.

Gemini landed five partial diffs in the working tree; some are keepers, some are placebos. This spec also disposes of those.

## 2. How sessions are supposed to work — and what's breaking

### 2.1 Intended architecture

```
CLI (src/cli.ts)
  → workflow CLI adapter (runSeparation, runOnboarding, …)
    → Kernel (src/core/workflow.ts)
      → withTrackedWorkflow wraps each item (src/tracker/jsonl.ts)
         - generateInstanceName → "Separation 1", "Onboarding 2", …
         - emitWorkflowStart(instance)
         - setLogRunId(runId) into AsyncLocalStorage
      → Session.launch (src/core/session.ts)
         - launch one browser per system (parallel)
         - CDP-tile windows
         - auth chain (sequential | interleaved), each system's login() throws on failure
         - emit session_create / browser_launch / auth_start / auth_complete observer events
      → Handler runs
         - ctx.page(id) awaits that system's auth-ready promise
         - ctx.step(name, fn) emits step_change running + captures exceptions
         - ctx.screenshot(kind, label) captures all open pages → emit screenshot event
      → emitWorkflowEnd(instance, finalStatus)
    → Dashboard (src/tracker/dashboard.ts)
      - reads .tracker/sessions.jsonl + per-workflow JSONL
      - rebuilds SessionState (live workflows, browser lifecycle, duo queue)
      - streams to React via SSE
```

### 2.2 The invariant that's being violated

**Invariant:** Every independent worker (pool worker OR separate OS process) that calls `launchPersistentContext` on a persistent `sessionDir` MUST receive a unique path. Chromium enforces this via a ProcessSingleton lock file inside that directory.

**Current state:**
- `src/workflows/old-kronos-reports/parallel.ts:120-145` implements this correctly via a per-worker counter closure that appends `_workerN` to `SESSION_DIR`.
- `src/workflows/separations/workflow.ts:151` declares a **static** `sessionDir: PATHS.ukgSessionSep` (resolves to `~/ukg_session_sep`) on the `old-kronos` system. No per-worker parameterization.
- Today's logs confirm: running `npm run separation 3917` while `npm run separation 3917 3910 3860` was still going (PIDs 20568 + 23560 + 23938 in `.tracker/sessions.jsonl`) resulted in PID 23560's lifespan of 400 ms — it emitted `workflow_start` + `workflow_end finalStatus=failed` with no session_create or browser_launch between them, because the persistent-context launch threw immediately.

The kernel's pool mode already solves this via the `launchFn` override. Single-process runs don't use `launchFn`. Multi-process runs (same machine, two separate `npm run` invocations) have no coordination primitive.

### 2.3 Why the dashboard "only shows one of the two"

The second process's workflow lifespan was 400 ms. No `session_create`, no `browser_launch`, no `auth_start`, no step events. `rebuildSessionState` (`src/tracker/dashboard.ts:200+`) reduces over these events to build the live panels; with almost none, the workflow appears as a noop that immediately ended. The dashboard isn't buggy here — the data is minimal because the process died.

Side effect: the log for that failed-400ms process did make it to the per-workflow JSONL (`separations-2026-04-20.jsonl` has a row with error `browserType.launchPersistentContext: Failed to create a ProcessSingleton …`). It shows up in the Queue panel but the Sessions panel never populates for it.

## 3. Decomposition

| Sub-project | Scope | Risk | Independence |
|-------------|-------|------|--------------|
| **A. Triage gemini's working-tree diffs** | Decide keep/revert/fix each of 5 diffs | None | Must land first (clears working tree) |
| **B. Dashboard UI polish** | #8, #11, #12 + auth timer + broken thumbnail | Low — frontend + one label | Independent |
| **C. Separations bugs** | #4, #9, #10, silent job-summary swallow, Save enabled wait, step-cache for extraction | Medium — behavioral | Independent |
| **D. Onboarding + I9 + CLI** | #5, #6, Save enabled wait, aggressive k-window dismiss | Medium — behavioral | Independent |
| **E. Observability + docs** | #1, #7, missing-timestamp root cause, runId format audit, sessions.jsonl doc | Low — observability | Mostly independent; touches tracker |

Each sub-project ships as its own commit (or small commit series) on the `master` branch. No branching strategy change.

## 4. Sub-project A — Triage gemini's diffs

Five files touched. Decisions:

| File | Decision | Rationale |
|------|----------|-----------|
| `src/utils/pii.ts` | **Keep** (PII redaction stays disabled) | User explicit: "don't worry about security" |
| `src/systems/new-kronos/navigate.ts` | **Keep** (timecard date carry-forward) | Real fix — sparse dates + dense data rows need per-row alignment |
| `src/tracker/session-events.ts` | **Keep** (count-based instance naming) | Real fix — old Set-based `while` returned reused names when a name was both started and ended |
| `src/dashboard/components/LogStream.tsx` | **Keep** + **investigate** (null-safe localeCompare) | Keep the defensive; in sub-project E, trace which emitter produces events without `timestamp`. Don't let the patch hide the real source. |
| `src/tracker/dashboard.ts` | Same as above | Same |

**Side effects:**
- With PII redaction gone, the `maskSsn` / `maskDob` / `redactPii` functions now return input unchanged. Decision: leave the pass-through stubs (callers exist). Don't delete the functions or their unit tests — they're testing the new (pass-through) contract. Update `tests/unit/utils/pii.test.ts` assertions to match the new behavior.
- Add `image.png` and `notes.md` to `.gitignore` at repo root (they're scratch, user referenced them in chat but they're not meant to be committed).

**Out of scope in A:** re-enabling redaction, deleting the PII utilities, or changing callers. Just land the current state cleanly.

## 5. Sub-project B — Dashboard UI polish

### 5.1 Remove `FailureDrillDown` entirely (#12)

The FAILURE card beneath the step pipeline is the broken-thumbnail card in the user's screenshot. Delete it.

- **Delete:** `src/dashboard/components/FailureDrillDown.tsx`
- **Edit:** `src/dashboard/components/LogPanel.tsx` — remove import at line 7, remove mount around line 233
- **Keep:** `/api/screenshots` endpoint, `screenshotCount` entry enrichment, `ScreenshotsPanel` + `ScreenshotCard` + `ScreenshotLightbox`, the Screenshots tab. The Screenshots tab is the only place screenshots appear after this change.
- **Keep:** classified error display — it's already present inside `LogStream`'s Errors tab. No info is lost.
- **Tests:** delete `tests/unit/dashboard/failure-drill-down*.test.ts` if any exist.

### 5.2 Auth chip: click-to-expand → hover popover (#8)

`src/dashboard/components/StepPipeline.tsx`.

- Remove `expandedGroups` state (L253), `toggleGroup` (L296-303), `onToggle`/`expanded` props on `AuthSuperChip` (L128-134), the ▼/▲ chevron (L177-178), the entire "Expanded auth-group children" block (L451-548).
- Replace the `<button onClick>` with a **Radix Popover** (`src/dashboard/components/ui/popover.tsx` already exists; the HeroUI calendar uses it).
- Trigger on `onMouseEnter` (with ~200 ms open delay to avoid jitter), close on `onMouseLeave` (with ~150 ms close delay to allow moving into the popover content if needed).
- Popover content: one row per child step, each row = `[status glyph] [monospace system id] [duration chip]`. Reuse `buildAuthGroupTitle`'s data, render properly-styled.
- Keep `title={hoverTitle}` as a fallback for non-pointer users (accessibility).

### 5.3 Auth chip: graceful partial timer (user callout)

`src/dashboard/components/StepPipeline.tsx:138-142`.

Replace:
```ts
const allHaveDuration = children.every((c) => c.durationMs !== undefined);
const totalDurationMs = allHaveDuration
  ? children.reduce((sum, c) => sum + (c.durationMs ?? 0), 0)
  : undefined;
```

With:
```ts
const knownDurations = children.filter((c) => c.durationMs !== undefined);
const totalDurationMs = knownDurations.length > 0
  ? knownDurations.reduce((sum, c) => sum + (c.durationMs ?? 0), 0)
  : undefined;
const partial = knownDurations.length < children.length;
const durationLabel = totalDurationMs !== undefined
  ? `${formatStepDuration(totalDurationMs)}${partial ? "+" : ""}`
  : "";
```

"+" suffix signals "at least this much, some children incomplete." Matches individual chips' graceful degradation.

### 5.4 Comment label fix (#11)

`src/workflows/separations/schema.ts:55` (confirmed via grep): `Last day worked:` → `Last day worked`.

```ts
// before
return `Termination EFF ${terminationEffDate}. Last day worked: ${lastDayWorked}. Kuali form #${docId}.`;
// after
return `Termination EFF ${terminationEffDate}. Last day worked ${lastDayWorked}. Kuali form #${docId}.`;
```

Also check `buildDateChangeComments` in the same file — anywhere else the phrase appears.

### 5.5 Broken screenshot thumbnail

Two hypotheses to verify during implementation:

1. **URL encoding** — filenames can contain `@` (onboarding emails in filename, e.g. `onboarding-mariaarjun409@gmail.com-error-i9-creation-i9-1776722162823.png`). `FailureDrillDown.tsx:111,161` uses `encodeURIComponent(s.filename)` — that's fine. But `ScreenshotsPanel` / `ScreenshotCard` constructs the URL separately. If ScreenshotsPanel uses raw filename, `@` stays literal and the request works in most browsers but edge cases fail.
2. **Race: event emitted before file written** — `emitScreenshotEvent` fires after `page.screenshot()` resolves, but there may be a window between "event readable by SSE" and "file fsync'd to disk" in high-latency filesystems. Unlikely on local macOS; parked.

Since sub-project B deletes FailureDrillDown entirely, hypothesis 1 is only relevant if ScreenshotsPanel has the same bug. Action:

- Audit `src/dashboard/components/ScreenshotsPanel.tsx` and `ScreenshotCard.tsx` for URL construction. If they use raw filename, wrap with `encodeURIComponent`.
- Add one screenshot with a `@` in its itemId to `tests/unit/dashboard/` or a manual QA step.

### 5.6 Additional cleanup found in audit

- **Duplicate fetch:** both `FailureDrillDown` and `ScreenshotsPanel` currently fetch `/api/screenshots?...`. Deleting FailureDrillDown eliminates the duplicate for free.
- **Layout thrash from expanded auth rows:** removing the click-to-expand block also fixes this.

**Files touched in B:**
- Delete: `src/dashboard/components/FailureDrillDown.tsx`
- Edit: `src/dashboard/components/LogPanel.tsx`, `src/dashboard/components/StepPipeline.tsx`, `src/workflows/separations/schema.ts`
- Audit: `src/dashboard/components/ScreenshotsPanel.tsx`, `src/dashboard/components/ScreenshotCard.tsx`
- Tests: update `tests/unit/dashboard/step-pipeline*.test.ts` for the timer change

## 6. Sub-project C — Separations bugs

### 6.1 Per-process sessionDir for old-kronos (#4)

**Problem:** `~/ukg_session_sep` is shared by every `npm run separation` process. Second launch → ProcessSingleton collision → 400 ms death.

**Fix:** Make `sessionDir` parameterized by PID (and optionally worker index for future pool support).

```
~/ukg_session_sep_pid<PID>   ← new
```

Options:

- **(a)** In `src/workflows/separations/workflow.ts:151`, change `sessionDir: PATHS.ukgSessionSep` → `sessionDir: \`${PATHS.ukgSessionSep}_pid${process.pid}\``. Add cleanup in the CLI adapter's `finally`.
- **(b)** Introduce a helper `getProcessIsolatedSessionDir(base: string): string` in `src/core/session.ts`, reused by any workflow that needs per-process isolation.

Recommend **(b)** — one-time factoring, reusable for any future multi-process workflow.

**Side effect:** each `npm run separation` invocation now starts fresh (no persistent login state reuse across processes). UKG login takes ~2 extra seconds, not a real regression for the human-scale usage pattern. Persistent state reuse across separations was never a feature anyone relied on; it was an accident of the static path.

**Cleanup:** on process exit (normal or SIGINT), the CLI adapter removes its own `_pid<PID>` dir. Best-effort; orphaned dirs are acceptable (next launch for that PID number collides harmlessly because PIDs rotate over thousands of values and the dir is just a pre-existing cache).

**Verification:** manually launch two `npm run separation <docId>` simultaneously post-fix. Expect both to proceed to auth without ProcessSingleton errors.

### 6.2 Propagate Job Summary failure → fail the step (#9 #10 Site A)

**Problem:** `src/workflows/separations/workflow.ts:297-301` logs a rejected `ctx.parallel` task but continues. When Work Location tab click times out, `jobSummaryData = undefined`, Kuali fill skipped silently, and the transaction still runs — producing a "done" run with empty txn #.

**Fix:** The Job Summary lookup is not optional. If it fails, the run should fail.

- Wrap the `phase1.jobSummary.status === "rejected"` branch so it throws:
  ```ts
  if (phase1.jobSummary.status === "fulfilled") {
    jobSummaryData = phase1.jobSummary.value;
  } else {
    const msg = errorMessage(phase1.jobSummary.reason);
    log.error(`[UCPath Job Summary] Failed: ${msg}`);
    throw new Error(`UCPath Job Summary extraction failed: ${msg}`);
  }
  ```
- This rethrow bubbles into `ctx.step("kronos-search", …)` which catches and emits `failed` for the step. The run is correctly marked failed — no silent continuation, no empty Kuali write.
- Old/New Kronos failures stay lenient (Kronos-not-found is a valid outcome — means Kuali dates win).
- Kuali timekeeper fill stays lenient (fill is idempotent; next-batch retry covers).

### 6.3 Harden Work Location tab click (#10)

**Problem:** today's doc 3917 failed the `getByRole("tab", { name: "Work Location" })` click; 3907 / 3860 / 3910 succeeded. Same PeopleSoft page, same day. Transient.

**Fix:** in `src/systems/ucpath/job-summary.ts:85`,

- Add `await waitForPeopleSoftProcessing(frame, 15_000)` immediately before the click. PS-processing often masks tab click targets.
- Wrap the click in `ctx.retry`-equivalent: 2 attempts, 2 s backoff. Use raw try/catch since `ctx` isn't in scope for system modules — or pass the retry as a utility from `src/systems/common/`.
- Also add iframe-vs-body consistency guard: `getFormRoot` currently returns `page.frameLocator("#main_target_win0").locator("body")` when the frame exists, else `page.locator("body")`. Verify at click time that the root resolves (count > 0) before proceeding; if zero, reload the page once and retry.
- Increase the inner timeout from 10 s to 15 s. PeopleSoft UI state machine is slow.

### 6.4 Save-and-Submit `isEnabled` wait (#5 Site B, also onboarding)

**Problem:** `src/systems/ucpath/transaction.ts:516` blind-clicks `saveAndSubmitButton` with a 10 s timeout. If the button is disabled (all-4-tabs-not-visited or post-refresh race), Playwright retries visibility/enabled/stable and times out exactly the way today's `johnnievalen` error showed.

**Fix:**

```ts
export async function clickSaveAndSubmit(
  page: Page,
  frame: FrameLocator,
): Promise<TransactionResult> {
  log.step("Clicking Save and Submit...");
  await dismissModalMask(page);

  const btn = smartHR.saveAndSubmitButton(frame);

  // Explicit wait for :enabled — more informative timeout than the implicit one
  // inside click(), and we can log progress if needed.
  try {
    await btn.waitFor({ state: "visible", timeout: 10_000 });
    await btn.evaluate((el) => {
      if ((el as HTMLInputElement).disabled) throw new Error("still disabled");
    }, null, { timeout: 20_000 }).catch(async () => {
      // Fallback: poll isEnabled() for up to 15s; if still disabled, log + throw
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        if (await btn.isEnabled().catch(() => false)) return;
        await page.waitForTimeout(500);
      }
      throw new Error("Save and Submit remained disabled after 15 s — likely tab-walk incomplete");
    });
  } catch (e) {
    // Take a diagnostic screenshot BEFORE throwing so operators can see
    // which tab state produced the stuck-disabled button.
    await page.screenshot({ path: `.screenshots/save-disabled-${Date.now()}.png` }).catch(() => {});
    throw e;
  }

  await btn.click({ timeout: 10_000 });
  …
}
```

Benefits: actionable error message ("Save remained disabled — tab walk incomplete"), diagnostic screenshot, same failure shape.

**Also harden the tab-walk:** `src/workflows/onboarding/enter.ts` (the ActionPlan builder) visits tabs. Audit that it really hits all four, waits for each to load, and re-clicks Personal Data at the end. The existing comment at `enter.ts:179` says it does; double-check during implementation that it uses the selector that matches today's rendered DOM.

### 6.5 Step-cache for `kuali-extraction` (user's #7 expansion)

Today doc 3917 was re-run three times (`3917#1`, `3917#2` via sibling process that died fast, `3917#3`). Each reran Kuali extraction from scratch: ~8 s per re-run. Onboarding caches its `extraction` step; separations doesn't cache at all.

**Add step-cache to kuali-extraction:**

In `src/workflows/separations/workflow.ts:196-206`:

```ts
const kualiData = await ctx.step("kuali-extraction", async () => {
  const cached = await stepCacheGet("separations", docId, "kuali-extraction");
  if (cached) {
    log.success("[Kuali] Extraction cached — reusing");
    return cached as SeparationData;
  }
  const kualiPage = await ctx.page("kuali");
  const ucpathPage = await ctx.page("ucpath");
  ucpathPage.on("dialog", (d) => d.accept().catch(() => {}));
  await openActionList(kualiPage);
  await clickDocument(kualiPage, docId);
  const extracted = await extractSeparationData(kualiPage);
  await stepCacheSet("separations", docId, "kuali-extraction", extracted);
  return extracted;
});
```

2 h TTL is right — fresh enough for same-day retries, stale enough that a real data change in Kuali will be picked up on the next day.

**Do not** cache `kronos-search`, `ucpath-job-summary`, `ucpath-transaction`, or `kuali-finalization` — they're side-effecting or time-sensitive.

### 6.6 Transaction-number readback hardening

Secondary defense in depth: if `clickSaveAndSubmit` returns `{ success: true, transactionNumber: null }` (submitted but couldn't parse), `fillTransactionResults` will still write empty. Add an assertion in separations:

```ts
transactionNumber = submitResult.transactionNumber ?? "";
if (submitResult.success && !transactionNumber) {
  log.error("[UCPath Txn] Submit succeeded but transaction number could not be extracted");
  throw new Error("Transaction submitted without recoverable transaction number");
}
```

Failing loud is better than silent empty writes.

**Files touched in C:**
- `src/core/session.ts` — `getProcessIsolatedSessionDir` helper
- `src/workflows/separations/workflow.ts` — Job Summary rethrow, step-cache, txn # assertion, sessionDir helper call, cleanup in CLI adapter finally
- `src/systems/ucpath/job-summary.ts` — Work Location retry + wait
- `src/systems/ucpath/transaction.ts` — Save enabled wait
- Tests: `tests/unit/workflows/separations/*.test.ts` — Job Summary failure rethrow, step-cache hit/miss

## 7. Sub-project D — Onboarding + I9 + CLI

### 7.1 Force-dismiss all `k-window` modals before I9 create (#5 / mariaarjun409)

**Problem:** I9 `search.ts` leaves the search dialog open on return. The onboarding handler presses Escape, but today's run had a **4th** Kendo window on the page (`titlebar-newUI-4`). That means multiple modals accumulate — Escape closes one, not all.

**Fix:** a force-dismiss helper in `src/systems/i9/navigate.ts` (or create if absent):

```ts
/** Close every k-window modal on the page. Idempotent. */
export async function closeAllKendoWindows(page: Page): Promise<void> {
  // Two pass approach: click the close button on every visible k-window,
  // then press Escape once for good measure to clear any non-closable variants.
  await page.evaluate(() => {
    const closers = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".k-window .k-window-action, .k-window .k-i-close, .k-window [aria-label='Close']"
      ),
    );
    closers.forEach((el) => el.click());
  }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(250);
}
```

Call this:
- End of `searchI9Employee` (right before `return parseSearchResults(page)`).
- Start of `createI9Employee` (right before `dashboard.createNewI9Link(page).click()`).
- Also inside a 2-attempt retry around the create click itself:

```ts
try {
  await dashboard.createNewI9Link(page).click({ timeout: 10_000 });
} catch (e) {
  await closeAllKendoWindows(page);
  await dashboard.createNewI9Link(page).click({ timeout: 10_000 });
}
```

**Inline-selector test:** `.k-window` is a raw CSS selector in an inline `evaluate()`. Add the `// allow-inline-selector` comment and whitelist the pattern in the inline-selectors guard if the test rejects it.

### 7.2 Save-and-Submit enabled wait (shared with C.4)

Same fix as sub-project C.4 — the `clickSaveAndSubmit` change in `src/systems/ucpath/transaction.ts` fixes onboarding's `johnnievalen` failure mode too.

**Additional:** audit `src/workflows/onboarding/enter.ts`'s tab walk. Confirm it visits Personal Data → Job Data → Earns Dist → Employee Experience → [fill Initiator Comments] → Personal Data before the Save step. Add explicit `waitForPeopleSoftProcessing` between each tab switch.

### 7.3 CLI: `npm run onboarding a b c` (#6)

**Keep:** existing `start-onboarding` command (both single-email and `--parallel N` with `batch.yaml`) — user said "yes keep it".

**Add:** new `onboarding` command with positional emails.

`src/cli.ts`:

```ts
program
  .command("onboarding")
  .description("Run onboarding for one or more emails (positional). Pool size defaults to min(N, 4).")
  .argument("<emails...>", "One or more employee emails")
  .option("--dry-run", "Preview actions without creating transactions")
  .option("--workers <N>", "Override pool size (default: min(emails.length, 4))", parseInt)
  .action(async (emails: string[], options: { dryRun?: boolean; workers?: number }) => {
    validateEnv();
    const poolSize = options.workers ?? Math.min(emails.length, 4);
    await runOnboardingPositional(emails, { dryRun: options.dryRun, poolSize });
  });
```

Add `runOnboardingPositional` in `src/workflows/onboarding/index.ts` — light wrapper around `runWorkflowBatch` (pool mode) with `deriveItemId: (item) => item.email` and `onPreEmitPending` matching the existing `runParallel` pattern.

`package.json`:

```json
"onboarding":     "node --import tsx/esm --env-file=.env src/cli.ts onboarding",
"onboarding:dry": "node --import tsx/esm --env-file=.env src/cli.ts onboarding --dry-run"
```

Usage: `npm run onboarding a@x.com b@x.com c@x.com` → runs all three with pool size 3; `--workers 2` caps at 2.

**Do not retire `start-onboarding`.** Both forms coexist. Document in root CLAUDE.md.

### 7.4 Additional: `closeAllKendoWindows` as a first-class cleanup

Since this helper will be defensive everywhere in I9, factor it cleanly in `src/systems/i9/` and export. If other systems need it later, promote to `src/systems/common/`.

**Files touched in D:**
- `src/systems/i9/search.ts` — append `closeAllKendoWindows` before return
- `src/systems/i9/create.ts` — prepend + 2-attempt retry around create click
- `src/systems/i9/navigate.ts` (new or existing) — `closeAllKendoWindows` helper
- `src/systems/ucpath/transaction.ts` — shared with C.4
- `src/workflows/onboarding/enter.ts` — tab-walk audit
- `src/workflows/onboarding/index.ts` — add `runOnboardingPositional`
- `src/cli.ts` — new `onboarding` command
- `package.json` — new scripts
- Tests: `tests/unit/systems/i9/*` for closeAllKendoWindows

## 8. Sub-project E — Observability + docs

### 8.1 Multi-session logging: document expected + known-limits (#1)

This is a mix of real bug + user misconception. The "only shows one" happens because the failed 400 ms process emits almost nothing. Sub-project C.1 fixes the root cause (no more 400 ms deaths). Sub-project E's job is to ensure the dashboard **visibly marks a failed-early-launch process** so the user knows.

- Backend (`src/tracker/dashboard.ts` → `rebuildSessionState`): when a `workflow_start` is followed by `workflow_end finalStatus=failed` with no `browser_launch` events in between, synthesize a virtual "crashed during launch" state so the Sessions panel can render a red placeholder.
- Frontend (`src/dashboard/components/SessionPanel.tsx`): render that placeholder with a "Launch failed — check Queue row for details" subtitle.

This is a UX fix, not a data fix. The underlying data is correct.

### 8.2 Missing-timestamp root cause (gemini's localeCompare defensive)

`src/dashboard/components/LogStream.tsx:56` and `src/tracker/dashboard.ts:1155` both defensively coalesce `a.timestamp ?? ""`. That patch landed because something emits events lacking `timestamp`. Find what.

Grep for `emit` helpers in `src/tracker/session-events.ts` and confirm each calls `Date.now().toISOString()` or similar. If any branch constructs an event without `timestamp`, fix at the source.

Suspects: `cache_hit` events (added 2026-04-19), `screenshot` events (numeric `ts` field instead of `timestamp` field — look at the sessions.jsonl dump in section 2.3, screenshot entries use `"ts":1776722504377` not `"timestamp":"..."`).

The dashboard sorting logic uses `e.timestamp`. If an event has `ts` (number) but no `timestamp` (ISO string), the sort key is undefined. **This is the real bug the localeCompare patches are covering up.** Fix: normalize events at read time — `e.timestamp ?? new Date(e.ts).toISOString() ?? ""`.

### 8.3 Step-cache explainer (answer to #7)

Write `docs/step-cache.md`:

- What step-cache is (pattern-twin of idempotency, 2 h TTL, disk-backed under `.tracker/step-cache/`)
- What it's used for (skip expensive read-only work on retry)
- What's opted in today: onboarding's `extraction` step only
- What's being added in sub-project C: separations' `kuali-extraction`
- What **cannot** be cached: anything side-effecting (transaction submit, Kuali save), anything time-sensitive (Kronos search results depend on current UKG state), anything with a UI auth step in scope
- How to opt a step in (code example)
- How to inspect the cache (`.tracker/step-cache/<workflow>-<itemId>/<step>.json`)
- How to clear (`stepCacheClear` or `rm -rf`)

### 8.4 runId format audit (open item from rethink)

The `3917#2` / `mariaarjun409@gmail.com#1` format in sessions.jsonl — the kernel generates UUIDs. So who's generating `#N`?

Investigate `src/workflows/onboarding/parallel.ts` (and `run.ts` if it exists) — legacy runId numbering is likely there. Either:

- **(a)** If it's legacy code still running under the kernel's `onPreEmitPending` contract, document the dual format and leave it alone (both runIds are unique within their data stream).
- **(b)** If we can unify to kernel UUIDs without breaking the dashboard, do so.

Also check `src/tracker/CLAUDE.md` note re: `RUNID_FALLBACK_UNTIL = 2026-04-26 — TODO delete after that date`. That deadline is 5 days away. Track as follow-up: delete the fallback + any lingering `{id}#N` emitters on or after that date.

### 8.5 `generateInstanceName` perf (low priority)

`src/tracker/session-events.ts:222-257` reads + parses the full `sessions.jsonl` on every call. At 91 KB today, fine; at 10 MB (months of activity), slow. Defer actual implementation; add a `// TODO: cache via mtime` comment and move on.

**Files touched in E:**
- `src/tracker/dashboard.ts` — rebuildSessionState crashed-launch placeholder, timestamp normalization
- `src/tracker/session-events.ts` — audit emitters for missing timestamp
- `src/dashboard/components/SessionPanel.tsx` — placeholder UI
- `docs/step-cache.md` — new file
- Follow-up note: `src/tracker/CLAUDE.md` update if runId fallback cleanup lands

## 9. Additional bugs found, not in user notes

Captured for transparency; each gets a brief mention in the implementation plan so nothing slips:

| Bug | File | Severity | Sub-project |
|-----|------|----------|-------------|
| Dashboard shows "done" for runs with empty txn # | `src/workflows/separations/workflow.ts` | High | C (fixed by 6.2 rethrow) |
| I9 `search.ts` leaves dialog open on return | `src/systems/i9/search.ts` | High | D (fixed by 7.1) |
| Inconsistent event timestamp field shape (`ts` numeric vs `timestamp` ISO) | `src/tracker/session-events.ts` | Medium | E (8.2) |
| `generateInstanceName` O(n) on every call | `src/tracker/session-events.ts` | Low | E (8.5 — defer) |
| RunSelector date-param regression (agent finding, unverified) | `src/dashboard/components/LogPanel.tsx` | Medium | Defer — verify live first |
| Screenshot fetch duplication between FailureDrillDown + ScreenshotsPanel | `src/dashboard/components/*` | Low | B (resolved by deleting FailureDrillDown) |
| `RUNID_FALLBACK_UNTIL = 2026-04-26` — scheduled cleanup | `src/tracker/dashboard.ts` | Low | E (8.4 follow-up) |

## 10. Out of scope

- Re-enabling PII redaction — user explicit
- Porting separations to kernel pool mode (currently `batch: sequential`) — would change Duo-per-doc semantics, separate discussion
- Selector re-verification dates sweep — no selectors touched by this spec
- Dashboard runner / replacement launcher — parked per `CLAUDE.md` deferred list
- Stats panel / run-diff frontend — parked

## 11. Testing strategy

Each sub-project's tests ship in the same commit as its code.

- **A:** update `tests/unit/utils/pii.test.ts` for pass-through behavior. Verify new-kronos/navigate.ts unit tests still pass (if any for that function; add one covering sparse-date carry-forward if absent).
- **B:** StepPipeline timer test (partial durations → "+" suffix), FailureDrillDown deletion (remove its test file), label-text test for separations comment builder.
- **C:** Job Summary failure → step failure propagation test. Step-cache hit/miss on kuali-extraction test. sessionDir PID isolation test (mock process.pid).
- **D:** `closeAllKendoWindows` unit test with a fake DOM. Save-enabled wait test with a disabled-then-enabled button.
- **E:** Timestamp normalization test (event with only `ts` numeric → dashboard sort key works). Crashed-launch placeholder rebuild test.

Run order before each sub-project lands:
1. `npm run typecheck:all`
2. `npm run test`
3. Manual smoke: start `npm run dashboard`, exercise the changed surface, verify no regressions in unchanged features.

## 12. Rollout order

1. **A (triage)** — commit the gemini diffs with clear messages, add tests, clean working tree.
2. **B (UI polish)** — ship in one commit; low risk.
3. **D (onboarding/I9)** — ships independently; separations still broken after this but onboarding is usable.
4. **C (separations)** — largest behavioral change; lands last among behavioral.
5. **E (observability)** — can ship in parallel with D or C.

Each sub-project = one commit (or a very short series). No branch. Merge direct to master.

## 13. Open questions / empirical items

Flagged for resolution during implementation (not blockers for this spec):

- Exact Kendo `k-window` lineage on I9 — need live repro to confirm which dialogs accumulate. Implementation will add force-dismiss; live run validates.
- Exact Work Location tab flake root cause on specific docs — retry + longer wait is defensive; if live runs still fail, escalate to a Playwright trace.
- RunSelector date-filter regression — agent claim, unverified. Confirm during implementation; include fix if real, punt otherwise.
- Screenshot thumbnail URL encoding — audit ScreenshotsPanel; only apply fix if there's a real encoding bug.
- runId `{id}#N` emission site — grep during sub-project E; document or unify depending on what's found.

## 14. Success criteria

- `npm run separation 3917 &; npm run separation 3910` completes both runs in parallel without ProcessSingleton errors.
- Re-running a failed separation immediately reuses cached Kuali extraction (verify in `.tracker/step-cache/`).
- A Job Summary failure marks the run as `failed` — no more "done" runs with empty txn #.
- `npm run onboarding a@x.com b@x.com` starts both with pool size 2.
- A stale Kendo modal on I9 no longer blocks "Create New I-9" click.
- Save-and-Submit click waits for the button to be enabled and reports "disabled after N seconds" if it never enables.
- Dashboard: FAILURE card gone, auth chip hover popover works, timer shows partial progress, "Last day worked" no-colon in comments.
- `docs/step-cache.md` answers #7 in writing.
- Working tree is clean at the end (gemini diffs committed or reverted; `image.png` + `notes.md` gitignored).
