---
name: custom-hr-lesson
description: Append a structured lesson entry to the right LESSONS.md (or AGENTS.md Lessons Learned section) in hr-automation, in the exact format the architecture test `lessons-format.test.ts` requires — `**Tried:** / **Failed because:** / **Fix:** / **Tags:**`. Routes to the correct file (system-specific vs project-root vs module AGENTS.md) based on the lesson's topic. Invoke after discovering a non-obvious failure mode worth capturing — a selector that broke for a surprising reason, a kernel pattern that bit you, a system quirk worth flagging.
---

# /custom-hr-lesson — Structured lesson logger

The hr-automation repo enforces a specific lesson format via `tests/unit/scripts/lessons-format.test.ts`. Easy to get wrong; this skill enforces the format and routes the entry to the right file.

## When to invoke

Right after discovering something worth flagging for the next session:
- A Playwright selector that failed in a non-obvious way (frame, modal mask, grid index mutation, stale element, etc.)
- A kernel pattern that produced a surprising failure mode
- A system quirk (PeopleSoft modal mask timing, Salesforce Lightning frame navigation, Duo edge case)
- An architectural decision made for a non-obvious reason

**Don't invoke for:**
- Routine bugfixes that don't add new knowledge ("forgot to await a promise")
- Lessons that are already documented
- Trivial discoveries ("the button was on a different page")

## Where the lesson goes

Pick by topic:

| Topic | File |
|---|---|
| UCPath selector or behavior | `src/systems/ucpath/LESSONS.md` |
| CRM (Salesforce) selector or behavior | `src/systems/crm/LESSONS.md` |
| I9 selector or behavior | `src/systems/i9/LESSONS.md` |
| Kuali selector or behavior | `src/systems/kuali/LESSONS.md` |
| OnBase selector or behavior | `src/systems/onbase/LESSONS.md` |
| ServiceNow / SharePoint / Kronos | `src/systems/<system>/LESSONS.md` (these exist: `servicenow`, `sharepoint`, `old-kronos`, `new-kronos`) |
| Other system without an existing `LESSONS.md` | Create one at `src/systems/<system>/LESSONS.md` |
| Kernel / workflow architecture | `LESSONS.md` at the project root |
| Cross-cutting pattern | `LESSONS.md` at the project root |
| Subsystem-specific learning (dashboard, tracker, OCR, etc.) | The relevant module's `AGENTS.md` under its **Lessons Learned** section (different format — see below) |

If it touches multiple systems, pick the primary one and cross-reference the others inside the body of the lesson.

## Before appending — dedupe + supersede check

Lessons are maintained, not append-only. Before you write a new entry, look at its neighbors so you don't grow a duplicate or leave stale guidance standing next to fresh guidance:

1. `npm run selector:search "<intent>"` and read the target file's existing entries on the same topic/tags.
2. If an existing lesson **covers the same thing**, update or extend it instead of adding a second entry.
3. If your new lesson **contradicts** an existing one (the old guidance is now wrong), fix or remove the stale entry in the same edit — don't let both coexist.
4. Only append a brand-new entry when the failure mode is genuinely new.

For a full sweep across *all* lesson stores (dedupe, staleness, broken references, superseded guidance), use the project's `custom-hr-lesson-audit` skill (`.Codex/skills/custom-hr-lesson-audit/`) rather than doing it by hand here.

## Required format — `LESSONS.md` files

Every `## H2` lesson in a `LESSONS.md` file MUST have these four subsections, in this order. The architecture test rejects entries missing any of them.

```markdown
## YYYY-MM-DD — One-line title

**Tried:** What approach was attempted. One paragraph, concrete.

**Failed because:** Root cause. Be specific — "the modal mask intercepts clicks for ~800ms after page nav and there's no DOM event to wait on" beats "the selector didn't work."

**Fix:** What worked, with enough detail to copy. Include code or selector snippets if relevant.

**Tags:** comma, separated, tags — used by `npm run selector:search` and grep. Use existing tags where they fit: `selector`, `peoplesoft-modal`, `frame-navigation`, `kernel`, `daemon`, `auth`, etc.
```

Optional subsections (don't add unless useful):

```markdown
**Selector:** FQN like `ucpath.smartHR.tab.personalData` — if the lesson ties to a registered selector.

**References:** Commit SHAs, GitHub issues, related lessons (link by file + anchor).
```

## Required format — module AGENTS.md `Lessons Learned` sections

A different, lighter format. Module-level `AGENTS.md` files use a flat dated bullet list under a `## Lessons Learned` section:

```markdown
- **YYYY-MM-DD: Title — what changed.** Context, why, any gotchas. One paragraph.
```

Use this form for lessons inside `src/dashboard/AGENTS.md`, `src/tracker/AGENTS.md`, etc. — not the four-subsection format.

## How to write a good lesson

- **Title**: the gotcha in one line, prefixed by date. Future-you scans titles first to find what's relevant.
- **Tried / Failed because / Fix**: assume the reader knows the system but not the specific bug. Don't recap the codebase; do recap the surprising thing in detail.
- **Tags**: think about what future-you would search for. Include the obvious tags (the system, the element type) plus one or two adjacent terms (the workflow context, the broader pattern).
- **Be concrete.** "Selector didn't work" is useless. "Selector matched a stale element after PeopleSoft re-rendered the grid post-save; needed `.first()` because new rows are inserted at top after the re-render" is useful.
- **Link to the fix.** If the lesson came from a specific commit, include the SHA in `**References:**`. Saves future archaeology.

## After writing — verify the format

Run the architecture test:

```bash
npm run test:architecture
```

If `lessons-format.test.ts` fails, the lesson is missing a required subsection or has them out of order. **Fix the lesson, not the test.** The format exists so `npm run selector:search` can mine these files.

**Scope of the test:** `lessons-format.test.ts` validates only the per-system files under `src/systems/*/LESSONS.md`. The project-root `LESSONS.md` and module-level `AGENTS.md` Lessons Learned sections are NOT validated by the test — but they still benefit from the same structure for consistency and grep-ability. Be careful with project-root entries: a malformed entry will silently pass CI.

## Cross-referencing

If two lessons touch the same selector or pattern, add a `**References:**` line to each pointing at the other (by file and date — anchors look like `src/systems/ucpath/LESSONS.md#2026-04-23-modal-mask-timing`). Avoids future drift between independent rediscoveries.
