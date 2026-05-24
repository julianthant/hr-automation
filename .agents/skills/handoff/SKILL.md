---
name: handoff
description: Generate a handoff brief so work can resume in a fresh Claude Code session with no context loss. Writes a markdown file under `docs/superpowers/handoffs/` and prints a short paste-ready prompt for the next session. Invoke ONLY when the user explicitly types `/handoff` or explicitly asks for a handoff / "save this for a new session." Works after a plan is written, mid-execution of a multi-task plan, or any time the user wants to preserve state before `/clear`-ing or closing the session.
---

# /handoff — Session handoff generator

Produce a self-contained handoff artifact so a new Claude Code session — which won't see this conversation — can resume the work exactly where it was paused.

## Output

Always produce **both** of these:

1. **A handoff file** at `docs/superpowers/handoffs/<YYYY-MM-DD>-<short-slug>.md`. Create the directory if it doesn't exist. The slug is 2–4 kebab-case words describing the task (e.g. `oath-signature-batch-rows`, `dashboard-queue-perf`).

2. **A short paste-ready prompt** echoed in chat, pointing at the file and the plan. The user will copy this into the new session as the first prompt. Keep it terse — the detail lives in the file.

   Template:
   > Continue work on **<task summary>**. Read `docs/superpowers/handoffs/<file>.md` for the handoff brief, then `<plan path>` for the implementation plan. Resume at task **<N>**.

## Handoff file structure

Use this template. Omit sections that don't apply (don't leave them empty with placeholder text).

```markdown
# Handoff — <task title>

**Date:** <YYYY-MM-DD>
**Paused at:** <where the session stopped — e.g., "after writing plan, before execution", "after task 3 of 7", "post-merge, awaiting review">

## Task summary

<2–4 sentences. What we're building and why. Include motivation, not just description — a fresh session needs to understand the constraint behind a scope decision without re-deriving it.>

## Plan

- Plan file: `<path>`
- Created: <date if known>

## Current state

- Branch: `<branch-name>`
- Worktrees: `<list paths + branches, or "none">`
- Commits ahead of master: <N>
- Uncommitted changes: <short summary or "clean">

## Progress

- [x] Task 1 — <name> (<sha>)
- [x] Task 2 — <name> (<sha>)
- [ ] Task 3 — <name> ← **resume here**
- [ ] Task 4 — <name>
- ...

## Open questions / deferred decisions

<Anything raised but not resolved. Format: "Q: ... — current thinking: ...". Skip the section if none.>

## Verification before resuming

Commands the new session should run first to confirm state matches this brief:

```bash
git status
git log --oneline master..HEAD
<project typecheck/test/lint commands>
```

<Add project-specific checks if relevant — e.g., "start the dashboard and confirm <feature> still renders".>

## Pointers

- Relevant CLAUDE.md files: <paths>
- Relevant memory entries: <paths under `~/.claude/projects/.../memory/` if any>
- Related past sessions: <claude-mem observation IDs if clearly relevant>
```

## How to fill it in

1. **Find the plan.** If the current conversation just produced a plan with `superpowers:writing-plans`, use that path. Otherwise scan `docs/superpowers/plans/` for recent files and confirm with the user which one is in scope. If there's no plan at all (the user is mid-exploration without one), say so and ask whether they want a lightweight handoff that captures conversation state instead, or whether they want to pause and write a plan first.

2. **Pull state from git, don't guess.** Run these in parallel:
   - `git status`
   - `git branch --show-current`
   - `git log --oneline master..HEAD`
   - `git worktree list`

3. **Pull progress from the conversation.** Look back over the session for completed-and-committed tasks. If you're unsure how many tasks are done or where to mark "resume here", ask the user before writing.

4. **Capture open questions.** Surface anything the user explicitly deferred ("we'll decide this later") or any tradeoff raised but not resolved. These matter most — they're the load-bearing context that won't survive `/clear`.

5. **Verification commands.** Use commands the project actually has — check `package.json` scripts (or equivalent for the project) rather than guessing. For repos following the user's standard layout, defaults are typically `npm run typecheck`, `npm run test`, `npm run test:architecture`, `npm run lint`.

6. **Pointers.** Link to the CLAUDE.md files the new session should read first — the project root's CLAUDE.md plus any subsystem CLAUDE.md the work touches. Include memory entries from `~/.claude/projects/<project-slug>/memory/` if any are load-bearing for this task. Include claude-mem observation IDs only when clearly relevant.

## Versatility

This skill works in several modes — pick the right one based on conversation state:

- **Post-plan.** A plan was just written, execution hasn't started. Handoff captures plan path + intent + verification, marks task 1 as the resume point.
- **Mid-execution.** Several tasks are done, more remain. Handoff captures progress checklist with commit SHAs, marks the next task as the resume point, surfaces any mid-flight discoveries that changed the plan.
- **Post-execution, pre-review.** All tasks done, review/merge pending. Handoff captures the diff scope, what review/merge steps remain, any worktrees still alive.
- **Exploratory pause.** No plan exists yet but the user has done significant exploration they don't want to lose. Handoff captures the open questions and what's been ruled in/out — explicitly note "no plan yet" and what would need to happen before execution can start.

If the conversation has no plan AND no in-progress work AND no exploration worth preserving, don't fabricate a handoff — tell the user there's nothing to capture and ask what they want.

## Discipline

- **Be honest about state.** If a worktree has uncommitted changes, say so. If a task was started but not finished, say so. The new session must not be tricked into thinking work is complete that isn't — that's how progress gets lost.
- **Capture motivation, not just facts.** "We're refactoring X because of constraint Y" is more valuable than "we're refactoring X." A new session can read the diff; it can't read the constraint.
- **Keep the chat-side prompt terse.** All the detail goes in the file. The chat-side prompt is just a pointer — three sentences max.
- **Don't fabricate verification commands.** If unsure what the project runs, check `package.json` (or the equivalent) before writing them down.
- **Name the file carefully.** Use today's date and a slug that's specific enough to find later. `2026-05-13-handoff.md` is useless; `2026-05-13-oath-signature-batch-rows.md` is good.
