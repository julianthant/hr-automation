<claude-mem-context>
# Memory Context

# [hr-automation] recent context, 2026-05-21 1:00am PDT

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision 🚨security_alert 🔐security_note
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (20,604t read) | 363,887t work | 94% savings

### May 18, 2026
S254 Re-run /review-code with multiple subagents to verify all planned fixes were completed and check for new issues in hr-automation codebase (May 18 at 10:40 PM)
S256 Fan out parallel subagents to complete all type-soundness plans and push to origin (May 18 at 10:41 PM)
S257 Fix "skipping invalid line" errors in .tracker/sessions-2026-05-18.jsonl (lines 685–724) (May 18 at 10:58 PM)
S258 Fix two bugs: (1) JSONL warning flood from sessions file being treated as a workflow, (2) OCR auto-retry with different API key on provider errors like Gemini 503 (May 18 at 10:59 PM)
### May 19, 2026
S259 Push all local commits and staged changes to git origin/master (May 19 at 2:38 AM)
S260 Push all changes to git — committed and pushed oath-signature + log-panel updates to origin/master (May 19 at 11:27 AM)
S261 Delegation.md documentation + architectural analysis of delegation workflow system (May 19 at 12:51 PM)
S262 Workflow Runtime Phase 2: Central Action Engine — implement performWorkflowAction dispatcher and wire 6 HTTP routes through it (May 19 at 11:17 PM)
S263 Run /review-code with parallel Sonnet agents across hr-automation codebase, synthesize findings into sequential plans, and execute each plan with a Sonnet subagent — all 4 plans now complete (May 19 at 11:44 PM)
### May 21, 2026
S264 Action system architecture review — split static policy from resolved descriptors, add client-side dispatcher hook, centralize OCR discard, and clarify batch-view toolbar scope semantics (May 21 at 12:35 AM)
2902 12:35a 🔵 hr-automation repo baseline before action system refactor — master ahead 13, two unstaged files
2903 " 🔵 projection.ts is where static policy descriptors get targetRunIds injected — withTargets() is the fill function
2904 12:36a ⚖️ Action system refactor implementation plan — 5 tasks defined
2905 " 🔄 Split static action policy from resolved action descriptors in workflow-runtime
2906 " 🔵 Pre-refactor state of WorkflowActionDescriptor and related types confirmed
2907 12:37a 🔵 Pre-refactor test baseline confirmed: all workflow-runtime and dashboard-actions tests pass
2912 12:38a 🔄 Split WorkflowActionPolicy from WorkflowActionDescriptor — targets now carry workflowId per target
2908 12:44a ⚖️ Action System Architectural Refactor — Policy/Descriptor Split and Centralized Dispatch
2909 12:45a 🔄 Split WorkflowActionPolicy from WorkflowActionDescriptor — Action Targets Now Carry workflowId
2910 12:47a 🔄 Centralized Workflow Action Dispatcher Hook — Sequential Subagent Task 2
2911 " 🔵 useWorkflowActionDispatcher Hook Not Yet Created — Test Fails with Module Not Found
2913 12:48a 🟣 useWorkflowActionDispatcher Hook Implemented and Tests Pass
2914 " 🔄 RetryButton Migrated to useWorkflowActionDispatcher
2915 " 🔄 DeleteButton Migrated to useWorkflowActionDispatcher
2916 " 🔄 CancelRunningButton Migrated to useWorkflowActionDispatcher
2917 12:49a 🔄 QueueItemControls Migrated — OCR Path Preserved, Non-OCR Cancel Uses Dispatcher
2918 " 🔵 Full Dashboard Action Migration Verified — 9/9 Tests Pass
2919 " ✅ src/dashboard/CLAUDE.md Updated — Dispatcher Pattern Documented
2920 12:50a 🔵 Migration Completeness Verified — No Stray Inline Fetch Calls Remain
2921 " 🔵 TypeScript Typecheck Passes Clean After Migration
2922 " 🔵 Full Dashboard Test Suite Passes With env-bootstrap + setup Imports
2923 12:51a 🔵 Lint Passes Clean — Pre-existing Warning in Unrelated File
2924 " 🔄 Commit 6faf6cff — Centralize Workflow Action Dispatch
2925 " 🔵 Final Commit Is a5ded2bd — Two Commit Attempts Made
2926 " ⚖️ Action Policy Architecture Refactor — Separation of Static Policy from Resolved Descriptors
2927 12:52a 🟣 useWorkflowActionDispatcher Hook — Centralized Workflow Action Dispatch
2928 " 🔵 OCR Prep Discard Routing — Component-Local Special Case Retained in CancelRunningButton
2929 " 🔄 WorkflowActionDescriptor — Per-Target workflowId, Scope/Source on Descriptor
2930 12:54a 🔄 OCR Discard Routed Through Central Workflow Cancel Dispatcher
2931 " ⚖️ Single Dispatcher Pattern for All Workflow Row Actions Including OCR
2932 12:55a 🔵 Test Failures Reveal Implementation Gaps for OCR Cancel Routing Refactor
2933 " 🔄 useWorkflowActionDispatcher Extended to Forward OCR Discard Context Fields
2934 " 🔄 CancelRunningButton OCR Special-Case Removed; Routes Through Central Dispatcher
2935 12:56a 🔄 CancelRunningButton Direct OCR Fetch Replaced with dispatchWorkflowAction
2936 " 🔄 WorkflowActionRequest Type Extended with OCR Discard Parent Context Fields
2937 " 🔄 performWorkflowAction: resolveActionTargets Deferred Per-Branch; OCR Discard Gets Full Parent Context
2938 12:57a 🔄 Hono Cancel Routes Extended to Parse and Forward OCR Discard Context
2939 " 🟣 All 16 Tests Pass After OCR Discard Central Cancel Refactor
2940 " 🔵 CLAUDE.md Lesson Needs Update — OCR Local Special Case No Longer Applies
2941 " ✅ Dashboard CLAUDE.md Updated with OCR Central Cancel Routing Documentation
2942 12:58a ✅ Tracker CLAUDE.md Updated with OCR Discard Central Cancel Variant Lesson
2943 " 🔄 Complete Diff Verified: OCR Discard Central Cancel Refactor — All Files Changed
2944 " 🟣 Typecheck and Full Test Suite Pass — OCR Central Cancel Refactor Complete
2945 " 🔵 Lint Clean for Refactor — Pre-existing Warning in Unrelated File
2946 12:59a 🔵 Pre-commit Verification: Dirty Files Confirmed; No Stale OCR Direct Fetch in Components
2947 " 🟣 Integration Test Added for /api/task/force-stop OCR Discard Path
2948 " 🟣 Final Verification: 50/50 Tests Pass, Typecheck Clean, Lint Clean
2949 " 🔄 11 Refactor Files Staged for Commit; Pre-existing Dirty Files Preserved
2951 1:00a ⚖️ Action system architecture redesign — policy/descriptor split + centralized dispatch
2950 " 🔄 Commit 06991af2 Landed: OCR Discard Central Cancel Refactor on Master

Access 364k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>