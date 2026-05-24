---
name: ui
description: Run the full UI redesign chain — superpowers:brainstorming → ui-ux-pro-max → frontend-design — sequentially in a single session. Invoke ONLY when the user explicitly types `/ui` or explicitly asks for "the UI chain" / "the redesign chain." Do not auto-trigger on generic UI requests; the user has opted out of automatic UI orchestration and prefers to call this skill manually.
---

# /ui — UI redesign chain

This skill orchestrates three other skills in sequence to redesign a UI. It is **user-invoked only** — never auto-trigger it from ambient UI language in a request.

## When to run

Run only when the user explicitly invokes `/ui` or says something like "run the UI chain" / "do the redesign chain." If the user is asking for a tweak, a bugfix, a copy change, a one-component visual nudge, or anything else where the three-skill chain would be overkill, work directly without invoking this skill. The three sub-skills can still be called individually when the user asks for them by name.

## The chain

Invoke these three skills sequentially via the Skill tool, in this order, in the same session. Each one's output feeds the next — do not parallelize, do not skip, do not collapse into a single call.

1. **`superpowers:brainstorming`** — pin down intent and constraints. What does "better" mean for this redesign? Who's the audience? What can't change? Brainstorming is the entry point for creative work; even when the user has a strong opinion already, this pass surfaces unstated constraints and saves time downstream. Keep it tight if the user is impatient, but run it.

2. **`ui-ux-pro-max`** — design intelligence pass. Once intent is clear, this skill produces visual direction: palette, typography, layout, component choices, motion language. If the session has been running a while and the redesign matters, suggest the user runs `/plugin` → update or restarts Claude Code first so the plugin is fresh.

3. **`frontend-design`** — production-grade implementation pass. Turns the design direction into actual code in the project's stack.

## Important

- **Each skill does a different job.** Brainstorming is about *what to build*. ui-ux-pro-max is about *visual language*. frontend-design is about *code*. Don't try to compress them.
- **Write code in the same turn as the design.** When ui-ux-pro-max or frontend-design produces code, write it to the target file in the same turn — don't leave it sitting in chat for the user to copy out. (This matches the user's standing preference.)
- **Sequential, not parallel.** Each pass needs the prior pass's output. Spawning them in parallel breaks the chain.
- **Respect the brainstorming scope rule from `/supe`.** Brainstorming in the user's workflow terminates at *alignment* — do not write a spec document, do not run the brainstorming skill's spec-writing checklist items, do not create `docs/superpowers/specs/*.md` files. When alignment is reached, transition directly to step 2 (ui-ux-pro-max).
