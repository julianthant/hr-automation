/**
 * Layer `domain` — rank 1.
 *
 * Owning design docs: `docs/rebuild/01-task-contract.md` §3.1 (the `temp_src/` layout, line 374 —
 * `domain/contracts/` is "bundle-safe: imports zod ONLY"), `docs/rebuild/11-clock-config-secrets.md`
 * (`domain/clock.ts`, `domain/config/{schema,resolve}.ts`, `domain/secrets.ts`),
 * `docs/rebuild/06-data-intake-and-edit-data.md` §1 (`domain/fields/registry.ts`),
 * `docs/rebuild/09-write-safety.md` (`domain/contracts/write-safety.ts`, `domain/ledger.ts`).
 * Built in master-plan Phase 1 items 1b/1c.
 *
 * Rank rationale: the bundle-safe vocabulary layer — zod + pure data only, no Playwright, no I/O.
 * Everything above it may import it; it may import nothing but `events` (rank 0).
 *
 * Placeholder barrel: see `temp_src/events/index.ts` for why every layer dir lands now.
 */
export {};
