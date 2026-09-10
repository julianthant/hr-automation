# 2026-06-11 fix execution — COMPLETE; only live re-verification remains

Every code item from the 2026-06-11 review/live-test handoff has landed on
master (final merge `0d83e4e0`). Suite: typecheck:all · 2,524 unit+delegation
tests · 75 architecture guards · lint — all green. Do NOT re-fix anything;
the only open work is a live verification pass of behavior that is so far
unit-tested only.

## Adjudicated do-not-do items (decided, documented — don't reopen)

- `runtimePolicy.prepRow`/`memberRow` KEPT: still load-bearing in projection
  title/subtitle fallback; removing them is a projection-layer refactor, not a
  vocab deletion (see src/workflows/CLAUDE.md).
- Orchestrator `runFanOutPhase` + reocr-whole-pdf NOT migrated onto
  `fanOutAndWatch`: SQLite dependency-batch mode and the 202-boundary
  dispatch/watch split are genuinely different shapes (see
  src/services/ocr/CLAUDE.md BM-1 lesson).

## Live re-verification checklist (playwright-cli, dryRun where applicable)

1. Queue-row Cancel on a RUNNING standalone OCR run → aborts within ~1s, row
   stays Cancelled (was: resumed running/ocr → person-lookup).
2. Cancel during enrichment → queued person-lookup/i9 children cascade-cancel.
3. OCR name consistency: repeated single-oath.pdf runs → `[ocr/second-opinion]`
   lines fire on weak-model misreads and the name self-corrects; pages prefer
   tier-1 models when free.
4. Re-run paths (force-research on EC rows, retry-page, verify per-check ↻,
   reocr-whole-pdf) still behave after the fanOutAndWatch/BM-5/BM-6 rewrite —
   trace prefixes shared, snapshots re-emit correctly.
5. EC: standalone trace is now `ec-`; deferred auth (Duo at claim time);
   blank-EID records are not fannable.
6. Per-record lookup labels need per-record evidence (no "running…" leak).
7. Sleep-purge lanes live-check: separations, searchPerson, login, oath
   enter.ts, kronos, sharepoint (conservative replacements, unverified live).
8. RunModal: formType + SharePoint ref reset on reopen; multi-file duplicate
   banner; per-tick re-render gone.

## Env notes

- Restart `npm run dashboard` before verifying (backend doesn't hot-reload).
- `DEBUG_SCREENSHOTS=1` gates debugScreenshot; `OCR_SECOND_OPINION_MAX`
  (default 5) caps suspect re-reads.
