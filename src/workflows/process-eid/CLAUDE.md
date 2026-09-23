# Process EID Workflow

Read-only UCPath workflow for manually completing the onboarding roster's EID
column. The operator enters one exact worksheet label (for example,
`September 14`). HTTP intake opens the newest local onboarding `.xlsx`, selects
that worksheet, and expands only rows that have a valid Smart HR transaction
number but no assigned EID.

Each eligible roster row becomes an `operation-member` queue row under one
operation coordinator. The member uses the roster's Lived Name to search SS
Smart HR Transactions, verifies the exact roster transaction number, then
reads the EID from the transaction detail routing strip:

`Transaction: T002235451, ID: 10901366, Effdt: 2026-09-28, Unit: SDCMP`

## Outcomes

- `Found` — exact transaction exists and has a numeric EID. Green dashboard
  badge; `emplId` contains the value for manual transcription.
- `Pending` — exact transaction exists but its ID is blank, `NEW`, or
  `PENDING`. Amber dashboard badge; this is a successful read, not a failure.
- `Not found` — the name search did not contain the exact roster transaction.
  Neutral dashboard badge; this is also a successful read.
- Parser, selector, authentication, duplicate-roster, and malformed-data errors
  fail the member row normally. Never convert an unknown page state into
  Pending or Not found.

The workflow never writes to UCPath or the roster. It only searches, reads,
stamps dashboard detail fields, and captures the final UCPath page.

## Roster contract

- Input worksheet matching is exact after trimming/collapsing whitespace and
  ignoring case.
- Header discovery scans the first 20 rows and requires `Lived Name`, a
  transaction-number header, and `EID`/`Employee ID`/`Empl ID` in one row.
- The newest local file whose name contains `onboarding` and ends in `.xlsx`
  is selected from the shared roster directories. An explicit `rosterPath` is
  allowed only as an internal/test override.
- Duplicate transaction numbers, a transaction without Lived Name, malformed
  transaction IDs, and unrecognized non-empty EID values fail loud.

## UCPath concurrency

`shared-context-pool` is intentionally fixed to one worker. SS Smart HR is a
stateful PeopleSoft surface; sequential members reuse one authenticated
browser without concurrent tabs racing search/detail state.
