---
name: review-code
description: Review code changes using parallel code-reviewer, performance-reviewer, code-simplifier, and doc-reviewer subagents. Sizes the fan-out automatically — single subagents for small diffs, multiple parallel reviewers split by area for large diffs. The doc-reviewer is dispatched only when the diff touches docs/comments/docstrings — code-only diffs skip it. Accepts a flexible target — current unstaged/staged changes (default), a specific commit, a commit range, a branch, or a PR number. Skips security review by design; the user is solo and has explicitly opted out. Invoke when the user types `/review-code`, or explicitly asks to "review the changes", "check the last commit", "review the diff", etc.
---

# /review-code — Parallel code + performance + simplification + docs review

Run `code-reviewer:code-reviewer`, `performance-reviewer:performance-reviewer`, `code-simplifier:code-simplifier`, and (conditionally) `doc-reviewer:doc-reviewer` subagents in parallel against a target diff, sized smartly, then aggregate all findings into a single comprehensive report. **No edits during this pass** — the orchestrator synthesizes subagent findings and presents them as cohesive, actionable recommendations. The user decides what to act on next.

The orchestrator's job: pick the target, size the fan-out, dispatch all subagents, synthesize findings into a coherent whole, report. No editing, no fixing — that's a separate motion after the report.

## 1. Pick the target

Recognize these target forms from the user's invocation:

| User said | Target |
|---|---|
| `/review-code` (no arg) | Current uncommitted changes — staged + unstaged (`git diff HEAD`) |
| "the last commit" / `HEAD` | `git show HEAD` |
| "the last N commits" / `HEAD~N..HEAD` | That range |
| A specific SHA | `git show <sha>` |
| A range like `master..HEAD` or branch name | That range |
| A PR number | `gh pr diff <num>` |

If ambiguous (e.g. user says "review what I just did" with both uncommitted changes and recent commits present), ask once: "Unstaged changes, last commit, or a specific range?"

## 2. Size the diff

Before dispatching, run these in parallel:

```bash
git diff <target> --stat
git diff <target> --shortstat
```

Use line and file counts to pick a tier:

| Tier | Size | Fan-out (always parallel) |
|---|---|---|
| **Small** | ≤200 lines OR ≤5 files | 1 code-reviewer + 1 performance-reviewer + 1 code-simplifier |
| **Medium** | 200–800 lines AND 5–15 files | 1 code-reviewer + 1 performance-reviewer + 1 code-simplifier |
| **Large** | 800–2000 lines OR 15–40 files | Split into 2–3 file groups by area. One code-reviewer per group + 1 performance-reviewer over the whole diff + 1 code-simplifier over the whole diff. |
| **XL** | >2000 lines OR >40 files OR multi-commit history | Split by commit (preferred when each commit is coherent) or by top-level directory. One code-reviewer per group + 1 performance-reviewer per group + 1 code-simplifier per group. |

**Doc-reviewer is conditional**, regardless of tier. Dispatch one (or more, for XL diffs) if the diff includes any of:
- Markdown files (`.md`, `.mdx`, `.rst`) — especially `README*`, `CLAUDE.md`, `LESSONS.md`, `docs/**`
- Substantial changes to JSDoc / TSDoc / docstring blocks
- New exported APIs without accompanying doc updates (the reviewer flags missing docs)

Check via `git diff <target> --name-only | grep -E '\\.(md|mdx|rst)$|README'` plus a quick scan of code-diff hunks for `/**` block changes. If none apply, skip the doc-reviewer — code-only diffs don't need it.

Tiers are guidelines, not hard rules — use judgment:
- A 50-line diff touching three unrelated subsystems may still warrant split reviewers.
- A 1500-line refactor of one file is one reviewer's job.
- A multi-commit range where each commit is its own coherent change is best split per-commit, regardless of line count.

## 3. Dispatch the subagents

**Issue all Agent tool calls in a single message** so subagents run concurrently. Parallel dispatch is the whole point — sequential dispatch defeats the design.

Each subagent's prompt must include:

**For `code-reviewer:code-reviewer`:**
- Target identifier (commit SHA, range, "current changes")
- Exact diff scope — the file list, or "all files in `<range>`"
- Project context (1–2 sentences from CLAUDE.md — what the codebase is)
- "Output high-priority findings only: bugs, logic errors, convention violations, real risks. Skip cosmetic nits unless systemic. Format each finding as `file.ts:42 — short description`."
- **"Do NOT do a security review — out of scope for this run."**
- **"Do NOT make any edits — read-only review only. Report findings."**

**For `performance-reviewer:performance-reviewer`:**
- Same target/scope
- "Output real perf concerns: memory leaks, N+1 queries, blocking I/O on hot paths, bundle bloat, runtime bottlenecks. Skip micro-optimizations. Format `file.ts:120 — short description`."
- **"Do NOT make any edits — read-only review only. Report findings."**

**For `code-simplifier:code-simplifier`:**
- Same target/scope
- "Review the changed code for opportunities to simplify: unnecessary complexity, redundant abstractions, readability improvements, naming clarity, over-engineering. Preserve all functionality. Do NOT apply changes — report findings only as `file.ts:42 — short description of simplification opportunity`."
- **"Read-only pass. No edits. Surface what could be simplified if acted on."**

**For `doc-reviewer:doc-reviewer` (when dispatched):**
- Same target/scope, but focus on documentation files and docstring/comment changes
- Project context (what the codebase is, what conventions exist around docs)
- "Output documentation findings: stale docs that no longer match the code (cross-reference against the actual source), missing docs for newly exported APIs, broken or outdated cross-references, inconsistent terminology between docs and code, unclear or incomplete passages where readers would get stuck. Skip stylistic prose nits and grammar unless it changes meaning. Format `file.md:42 — short description` or `file.ts:42 (doc comment) — short description`."
- "If the diff includes code that contradicts a claim in an existing doc that wasn't touched, flag it — that's stale doc, not out-of-scope."
- **"Do NOT make any edits — read-only review only. Report findings."**

When fanning out to multiple code-reviewers over file groups, each gets a non-overlapping subset of files so they don't duplicate work.

## 4. Aggregate

When all subagents return:

1. **Dedupe** — if two reviewers flag the same `file:line`, merge into one finding (keep the more specific description; note if both code quality and simplification concern meet).
2. **Rank by severity** — bugs / logic errors / data corruption > convention violations > simplification opportunities > style nits.
3. **Group by file** — the reader wants "what's wrong with file X", not "what does reviewer 1 think."
4. **Spot-check suspicious claims** — if a finding references an unfamiliar file:line, read it before reporting. Subagents occasionally hallucinate locations.
5. **Identify cross-cutting themes** — if multiple reviewers flag issues in the same area (e.g., error handling throughout the daemon layer, naming inconsistency across 3 files), surface that as a theme at the top, not just isolated line findings.

## 5. Report

Use this structure:

```
## Review summary
Reviewed N files / M lines across K commits. Fan-out: <tier> (<X code + Y perf + Z simplifier + W doc subagents>).

3 high-priority findings, 5 medium, 2 simplification opportunities, 1 perf concern, 2 doc issues.

[Cross-cutting themes, if any:]
> **Theme:** Error handling — 3 separate files are swallowing errors in the daemon layer without re-throwing. Cohesive fix: add a shared error boundary helper.

## High priority
- **file.ts:42** — <one-sentence description>
- **other.tsx:88** — ...

## Medium priority
- ...

## Simplification opportunities
- **file.ts:18** — <what could be simplified and why>
- ...

## Performance
- **file.ts:120** — ...

## Documentation
- **CLAUDE.md:88** — <stale claim / missing doc / inconsistency>
- **file.ts:42 (doc comment)** — ...
```

Omit sections with no findings — don't print "Simplification: none". If doc-reviewer wasn't dispatched, the section simply doesn't appear. If a subagent returned nothing for its slice, say so plainly. Don't pad findings to look thorough.

Cross-cutting themes are the most valuable output — if patterns appear across multiple files or subsystems, make those visible so the user can plan a cohesive fix rather than whack-a-mole individual lines.

## Important

- **No edits during review.** This pass is read-only. Subagents report; the orchestrator synthesizes. Edits, fixes, and refactors happen in a separate motion after the user has seen the full picture.
- **No security review.** Explicit opt-out. Do not add a subagent type for it.
- **Always use `code-reviewer:code-reviewer`** (dotclaude agent) — not `code-reviewer` or `feature-dev:code-reviewer`.
- **Always include `code-simplifier:code-simplifier`** — simplification findings belong alongside correctness and perf findings.
- **Parallel dispatch is the whole point.** Send all Agent calls in one message. Sequential dispatch defeats the design.
- **The orchestrator synthesizes — don't spawn a "synthesis subagent."** That just adds latency.
- **Size up first.** Don't skip `git diff --stat`. A 50-line diff and a 3000-line diff need different fan-outs.
- **Trust but verify.** Subagent findings reference file:line. Before reporting a non-obvious one as high priority, glance at the actual line.
- **Surface themes over line-items.** Individual findings are useful; cross-cutting patterns are more valuable. If three files share the same structural problem, say so once and describe the cohesive fix.
