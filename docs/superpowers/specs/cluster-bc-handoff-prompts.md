# Cluster B + Cluster C — Handoff Prompts

These are self-contained prompts you can paste into a new Claude Code session to design + implement Clusters B and C. Both reference the Cluster A spec (`2026-04-28-daemon-coordination-cancel-retry-design.md`) and the source notes (`notes.md`).

---

## Cluster B — Dashboard Footer Redesign

Paste this into a new session:

> I want to redesign the dashboard with a terminal-style footer. The footer should host the SessionPanel content (relocated from the current right rail) and possibly the preview/capture mode controls.
>
> Source notes (from `notes.md`):
> ```
> add a footer like a terminal. what to add to it. session panel move down and maybe
> preview/capture mode in there?
> ```
>
> Constraints:
> - Cluster A (daemon coordination, cancel verbs, force-stop chrome cleanup, cancelled badge) is already shipped — see `docs/superpowers/specs/2026-04-28-daemon-coordination-cancel-retry-design.md` and the recent commit history. Do NOT reopen Cluster A.
> - Cluster C (separations duplicate auto-fill) is a separate follow-up — out of scope here.
> - The dashboard's existing layout is in `src/dashboard/App.tsx`. Current zones: TopBar (top), WorkflowRail (left sidebar), QueuePanel (left), LogPanel (center), SessionPanel (right rail). The footer would be a new fifth zone below the main row.
> - SessionPanel currently shows: WorkflowBox per active workflow instance (with browser chips + auth state), DaemonsSection (list of alive daemons + spawn/stop), SelectorWarningsPanel (selector-fallback aggregations), live SSE feed.
> - Per global CLAUDE.md, this redesign goes through three skills sequentially: `superpowers:brainstorming` → `ui-ux-pro-max` → `frontend-design`. Don't skip any — they do different jobs and the order matters. Read `~/.claude/CLAUDE.md` for the rationale.
>
> Open questions to brainstorm:
> - What does "terminal-style" mean visually — JetBrains Mono everywhere? CRT-tinted background? scrolling log feel? Or just visually compact + status-line vibe?
> - Should the footer be persistent (always visible) or collapsible? What's its target height?
> - Does relocating SessionPanel to the footer keep all sub-panels (WorkflowBox, DaemonsSection, SelectorWarningsPanel), or split them across multiple surfaces?
> - "Preview/capture mode in there" — does the user mean the existing CaptureModal trigger / OathPreviewRow live there, or a new affordance?
> - What right-rail content stays in the rail (if anything) vs moves to the footer? Or does the right rail go away entirely?
>
> Start by invoking `superpowers:brainstorming` to clarify intent, then `ui-ux-pro-max` for the visual direction, then `frontend-design` for the implementation. Before any code: confirm the design with the user, write the spec to `docs/superpowers/specs/YYYY-MM-DD-dashboard-footer-redesign-design.md`, and commit it (force-add since `docs/superpowers/specs/` is gitignored). Each skill's output feeds the next; don't collapse the chain even if the redesign feels small.

---

## Cluster C — Separations Duplicate Auto-Fill

Paste this into a new session:

> I want separations to detect when the same employee is being processed twice and auto-load the values from the last successful run via edit-data mode.
>
> Source notes (from `notes.md`):
> ```
> For separations sometimes we have duplicates and if we do, just copy what the last successive
> run from our history did. so we had le jackson twice so just run that in edit data mode and
> copy what the last successful ran of him did and do it like that.
> ```
>
> Constraints:
> - Cluster A is shipped — daemon mode, cancel verbs, edit-and-resume infrastructure (the `prefilledData` channel + `/api/run-with-data` + `EditDataTab` + kernel `splitPrefilled`) all already exist. See `docs/superpowers/specs/2026-04-28-daemon-coordination-cancel-retry-design.md` (Cluster A) and `docs/superpowers/specs/2026-04-24-dashboard-operations-design.md` (where edit-and-resume was specced).
> - Cluster B (footer redesign) is independent — out of scope.
> - The separations workflow already calls `findExistingTerminationTransaction(page, eid, effectiveDate)` in `src/workflows/separations/workflow.ts` to detect dupes against UCPath's Smart HR Transactions list. That's a *live-page* probe and only fires once the workflow is already running. Cluster C wants dupe detection at *enqueue time* (before any work happens) by reading past JSONL tracker entries.
> - Tracker JSONL entries live at `.tracker/{workflow}-{YYYY-MM-DD}.jsonl`. Each entry includes `data` (a Record<string, string>) which carries `name`, `eid`, `docId`, `transactionNumber`, `lastDayWorked`, etc. for separations.
>
> Open questions to brainstorm:
> - What counts as a duplicate — same EID? same docId? same name? Some combination?
> - When does dupe detection fire — at enqueue time (before the queue file write), at claim time (just before the daemon processes the item), or as a dashboard-side warning the user sees on the queue panel?
> - When a duplicate is detected, what fields from the prior successful run are copied? All of `data`? A subset? Should the user see a confirmation modal listing the carried-over fields, or is auto-apply the right call?
> - How does the user override auto-fill — by clicking through EditDataTab and changing fields manually, or via a "force fresh extract" button on enqueue?
> - Lookback window — search across all JSONL files (last 30+ days) or only today's?
> - Performance — JSONL reads aren't free if we walk a month of files for every enqueue. Build an index, or accept the cost?
> - Behavior on a partial-success prior run (e.g., kuali-extraction succeeded but ucpath-transaction failed): copy the extracted data but skip the txn#?
>
> Start by invoking `superpowers:brainstorming` to nail down semantics. Then write the spec to `docs/superpowers/specs/YYYY-MM-DD-separations-duplicate-autofill-design.md` (force-add to git since the specs dir is gitignored), self-review, get user approval, and invoke `superpowers:writing-plans` for the implementation plan.
>
> Useful starting points to read:
> - `src/workflows/separations/workflow.ts` — current handler, including the existing `findExistingTerminationTransaction` call site
> - `src/tracker/dashboard-ops.ts` — `findLatestEntryData` (already exists; pulls latest tracker `data` for a given workflow + id) — likely reusable for the dupe-fill flow
> - `src/core/workflow.ts` `splitPrefilled` — how the kernel merges `prefilledData` into `ctx.data` before the handler runs
> - The `2026-04-24-dashboard-operations-design.md` spec, Section 3.1 — separations' edit-and-resume opt-in (`!ctx.data.employeeName` extraction gate)

---

## Notes for both prompts

- The user's working preference is to **fail loud** (no silent fallbacks, throw with a clear error so the user fixes upstream data — see `~/.claude/projects/-Users-julianhein-Documents-hr-automation/memory/feedback_fail_loud_over_auto_correct.md`). Apply this when designing dupe-detection error paths and footer-state edge cases.
- The user delegates tradeoff decisions but wants the reasoning visible — don't gate on approval for every micro-decision (`feedback_delegation_style.md`).
- Dashboard backend (`src/tracker/dashboard.ts` on port 3838) doesn't hot-reload — backend changes need `npm run dashboard` restart (`reference_dashboard_restart_required.md`).
- Specs go to `docs/superpowers/specs/` which is gitignored — commit with `git add -f` (`880` from prior session memory).
