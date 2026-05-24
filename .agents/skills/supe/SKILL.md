---
name: supe
description: Run the explicit superpowers workflow — `superpowers:brainstorming` → `superpowers:writing-plans` — taking a feature from rough idea to a committed plan file, then STOP. Invoke ONLY when the user explicitly types `/supe` or explicitly asks for "the superpowers flow" / "brainstorm and plan this." If the user's invocation mentions "handoff" / "with handoff" / "and a handoff," also runs `/handoff` after the plan is committed. The user has opted OUT of using superpowers as the default workflow — never auto-trigger this skill on ambient feature-building language.
---

# /supe — Superpowers brainstorm → plan flow

This skill orchestrates the user's preferred superpowers workflow for taking a feature from rough intent to a written plan. It is **user-invoked only**. The user has explicitly removed superpowers as a default workflow — do not invoke this skill on ambient "let's build X" / "I want to add Y" language. Only when the user types `/supe` or explicitly asks for the superpowers flow.

## Scope

**Covers:**
1. Brainstorming via `superpowers:brainstorming` (Q&A only, no spec).
2. Writing the plan via `superpowers:writing-plans`, committing it, and stopping.
3. Optionally running `/handoff` afterward — only if the user's invocation explicitly mentions a handoff.

**Does NOT cover:**
- **Execution.** Even after the plan is written, do NOT auto-proceed. Execution happens only in a separate later turn when the user explicitly says "execute the plan" / "run this" / similar. See "When the user later asks to execute" below.
- **Spec documents.** Brainstorming terminates at *alignment*, not a spec file. Do NOT write `docs/superpowers/specs/*.md` files.
- **Codex / codex:rescue.** Not part of this flow.

## Step 1 — Brainstorm

Invoke `superpowers:brainstorming` via the Skill tool.

- Drive Q&A to pin down intent, constraints, what "done" looks like, and any non-obvious requirements.
- **SKIP the brainstorming skill's spec-writing checklist items** (write design doc, spec self-review, user reviews spec). The terminal state for this flow is *alignment*, not a spec file.
- When alignment is reached, transition directly to step 2.

## Step 2 — Write the plan

Invoke `superpowers:writing-plans` (or `superpowers:write-plan`) via the Skill tool.

- Produce the implementation plan, then **STOP**.
- Structure the plan for subagent-driven execution: each task is one subagent dispatch — self-contained, with all file paths, code, and verification a fresh Sonnet subagent would need. (This is for *possible* future use; the plan being suited for subagents doesn't commit the user to subagent execution.)
- The `writing-plans` skill ends with "offer execution choice" — **ignore that prompt.** The plan is the deliverable for `/supe`.
- Commit the plan file before declaring `/supe` complete.
- Report the plan path(s) to the user, then stop.

## Step 3 — Handoff (only if explicitly requested)

If — and only if — the user's invocation prompt mentions "handoff" / "with handoff" / "and a handoff" / "save this for a new session" (or similarly explicit phrasing), invoke `/handoff` via the Skill tool after the plan is committed.

If the user did not mention a handoff, skip this step. Do not ask "want a handoff?" — it would defeat the explicit-opt-in principle.

## When the user later asks to execute (separate turn)

Execution is **not part of `/supe`** and only happens when the user later explicitly says "execute the plan" / "run plan A" / "start implementing" / similar. When that happens:

- **Default execution mode for a superpowers plan = subagent-driven** (Opus orchestrator + Sonnet subagents per task). This is *because* the user opted into the superpowers flow for this plan — it is NOT a global default for non-superpowers work.
- **If the user explicitly opts out of subagents** ("don't use subagents" / "I'll drive this myself" / "do it inline"), honor that. Drop to inline execution — Opus runs tasks directly, no subagent dispatch.
- **Parallel dispatch:** when plan tasks touch disjoint files with no ordering dependency, parallel dispatch (multiple Agent calls in one message, each with its own worktree + branch) is the *default* for superpowers plan execution — but only when the user hasn't opted out of parallelism. If the user says "don't parallelize" / "one at a time" / "sequential" / similar, honor that and run tasks sequentially.
- **When parallel dispatch is used, the mandatory worktree discipline from `~/.claude/CLAUDE.md` applies in full** — that section of CLAUDE.md is about correctness, not preference. Each subagent in its own worktree on a named branch, orchestrator verifies after each return, sequential `--no-ff` merges only after all complete, worktrees deleted after merge, end-of-batch sweep. Never skip the discipline once you've decided to go parallel.
- **Opus does NOT review subagent diffs between tasks.** Trust the subagent. Per-task verification (typecheck + test + architecture guard) is the gate. Final review across the whole plan happens at the end via `superpowers:requesting-code-review`.

## Important

- **This flow is opt-in, not the default.** Never invoke on ambient "let's build X" language. Only when explicitly invoked.
- **Plan is the deliverable.** No spec file. No auto-execution. Stop after the plan is committed.
- **Handoff is opt-in within opt-in.** Only invoke `/handoff` if the user's `/supe` request mentions it.
- **Sub-skills' default prompts may try to auto-progress.** Override them — `writing-plans` ends with "offer execution choice"; skip that.
- **Subagents and parallelism are not assumed for non-superpowers work.** This skill only governs how superpowers plans get built and (later) executed. For anything outside this flow, default to direct inline work unless the user asks otherwise.
