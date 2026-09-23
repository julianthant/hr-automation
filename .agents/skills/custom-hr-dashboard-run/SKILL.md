---
name: custom-hr-dashboard-run
description: >
  Rapid runbook and CLI guide for launching, queueing, monitoring, and controlling workflows
  via the hr-automation dashboard API (:3838). Use whenever the user asks to run, process,
  enqueue, start, monitor, retry, or cancel a workflow from the dashboard (onboarding, separations,
  crm-doc-download, person-lookup, oath-signature, kronos-pay-rule, process-eid, or OCR/upload runs).
  Eliminates exploratory trial-and-error by providing exact curl recipes, token auth, input schemas,
  daemon lifecycle checks, gate approvals, and monitoring patterns.
---

# Dashboard Workflow Runbook (`custom-hr-dashboard-run`)

This skill provides the authoritative, fast runbook for driving the hr-automation dashboard backend (`http://localhost:3838`) directly. Use it to immediately launch, inspect, unblock, and monitor workflows without exploratory trial-and-error.

> [!IMPORTANT]
> **Core Architecture Rules:**
> 1. **Dashboard-only workflow launches**: Workflows are started **only** via the dashboard API (`/api/enqueue` or `/api/ocr/prepare`). Do NOT look for or add `npm run <workflow>` CLI launch scripts.
> 2. **Auto-spawned daemons**: You do **not** need to start daemons manually before enqueuing. Calling `POST /api/enqueue` automatically boots and provisions the required daemon workers (`ensureDaemonsAndEnqueue`).
> 3. **Operator Auth Header**: All mutations require the session token from `GET /api/operator/session` passed in header `x-hr-auto-operator-token: <TOKEN>`.
> 4. **Live Duo MFA**: In live production runs, Duo MFA prompts are delivered to the operator's physical device during auth. Always notify the operator when auth begins so they can approve it.

---

## 1. Quick-Start (10-Second Enqueue)

You can use the bundled CLI script [`dashboard-cli.sh`](./scripts/dashboard-cli.sh) or direct `curl` commands:

### Using `dashboard-cli.sh`:
```bash
CLI=".agents/skills/custom-hr-dashboard-run/scripts/dashboard-cli.sh"

# 1. Check dashboard health & active daemons
$CLI status

# 2. Enqueue an onboarding run
$CLI enqueue onboarding '[{"email":"user@ucsd.edu","mode":"new-hire"}]'

# 3. Enqueue separations (task 1 / all)
$CLI enqueue separations '[{"docId":"4694"},{"docId":"4693"}]'

# 4. Monitor live progress until terminal
$CLI monitor onboarding
```

### Using Raw `curl`:
```bash
# 1. Grab operator token
TOKEN=$(curl -s http://localhost:3838/api/operator/session | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')

# 2. Enqueue workflow
curl -s -X POST http://localhost:3838/api/enqueue \
  -H "content-type: application/json" \
  -H "x-hr-auto-operator-token: $TOKEN" \
  -d '{"workflow":"onboarding","inputs":[{"email":"alice@ucsd.edu","mode":"new-hire"}]}'
```

---

## 2. Input-Run Workflows & Exact JSON Schemas (`/api/enqueue`)

All input-run workflows map to `src/dashboard/lib/input-run-registry.ts`. The payload structure is:
```json
{
  "workflow": "<workflow-name>",
  "inputs": [ ... ],
  "parallelWorkers": 1,   // optional: 1 | 2 | 4 | 6 | 8 | "auto"
  "skipSteps": ["stepA"], // optional: subset of declared handler steps to skip
  "preset": "full"        // optional: run preset
}
```

### Supported Input Workflows:

| Workflow | Input Item Shape | Example / Options | Notes |
|---|---|---|---|
| **`onboarding`** | `{"email": string, "mode"?: "new-hire"\|"rehire", "dryRun"?: boolean, "rosterPath"?: string}` | `[{"email":"jdoe@ucsd.edu","mode":"new-hire"}]` | Resolves Legal vs Lived names from newest roster in `data/rosters/`. `dryRun: true` skips I-9 submit and Smart HR final submit. |
| **`separations`** | `{"docId": string, "dryRun"?: boolean}` | `[{"docId":"4694"},{"docId":"4693"}]` | `docId` is Kuali document ID. `dryRun: true` skips Smart HR submit and Kuali final save. |
| **`crm-doc-download`** | `{"email": string}` OR `{"emplId": string}` | `[{"email":"jdoe@ucsd.edu"},{"emplId":"10873611"}]` | Downloads offer letters/iDocs into `data/onboarding/Onboarding Docs <date> <hash>.zip`. Uses Legal vs Lived naming from onboarding roster. |
| **`person-lookup`** | **Search**: `{"emplId": string}` OR `{"name": "Last, First"}`<br>**Match**: `{"lastName": string, "firstName": string, "dob"?: string, "ssn"?: string}` | `[{"name":"Smith, John"}]`<br>Match: `[{"lastName":"Smith","firstName":"John","dob":"01/01/2000"}]` | `crmCheck: true` is supported on Search mode. |
| **`process-eid`** | `{"source": "roster-sheet", "sheet": string}` OR `{"source": "roster-sheet", "rosterPath": string}` | `[{"source":"roster-sheet","sheet":"Onboarding"}]` | Reads roster sheet or path and processes EIDs. |
| **`oath-signature`** | `{"emplId": string}` | `[{"emplId":"10873611"}]` | Signs oath in UCPath for existing employee ID. |
| **`kronos-pay-rule`** | `{"emplId": string}` | `[{"emplId":"10873611"}]` | Updates Kronos pay rule. |

---

## 3. Upload-Run Workflows (`/api/ocr/prepare` & `/api/oath-upload/start`)

Upload runs back file/PDF-driven workflows (`src/dashboard/lib/run-modal-registry.ts`):
- `emergency-contact`, `ocr`, `onbase`, `i9-check` (Run I-9 Check)
- `oath-upload`

### OCR Upload Recipe:
```bash
curl -s -X POST http://localhost:3838/api/ocr/prepare \
  -H "x-hr-auto-operator-token: $TOKEN" \
  -F "file=@/path/to/document.pdf" \
  -F "targetWorkflow=emergency-contact" \
  -F "formType=emergency_contact"
```

### Oath Upload Recipe:
```bash
curl -s -X POST http://localhost:3838/api/oath-upload/start \
  -H "x-hr-auto-operator-token: $TOKEN" \
  -F "file=@/path/to/oath.pdf"
```

---

## 4. Monitoring Execution & Daemons

Never use indefinite manual `sleep` commands. Monitor using these standard endpoints and tracker logs:

### 1. Check Active Daemons
```bash
curl -s "http://localhost:3838/api/daemons?workflow=<workflow>" | jq .
```
Key fields to check:
- `phase`: `"idle"` | `"running"` | `"authenticating"`
- `currentItem`: The item ID currently being processed
- `itemsProcessed`: Count of items handled in this daemon session
- `pidAlive`: Whether the browser/daemon process is running

### 2. Check Queue Entries (Latest State per Row)
```bash
curl -s "http://localhost:3838/api/entries?workflow=<workflow>" | jq .
```

### 3. Tail Real-Time JSONL Logs
- **Row transitions**: `tail -n 20 .tracker/rows/<workflow>-$(date +%Y-%m-%d).jsonl`
- **Detailed daemon logs**: `tail -n 30 .tracker/logs/<workflow>-$(date +%Y-%m-%d).jsonl`
- **Row lifecycle transitions**: `tail -n 20 .tracker/debug/row-lifecycle-$(date +%Y-%m-%d).jsonl`

### 4. Categorizing Terminal Outcomes
Always differentiate expected business outcomes from unexpected execution failures:
- **Expected business states**:
  - `cannot be in the future` / `not yet eligible`: Employee last day worked is future-dated.
  - `not found in Action List`: Doc already completed or in another queue.
  - `Task 1 already complete`: Re-run on already finalized record.
- **Systemic / Operational failures**:
  - `Timeout 10000ms exceeded`: Selector or page navigation issue.
  - `auth failed`: SSO or Duo timeout.

---

## 5. Handling Review Gates (Identity Approval)

When `onboarding` or `separations` matches a person in UCPath who has a different name (e.g. fuzzy DOB match on a common name) or multiple ambiguous matches, the workflow pauses at `person-search` for operator identity review.

### Option A: "Not This Person" (Mark false match & continue as New Hire)
In `onboarding`, if UCPath matched someone else (e.g. Mcilwain when hiring Anthony Garcia):
```bash
curl -s -X POST http://localhost:3838/api/eid-approval/not-this-person \
  -H "content-type: application/json" \
  -H "x-hr-auto-operator-token: $TOKEN" \
  -d '{
    "workflow": "onboarding",
    "id": "anthony.r.garcia05@gmail.com",
    "runId": "<runId-from-tracker-if-known>",
    "eid": "10783400"
  }'
```
This automatically re-queues the person with the false EID excluded and proceeds as a New Hire!

### Option B: Approve Proposed EID (Confirm Rehire)
If the matched person IS the hire:
```bash
curl -s -X POST http://localhost:3838/api/eid-approval/approve \
  -H "content-type: application/json" \
  -H "x-hr-auto-operator-token: $TOKEN" \
  -d '{
    "workflow": "onboarding",
    "id": "person@ucsd.edu",
    "approvedEid": "10873400"
  }'
```

---

## 6. Stopping, Canceling & Retrying

### Stop Daemons (Kill Workers)
```bash
# Stop all daemons for a workflow
curl -s -X POST http://localhost:3838/api/daemon/stop \
  -H "content-type: application/json" \
  -H "x-hr-auto-operator-token: $TOKEN" \
  -d '{"workflow":"<workflow-name>"}'
```

### Cancel Runs
```bash
# Cancel all active (queued + running) runs for a workflow
curl -s -X POST http://localhost:3838/api/cancel-active-bulk \
  -H "content-type: application/json" \
  -H "x-hr-auto-operator-token: $TOKEN" \
  -d '{"workflow":"<workflow-name>"}'
```

### Retry a Run
```bash
curl -s -X POST http://localhost:3838/api/retry \
  -H "content-type: application/json" \
  -H "x-hr-auto-operator-token: $TOKEN" \
  -d '{"workflow":"<workflow-name>","runId":"<runId>"}'
```

---

## 7. Common Pitfalls & Lessons Learned

1. **Never parse arbitrary files for API paths**:
   The dashboard API routes are frozen in `src/tracker/dashboard/hono/manifest.ts` and `INPUT_RUN_REGISTRY` in `src/dashboard/lib/input-run-registry.ts`. Check those two files first.
2. **Never try to launch daemons from CLI**:
   `POST /api/enqueue` handles daemon spawning automatically with correct environment, locks, and ports.
3. **Rosters and Non-Breaking Spaces**:
   Spreadsheets exported from Excel / Google Sheets often contain non-breaking spaces (`\xa0`). When parsing CSVs or tabular lines from users, normalize whitespace with `.replace(/\s+/g, ' ')`.
4. **Folder Naming Standards**:
   `crm-doc-download` and `onboarding` store documents with format:
   `Last, First (Lived) M. EID`
   *(Parentheses for lived name are only included when lived first name differs from legal first name)*.
5. **SSN ITIN / 900-Series Placeholders**:
   National IDs starting with 900–999 in CRM are placeholder numbers (no SSN). Onboarding automatically blanks the SSN for I-9 creation rather than failing or submitting the invalid 9-placeholder.
