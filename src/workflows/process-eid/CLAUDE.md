# Process EID Workflow

Read-only UCPath workflow for manually completing the onboarding roster's EID
column. The operator names one roster table — either an exact worksheet label
inside the newest local onboarding `.xlsx` (for example, `Onboarding`), or the
full path to a roster `.xlsx`/`.csv` they downloaded themselves. HTTP intake
reads that table and expands only rows that have a valid Smart HR transaction
number but no assigned EID (blank / `Requested` / `Pending` / `New`). **A row
whose EID column is already filled is never re-processed.**

Each eligible roster row becomes an `operation-member` queue row under one
operation coordinator. The member searches SS Smart HR Transactions by the
roster's **transaction number** and reads the EID from the transaction detail
routing strip:

`Transaction: T002235451, ID: 10901366, Effdt: 2026-09-28, Unit: SDCMP`

## The transaction number is the key; the name is the PROOF (2026-09-16)

The lookup used to search by Lived Name and then require the roster's
transaction number in the results. That is backwards: a transaction number is
unique in UCPath and a name is not, and a roster lived name is frequently not
the name UCPath holds (`Rita Li` / `Guangyi Li`).

So `findTransactionEidByTransactionId` searches the Transaction ID box, and the
member row then **proves the transaction belongs to the person who supplied
it** — `verifyUcpathTransactionName` compares UCPath's own Hire Details name
against BOTH roster spellings (lived + legal) and the best tier wins. `same` or
`similar` (one edit: `Stone` vs `Stoney`) is proof and is reported in the
`Name Match` detail field; `different` against both is a MISMATCH that fails the
row with both names in the message and records NO EID.

This is not theoretical. On the first CSV run (2026-09-16, `26-27 Student
Applicants(Sept 28)`), five rows carried a transaction number belonging to
somebody else entirely — `T002236424` is Michael Skaria, not Chaz Adams;
`T002236428` is Stephen Kuo, not sanya dhir; `T002236431` is Tiffany Vo,
`T002236500` is Helen Hengya Zhou, `T002237975` is Eryn Rataj. A block of T-ids
had been pasted onto the wrong rows. Without the name proof, each of those rows
would have recorded a real, plausible, WRONG EID into the roster.

## Outcomes

- `Found` — the transaction exists, its name matches the roster, and it has a
  numeric EID. Green dashboard badge; `emplId` holds the value to transcribe.
- `Pending` — the transaction exists and matches, but its ID is blank, `NEW`,
  `REQUESTED`, or `PENDING`. Amber badge; a successful read, not a failure.
- `Not found` — UCPath's verified "No matching values were found" for that
  transaction number. Neutral badge; also a successful read.
- **Failed** — the name does not match (the EID is withheld), the roster lists
  the transaction twice, or a parser/selector/auth error occurred. Never convert
  an unknown page state into Pending or Not found.

The workflow never writes to UCPath or the roster. It only searches, reads,
stamps dashboard detail fields, and captures the final UCPath page. The
mismatch screenshot is captured BEFORE the row throws, so the failure carries
the page it was read from.

## Roster contract

- `.xlsx` (worksheet label matched exactly after trimming/collapsing whitespace
  and ignoring case; a label may be omitted only for a single-worksheet
  workbook) or `.csv` (one table, labeled by filename — a worksheet label with
  a `.csv` is refused rather than ignored).
- Header discovery scans the first 20 rows and requires `Lived Name`, a
  transaction-number header, and `EID`/`Employee ID`/`Empl ID`/`UCPath ID` in
  one row. `Legal Name` is optional and carried only when it differs.
- With no `rosterPath`, the newest local file whose name contains `onboarding`
  and ends in `.xlsx` is selected from the shared roster directories.
- **A repeated transaction number fails only its own rows, not the roster.**
  Numbers are indexed across EVERY row (assigned or not), and each row sharing
  one carries a `rosterConflict` that the handler throws before any UCPath
  search — naming both row numbers. The unambiguous rows in the same run still
  execute; aborting the whole expansion punished 19 good rows for 2 bad ones.
- A transaction with no name at all, malformed transaction IDs, and
  unrecognized non-empty EID values fail loud.

## UCPath concurrency

`shared-context-pool` is intentionally fixed to one worker. SS Smart HR is a
stateful PeopleSoft surface; sequential members reuse one authenticated
browser without concurrent tabs racing search/detail state. After the first
person, later members skip the HR-Tasks sidebar reload when the search box is
still on screen, or click Return to Search when the prior lookup left
Transaction Details open. Both reuse paths Clear leftover criteria first —
Return to Search after an auto-opened detail restores that transaction's T-id,
which would AND-filter the next search.
