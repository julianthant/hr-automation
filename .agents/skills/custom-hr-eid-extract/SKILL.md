---
name: custom-hr-eid-extract
description: >
  Extract UCPath Employee IDs (EmplID / EID) for onboarding roster candidates with a transaction number.
  Use whenever the user invokes /custom-hr-eid-extract, asks to extract EIDs, process EIDs, check Smart HR
  transactions for generated IDs, identify which candidates have numeric EIDs vs pending in UCPath, or
  populate the UCPath ID column on an onboarding roster.
---

# UCPath EID Extraction Workflow (`custom-hr-eid-extract`)

This skill provides the authoritative runbook and automation recipes for finding and extracting UCPath Employee IDs (EID / EmplID) from PeopleSoft SS Smart HR Transactions for candidates on an onboarding roster who have a transaction number (`T...`).

---

## 1. How EID Extraction Works in UCPath

When an onboarding hire or rehire transaction is submitted in UCPath, it receives a **Transaction Number** (e.g., `T002235451`). The Employee ID (`EmplID`) is not created at draft time; it is assigned once the transaction is approved and processed by UCPath central.

### UCPath Navigation & Extraction Steps
1. **SS Smart HR Transactions**:
   - PeopleSoft navigation: `Admin Menu -> Smart HR Templates -> SS Smart HR Transactions` (or Nav Collection `ADMN_UC_ADMIN_LOC_HIRE_NAVCOLL` -> Tile `UC_HIRE_TASKS_TILE_FL` -> Smart HR Transactions).
   - Content frame: `#main_target_win0`.
2. **Search by Transaction ID**:
   - Enter the transaction number (e.g., `T002235451`) into "Transaction ID begins with" (`ssSmartHRTransactions.txnNumberTextbox(frame)`).
   - Click "Search".
   - *Why Transaction ID instead of Name?* Transaction IDs are globally unique in UCPath. PeopleSoft name search is begins-with, which collides on common names and fails when lived names differ from legal names.
3. **Inspect the Search Outcome**:
   - **Single result**: PeopleSoft navigates directly to the Transaction Details page.
   - **Multiple rows in grid**: Drill into the exact row matching the transaction ID (`ssSmartHRTransactions.transactionResultRow(frame, transactionId)`).
   - **"No matching values were found"**: Verified PeopleSoft no-match state.
4. **Read the Detail & Routing Strip**:
   - At the bottom of the Transaction Details page, inspect the routing strip:
     ```text
     Transaction: T002235451, ID: 10901366, Effdt: 2026-09-28, Unit: SDCMP
     ```
   - Extract the `ID`:
     * **`Found`**: Numeric ID (e.g., `10901366`, 8 digits). The candidate has been assigned an EID.
     * **`Pending`**: ID says `NEW`, `PENDING`, or is blank/empty. The transaction is still in flight (e.g. pending location or central review). This is an expected intermediate state, not an error.
     * **`Not found`**: No matching transaction exists in UCPath (e.g. typo, or transaction was never submitted).
5. **Verify Name Match**:
   - Read the hire name from the transaction detail (`readTransactionHireName`).
   - Compare with the roster's lived name / legal name to verify that UCPath's transaction belongs to the expected person before assigning the EID.
   - Fail loud if there is a mismatch.

---

## 2. Execution Methods

### Method A: Dashboard / API (`process-eid` workflow)

The codebase has a dedicated kernel workflow `process-eid` (`src/workflows/process-eid/`) that automatically scans the newest onboarding roster, expands rows having a transaction number but missing/pending EIDs, looks them up in UCPath, verifies names, and displays them on the dashboard.

#### 1. Enqueue via Dashboard API (`:3838`)
```bash
# 1. Grab operator session token
TOKEN=$(curl -s http://localhost:3838/api/operator/session | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')

# 2. Enqueue Process EID for a specific worksheet (e.g. "September 14") or whole roster
curl -s -X POST http://localhost:3838/api/enqueue \
  -H "content-type: application/json" \
  -H "x-hr-auto-operator-token: $TOKEN" \
  -d '{"workflow":"process-eid","inputs":[{"source":"roster-sheet","sheet":"September 14"}]}'
```

#### 2. Dashboard UI
- Open dashboard: `http://localhost:5173/?wf=process-eid`
- The operation row shows all candidates under the sheet.
- Each person row displays:
  - **Lived Name** and **Roster Row**
  - **Transaction Number**
  - **Result Chip**:
    - Green **`Found`** with the 8-digit EID
    - Amber **`Pending`** for transactions awaiting central approval
    - Neutral **`Not found`** if the transaction number doesn't exist

---

### Method B: Automated Headless CLI Lookup

To perform a fast, direct lookup from Node/TypeScript using the repo's verified UCPath functions:

```ts
import { launchBrowser } from "src/infra/browser/launch.js";
import { DUO_LOGIN_FLOWS } from "src/infra/auth/duo-login-flows.js";
import { findTransactionEidByTransactionId } from "src/systems/ucpath/ss-smart-hr.js";

// 1. Launch browser & login to UCPath (Duo Autopilot handles MFA)
const session = await launchBrowser({ headless: true });
const ucpathFlow = DUO_LOGIN_FLOWS.find((f) => f.key === "ucpath");
await ucpathFlow.run(session.page);

// 2. Lookup EID by exact transaction ID
const result = await findTransactionEidByTransactionId(session.page, {
  transactionId: "T002235451"
});

if (result.transactionFound) {
  if (result.eid) {
    console.log(`Found EID: ${result.eid} (Name: ${result.ucpathName}, Status: ${result.approvalStatus})`);
  } else {
    console.log(`Pending: Transaction exists in status "${result.approvalStatus}" but no numeric EID yet.`);
  }
} else {
  console.log("Not found in UCPath.");
}
```

---

## 3. Roster Updating & Output Rules

When updating the onboarding roster spreadsheet (`.xlsx` and `.csv`):
1. Locate the **UCPath ID** column (standard: Column 20 / Column T, header `UCPath ID` or `Employee ID`).
2. Write the extracted 8-digit numeric EID into the cell for each **`Found`** candidate.
3. For candidates where the transaction is in flight, leave as `Pending` or `Requested`.
4. Present a structured summary table showing:
   - Applicant Name (Lived Name)
   - Transaction Number
   - UCPath Status (e.g. Approved, In Progress)
   - Extracted EID or Pending status
5. Provide direct `file://` links to the modified `.xlsx` and `.csv` roster files.
