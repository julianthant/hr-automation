# Kronos Paycodes (`kronos-pay-rule`)

Updates UKG (WFD / New Kronos) pay rules for represented employees based on the June 2026 OT election roster.

**Kernel-based.** Dashboard input run (comma-separated EIDs). One browser (`new-kronos`). Steps: `csv-lookup` → `determine-action` → `kronos-auth` → `update-pay-rule`.

## Verification source

Roster CSV (read-only lookup, cached after first load):

`.tracker/rosters/RRSS June 2026 OT Elections Tracker(Represented EEs RRSS - OT -CT).csv`

Columns used: Employee ID, Union Code, Pay Rule In UKG if applicable, Currect Election, Election eff. 7/1/2026 (CASH, CT, NONE), Timekeeping System updated eff. 7/1/26 (Yes, N/A).

## Decision logic (`election-logic.ts`)

Pure + unit-tested in `tests/workflows/kronos-pay-rule/election-logic.test.ts`.

1. **Skip** if not in UKG, already updated (`Yes`), pay rule has no `-CT-`/`-OT-` segment, employee elected `NONE`, union is K6/RX/TX (previous election continues on blank), the election value is **unrecognized** (`UNKNOWN` — never treated as blank, since the blank default can swap a pay rule; fix the roster CSV and re-run), or current pay rule already matches the target (OT for CASH/blank-default, CT for Comp Time election).
2. **Change** by swapping the `-CT-` ↔ `-OT-` segment in the existing pay rule code (e.g. `SX-8Hol-8-CT-30` → `SX-8Hol-8-OT-30`). Effective date is always **07/01/2026** (`PAY_RULE_EFFECTIVE_DATE` in `workflow.ts` — update it when the workflow is reused for a future election cycle).
3. **Blank election defaults to OT** for union codes: HX, CX, SV, SX, RP (no new June 2026 election → employee must receive pay for overtime worked).

## Kronos UI flow (`systems/new-kronos/navigate.ts`)

For each EID that needs a change:

0. **Reset to home** (`resetNewKronosToHome`) — the previous item leaves its People editor open, and once open, Go To → People has no "People" option, so every item must start fresh.
1. Navbar Employee Search → enter EID → select result checkbox
2. Go To → **People**, then **verify identity** (`verifyPeopleEmployee` reads `.empName`) — fail loud if the editor shows a different EID
3. Expand **Timekeeper** (if collapsed)
4. Add pay rule row → search dialog → type exact OT/CT code → **OK** → set effective date via **calendar icon** → **Save**

**Batch employee switch (fail-loud):** steps 0 + 2 guard the "keeps redoing the old person" bug — never trust whole-page text for identity (the searched EID lingers in the global search box); confirm the editor's own `.empName` header. See `src/systems/new-kronos/LESSONS.md` (2026-07-02 batch entry).

**Fail-loud commit gates (all three readbacks throw):** the lookup **OK** click intermittently no-ops on jqx, so `addPayRule` retries row-select + OK up to 3× and only proceeds once the chosen **code** actually appears in the row1 grid cell (`payRuleCodeCommittedInCell` readback); the **effective date** is likewise polled out of its grid cell after the Enter-commit. Neither an empty pay rule nor a blank effective date can reach Save. **Save itself is readback-gated too** (2026-07-04): `savePersonRecord` polls for the Save button returning to its native-`disabled` no-pending-edits state (live-verified contract, read-only probe `scripts/verify-kronos-save-state.ts`) and THROWS if it stays enabled — a validation-error dialog or rejected save can no longer stamp the row "Updated". See `src/systems/new-kronos/LESSONS.md` (2026-07-02 pay-rule entries).

**CSV header guard:** `loadElectionsTracker` validates the five exact-key columns (`Employee ID`, `Employee Name`, `Union Code`, `Pay Rule In UKG if applicable`, `Currect Election`) at load and throws if any is missing — a renamed header would otherwise read `""` for every row and silently skip the whole roster as "Not in UKG".

Selectors under `people.*` in `src/systems/new-kronos/selectors.ts` target the **`managePeople#/managePeople` frame** (not the top-level page). Live-verified 2026-07-02 on EID 10403587. Probe script: `scripts/verify-kronos-people-selectors.ts`.

Tests use `HRAUTO_ELECTIONS_CSV` → `tests/fixtures/kronos-pay-rule/elections-tracker.csv` (operator default remains the `.tracker/rosters/…` file).

## Dashboard

- Category: **Payroll**
- Label: **Kronos Paycodes**
- Input placeholder: comma-separated EIDs
- Trace id prefix: `kp`

## Lessons Learned

- **2026-07-02: Election roster drives skip vs change; Kronos only runs on `change`.** The CSV is authoritative for union code and election columns — do not infer election from the live Kronos pay rule alone. A blank `Election eff. 7/1/2026` for HX/CX/SV/SX/RP means default to OT (swap CT→OT when the current rule is CT).
