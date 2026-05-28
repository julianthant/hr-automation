# Utils Module

Environment validation, error helpers, error classification, and colored logging.

## Lessons Learned

- **2026-04-10: Dashboard logs empty for separations** — `emit()` in `log.ts` never included `runId` in `LogEntry`. The dashboard server filtered `l.runId === runId` which evaluated to `undefined === "3885#1"` → false, rejecting all logs. Fix: added `runId` to `LogContext`, added `setLogRunId()` export, `withTrackedWorkflow` calls `setLogRunId(runId)` after computing it. Server-side filter also changed to `!l.runId || l.runId === runId` as a fallback for old log entries without `runId`.
- **2026-04-10: classifyError for user-facing messages** — Raw Playwright errors like "Target closed" or "Execution context was destroyed" are meaningless to users. Added `classifyError()` that pattern-matches error messages and returns concise descriptions (e.g. "Browser closed unexpectedly", "Page navigated away during action"). Used by `withTrackedWorkflow` when emitting `failed` entries so dashboard shows helpful error text.
- **2026-04-21: classifyPlaywrightError as a structured sibling** — `classifyError` returns a display string, which is fine for dashboards but terrible for programmatic branching (callers were doing `msg.includes("Timeout")` everywhere). Added `classifyPlaywrightError()` returning `{kind, summary, original}` so logging/retry logic can switch on a small kind enum. Intentional ordering gotcha: `navigation-interrupted` is checked before `timeout-stale` because "frame was detached" contains the substring `detached` and would otherwise mis-classify. Also: `timeout-stale` lives OUTSIDE the `timeout` gate because stale-DOM errors surface without the word "Timeout" during nav races — the `timeout-` prefix is retained for caller grouping only.
