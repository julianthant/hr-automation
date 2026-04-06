# EID Lookup Manual Research Notes

Manual playwright-cli lookups to understand search patterns and edge cases.
Search page: Person Organizational Summary in UCPath.

## Target List

| # | Name | Expected Term Date | Expected EID |
|---|------|-------------------|-------------|
| 1 | Mendoza, Daniela | N/A | N/A |
| 2 | Mendoza, Rocio | N/A | N/A |
| 3 | Miller, Terri | Active 06/22/2025 | 10403694 |
| 4 | Miranda, Estela Evelia | 6/30/2022 | 10407325 |
| 5 | Mondragon, Juan Carlos | Active 03/09/2026 | 10401537 |
| 6 | Manrique, Dan GeraErick | Active 06/22/2025 | N/A |
| 7 | Morfin, Heriverto | 12/1/2025 | 10367561 |
| 8 | Nguyen, Sandra Tuyet-Nhung | N/A | N/A |
| 9 | Neubarth, Anita Trevino | 12/16/2020 | 10411766 |
| 10 | Padilla, Evangelina | 9/28/2022 | 10409489 |
| 11 | Padilla, Jorge | 6/30/2022 | 10413523 |
| 12 | Hernandez, Jeanette | 9/9/2022 | 10482236 |
| 13 | Hernandez, Jesus | (blank) | (blank) |
| 14 | Hodges, Patricia M. | 4/15/2022 | 10425783 |
| 15 | Melycher, Kristine R. | 11/9/2022 | 10375001 |
| 16 | Reece, Albert Allan | 6/29/2018 | 10431049 |
| 17 | Ramos, Rosa Elisa | 6/29/2018 | 10430912 |
| 18 | Waddell, Jeffrey | 3/31/2023 | 10364422 |
| 19 | Wilson, Robert | N/A | N/A |
| 20 | Sta Teresa, Carlos Gabriel | 9/26/2020 | 10416089 |
| 21 | Santoyo, Christina | 11/7/2019 | 10428115 |
| 22 | Salazar, Michelle | N/A | N/A |
| 23 | Sandoval, Aaron | N/A | N/A |
| 24 | Solis, Kelli | 2/17/2023 | 10406012 |
| 25 | Stoelo, Sanchez Maria S | N/A | N/A |
| 26 | Sholan, Andrea E | 9/27/2020 | 10413372 |
| 27 | Stacy, Joseph | N/A | N/A |
| 28 | Skyo, Rachel | N/A | N/A |
| 29 | Tellez, Elizabeth | 3/11/2022 | 10417729 |
| 30 | Todd, Rauk | N/A | N/A |
| 31 | Thorne, Herman F | 3/31/2021 | 10411375 |
| 32 | Thorp, Nichole | 4/13/2019 | 10429198 |
| 33 | Tinderholt, Jeffrey | 2/6/2022 | 10405733 |

## Lookup Results & Observations

### #31 — Thorne, Herman F (Expected: EID 10411375, Term 3/31/2021)
- **Search "Thorne, Herman F"**: "No matching values were found" (PeopleSoft doesn't match with middle initial in Name field)
- **Search "Thorne, Herman"**: FOUND — **single result, PeopleSoft skipped the results grid and went directly to the detail page**
- **Result**: EID 10411375, Termination Date 03/31/2021, SDCMP, HOUSING/DINING/HOSPITALITY, MAINT MECH, Staff: Career
- **KEY FINDING**: When PeopleSoft search returns exactly 1 result, it bypasses the results grid table (`tdgbrPTS_CFG_CL_STD_RSL$0`) and navigates directly to the detail page. The current automation only looks for the grid → completely misses single-result matches.
- **How to detect**: After clicking Search, check for the presence of `PER_INST_EMP_VW_LAST_HIRE_DT$0` (detail page field) instead of/in addition to the results grid table.

### #32 — Thorp, Nichole (Expected: EID 10429198, Term 4/13/2019)
- **Search "Thorp, Nichole"**: "No matching values were found"
- **Search by EID 10429198**: FOUND — name in UCPath is **"Nicole Thorp"** (no 'h')
- **Result**: EID 10429198, Termination Date 04/13/2019, SDCMP, CONV (conversion record), 2 employment records
- **KEY FINDING**: Name spelling mismatch between user's list and UCPath. "Nichole" vs "Nicole". PeopleSoft Name field uses "begins with" matching but still requires exact spelling of the prefix.
- **Implication**: Automation should try partial/shorter first name prefixes as a fallback strategy.

### #33 — Tinderholt, Jeffrey (Expected: EID 10405733, Term 2/6/2022)
- **Search "Tinderholt, Jeffrey"**: FOUND — single result, direct to detail page (same as Thorne)
- **Result**: EID 10405733, Termination Date 02/06/2022, SDCMP, HOUSING/DINING/HOSPITALITY, COOK SR, Staff: Career
- **Confirms**: Single-result → direct detail page pattern.

### #3 — Miller, Terri (Expected: EID 10403694, Active 06/22/2025)
- **Search "Miller, Terri"**: FOUND — **3 results in grid** (multiple results = grid is shown)
- **Results**:
  - 10403694 rec 0: Inactive, SDCMP, BLANK AST 3
  - 10403694 rec 1: **Active**, SDCMP, EVENTS SPEC 2
  - 10479950 rec 0: Inactive, SDCMP, STDT ACAD ADVISOR 3
- **KEY FINDING**: Same EID can have multiple employment records (rec 0, rec 1). One can be Active while another is Inactive. Need to identify the correct record (typically the Active one, or the HDH one).

### #4 — Miranda, Estela Evelia (Expected: EID 10407325, Term 6/30/2022)
- **Search "Miranda, Estela"** (dropped middle "Evelia"): FOUND — single result, direct to detail
- **Result**: EID 10407325, Termination Date 06/29/2022, SDCMP, HOUSING/DINING/HOSPITALITY, CUSTODIAN SR
- **Note**: User's list had "6/30/2022" but UCPath shows "06/29/2022" (off by 1 day — term date vs effective date of the Inactive assignment row which is 06/30)
- **Confirms**: Dropping middle name works well for search.

### #5 — Mondragon, Juan Carlos (Expected: EID 10401537, Active 03/09/2026)
- **Search "Mondragon, Juan"**: FOUND — **2 results in grid**
- **Results**:
  - 10401537 rec 1: **Active, LACMP** (not SDCMP!), FOOD SVC WORKER
  - 10401537 rec 0: Inactive, SDCMP, STDT 2
- **KEY FINDING**: Employee transferred between business units. Active record is under LACMP, not SDCMP. The automation currently filters for SDCMP only → would show this as "Inactive SDCMP" and miss the active LACMP record.
- **Implication**: May need to check ALL business units, not just SDCMP, or at least flag when SDCMP records exist but are all Inactive.

### #7 — Morfin, Heriverto (Expected: EID 10367561, Term 12/1/2025)
- **Search "Morfin, Heriverto"**: "No matching values were found"
- **Search by EID 10367561**: FOUND — name in UCPath is **"Eddie Morfin"** (completely different first name!)
- **Result**: EID 10367561, Active, SDCMP, ENROLLMENT MANAGEMENT, ADMISSIONS RECRMT SPEC 4 SV
- **KEY FINDING**: Name in user's list ("Heriverto") is completely different from UCPath legal name ("Eddie"). This is likely a preferred name vs legal name mismatch. Cannot be found by name search alone.
- **Note**: User listed term date "12/1/2025" but that's the EFFDT (effective date of assignment), not termination date. Employee is Active.

### #12 — Hernandez, Jeanette (Expected: EID 10482236, Term 9/9/2022)
- **Search "Hernandez, Jeanette"**: FOUND — **4 results in grid**
- **Results**:
  - 10018996 rec 0: Inactive, MECMP, STDT 4
  - 10018996 rec 1: Inactive, MECMP, STDT 3
  - 10313598: Inactive, IRCMP, STDT 4
  - **10482236**: Inactive, **SDCMP**, FOOD SVC WORKER ← correct match
- **KEY FINDING**: Multiple different people with the same name across different business units. The SDCMP filter correctly narrows to the right person.

## Key Patterns Discovered

### 1. Single-Result Direct-to-Detail (CRITICAL BUG)
When PeopleSoft search returns exactly 1 match, it skips the results grid table and goes directly to the detail page. The detail page shows:
- Person ID (EID) in `generic` element
- Full name
- Employment Instances with Last Hire Date, Termination Date, Payroll Status
- Assignments table with BU, Position, Dept, Job Code, etc.

**Detection**: After clicking Search, check for detail page indicators (e.g., "Employment Instances", person ID field) not just the grid table.

### 2. Form State Corruption After "No Matching Values"
The "No matching values were found" message corrupts the PeopleSoft form state. After this message:
- Clear button may not properly reset the form
- Subsequent searches on the same page may fail silently
- **Fix**: Always re-navigate to Person Org Summary between search strategies.

### 3. Name Mismatches
Several types of name mismatches encountered:
- **Spelling variants**: "Nichole" vs "Nicole" (one letter difference)
- **Legal vs preferred name**: "Heriverto" vs "Eddie" (completely different)
- **Middle initial interference**: "Herman F" fails, "Herman" succeeds
- **Implication**: Need shorter prefix fallback searches and accept that some names will never be found by name alone.

### 4. Business Unit Transfers
Employees can have records across multiple business units (SDCMP, LACMP, MECMP, IRCMP). The active record may be under a different BU than SDCMP. Current SDCMP-only filter may miss active records.

### 5. Multiple Employment Records
Same EID can have multiple employment records (rec 0, rec 1, etc.) with different statuses. The automation should identify the most relevant record (Active > Inactive, HDH department preferred).

### 6. Multiple People Same Name
Common names like "Hernandez, Jeanette" return multiple different people. SDCMP filter and department keywords (HDH) help narrow to the correct person.

## Complete Results (All 33 Names)

| # | Name | EID | Term Date | Dept | Job Title | BU | Notes |
|---|------|-----|-----------|------|-----------|-----|-------|
| 1 | Mendoza, Daniela | 10402221 | 12/08/2022 | TEACHING & LEARNING COMMONS (000441) | STDT 3 | SDCMP | Student, not HDH |
| 2 | Mendoza, Rocio | N/A | N/A | — | — | — | Not in UCPath |
| 3 | Miller, Terri | 10403694 | rec0: 01/17/2023 (Transfer) | HOUSING/DINING/HOSPITALITY (000412) | BLANK AST 3 → EVENTS SPEC 2 | SDCMP | Rec1 Active at RADY SCHOOL OF MANAGEMENT |
| 4 | Miranda, Estela Evelia | 10407325 | 06/29/2022 (Retirement) | HOUSING/DINING/HOSPITALITY (000412) | CUSTODIAN SR | SDCMP | Single result → detail |
| 5 | Mondragon, Juan Carlos | 10401537 | rec0: 09/19/2021 (Auto Term) | VCSA CAMPUS RECREATION (000228) | STDT 2 | SDCMP | Rec1 Active under LACMP, On Campus Housing (317000) |
| 6 | Manrique, Dan GeraErick | 10420567 | Active | HOUSING/DINING/HOSPITALITY (000412) | MAINT MECH | SDCMP | Single result → detail |
| 7 | Morfin, Heriverto | 10367561 | Active | ENROLLMENT MANAGEMENT (000130) | ADMISSIONS RECRMT SPEC 4 SV | SDCMP | UCPath name is "Eddie Morfin" — name mismatch |
| 8 | Nguyen, Sandra Tuyet-Nhung | 10535568 | 09/18/2022 (Auto Term) | School of Public Health (000383) | STDT 4 | SDCMP | Student, not HDH |
| 9 | Neubarth, Anita Trevino | 10411766 | 12/15/2020 (Retirement) | HOUSING/DINING/HOSPITALITY (000412) | MARKETING SPEC 2 | SDCMP | Single result → detail |
| 10 | Padilla, Evangelina | 10409489 | 09/27/2022 (Medical Sep) | HOUSING/DINING/HOSPITALITY (000412) | CUSTODIAN SR | SDCMP | Single result → detail |
| 11 | Padilla, Jorge | 10413523 | 06/29/2022 (Retirement) | HOUSING/DINING/HOSPITALITY (000412) | CUSTODIAN SR | SDCMP | Single result → detail |
| 12 | Hernandez, Jeanette | 10482236 | 09/08/2022 (Resign) | HOUSING/DINING/HOSPITALITY (000412) | FOOD SVC WORKER | SDCMP | 4 results, 1 SDCMP |
| 13 | Hernandez, Jesus | 10403226 | 03/29/2021 (Auto Term) | CELLULAR & MOLECULAR MEDICINE (000326) | STDT 4 | SDCMP | Student, not HDH. 24 results total |
| 14 | Hodges, Patricia M. | 10425783 | 04/14/2022 (Retirement) | HOUSING/DINING/HOSPITALITY (000412) | FOOD SVC WORKER PRN | SDCMP | Single result → detail |
| 15 | Melycher, Kristine R. | 10375001 | 11/08/2022 (Retirement) | HOUSING/DINING/HOSPITALITY (000412) | FOOD SVC SUPV | SDCMP | Single result → detail |
| 16 | Reece, Albert Allan | 10431049 | 06/28/2018 (Union Dues) | UNIVERSITY UC San Diego | CONV | SDCMP | Conversion shell record |
| 17 | Ramos, Rosa Elisa | 10430912 | 06/28/2018 (Union Dues) | UNIVERSITY UC San Diego | CONV | SDCMP | Conversion shell record |
| 18 | Waddell, Jeffrey | 10364422 | 03/31/2023 (Retirement) | HOUSING/DINING/HOSPITALITY (000412) | FAC MGR 1 | SDCMP | Single result → detail |
| 19 | Wilson, Robert | N/A | N/A | — | — | — | 18 results, no SDCMP |
| 20 | Sta Teresa, Carlos Gabriel | 10416089 | 09/26/2020 (Resign) | HOUSING/DINING/HOSPITALITY (000412) | STDT 3 | SDCMP | Student, multi-word last name |
| 21 | Santoyo, Christina | 10428115 | 11/07/2019 (Union Dues) | UNIVERSITY UC San Diego | CONV | SDCMP | Conversion shell record |
| 22 | Salazar, Michelle | 10402198 | Inactive | Various (student roles) | STDT 3, STDT ACTIVITIES, ELECTED OFCR | SDCMP | 7 student records |
| 23 | Sandoval, Aaron | N/A | N/A | — | — | — | 2 results, no SDCMP (LACMP, RVCMP) |
| 24 | Solis, Kelli | 10406012 | 02/17/2023 (Medical Sep) | HOUSING/DINING/HOSPITALITY (000412) | FOOD SVC WORKER LD | SDCMP | Single result → detail |
| 25 | Stoelo, Sanchez Maria S | N/A | N/A | — | — | — | Not in UCPath |
| 26 | Sholan, Andrea E | 10413372 | 09/27/2020 (Resign) | HOUSING/DINING/HOSPITALITY (000412) | FOOD SVC WORKER LD | SDCMP | Single result → detail |
| 27 | Stacy, Joseph | N/A | N/A | — | — | — | Not in UCPath |
| 28 | Skyo, Rachel | N/A | N/A | — | — | — | Not in UCPath |
| 29 | Tellez, Elizabeth | 10417729 | 03/11/2022 (Resign) | HOUSING/DINING/HOSPITALITY (000412) | BLANK AST 3 | SDCMP | Single result → detail |
| 30 | Todd, Rauk | N/A | N/A | — | — | — | Not in UCPath |
| 31 | Thorne, Herman F | 10411375 | 03/31/2021 (Retirement) | HOUSING/DINING/HOSPITALITY (000412) | MAINT MECH | SDCMP | Single result → detail |
| 32 | Thorp, Nichole | 10429198 | 04/13/2019 (Union Dues) | UNIVERSITY UC San Diego | CONV | SDCMP | Name is "Nicole" not "Nichole". 2 CONV records |
| 33 | Tinderholt, Jeffrey | 10405733 | 02/06/2022 (Dismissal) | HOUSING/DINING/HOSPITALITY (000412) | COOK SR | SDCMP | Single result → detail |

## Department Names Observed

### Accepted Departments (employees in user's list with known EIDs)
- **HOUSING/DINING/HOSPITALITY** (Dept ID: 000412) — most common, SDCMP
- **On Campus Housing** (Dept ID: 317000) — under LACMP business unit
- **RADY SCHOOL OF MANAGEMENT** (Dept ID: 000195) — Miller transferred here (rec1 active)
- **ENROLLMENT MANAGEMENT** (Dept ID: 000130) — Morfin "Eddie" (but name mismatch, may not be intentional match)
- **UNIVERSITY UC San Diego** — conversion shell records (CONV), no real dept
- **VCSA CAMPUS RECREATION** (Dept ID: 000228) — Mondragon student rec
- **TEACHING & LEARNING COMMONS** (Dept ID: 000441) — Mendoza Daniela student
- **School of Public Health** (Dept ID: 000383) — Nguyen Sandra student
- **CELLULAR & MOLECULAR MEDICINE** (Dept ID: 000326) — Hernandez Jesus student

### Termination Reason Types Observed
- Retirement
- Resign - No Reason Given
- Resign - Personal Reasons
- Medical Separation
- Dismissal - Attendance
- Union Dues Retention (CONV records)
- Job Record End Date - Auto Term (student records)
- Transfer - Intra Location (between departments)

### Business Units Observed
- **SDCMP** — UC San Diego Main Campus (primary filter)
- **LACMP** — LA Campus (Mondragon active record)
- **MECMP**, **IRCMP**, **RVCMP**, **SCCMP**, **SBCMP** — other UC campuses
- **LAMED**, **IRMED**, **SDMED**, **DVMED** — medical centers
- **UCANR**, **DVCMP** — other UC entities

