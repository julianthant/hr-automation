<claude-mem-context>
# Memory Context

# [hr-automation] recent context, 2026-05-19 11:36am PDT

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (18,571t read) | 694,786t work | 97% savings

### May 18, 2026
S250 Plan 4 — add isTrackerStatus runtime validation to eventRows and allLatestRows SELECTs in queries.ts (May 18 at 9:26 PM)
S251 Plan 3 — Residual formKind guards: three type-soundness tightenings in OCR form handling code (May 18 at 9:31 PM)
S252 Plan 6 — LogEntry boundary validator for hr-automation: add isLogEntry type guard and wire into both log-entry JSONL read functions (May 18 at 10:29 PM)
S253 Plan 7 — Lifecycle-tied screenshot cleanup: architecture reviewed and implementation queued (May 18 at 10:33 PM)
S255 Plan 7 — Lifecycle-tied screenshot cleanup for hr-automation: close TODO(2026-05-11) in server.ts with 30-day terminal_at-based sweep (May 18 at 10:34 PM)
2675 10:38p 🟣 DB Schema v9 — terminal_at Column for Lifecycle-Tied Screenshot Cleanup
2676 " 🟣 Screenshot Sweep — Lifecycle-Tied Cleanup for Stale Run Evidence
2674 " 🟣 Test suite created for sweepStaleRunScreenshots with 7 scenarios
2680 10:39p 🔵 Code Review Verification — Plans 1–4, 6 CLOSED; Plan 7 Uncommitted and Needs Test
2679 " 🔵 Test failure: seedRun with different trackerDates creates two runs rows, not an upsert
2681 " 🔴 Test fixed: seedRun timestamps pinned to same calendar date to force upsert on single PK row
2682 " 🔵 readDryRun Narrowing — String-Only Check Is Safe Given TrackerEntry.data Type
S254 Re-run /review-code with multiple subagents to verify all planned fixes were completed and check for new issues in hr-automation codebase (May 18 at 10:40 PM)
2683 10:40p 🔴 readDryRun Regression — Boolean dryRun Values Silently Dropped After Predicate Narrowing
2684 " 🔵 Fresh Type-Soundness Sweep — Remaining SQLite Boundary Gaps and Unknown Array Patterns
S256 Fan out parallel subagents to complete all type-soundness plans and push to origin (May 18 at 10:41 PM)
2685 10:43p 🔵 Plan 7 (apply.ts + schema.ts) Already Committed — Only Plan 5 (registry.ts) Remains Uncommitted
2686 " 🔵 readDryRun Regression Confirmed False Positive — Boolean dryRun at approve.ts:91 Goes to Fan-Out Input, Not OCR Tracker Row
2687 " 🔵 Plan 7 Already Committed as feat(tracker): lifecycle-tied screenshot cleanup — Only Plan 5 + AGENTS.md Remain Uncommitted
2688 10:44p 🟣 Plan 7 Fully Complete — Screenshot Sweep Committed with 219-Line Test Suite
2689 " 🔄 Plan 5 Committed — OCR Registry Double-Cast Replaced with keyof Narrowing
2690 " 🔵 SQLite Log Level Cast Gap Confirmed — queries.ts:172 Lacks LOG_ENTRY_LEVELS Validation
2691 " ✅ Parallel Worktrees Created for SQLite Mapper Validation and Misc Cleanups
2692 " 🔵 LOG_ENTRY_LEVELS Not Exported from jsonl.ts — sqlite-mappers Fix Must Export or Duplicate
2693 10:45p 🟣 Parallel subagent fan-out requested for type-soundness completion
S257 Fix "skipping invalid line" errors in .tracker/sessions-2026-05-18.jsonl (lines 685–724) (May 18 at 10:58 PM)
S258 Fix two bugs: (1) JSONL warning flood from sessions file being treated as a workflow, (2) OCR auto-retry with different API key on provider errors like Gemini 503 (May 18 at 10:59 PM)
### May 19, 2026
2694 2:34a 🔵 Source of "skipping invalid line" warnings in sessions JSONL
2695 2:35a 🔵 parseTrackerFilename matches sessions file, leaking "sessions" as a fake workflow
2696 " 🔵 OCR error classification and per-page retry logic architecture
2697 2:36a 🔵 runSinglePageThroughPool only reports last-tried key, not full attempted-keys list
2698 " 🔴 OCR per-page retry: exhausts full pool by default and tracks all attempted keys
2699 2:39a 🔵 EID Lookup Page — Footer and Label Bugs Identified
2700 " 🔵 GroupRowBase Footer Architecture — footerSecondaryId Controls Run ID Display
2701 " 🔵 Root Cause Found — DaemonBatchRow Passes batchParentRunId as footerSecondaryId
2702 2:40a 🔴 EntryItem: Removed pickRowTitle — Cancelled Entries Now Show resolvedName
2703 " 🔄 resolveChildLabel Reordered Priority and Exported — EID Now Takes Precedence Over __subject
2704 " 🔴 DaemonBatchRow and QueuePanel — footerSecondaryId Removed from Batch Row Footers
2705 2:41a 🔴 delegation-row-helpers Tests Updated to Match New resolveChildLabel Priority
2706 " 🔵 TypeScript Error — titleOverride Missing from TrackerApprovalDelegationSurface Type
2707 " 🔵 titleOverride Missing from TrackerApprovalDelegationSurface — All Three Surface Kinds Reference It
2708 2:42a 🔴 TypeScript Fix — Removed titleOverride from ApprovalDelegationSurface
2709 " 🔵 Pre-existing Lint Errors Blocking Test Run — Unused Imports in Daemon and Kernel Files
2710 " 🔴 Lint Fix — Removed Unused Imports from daemon.ts and run-workflow.ts
2711 " 🔴 resolveRowArchetype Extended with Legacy Field Heuristics for Unstamped OCR Rows
2712 2:44a 🔴 All 61 Tests Pass — resolveRowArchetype Legacy Heuristics Fix Confirmed
2713 " ✅ src/tracker/CLAUDE.md Updated — Legacy Archetype Fallbacks Documented
2714 3:00a ✅ Delegation workflow documentation requested
2715 11:13a 🔴 Test failure: countSidebarRowsFromTrackerHistory discarded OCR review rows not hidden
2716 11:14a 🔵 countSidebarRowsFromTrackerHistory discarded-row filtering investigation
2717 " 🔵 Root cause: discarded OCR rows without data.mode="prepare" bypass isResolvedPrepEntry filter
2718 " 🔴 Fixed isResolvedPrepEntry to filter discarded OCR rows without requiring batch-parent archetype
2719 " ✅ CLAUDE.md lesson added: legacy OCR discard rows can lack data.mode
2720 11:15a 🔴 Full test suite passes clean after isResolvedPrepEntry fix — 1628/1629 passing
2721 11:16a 🔴 resolveRowArchetype legacy fallbacks restored for mode/taskRole/requestRole
2722 " 🔴 Cancelled delegated lookup rows keep person/EID titles instead of technical OCR retry ids
2723 " ✅ Daemon batch cards and batch rows no longer show raw parentRunId in footer
2724 " 🔄 queue-surface-classifier.ts toJsonlEntry/toDashboardEntry simplified to identity casts
2725 11:27a 🔵 hr-automation repo has 31 unstaged files and is 13 commits ahead of origin/master
S259 Push all local commits and staged changes to git origin/master (May 19 at 11:27 AM)
**Investigated**: Git status showed 31 unstaged modified files and 13 unpushed commits on local master ahead of origin/master.

**Learned**: The 31 unstaged files were a type-soundness sweep and documentation updates across core, OCR, and tracker modules — companion edits to the 13 refactor commits already committed locally.

**Completed**: All 31 unstaged files were staged and committed as a single rollup commit ("chore: type-soundness sweep and doc updates across core/ocr/tracker"), then the full batch of 14 commits (13 prior refactors + the new chore commit) was pushed to origin/master. Remote is now at b0734cff.

**Next Steps**: No active work in progress — push was the complete request and it succeeded.


Access 695k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>