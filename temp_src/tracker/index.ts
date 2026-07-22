/**
 * Layer `tracker` — rank 5.
 *
 * Owning design doc: `docs/rebuild/03-tracker-dashboard.md` §2 (the `.tracker/` storage layout:
 * `spans/` + `notes/` + `ledger/`), §2.2 (server-side projections), §5 (`temp_src/tracker/compat/
 * lift-legacy.ts`, line 562). Built in master-plan Phase 1 item 1e.
 *
 * Rank rationale: tracker owns the typed span/note EMIT path and the JSONL/SQLite writers —
 * `docs/rebuild/10-guard-test-architecture.md`:§2 (`tracker-row-emission`, RE-DERIVE) bans
 * `appendFileSync` to event JSONL "outside `temp_src/tracker/`". The producers of those events
 * (`core`, `exec`) therefore CALL INTO tracker, so tracker must sit BELOW them. It sits above
 * `workflows` only so it may reach the error taxonomy in `base`; in practice it imports `events` +
 * `domain` and nothing else, and it must never import `core`, `exec`, or `server`.
 *
 * Placeholder barrel: see `temp_src/events/index.ts` for why every layer dir lands now.
 */
export {};
