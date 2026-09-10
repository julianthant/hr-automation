# Handoff — Dining student onboarding (2026-08-18 → 2026-08-20)

**Written for a fresh session.** Everything below is either verified live or explicitly
marked as unverified. Read "Corrections" first — one thing I reported earlier was wrong.

---

## 1. Corrections to what was previously reported

**The three "Awaiting EID Approval" rows are almost certainly NOT rehires.** I earlier
described them as "UCPath matched a differently-named person — review the EID", which
under-stated it. The actual matches, from the daemon logs:

| CRM record | UCPath matched | EID | Verdict |
|---|---|---|---|
| Juliana Romano | **Julian Davey** | 10884140 | different person |
| Maria Renee Santos | **Mariana Herrera** | 10769454 | different person |
| Mia Perez | **Mia McKrell** | 10871985 | different person |

This is the known **DOB-keyed fuzzy Search/Match** behaviour (see `src/systems/ucpath/LESSONS.md`,
2026-08-06: Search/Match keys on DOB with fuzzy first names and *ignores the last name*).
These are false positives; the wrong-person guard did its job. The likely correct action is
to **dismiss** each match and let them proceed as new hires — but that is the operator's call,
not mine, and it has **not** been done.

**The two rehires ARE genuine** — the matched person's name is identical, not fuzzy:

| CRM record | UCPath matched | EID |
|---|---|---|
| Carlos Rocha | Carlos Rocha | 10864605 |
| Marcus Williams | Marcus Williams | 10841361 |

---

## 2. Completed transactions

### 2026-08-18 batch (roster "Sept 11")

| Legal Name | Transaction # | I-9 Profile | Status |
|---|---|---|---|
| ALI ALNASSER | `T002214646` | `2208420` | Pending approval |
| Jaden Campos | `T002214808` | `2208505` | Pending approval |
| Alyssa Corona | `T002214810` | `2208508` | Pending approval |
| Ayelen Flores Soriano | `T002214812` | `2208509` | Pending approval |
| Bela Das | — | — | **Rehire**, existing EID `10884748` — not filed |

### 2026-08-20 batch (11 yellow-highlighted rows)

| Legal Name | Transaction # | I-9 Profile | Status |
|---|---|---|---|
| Lenny Salazar | `T002216458` | `2209332` | Pending approval |
| Nicole Saenz | `T002216471` | `2209331` | Pending approval |
| Lele Zhang | `T002216475` | `2209338` | Pending approval |
| Carolina Soria | `T002216493` | `2209336` | Pending approval |

Spreadsheet columns for a completed row: `Entered In UCPath` = `JZ <date>`,
`Transaction #` = the T-number, `UCPath ID` = `Requested`.

**Note — Ali Alnasser has no SSN.** CRM holds `999-99-9999`. Per operator rule his UCPath
National ID and his I-9 SSN are both blank, and his transaction comment reads
*"…EE does not have an SSN yet, we will add it as soon as it is provided."* The I-9 profile
exists but is SSN-less until the real number arrives.

**Note — Alyssa Corona** has only 2 documents on her CRM record, so there is no
*EE Data Gathering Form*; her zip contains only the signed offer letter.

---

## 3. Outstanding work

### 3a. Emily Robles + Hao Sun — I-9 done, transaction still needed

Operator confirmed on 2026-08-20 that **both I-9s are complete**:

| Name | Email | I-9 Profile | Position # |
|---|---|---|---|
| Emily Robles | `emrobles0026@gmail.com` | `2209330` | 40692751 |
| Hao Sun | `shawnsun824@gmail.com` | `2209337` | 40847440 |

**Instruction from the operator: use the existing profile id and SKIP the I-9 step; just do
the transaction.**

The workflow does not currently accept a supplied profile id. Two options:

1. **Preferred** — extend the `prefilledData` channel so `i9ProfileId` can be supplied and
   the `i9-creation` step short-circuits when it is present. The dashboard "Edit Data" tab
   already uses this channel for other workflows (see `src/workflows/CLAUDE.md` → Opt-Ins);
   onboarding has not opted in (`detailFields` has no `editable: true`).
2. **Interim** — the existing I-9 SSN search already finds and reuses a profile
   (`i9SearchOnly: "true"`), so a plain re-run *should* reuse `2209330`/`2209337` rather than
   create duplicates. Emily has a real SSN so the SSN search will match. Hao Sun's CRM SSN is
   `***-**-9999` (i.e. none), so his lookup falls to the **name** search added this session —
   verify it finds `2209337` before trusting it.

**Before re-running either, CHECK UCPATH.** Their last attempt ended with an *unknown* submit
outcome — "Save and Submit timed out with no error banner and no confirmation OK dialog". The
diagnostic confirmed the correct control was clicked
(`HR_TBH_WRK_TBH_SAVE$4$`, value `Save and Submit`, exactly one match), and *Transactions in
Progress* was empty afterwards — but an empty in-progress grid does **not** prove the hire was
not submitted. **Confirm no transaction exists for them before re-running**, or you risk a
duplicate hire.

### 3b. Three false-match pauses — need a dismiss decision

Mia Perez, Juliana Romano, Maria Renee Santos (see §1). They are sitting as `eidApproval:
"pending"` with the amber "Awaiting Approval" badge in the dashboard queue. The generic routes
are `POST /api/eid-approval/dismiss` and `/approve`. Dismiss re-opens them for a normal
new-hire run; approve would record the *wrong* EID, so **do not approve these three**.

### 3c. Two genuine rehires — need the rehire path

Carlos Rocha (`10864605`), Marcus Williams (`10841361`), plus Bela Das (`10884748`) from the
2026-08-18 batch. The onboarding workflow deliberately short-circuits on a rehire before I-9
and before Smart HR. There is no automated rehire path in this workflow.

---

## 4. Bugs fixed this session (all committed, all gates green)

Ten commits, `af8d4f94`..`e255aa5f`. Every one was found by a live run, not by reading code.

| Commit | Defect |
|---|---|
| `af8d4f94` | **PDF download never worked.** The iDocs PDF.js viewer is an iframe that exists only on the CRM *record* page, but `crm-search` navigates to the UCPath Entry Sheet first, destroying it — so every run logged "viewer did not load within 30000ms" and saved 0 files. Now the viewer hash is captured before leaving the record page. Also: folder names title-cased (`Alnasser, Ali Anwar EID`, not `ALNASSER, ALI ANWAR EID`), documents named by identity (`Signed Offer Letter.pdf`, `EE Data Gathering Form.pdf`), and the folder packed into a sibling `.zip`. |
| `d39991d0` | **Roster downloads were unreadable.** Excel Online writes `<colorFilter>` into `xl/tables/*.xml`; ExcelJS throws on it, aborting the whole workbook read — so a good download landed on disk unusable by `roster-loader.ts`. Now stripped at download time. |
| `78e3dfd6` | **Compensation Rate silently empty** — `safeFill` reported success on a grid node the PeopleSoft round-trip had replaced. UCPath then kept Save and Submit greyed out and the run died later with a misleading "tab walk incomplete". New `fillVerified` reads the value back. Also `isUcpathRejectedSsn`/`ssnForUcpathEntry` for the 900-999 range. |
| `5f6a508b` | Dry run now walks the **whole** workflow, withholding only the two form submissions (fills the I-9 profile then abandons it; fills all four Smart HR tabs then asserts Save and Submit is *enabled* instead of clicking). |
| `773b5287` | **The actual submit blocker: a stale fiscal-year job end date.** `06/30/2026` against a `09/11/2026` start → UCPath refused with a blocking modal, *"Expected Job End Date cannot be before Job Effective Date"*, which the automation clicked past **as if it were the submit confirmation**. Now read per-hire from CRM's "Expected Job End Date (if applicable)"; the constant is only a fallback (rolled to `06/30/2027`); a guard refuses an end date before the start; and dialog text is read so a refusal throws. |
| `ec126e19` | **Duplicate-I-9 risk.** The no-SSN path skipped the I-9 search entirely, so every re-run would file another profile. Now searches by name when there is no SSN. Caught before it did damage. |
| `cb4e23a3` | **Transaction number.** Was derived from SS Smart HR, which does not carry an unprocessed hire — so every *successful* hire reported `submittedWithoutTxnNumber`. Now read via the operator's path: Transactions in Progress row → Continue → "Transaction ID:". |
| `e255aa5f` | **Cross-item I-9 state leakage** (cost 5 of the 11 hires) and **CRM `N/A` placeholders** (cost 2). See below. |

Two worth understanding because they only appear on multi-item runs:

- **Stale Kendo dialogs.** The daemon reuses one I-9 browser for every queued person and the
  app never fully tears its modals down — after a few items the page carried 15 hidden windows
  whose overlays intercept pointer events, so the next item's "Search Options" click was
  blocked and every remaining item on that worker died with an opaque timeout.
  `closeAllKendoWindows` cannot fix it (it clicks close buttons hidden windows don't expose).
  New `resetI9Page` navigates the page once per item.
- **CRM "N/A".** Operators type `N/A` to mean empty; it was written verbatim into the I-9
  Employee Profile, and Save & Continue then produced no confirmation. `normalizeCrmPlaceholder`
  maps the placeholder set to `""` for every extracted field while preserving real names that
  merely contain one as a substring ("Anna", "Nana").

Also fixed: **SSO credential fill** could put the password into the username box —
`.or()` + `.first()` resolves in DOM order, not chain order, and none of its username anchors
matched the live form. Now uses live-mapped anchors (`#ssousername` / `#ssopassword`) with a
distinctness assertion and a read-back. (Operator spotted this one.)

---

## 5. Known open issues

1. **`buildHireSearchName` is unverified.** It builds `"Last,First"` for the SS Smart HR Name
   box. Live searches for `ALNASSER,ALI`, `ALNASSER`, `Ali Alnasser`, `ALI ANWAR` and even a
   known-present row (`Elliot Hom`) all returned **0 rows**, so neither format is proven. I
   changed it to `"First Last"` mid-session and **reverted it** rather than ship a guessed
   format. It only feeds the fail-open duplicate-hire probe, so a wrong key biases toward
   submitting (never toward a false skip) — but it should be mapped properly.
2. **`readSubmittedHireReceipt` (SS Smart HR) is now a fallback only.** It cannot see an
   unprocessed hire. Left in place for the EID-bearing case.
3. **Diagnostics still in the tree**, intentionally: `[Submit]` control identification and
   action-bar enumeration in `clickSaveAndSubmit`; opt-in per-stage screenshots via
   `HR_ONBOARDING_CAPTURE_STEPS=1` (writes `.screenshots/onboarding-process/NN-*.png`). Remove
   if noisy.
4. **Duo WebAuthn signCount wedge.** Repeatedly `pkill`-ing daemons mid-ceremony desynced the
   counter and caused three consecutive CRM auth failures. Fix is the documented one-liner in
   `docs/engineering/hands-off-duo-webauthn.md` §6. **Always stop daemons with
   `npx tsx --env-file=.env src/cli.ts daemon-stop onboarding`, never `pkill`.**
5. **`expectedJobEndDate` is blank in CRM for many rows** — those fall back to the
   `06/30/2027` default, which is correct for FY26-27 but will need rolling next July
   (`ANNUAL_DATES_END`, or the Settings page).

---

## 6. How to run it

```bash
# Dashboard (daemons inherit its env; needed for the enqueue API)
npx tsx --env-file=.env src/cli.ts dashboard

# Operator token
TOKEN=$(curl -s http://127.0.0.1:3838/api/operator/session \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')

# Enqueue (dryRun optional; parallelWorkers optional)
curl -s -X POST http://127.0.0.1:3838/api/enqueue \
  -H 'Content-Type: application/json' -H "x-hr-auto-operator-token: $TOKEN" \
  -d '{"workflow":"onboarding","parallelWorkers":3,
       "inputs":[{"email":"someone@example.com"}]}'

# Roster refresh (auto-sanitises the workbook)
curl -s -X POST http://127.0.0.1:3838/api/sharepoint-download/run \
  -H 'Content-Type: application/json' -H "x-hr-auto-operator-token: $TOKEN" \
  -d '{"id":"onboarding"}'

# ALWAYS stop daemons gracefully — never pkill (see §5.4)
npx tsx --env-file=.env src/cli.ts daemon-stop onboarding
```

**Picking rows from the roster:** the "to do" rows are those whose **`Entered In UCPath`** cell
has fill `FFFFFF00` (yellow). Read the fill with ExcelJS rather than eyeballing a screenshot —
that is how the 11 were selected on 2026-08-20 and it matched the operator's highlighting exactly.

**Parallelism:** 3 workers was fine *after* the `resetI9Page` fix. Each worker runs 3 browsers
and 3 Duos, so 3 workers ≈ 9 Chromium processes.

**Documents** land at `data/onboarding/<YYYY-MM-DD>/<Last, First Middle EID>/` (plain folder per hire inside the day's folder — no zip since the 2026-08-20 afternoon; existing archives were converted).

---

## 7. Verification checklist for the next session

1. `npm run test` (expect ~4679 passing), `npm run test:architecture` (31/31), `npm run lint`,
   `npm run typecheck:all`. All were green at `e255aa5f`.
2. Confirm the 8 filed transactions above still show **Pending** in UCPath and that none is
   duplicated.
3. Confirm **no** transaction exists for Emily Robles or Hao Sun before re-running them (§3a).
4. Reconcile the spreadsheet: 8 rows get their T-number + `Requested`; 5 rows (3 false matches,
   2 rehires, plus Bela Das from the 18th) remain open.

**Rebuild accounting:** every `src/`/`tests/` change this session is recorded in
`config/rebuild/legacy-change-accounting.json` and the preservation hashes are refreshed.
If you touch `src/` or `tests/`, commit first and then add the record, or the guards go red —
that alarm is by design.

---

## 8. Session 2 (2026-08-20, afternoon) — outcome

All four numbered items of the morning handoff are done. Commits: `5c58bb9a` (fix), `9de1fc27` (accounting/preservation refresh). Gates green (`test`, `test:architecture` 31/31, `lint`, `typecheck:all`).

### 8.1 Root cause of the Emily Robles / Hao Sun "unknown outcome"
Not a flaky submit. PeopleSoft rendered its own Search/Match review page — **"Person Match Found"** ("Possible Person Matches" grid + *Not a Match - Continue with Hire* / *Save for Later* / *Cancel*) — which the outcome poll never watched, so the click timed out blind and nothing was persisted (Transactions in Progress stayed empty). Evidence: `.tracker/screenshots/onboarding-*-error-transaction-ucpath-17872471{49489,88470}.png`.

Fix (`5c58bb9a`): `clickSaveAndSubmit` polls three signals (error banner → Person Match heading → confirmation OK), reads the grid by header (`readPersonMatchCandidates`), and continues ONLY when every candidate is excluded by a hard identifier (DOB month/day or SSN last-4 known on both sides and different — never by name) or by an operator-reviewed EID; otherwise fails loud listing the candidates. New operator channel **`prefilledData.notMatchEids`** (comma-separated EIDs the operator confirmed are NOT this hire) — also lets the person-search identity gate proceed as a new hire when every Search/Match hit is a reviewed EID (dismissing the review card alone only stamps the row; the DOB-keyed fuzzy match recurs on every re-run). See `src/workflows/onboarding/CLAUDE.md` (2026-08-20 section) + `src/systems/ucpath/LESSONS.md` (2026-08-20).

Candidates reviewed live before vouching (all different people): Emily Robles ↔ 10773675 (SSN ***9035 ≠ ***4267, DOB 10/8 ≠ 8/26); Hao Sun ↔ 10 same-surname rows — the only exact-name one, 10839930, is a Berkeley Simons Institute visiting scholar (DOB 11/24 ≠ 8/24); the two with no comparable identifier, 10416504 Haotian Sun (employed 2017–18) and 10743545 Haowen Sun (UCLA Physics volunteer 2024), were passed as `notMatchEids`.

### 8.2 Filed (all `Pending`, all verified in Transactions in Progress — 1-9 of 9, one row per person, no duplicates)

| Legal Name | Transaction # | I-9 Profile | Note |
|---|---|---|---|
| Emily Robles | `T002216676` | `2209330` (reused) | Person Match: 1 namesake, auto-excluded |
| Hao Sun | `T002216675` | `2209337` (reused via NAME search — verified) | Person Match: 10 candidates |
| Mia Perez | `T002216682` | `2209405` | gate: 10871985 reviewed; Person Match: 3 namesakes auto-excluded |
| Juliana Romano | `T002216681` | `2209402` | gate: 10884140 reviewed; Person Match: Romano-Silverstein auto-excluded |
| Maria Renee Santos | `T002216685` | `2209408` | gate: 10769454 reviewed; first run died at I-9 "no confirmation after Save & Continue" — the profile HAD been created; the retry's SSN search found 2209408 (no duplicate) |

Earlier 08-20 four (Salazar/Saenz/Zhang/Soria) still `Requested` in TIP. **The 08-18 four are now `Hired/Added` with EIDs** (Smart HR Transaction Status, HR_TBH_STATUS): Alnasser 10895294, Campos 10895319, Corona 10895206, Flores Soriano 10895232. Screenshots: `.screenshots/onboarding-verify-2026-08-20/`.

### 8.3 Spreadsheet (live Excel Online, sheet "Sept 11")
Live columns are **R** = Entered In UCPath, **S** = Transaction #, **T** = UCPath ID, **AB** = I-9 (one column right of the ExcelJS header mapping of the local download — verify live before writing). Written + read back: rows 42 Perez, 44 Robles, 46 Romano, 49 Santos, 51 Sun → `JZ 8/20/2026` / T# / `Requested` / I-9; rows 5/6/7/9 (08-18 batch) UCPath ID `Requested` → the EIDs above. Rows 47/48/50/60 were already reconciled. Left untouched: 8 Bela Das, 45 Carlos Rocha, 53 Marcus Williams (rehires, §3c). The yellow "to do" fills were NOT cleared (formatting; operator's call).

### 8.4 Still open
1. §5.1 `buildHireSearchName` — still unverified (untouched this session).
2. **Rehires** (Rocha 10864605, Williams 10841361, Bela Das 10884748) — no automated rehire path; not filed.
3. I-9 `createI9Employee` can persist the profile yet report "No confirmation dialog found after Save & Continue" (Maria Santos) — the search-first guard makes the retry safe, but the confirmation read is too strict; worth a look.
4. **SharePoint/ADFS login wedges the renderer under a standalone headless/non-default launch** (screenshot + CDP hang at the ADFS Sign In after "Duo WebAuthn armed"); the kernel-identical launch (`launchBrowser({ acceptDownloads: true })`, headed, no viewport/args) works. Scratch scripts in `generated/.scratch/` (gitignored).
5. `duo-autopilot` extension path (`npm run sel:browser`) failed Duo for UCPath twice (`passkey → auth_fail`); the runtime CDP-WebAuthn path (`loginToUCPath` in a tsx script) is what worked for verification.

### 8.5 Session 2, second pass — "fix the remaining" (commits `dd2a6ec5` … `e171c9da`)
- **Documents are per-day plain folders now** (`data/onboarding/<YYYY-MM-DD>/<Last, First Middle EID>/`, no zip; `dd2a6ec5`). Existing 08-18/08-20 archives were unzipped into that layout (16/16 verified, zips removed; the two "Na" duplicates sit in `2026-08-20/_duplicate-na-placeholder/`). `crm-doc-download` (CLI-only) still packs its own run archive — untouched.
- **§5.1 CLOSED — `buildHireSearchName` is `First Last`** (live-verified; every `Last,First` variant returned nothing, so the duplicate-hire probe had fallen open since 2026-07-01, and the SS Smart HR list DOES carry a Requested/Pending hire). A single match auto-opens the Transaction Details page; `readSsSmartHrSearchOutcome` handles it. `generated/.scratch/probe-live.ts` verified: Hao Sun → found T002216675 Pending; Ali Alnasser → T002214646 Approved (detail); Emily Robles → T002216676 Pending (detail); wrong effdt → not found; unknown → none; receipts read back for both (`1479620d`).
- **I-9 late confirmation** (Maria case): `createI9Employee` polls 15 s for validation error / duplicate dialog / OK / saved-profile route (`1479620d`, `e2ee1dd4`).
- **Review card: "Not this person — run as new hire"** (onboarding only) → `POST /api/eid-approval/not-this-person` → re-enqueue with accumulated `prefilledData.notMatchEids` + stamp dismissed. Verified headless on a seeded row (`.screenshots/eid-approval-onboarding/02-not-this-person-button.png`). Route added to the Hono manifest (`60523c2a`).
- **Duo-Autopilot selector browser**: `npm run sel:browser` now wipes `.auth/<session>-profile` every launch (stale signCount was the `passkey → auth_fail`); hands-off UCPath login re-verified.
- **Rehires (Rocha 10864605, Williams 10841361, Bela Das 10884748) — still NOT filed.** UCPath offers `UC_REHIRE` (UC Rehire – Staff Only), `UC_REHIRE_REI` (Reinstatement) + academic variants in the Smart HR template lookup. Building the path means mapping that template live (Empl ID / Empl Record selection, field layout) under a dry run — needs the operator's procedure (which template for student rehires, what differs from UC_FULL_HIRE). Not guessed.
- SharePoint/ADFS headless wedge: documented in §8.4 (kernel-style headed launch works); left as-is.
