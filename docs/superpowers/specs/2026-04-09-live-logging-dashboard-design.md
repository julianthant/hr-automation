# Live Per-Item Logging + Dashboard Redesign

## Problem

The dashboard refreshes by replacing the entire table innerHTML every second, causing visible flickering. Workflow tabs reorder when clicked. There's no way to see logs for a specific employee — all 479 log calls go to shared stdout. When something goes wrong, the user has to scroll through a mixed console stream to find the relevant lines. Key decision points (reason code selection, name search fallbacks, date computations) don't log WHY a choice was made.

## Solution

Three changes:

1. **Per-item log capture via AsyncLocalStorage** — zero function signature changes, all existing log calls automatically captured per item
2. **Enhanced logging at ~30-40 decision points** — add reasoning context to key workflow choices
3. **Dashboard UX overhaul** — DOM diffing (no flicker), fixed tab order, row-click log panel, remove logo

---

## 1. Per-Item Log Capture

### Architecture

```
log.step("Filling position number...")
    │
    ▼
log.ts checks AsyncLocalStorage
    │
    ├── Always: print to console (existing behavior)
    │
    └── If context exists: append to .tracker/{workflow}-{date}-logs.jsonl
        { workflow, itemId, level: "step", message, timestamp }
```

### Modified file: `src/utils/log.ts`

Add AsyncLocalStorage-based context:

```typescript
import { AsyncLocalStorage } from "async_hooks";

interface LogContext {
  workflow: string;
  itemId: string;
}

const logStore = new AsyncLocalStorage<LogContext>();

export function withLogContext<T>(
  workflow: string,
  itemId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return logStore.run({ workflow, itemId }, fn);
}
```

Each `log.step/success/error/waiting` call checks the store and appends to JSONL if a context exists. Console output is unchanged.

### Log JSONL format

File: `.tracker/{workflow}-{date}-logs.jsonl`

```json
{"workflow":"onboarding","itemId":"jsmith@ucsd.edu","level":"step","message":"Filling SSO credentials...","ts":"2026-04-09T10:42:03.123Z"}
{"workflow":"onboarding","itemId":"jsmith@ucsd.edu","level":"success","message":"ACT CRM authenticated","ts":"2026-04-09T10:42:08.456Z"}
```

### Workflow entry point changes (5 files)

Each workflow wraps per-item processing:

- `src/workflows/onboarding/workflow.ts` — wrap `runOnboarding()` call
- `src/workflows/onboarding/parallel.ts` — wrap inside worker loop
- `src/workflows/eid-lookup/workflow.ts` — wrap each name lookup
- `src/workflows/old-kronos-reports/parallel.ts` — wrap `runKronosForEmployee()`
- `src/workflows/work-study/workflow.ts` — wrap `runWorkStudy()`
- `src/workflows/separations/workflow.ts` — wrap `runSeparation()`

Pattern:
```typescript
await withLogContext("onboarding", email, () => runOnboarding(email, options));
```

---

## 2. Enhanced Logging Points (~30-40 new log calls)

### Separations

| File | What to log |
|------|-------------|
| `kuali/navigate.ts` | Reason code mapping: which Kuali type → which UCPath reason, and why |
| `workflows/separations/workflow.ts` | Termination date computation (sep date + 1 day) |
| `workflows/separations/workflow.ts` | Kronos date resolution: which system's date was used and why |
| `workflows/separations/workflow.ts` | Template selection: UC_VOL_TERM vs UC_INVOL_TERM and why |
| `kuali/navigate.ts` | Department best-match result |

### Onboarding

| File | What to log |
|------|-------------|
| `workflows/onboarding/extract.ts` | Each field extraction: which CRM label matched |
| `ucpath/transaction.ts` | Comp rate code selection rationale |
| `ucpath/navigate.ts` | Person search: rehire detection result |
| `ucpath/transaction.ts` | Grid field index used (and if fallback triggered) |

### EID Lookup

| File | What to log |
|------|-------------|
| `workflows/eid-lookup/search.ts` | Name search strategy: full → first-only → middle-only fallbacks |
| `workflows/eid-lookup/search.ts` | HDH/SDCMP filter: how many results before/after |
| `workflows/eid-lookup/workflow.ts` | CRM cross-verification match/mismatch detail |

### Kronos Reports

| File | What to log |
|------|-------------|
| `old-kronos/reports.ts` | Report polling: phase, attempt count, status transitions |
| `old-kronos/reports.ts` | PDF validation: size, name match result |
| `old-kronos/reports.ts` | Download method used (event vs filesystem fallback) |

### Auth (all workflows)

| File | What to log |
|------|-------------|
| `auth/duo-poll.ts` | Recovery actions taken (SAML retry, failedLogin retry) |
| `auth/sso-fields.ts` | Which SSO label variant matched |

---

## 3. Dashboard UX Overhaul

### 3A. DOM Diffing (no flicker)

Replace `tbody.innerHTML = ...` with a diff algorithm:

1. On each SSE tick, compute new row data
2. Compare with current DOM rows by item ID
3. Only update cells whose content changed
4. Add new rows with animation; remove stale rows with fade-out
5. Never re-render rows that haven't changed

### 3B. Fixed Tab Order

Predefined order constant:
```javascript
const TAB_ORDER = ['onboarding', 'separations', 'kronos-reports', 'eid-lookup', 'work-study'];
```

Tabs always render in this order. Missing workflows get a dimmed/disabled tab. New unknown workflows append to the end.

### 3C. Remove Logo

Replace the gold `H` logo mark with just the text "HR Automation Control".

### 3D. Row-Click Log Panel

Click any table row → expand a log panel below it:

- Panel is a `<tr>` inserted after the clicked row with `colspan` spanning all columns
- Contains a scrollable log viewer (max-height: 400px)
- Log entries: timestamp (monospace), level icon (colored), message
- Color coding: step=dim gray, success=green, error=red, waiting=amber
- Auto-scrolls to bottom as new entries arrive
- New entries animate in (slide down + fade)
- Click same row again to collapse; click different row to switch
- SSE endpoint: `/events/logs?workflow=X&id=Y` streams log entries for that item

### 3E. Server Endpoints (additions)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/logs?workflow=X&id=Y` | JSON array of log entries for item |
| `GET /events/logs?workflow=X&id=Y` | SSE stream of log entries for item |

---

## Files to Create

```
src/utils/log.ts              — Modify: add AsyncLocalStorage, withLogContext, JSONL append
src/tracker/dashboard.ts      — Rewrite: DOM diffing, fixed tabs, log panel, no logo
```

## Files to Modify (log context wrappers)

```
src/workflows/onboarding/workflow.ts
src/workflows/onboarding/parallel.ts
src/workflows/eid-lookup/workflow.ts
src/workflows/old-kronos-reports/parallel.ts
src/workflows/work-study/workflow.ts
src/workflows/separations/workflow.ts
```

## Files to Modify (enhanced logging)

```
src/auth/duo-poll.ts
src/auth/sso-fields.ts
src/kuali/navigate.ts
src/ucpath/transaction.ts
src/ucpath/navigate.ts
src/workflows/onboarding/extract.ts
src/workflows/eid-lookup/search.ts
src/workflows/eid-lookup/workflow.ts
src/workflows/separations/workflow.ts
src/old-kronos/reports.ts
src/old-kronos/navigate.ts
```

## Files to Modify (JSONL reader for logs)

```
src/tracker/jsonl.ts          — Add readLogEntries() function
```
