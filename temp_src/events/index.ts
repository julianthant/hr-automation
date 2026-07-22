/**
 * Layer `events` — rank 0 (the bottom of the tree).
 *
 * Owning design doc: `docs/rebuild/03-tracker-dashboard.md` (§1.2 wire/at-rest contract; line 62
 * declares `temp_src/events/types.ts` "the wire/at-rest contract. ZERO imports (leaf module)").
 * Built in master-plan Phase 1 item 1e.
 *
 * Rank rationale: a genuine zero-import leaf. Sitting at rank 0 is what makes the layer matrix
 * enforce that literally — nothing outranks it, so nothing is importable FROM here.
 *
 * Placeholder barrel: the directory must be tracked by git and covered by tsconfig + eslint +
 * `test:architecture` from the first commit — charter `docs/rebuild/00-charter.md`:118-119
 * ("Same quality umbrella from day one … No ungated parallel tree").
 */
export {};
