---
name: custom-hr-crm-check
description: >
  Audit and verify candidate offer letter statuses and process stages in ACT CRM for onboarding rosters.
  Use whenever the user invokes /custom-hr-crm-check, asks to check CRM stages, check offer letter status,
  filter active vs archived candidates, identify which candidates lack "Offer Letter Sent", or add/update
  the "Offer Letter Status" column in an onboarding roster spreadsheet.
---

# ACT CRM Offer Letter & Process Stage Audit (`custom-hr-crm-check`)

This skill provides the authoritative runbook and automation recipes for auditing ACT CRM onboarding records against onboarding rosters, verifying offer letter issuance, and updating roster spreadsheets with exact CRM statuses.

---

## 1. Core Principles & Rules

### Rule 1: Exclude Archived / Declined Candidates
- If a roster row contains **"archived"** in its notes (e.g., `declined offer archived 9/17/26`, `no response archived 9/21/26`, `declined bg archived CC`), **do NOT search them in CRM**.
- These candidates explicitly declined or withdrew.
- Mark them immediately as: **`Declined (Archived)`**.

### Rule 2: Focus on Candidates Lacking a Transaction Number
- Candidates with a UCPath Transaction # (e.g., `T002245...`) are already entered or hired: mark as **`Entered in UCPath (Hired)`**.
- For all candidates without a Transaction #, audit ACT CRM to determine whether an offer has been sent, created, or if the department has not initiated onboarding yet.

### Rule 3: Process Stage Classifications
From ACT CRM search results, extract the `Process Stage` and `Offer Sent On` date of the newest record:
* **`Offer Letter Sent`**: The candidate received their official onboarding offer letter and is active/in-flight.
* **Alternative CRM Stages**:
  * **`Record Created`**: Department created the candidate profile in CRM, but has not dispatched the offer letter yet.
  * **`Campus Forms Pending Approval`**: Forms submitted; waiting for approval before releasing offer letter.
  * **`Account Creator Notified`**: Older/stalled record or account setup stage.
* **`No Offer in CRM`**: 0 records found in CRM by email or legal name. (The roster may note that background check authorization was accepted, but the department has not initiated an onboarding offer in CRM).

---

## 2. Fast Audit Execution

### Step 1: Query ACT CRM with Headless Browser
Using the built-in CRM system helpers:

```ts
import fs from "node:fs";
import { launchBrowser } from "src/infra/browser/launch.js";
import { DUO_LOGIN_FLOWS } from "src/infra/auth/duo-login-flows.js";
import { searchCrmOnboardingResultRows } from "src/systems/crm/onboarding-records.js";

// 1. Launch browser (Duo Autopilot handles MFA hands-off)
const session = await launchBrowser({ headless: true });
const crmFlow = DUO_LOGIN_FLOWS.find((f) => f.key === "crm");
await crmFlow.run(session.page);

// 2. Search candidate by email (with legal name fallback)
let rows = await searchCrmOnboardingResultRows(session.page, candidateEmail);
let recordRows = rows.filter((r) => r.name !== "Search Results" && (r.recordUrl || r.processStage));

if (recordRows.length === 0 && candidateLegalName) {
  const nameRows = await searchCrmOnboardingResultRows(session.page, candidateLegalName);
  recordRows = nameRows.filter((r) => r.name !== "Search Results" && (r.recordUrl || r.processStage));
}

// 3. Sort by Offer Sent date descending
recordRows.sort((a, b) => new Date(b.offerSentOn || 0).getTime() - new Date(a.offerSentOn || 0).getTime());

const latest = recordRows[0];
const stage = latest ? latest.processStage : "No Offer in CRM";
```

### Step 2: Spreadsheet Column Update (Column 31)
When updating an onboarding roster (`.xlsx` and `.csv`):
1. Locate the first available empty column (standard: Column 31, header: **`Offer Letter Status`**).
2. Populate the column according to:
   - Row with Transaction #: `Entered in UCPath (Hired)`
   - Row with "archived" in notes: `Declined (Archived)`
   - Row with CRM "Offer Letter Sent": `Offer Letter Sent`
   - Row with other CRM stage: The exact stage (e.g. `Record Created`, `Campus Forms Pending Approval`)
   - Row not found in CRM: `No Offer in CRM`
3. Save both the updated `.xlsx` (using `ExcelJS`) and `.csv`.
4. Provide clickable `file://` links to the modified files.

---

## 3. Reporting Format

When presenting CRM audit results to the operator:
1. **Summary Counts**:
   - Total rows in roster
   - Already hired (`Entered in UCPath (Hired)`)
   - Archived / declined (`Declined (Archived)`)
   - Active applicants without transaction number:
     - Count of `Offer Letter Sent`
     - Count of alternative stages (list them specifically)
     - Count of `No Offer in CRM`
2. **Actionable Breakdown Table**:
   - List all active candidates with alternative stages or `No Offer in CRM` so the department can follow up on missing offers.
