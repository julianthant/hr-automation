---
name: custom-hr-lesson-audit
description: Garbage-collect the hr-automation lesson stores — sweeps every LESSONS.md (per-system + root) and every AGENTS.md "Lessons Learned" section to find and fix duplicate, outdated, superseded, and broken-reference lessons, then verifies each remaining lesson still maps to real code. Invoke on demand whenever you want to clean up lessons — e.g. "/custom-hr-lesson-audit", "audit the lessons", "dedupe lessons", "are our lessons still accurate", "remove stale lessons", "check lessons against the codebase". Run it periodically so future sessions don't follow outdated guidance.
---

# Lesson Audit — maintenance sweep for lesson stores

The repo accumulates lessons faster than it prunes them. This skill is the on-demand garbage collector: it reads every lesson, checks each one against the **current** codebase, and fixes what's rotten — duplicates, superseded guidance, dead references — so future sessions read only lessons that are still true.

This is the *cleanup* counterpart to the `custom-hr-lesson` add-flow skill (which writes one new lesson and self-dedupes against neighbors). Use `custom-hr-lesson` to add; use `custom-hr-lesson-audit` to sweep.

## When to invoke

- The user asks to audit / clean / dedupe / verify lessons, or asks whether the lessons are still accurate.
- After a large refactor, rename, or system removal that may have invalidated cited selectors/files/scripts.
- Periodically, as hygiene — there's no schedule; you run it when asked.

Default scope is **everything**. The user may narrow it ("just UCPath", "just the root LESSONS.md") — honor that and skip the rest.

## What counts as a lesson store

Three kinds of files. Discover them fresh each run (don't trust a hardcoded list — systems and modules come and go):

1. **Per-system lesson files** — `src/systems/*/LESSONS.md`. Strict 4-subsection format, **test-enforced** (see Format below).
2. **Root lesson file** — `LESSONS.md` at the repo root. Section/bullet prose, not test-enforced.
3. **Module lesson sections** — the `## Lessons Learned` section inside `**/AGENTS.md` (dashboard, tracker, core, scripts, each workflow, etc.). Dated-bullet format, not test-enforced.

Find them with:

```bash
ls src/systems/*/LESSONS.md LESSONS.md
rg -l '^## Lessons Learned' --glob '**/AGENTS.md'
```

Read each file fully before judging anything in it — context from sibling lessons is how you spot duplicates and supersessions.

## The five detection passes

Run all five against each lesson. Tag every finding with which pass(es) caught it, so the summary shows *which is which*. **Verify with evidence — never flag on a hunch.**

### 1. Broken references
A lesson is only useful if the thing it talks about still exists. Pull every concrete reference out of the lesson body and confirm it against the live tree:

| Reference in the lesson | How to verify it still exists |
|---|---|
| Selector FQN (e.g. `ucpath.smartHR.tab.personalData`) | Grep the namespace/function in `src/systems/<sys>/selectors.ts` |
| File path (`src/...`, `tests/...`) | Glob / `ls` the path |
| npm script (`npm run <name>`) | Check `scripts` in `package.json` |
| Backticked symbol (function/class/const) | Grep `src/` for the definition |
| Commit SHA (in `**References:**`) | `git cat-file -t <sha>` |

If a reference is gone, the lesson is a **broken-ref** candidate. Judge whether the lesson's *value* depends on that reference: a lesson whose entire fix points at a deleted helper is dead; a lesson that merely mentions a renamed file in passing just needs the reference updated.

### 2. Superseded / contradicted
Read the nearest current `AGENTS.md` guidance and any **newer** dated lessons. Flag a lesson when current truth has moved on — "use X" where X was replaced by Y, a workaround for a bug that's since been fixed at the root, a pattern an architecture guard now forbids. A newer lesson that explicitly says "supersedes the YYYY-MM-DD lesson" is a definitive signal.

### 3. Duplicate / near-duplicate
Cluster lessons by topic + `Tags:` overlap + the same selector/file. Two entries describing the same failure and the same fix are merge candidates. Keep the richer one (more detail, more recent date), fold in anything unique from the other, and add a `**References:**` cross-link if related-but-distinct.

### 4. Age (informational)
Parse the `YYYY-MM-DD` prefix. Old lessons aren't wrong just for being old — **do not delete on age alone.** Age only raises priority for the *other four* checks: an old lesson that also has a broken ref or is superseded is high-confidence rot. Report the oldest lessons so the user knows what to eyeball, but leave still-valid ones untouched.

### 5. Git evidence
Where a lesson cites a commit or a specific pattern, use git to confirm the lesson still reflects reality — e.g. the cited fix wasn't later reverted, the file it describes still contains the pattern it claims. Treat this as corroboration for passes 1–2, not a standalone delete trigger.

## What to actually change (autonomy policy)

Act autonomously, but only on **high-confidence** findings. The bar is "another engineer reading the evidence would agree without discussion." When confident, fix it; when not, leave the lesson exactly as-is and list it under "left for you" in the summary. Losing a real lesson is worse than carrying a slightly stale one — and git history is the only backstop, so the summary must account for everything removed.

**Apply automatically (high-confidence):**
- **Exact / near-exact duplicates** → merge into the richer entry, delete the lesser, cross-reference if needed.
- **Confirmed-dead references** where the lesson's value depended on the now-deleted selector/file/script/symbol → remove the lesson (or, if only the reference rotted but the insight stands, update the reference and keep the lesson).
- **Explicitly superseded** entries (a newer lesson or current `AGENTS.md` directly replaces them) → remove the obsolete one, ensuring its replacement still carries any unique detail.

**Leave in place, report only (judgment calls):**
- Ambiguous contradictions where current truth isn't clearly established.
- Partial-overlap lessons where merging might drop nuance.
- Age-only flags with no other problem.
- Anything where the evidence is incomplete or you're guessing.

## Preserve the enforced format

Per-system `src/systems/*/LESSONS.md` entries MUST keep, in order: an `## YYYY-MM-DD — title` header, then `**Tried:**`, `**Failed because:**`, `**Fix:**`, `**Tags:**`. `tests/unit/scripts/lessons-format.test.ts` rejects entries missing any of these. When you merge two per-system lessons, the survivor must still be a complete, well-ordered entry. Root `LESSONS.md` and module `AGENTS.md` sections aren't test-enforced but follow the same shape — keep their existing prose/bullet style.

Editing lesson files needs **no** catalog rebuild — `npm run selector:search` reads `LESSONS.md` live. (Only `selectors.ts` edits require `npm run selectors:catalog`.)

## After editing — verify

```bash
npm run test:architecture
```

If `lessons-format.test.ts` fails, you broke a required subsection or header order while merging/removing — **fix the lesson, not the test.** Re-run until green.

## Output — the audit summary

End with a single report so nothing the sweep touched is invisible. Group by action, and within each finding name the file, the lesson title/date, the pass(es) that caught it, and the evidence:

```
## Lesson audit — <date>

Scanned: <N> files (<P> per-system, root, <M> module AGENTS.md sections), <K> lessons total.

### Removed (<count>)
- `src/systems/<sys>/LESSONS.md` — "YYYY-MM-DD title" — [duplicate of "<other>"] / [dead-ref: `<thing>` gone since <evidence>]

### Merged (<count>)
- `<file>` — folded "YYYY-MM-DD a" into "YYYY-MM-DD b" (kept richer; cross-linked)

### Edited (<count>)
- `<file>` — "title" — updated stale reference `<old>` → `<new>` (insight still valid)

### Left for you (<count>)  ← judgment calls, not changed
- `<file>` — "title" — [possible contradiction with <X>; couldn't confirm which is current]

### Oldest still-valid (informational)
- `<file>` — "YYYY-MM-DD title" — verified refs still exist; consider eyeballing

Architecture test: <pass/fail>
```

Keep the report tight. The point is an auditable trail of what changed and why, plus a short list of what needs a human's judgment.
