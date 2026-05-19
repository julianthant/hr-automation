<claude-mem-context>
# Memory Context

# [hr-automation] recent context, 2026-05-18 4:39pm PDT

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (18,931t read) | 697,288t work | 97% savings

### May 17, 2026
S233 Full code review of oath-upload, oath-signature, emergency-contact, and OCR workflows — tracing frontend/backend logic, consistency, delegation patterns, row archetypes, logs/timeline, and codebase-wide simplification/unification (May 17 at 11:40 AM)
S234 Full cross-workflow code review of oath-upload, oath-signature, emergency-contact, OCR + codebase-wide sweep → produced 4 implementation plans + 4 handoff documents covering ~80 findings (May 17 at 11:48 AM)
S235 Plan 1 of 4 (2026-05-17 correctness bug fixes) — Task 5 verification sweep: resolve typecheck:all and lint errors, then commit (May 17 at 12:00 PM)
S236 Review and fix Plan 1 (2026-05-17 correctness bug fixes) — fan out subagent to verify execution and apply fixes (May 17 at 12:26 PM)
S237 Archetype Migration Completion — Plan 2 of 4 session start (May 17 at 1:00 PM)
S238 Memory observer: monitor hr-automation primary session completing archetype migration plan (tasks 3–5) (May 17 at 1:06 PM)
S239 Observer role for Plan 2 (Archetype Migration Completion) execution in hr-automation — record durable technical observations about what was built, fixed, and documented (May 17 at 10:17 PM)
S240 Execute hot-path performance plan (Plan 3 of 4) — all four tasks completed inline (May 17 at 10:30 PM)
S241 Plan 4 Cross-Workflow Unification — observer session recording primary session execution of Tasks 2 and 4 (May 17 at 10:49 PM)
### May 18, 2026
2468 9:32a 🔴 EID Lookup Fan-Out Rows No Longer Grouped as Batch Cards — Surface as Flat Delegation Members
2469 " 🔴 Batch View Member Rows Now Show Person Name as Title Instead of Batch Label
2470 " 🔴 EID Lookup Pending Rows Now Use Person Name as __name Instead of parentSubject Batch Label
2471 " 🟣 Oath Signature Input Schema and Fan-Out Now Pass Person's Printed Name from OCR Records
2472 9:33a 🔴 Oath Signature Pending Data — __name Now Uses Person Name, Not parentSubject Batch Label
2473 " 🔴 Dispatch Row "Oath Signature Request" — __queueSubtitle Removed from Row Data
2474 " ✅ Tests Updated — EID Lookup Fan-Out Now Expected as Flat Delegation Members, Not Batch Cards
2475 9:34a ✅ Tests Updated — __queueSubtitle Removed from Dispatch Row Assertions, New Person-Name Test Added
2476 9:54a 🟣 RunModal Multi-File Upload for Oath Signature
2477 " ⚖️ Multi-File Oath Upload is Grouped Singles, Not a New Workflow
2478 10:07a 🔵 Oath OCR form spec — EID extraction and matching logic
2479 " 🔵 Latest oath signature OCR run successfully extracted 8-digit EID starting with "10"
2480 10:08a 🔵 RunModal already supports multiple PDF uploads — gated by allowMultipleFiles config flag
2481 " 🔵 Run-modal registry — current multi-file and workflow config state
2482 10:09a 🔵 OCR runs today processed 612 and 1115 records — no per-record EID detail captured
2483 " 🔵 All 1115 OCR records in latest run have EIDs starting with "10" — no missing or wrong-prefix EIDs found
2484 " 🔵 OCR tracker stores records as JSON-encoded string, not a parsed array — sample record confirms EID extraction working
2485 10:36a 🔵 OCR Missing 8-Digit EID Numbers in Oath Signature PDFs
2486 " 🔵 OCR Oath Signature Run: One Record Missing EID (CORREA DINORA)
2487 " 🔵 EID Normalization and Validation Logic in src/domain/identity/eid.ts
2488 " 🔵 CORREA DINORA OCR Record: EID Blank, UCPath Lookup Returned "Not Found"
2489 " 🔵 Root Cause: Gemini OCR Extracts 6-Digit EIDs; Validation Requires 8-Digit ^10\d{6}$ Format
2490 10:37a 🔵 Roster Matching Fails for All Records Due to 6-Digit EIDs Not Matching Roster
2491 " 🔵 oath.ts EID Matching: 6-Digit EIDs Silently Dropped by normalizeUcpathEmployeeId at Line 164
2492 10:38a 🔵 PrepareInput Accepts Single pdfPath — Multi-PDF Upload Not Yet Supported
2493 10:39a 🔴 OCR Prompt Fixed: Gemini Now Instructed to Extract Full 8-Digit UCPath EIDs
2494 10:40a 🔴 Added Diagnostic Log Warning When Gemini Extracts Invalid (Non-UCPath) EID Format
2495 " 🟣 Multi-PDF Upload Enabled for Emergency Contact Run Modal
2496 " 🟣 Multi-PDF Upload Enabled for OCR Run Modal
2497 " 🟣 Multi-PDF Upload Enabled for oath-upload Run Modal — All Four Modals Now Support Multi-File
2498 " 🔴 RunModal Multi-File Batch Subject Generalized — No Longer Hardcoded to oath-signature
2499 " 🟣 buildBatchSubject Helper Added to RunModal for Workflow-Aware Batch Labels
2500 10:41a ✅ TypeCheck Passes Clean After All OCR EID and Multi-PDF Upload Changes
S242 Fix OCR missing 8-digit EID extraction from oath signature PDFs + add multi-PDF upload to all run modals (May 18 at 10:42 AM)
2501 10:46a 🔵 RunModal multi-PDF upload: logic exists but gated by allowMultipleFiles flag
2502 10:47a 🟣 RunModal: added handleFilesAdd for appending PDFs to existing selection
2503 " 🟣 FileRows: added "Add PDFs" button for incrementally appending files after initial selection
2504 10:53a ✅ RunModal "Add PDFs" label upgraded to labeled button style
2505 " 🟣 RunModal multi-file mode shows Dropzone and FileRows simultaneously
2506 10:57a 🔄 FileRows component rewritten to render one row per file
2507 " 🟣 Dropzone gains compact mode that collapses to a single row when files are already attached
2508 11:01a 🔵 OCR Oath Form — EID Extraction Already Prompted but Failing in Practice
2509 11:02a 🟣 TDD Red Phase: Failing Test Added to Drive Oath OCR Prompt Improvement for Top-Margin EIDs
2510 " 🔴 Oath OCR EID extraction improved to scan full page including top margin
2511 2:43p 🔵 Daemon Cancellation Bug: Pending EID Lookup Rows Lose Their Title
2512 2:44p 🔵 EID Lookup Row Title Bug: Daemon Stop May Trigger Sweeps That Overwrite Pending Row Names
2513 " 🔵 Large WIP Changeset: OCR Delegation Row Naming, Queue Surfaces, Sweeps, and Multi-File Oath Upload
2514 2:45p 🔴 Daemon shutdown-cancel rows now preserve title and row archetype
2515 3:03p ✅ src/core/CLAUDE.md lesson: daemon shutdown rows must preserve display metadata
2516 3:17p 🔴 Full test suite and lint pass after daemon shutdown-cancel fix
2517 " 🔴 Full 1595-test suite passes after daemon shutdown-cancel row fix

Access 697k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>