# Generated Artifacts

This directory holds outputs produced by scripts, analysis tools, and tests. These files are not source of truth.

## Layout

- `schemas/` — JSON Schema exports from workflow Zod schemas. Regenerate with `npm run schemas:export`.
- `pathfinder/` — architecture/pathfinder reports and analysis scratch output.
- `.tracker-test/` and `.tracker-log-test/` — tracker JSONL files produced by unit tests.
- `.e2e-screenshots/` — screenshots captured during E2E/manual browser verification.

Runtime tracker data still belongs in root `.tracker/`; only test/generated tracker output goes here.
