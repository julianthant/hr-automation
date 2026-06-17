# Generated Artifacts

Outputs produced by scripts, analysis tools, and tests. None of this is a source
of truth — it's all re-created on demand, so everything except the tracked
directory shells (this file, `schemas/README.md` + `.gitkeep`) is gitignored.

The top level stays clean on purpose: tracked structure is visible, and all
run-scratch hides in the two dot-dirs (`.e2e/`, `.tests/`).

## Layout

- `schemas/` — JSON Schema exports from workflow Zod schemas. Regenerate with
  `npm run schemas:export`; the `*.schema.json` files are gitignored.
- `pathfinder/` — architecture/pathfinder reports and analysis scratch.
- `reports/` — one-off generated HTML reports (e.g. `claude-improvements-*.html`).
- `.e2e/` — **all** e2e-test run artifacts, unified (the `e2e-test` skill owns this):
  - `tracker/` — the dashboard's isolated tracker data during a stub-lane run
    (`HRAUTO_TRACKER_DIR`), including the `e2e-gates/` hold files. This is the
    *app's* output, pointed here so it never pollutes real `.tracker/`.
  - `runs/<YYYYMMDD-HHMM>/` — the *harness's* own per-run bookkeeping:
    `manifest.jsonl`, `issues.jsonl`, `api/` state dumps, `report.html`,
    `handoff.md`, plus `tools/` and `CURRENT_RUN_TS`.
- `.tests/` — tracker output written by unit tests, one dir per test:
  `tracker/` (jsonl), `log/` (log-context), `log-validator/` (log-entry-validator).

Runtime tracker data still belongs in root `.tracker/`; only test/generated
tracker output goes here. E2E screenshots live at root `.screenshots/e2e/<ts>/`
(the standing screenshot convention), not under `generated/`.
