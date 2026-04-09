# Tracker Module

Two-tier tracking: JSONL for live dashboard streaming, Excel for persistent historical records.

## Files

- `jsonl.ts` — JSONL append-only tracker + `withTrackedWorkflow` lifecycle wrapper
- `dashboard.ts` — SSE API server (port 3838) — serves `/api/*` and `/events/*` endpoints only (no HTML)
- `export-excel.ts` — On-demand Excel export from JSONL data
- `locked.ts` — Generic mutex-locked write wrapper for parallel Excel access
- `spreadsheet.ts` — `appendRow(filePath, columns, data)` and `parseDepartmentNumber(deptText)`
- `index.ts` — Barrel re-exports

## `withTrackedWorkflow(workflow, id, data, fn)`

Lifecycle wrapper for all workflows. Auto-emits JSONL events:
- **pending** — immediately on start
- **running** — via `setStep(step)` callback at phase transitions
- **done** — automatically on successful return
- **failed** — automatically on thrown error (with error message)

```ts
await withTrackedWorkflow("separations", docId, {}, async (setStep, updateData) => {
  setStep("authenticating");
  // ... auth ...
  updateData({ name: employeeName });
  setStep("extraction");
  // ... extract ...
}); // auto-emits done or failed
```

- `setStep(step)` — emits a `running` event with the step name
- `updateData(d)` — merges data into the entry (e.g. employee name discovered mid-workflow)
- All 5 workflows use this wrapper nested inside `withLogContext`
- Tracker functions (`updateOnboardingTracker`, etc.) are Excel-only — they no longer call `trackEvent()`

## Dashboard SSE Server

`startDashboard(workflow, port)` starts an HTTP server with:
- `GET /api/workflows` — list all workflows with JSONL data
- `GET /api/dates?workflow=X` — list available dates for a workflow
- `GET /api/entries?workflow=X` — return all tracker entries (JSON)
- `GET /api/logs?workflow=X&id=Y` — return log entries (JSON)
- `SSE /events?workflow=X&date=Y` — stream entries + workflow list every 1s
- `SSE /events/logs?workflow=X&id=Y&date=Z` — stream log entries every 500ms

API-only: does not serve HTML. The React dashboard is served by Vite dev server (port 5173) which proxies API calls to 3838.

## JSONL File Format

Two file types per workflow per day in `.tracker/`:

- **Entries**: `.tracker/{workflow}-{YYYY-MM-DD}.jsonl` — one JSON line per `trackEvent()` call
- **Logs**: `.tracker/{workflow}-{YYYY-MM-DD}-logs.jsonl` — one JSON line per `log.step/success/error/waiting` call (via `withLogContext`)

## `appendRow(filePath, columns, data)`

Appends a single row to an `.xlsx` file. Creates the file and/or worksheet if missing. Worksheet name is today's date as `YYYY-MM-DD`.

## Gotchas

- **Critical ExcelJS quirk**: After `readFile()`, ExcelJS loses column key mappings. Code re-applies keys in a loop — without this, `addRow(data)` won't map object keys correctly.
- Date uses `new Date().toISOString().slice(0, 10)` — system clock, no timezone awareness
- Tracker `.xlsx` files belong inside their workflow folder, never in project root
- Dashboard port 3838 conflict: logs and skips if port in use (another instance running)
- `withTrackedWorkflow` does NOT call `withLogContext` — use both: `withLogContext` wraps `withTrackedWorkflow` to get both log streaming and entry tracking
