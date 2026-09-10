# Person Lookup — UCPath / CRM presence + CRM identity fill

## Goal

When UCPath Person Org misses but CRM finds the person (or vice versa), the run
is still **found**, identity details are filled from the system that hit, and
the detail grid shows explicit **UCPath** / **CRM** Found|Not found cells.

## Rules

1. Grid fields `ucpathFound` / `crmFound` (labels **UCPath** / **CRM**):
   `Found` | `Not found`.
2. Overall row is **Not found** only when **both** miss
   (`activeStatus === "not-found"`).
3. Identity fill: UCPath wins when present; else CRM (name, dept, EID).
   Start Date remains CRM First Day of Service when CRM has it.
4. Active / HR status:
   - UCPath hit → existing `active` | `inactive` | `non-hdh` | `ambiguous`
   - CRM-only → `activeStatus: "n/a"`, `hrStatus: "N/A"` (no A/IA chip)
   - Both miss → `not-found` / `Not found`

## Grid order

Search, Name, EID, Dept, HR Status, UCPath, CRM, Start Date, End Date, Term Reason.
