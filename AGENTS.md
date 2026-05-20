<claude-mem-context>
# Memory Context

# [hr-automation] recent context, 2026-05-19 11:22pm PDT

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (19,075t read) | 964,177t work | 98% savings

### May 18, 2026
S252 Plan 6 — LogEntry boundary validator for hr-automation: add isLogEntry type guard and wire into both log-entry JSONL read functions (May 18 at 10:29 PM)
S253 Plan 7 — Lifecycle-tied screenshot cleanup: architecture reviewed and implementation queued (May 18 at 10:33 PM)
S255 Plan 7 — Lifecycle-tied screenshot cleanup for hr-automation: close TODO(2026-05-11) in server.ts with 30-day terminal_at-based sweep (May 18 at 10:34 PM)
S254 Re-run /review-code with multiple subagents to verify all planned fixes were completed and check for new issues in hr-automation codebase (May 18 at 10:40 PM)
S256 Fan out parallel subagents to complete all type-soundness plans and push to origin (May 18 at 10:41 PM)
S257 Fix "skipping invalid line" errors in .tracker/sessions-2026-05-18.jsonl (lines 685–724) (May 18 at 10:58 PM)
S258 Fix two bugs: (1) JSONL warning flood from sessions file being treated as a workflow, (2) OCR auto-retry with different API key on provider errors like Gemini 503 (May 18 at 10:59 PM)
### May 19, 2026
S259 Push all local commits and staged changes to git origin/master (May 19 at 2:38 AM)
S260 Push all changes to git — committed and pushed oath-signature + log-panel updates to origin/master (May 19 at 11:27 AM)
2729 11:37a 🔴 OCR single-file rows now correctly show "Single delegation" label
2728 " 🔴 Oath signature: fixed failing ensurePersonProfilesSearchForm step and ALL-CAPS name display
2730 " 🟣 Unit tests added for OCR single vs batch delegation label logic
2731 " 🔵 Oath signature fixes not yet implemented — two test failures reveal root causes
2732 " 🔴 ensurePersonProfilesSearchForm implemented and exported in enter.ts
2733 " ✅ All 20 tests pass after OCR label fix; CLAUDE.md updated with file-count lesson
2734 11:38a 🔴 OCR oath form deriveInput now title-cases printedName via displayPersonName
2735 " 🔴 ensurePersonProfilesSearchForm test mock updated to include waitFor method
2736 " 🔴 All oath-signature unit tests passing after both fixes applied
2737 " ✅ Full test suite passes after OCR label fix: 1632/1633 tests pass
2738 " 🔵 Oath-signature daemon batch failure: UCPath Person Profiles stale detail page scenario documented
2739 11:39a 🔵 Typecheck and lint pass after oath-signature fixes; one pre-existing lint warning unrelated to changes
2740 " ✅ Oath-signature fix complete: 6 files changed, ready to commit
2741 7:17p 🔵 DaemonBatchRow footer lacks retry/delete/timer controls that normal EntryItem rows have
2742 7:18p 🔵 DaemonBatchRow prop interface discovered via QueuePanel render site
2743 " 🔵 DeleteButton and RetryButton API constraints for DaemonBatchRow footer integration
2744 7:19p 🔵 SSR-confirmed: EntryItem "Needs review" footer renders no action buttons — only time and run number
2745 7:27p 🟣 BatchFooterActions component added to queue panel
2746 7:28p 🔄 DaemonBatchRow refactored to use BatchFooterActions
2747 " 🟣 passive-delegation GroupRowBase rows now show BatchFooterActions
2748 " 🟣 retry-bulk API now accepts items array with runId and resets OCR dependencies on retry
2749 7:29p 🟣 retry-bulk Hono route now parses and forwards items array with runId
2750 " 🟣 OcrReviewPane blocks approval while OCR dependency retries are pending
2751 " 🟣 Unit tests added for OCR dependency reset on retry and bulk retry with runId
2752 " 🟣 UI test added for BatchFooterActions rendering retry and delete controls
2753 7:30p 🔵 All 50 tests pass after BatchFooterActions and OCR retry reset changes
2754 " 🔴 TypeScript error in retry.ts: runId missing on ids-mapped items type
2755 " 🔴 Fixed TypeScript error in retryBulk items array type annotation
2756 7:31p ✅ CLAUDE.md updated with passive-delegation batch footer lesson
2757 " ✅ OCR CLAUDE.md updated with EID lookup dependency retry semantics
2758 " ✅ tracker CLAUDE.md documents retry rule for OCR dependency children
2759 " 🔵 typecheck and dashboard build both pass after BatchFooterActions and retry fixes
2760 7:32p 🔵 Full test suite passes: 1636/1637 tests, 0 failures after all BatchFooterActions changes
2761 7:33p 🔵 Lint passes with 1 pre-existing warning; all changes ready to commit
2762 9:48p 🟣 Comprehensive Workflow Documentation Requested
2763 " 🔵 Complete Workflow Registry Inventory
2764 " 🔵 Complete Dashboard API Action Surface Catalogued
2765 9:49p 🔵 Run Entry Points: RunModal and QuickRun Registry Contents
2766 " 🔵 All Workflow defineWorkflow Configs Fully Catalogued
2767 " 🔵 Cancel/Retry/Delete Backend Implementation Details
2768 " 🔵 delegation.md Existing Content Fully Read
2769 9:51p 🟣 Comprehensive workflow/action map document planned for hr-automation
2770 9:56p 🟣 delegation.md replaced with comprehensive workflow/action map
2771 " ✅ delegation.md rewritten: 522-line partial spec → 307-line complete workflow/action map
2772 11:14p ⚖️ Workflow Architecture — Migrate to Centralized Modular Structure
2773 11:17p ✅ Delegation workflow documentation requested
S261 Delegation.md documentation + architectural analysis of delegation workflow system (May 19 at 11:17 PM)
2774 " 🔵 hr-automation active unstaged changes include delegation.md and queue panel components
2775 11:18p 🔵 Cross-workflow unification plan (2026-05-17) status: written but not started
2776 11:20p 🟣 Workflow runtime migration master plan created: 6-phase policy-driven architecture
2777 11:21p 🔵 docs/ directory is excluded by .gitignore — workflow runtime plans are untracked

Access 964k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>