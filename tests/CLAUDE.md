# Tests

Unit tests for pure/near-pure logic. Playwright automation, login flows, and live system interactions are NOT tested here — they require real sessions, Duo MFA, and PII.

## Layout

`tests/unit/` mirrors `src/` one-for-one. A test for `src/foo/bar.ts` lives at `tests/unit/foo/bar.test.ts`.

```
tests/unit/
  auth/            ← src/auth/
  browser/         ← src/browser/
  tracker/         ← src/tracker/
  systems/
    ucpath/        ← src/systems/ucpath/
  utils/           ← src/utils/
  workflows/
    onboarding/    ← src/workflows/onboarding/
    separations/   ← src/workflows/separations/
```

Two test files for the same source module are allowed when they test distinct behaviors (e.g. `utils/log.test.ts` + `utils/log-context.test.ts`).

`tests/integration/` is reserved for future browser-backed integration tests — do not put unit tests there.

## Conventions

- Framework: `node:test` + `node:assert/strict`. No vitest/jest.
- Imports use the `.js` extension (ESM requirement): `import { x } from "../../../src/utils/foo.js"`.
- Filename mirrors the source file: `src/systems/ucpath/types.ts` → `tests/unit/systems/ucpath/types.test.ts`. Do not invent descriptive test names (`transaction-types.test.ts` was wrong — the source is `types.ts`).
- Each `describe` block covers one exported function or type.
- Prefer characterization tests for pure logic: cover documented behavior, edge cases, and any JS quirk that's been pinned (e.g. `Date.setMonth` overflow — see `workflows/separations/schema.test.ts`).

## What belongs here

Pure-logic modules: schemas, date math, mapping tables, reducers, regex classifiers, worker-pool queueing, JSONL I/O, grid layout math, small string helpers.

## What does NOT belong here

- Playwright automation (`src/*/navigate.ts`, `extract.ts`, `enter.ts`)
- Auth/login flows (require Duo MFA)
- Dashboard React hooks (browser-only state + SSE)
- Excel file I/O and screenshot helpers
- CLI command scaffolding (Commander parsing)

## Running

```bash
npm test                    # Run all tests
npm run typecheck:all       # Typecheck tests + src together
node --import tsx/esm --test tests/unit/workflows/separations/schema.test.ts   # Single file
```
