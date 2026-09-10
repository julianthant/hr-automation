---
name: custom-hr-tree-guard
description: Use before running any multi-file operation in this repo's shared working tree — eslint --fix, formatters, codemods, mass renames/retirements, cleanups — or before committing when `git status` shows files you didn't edit this session, when unexplained untracked files appear, when tempted to git stash/clean/reset to get a "clean baseline", or when a subagent reports work complete and you're about to trust, merge, or build on its commits.
---

# /custom-hr-tree-guard — Multi-session working-tree safety

## The environment fact this skill exists for

This repo usually has SEVERAL live editors at once: the user's own editor, this session, other Codex sessions, and background subagents — all sharing ONE working tree. Any dirty or untracked file you didn't create is another editor's **live work-in-progress** — not clutter, not "unrelated WIP to shelve," not yours to fix, move, stash, or delete.

Real incidents this skill prevents (all happened here): a `git clean -fd` destroyed another session's untracked docs; a repo-wide `eslint --fix` rewrote foreign in-flight files; a subagent deleted someone else's failing test to force a green suite; a rename pass silently deleted `src/control/ocr/index.ts` and master stayed broken for two days.

## Step 1 — Attribution snapshot (required before ANY multi-file operation or commit)

```bash
git status --porcelain=v1   # save output to your scratchpad: tree-before-<task>.txt
```

Classify **every** line: **MINE** (files you created or edited *this session*) vs **FOREIGN** (everything else — including every untracked file you can't explain). Can't attribute it? It's FOREIGN. Keep the snapshot; it settles any later "which hunks are mine" question.

## Step 2 — Operate on MINE only

- Mass fixes/formatters/codemods run with **explicit pathspecs from the MINE list**: `npx eslint <my-paths> --fix` — never `npx eslint src --fix` on a tree with FOREIGN entries.
- "Green" means **your scope** is green. Lint/test failures living in FOREIGN files: report them, don't fix them, never delete or `.skip()` a failing test you didn't break — that failure is a signal owned by another session.
- FOREIGN files are never stashed, cleaned, reset, `checkout --`'d, deleted, or edited. `git stash` is **not** a safe parking spot here: other sessions keep editing while your stash sits, so the pop conflicts with or silently clobbers their newer edits, and `-u` kidnaps their untracked WIP. There is no "temporarily move it aside" on a live shared tree — scope your operation instead.

## Step 3 — Commit isolation

Stage by explicit pathspec from the MINE list. A mixed file (your hunks + foreign hunks): `git add -p` and take only yours. Inseparable? Stop and ask the user. Never `git add -A`, `git add -u`, or `git add $(git diff --name-only)` — each assumes the whole tree is yours.

## Step 4 — Subagent commit audit (worktree AND sequential-on-master)

A subagent's "done — suite green, committed" is a **claim**. Before merging, trusting, or building on it:

```bash
git log --oneline <base>..HEAD      # do the claimed commits exist?
git diff --stat <base>..HEAD        # every touched file vs the assigned scope
```

Any file **outside the assigned scope** — and especially any **deletion** (test files, `index.ts`/barrel files) — is stop-and-investigate before anything else proceeds. The known failure mode: a subagent deleting a *foreign* failing test so its own suite reports green. Global AGENTS.md already mandates checks for worktree dispatch; this audit applies equally to subagents committing **sequentially on master**, where no other checklist covers it.

## Step 5 — Residue sweep after renames/retirements

After any mass rename/retire/move pass, before declaring done:

1. Grep for the old identifiers/paths — zero hits outside legacy-compat code.
2. Confirm every touched directory's `index.ts`/barrel still exists and its exports resolve.
3. Run `npm run typecheck:all`, and `npm run build:dashboard` if dashboard files were touched — plain `npm run typecheck` **excludes `src/dashboard/**`**, which is exactly how a deleted barrel once passed checks and broke master for two days.

## Rationalizations already seen in this repo

| Excuse | Reality |
|---|---|
| "I'll stash everything for a clean baseline and pop it after" | On a live shared tree, pop clobbers or conflicts with edits made meanwhile. Scope the operation; never shelve foreign work. |
| "The whole repo should be lint-green anyway" | Foreign files are mid-edit. Fixing them creates conflicts and masks their owner's state. |
| "That test references a deleted function — just remove it" | Not yours, not your call. Report it to the user. |
| "These untracked files look like scratch" | Another session's WIP until proven otherwise. Leave them; mention them. |
| "The subagent says the suite is green" | Verify its commits against its assigned scope yourself before trusting it. |

## Red flags — STOP if you catch yourself…

- typing `git stash`, `git clean`, `git reset --hard`, `git checkout --`, or `git add -A` while FOREIGN entries exist in your snapshot
- running a fix/format/codemod command whose pathspec is broader than your MINE list
- about to delete or skip a failing test you never touched
- merging or building on subagent work whose diff you haven't seen
- declaring a rename/migration done without the residue sweep
