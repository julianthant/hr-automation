# Utils Module

Environment validation, error helpers, error classification, and colored logging.

## Files

- `env.ts` — `validateEnv()` checks for `UCPATH_USER_ID` and `UCPATH_PASSWORD` in `process.env`, returns `{ userId, password }`, throws `EnvValidationError` if missing
- `errors.ts` — `errorMessage(err: unknown): string` safely extracts message from caught errors (`err.message` or `String(err)`); `classifyError(err): string` maps raw Playwright/system errors to concise user-facing messages (e.g. "Target closed" → "Browser closed unexpectedly", "Navigation timeout" → "Page took too long to load")
- `log.ts` — `log` namespace with colored console output + JSONL log file emission:
  - `log.step(msg)` — blue `->` prefix
  - `log.success(msg)` — green `✓` prefix
  - `log.waiting(msg)` — yellow `⏳` prefix
  - `log.warn(msg)` — yellow `!` prefix (used by `safeClick`/`safeFill` for selector fallback warns)
  - `log.error(msg)` — red `✗` prefix (writes to stderr)
  - `setLogRunId(runId)` — inject `runId` into current `AsyncLocalStorage` log context (called by `withTrackedWorkflow`)
  - `getLogRunId()` — read the runId from the current `AsyncLocalStorage` log context (used by `emitSessionEvent` so kernel events carry the runId of the running workflow item)
  - `withLogContext(workflow, itemId, fn, dir?)` — wraps `fn` in `AsyncLocalStorage` context so all `log.*()` calls emit to JSONL
- `pii.ts` — PII masking helpers used by `serializeValue` in `src/tracker/jsonl.ts`:
  - `maskSsn(value)` — `123-45-6789` → `***-**-6789`
  - `maskDob(value)` — `01/15/1992` → `**/**/1992` (also handles ISO dates)
  - `redactPii(text)` — bulk text scrub for log-message safety
- `screenshot.ts` — `debugScreenshot(page, label, dir?)` — best-effort screenshot to `.screenshots/`; never throws (so a screenshot failure can't mask the original error). Used by `Stepper.step` on failure via `Session.screenshotAll`.
- `worker-pool.ts` — `runWorkerPool({ items, workerCount, setup, process })` — generic queue-based fan-out helper. NOT a kernel mode (kernel pool launches one Session per worker; this helper shares one Session/Context across N tabs). Used by eid-lookup for the "1 Duo, N searches" pattern.

Uses `picocolors` for colorization. Only `log.error()` uses `console.error` (stderr); all others use `console.log` (stdout).

## Lessons Learned

- **2026-04-10: Dashboard logs empty for separations** — `emit()` in `log.ts` never included `runId` in `LogEntry`. The dashboard server filtered `l.runId === runId` which evaluated to `undefined === "3885#1"` → false, rejecting all logs. Fix: added `runId` to `LogContext`, added `setLogRunId()` export, `withTrackedWorkflow` calls `setLogRunId(runId)` after computing it. Server-side filter also changed to `!l.runId || l.runId === runId` as a fallback for old log entries without `runId`.
- **2026-04-10: classifyError for user-facing messages** — Raw Playwright errors like "Target closed" or "Execution context was destroyed" are meaningless to users. Added `classifyError()` that pattern-matches error messages and returns concise descriptions (e.g. "Browser closed unexpectedly", "Page navigated away during action"). Used by `withTrackedWorkflow` when emitting `failed` entries so dashboard shows helpful error text.
