/**
 * Layer `workflows` — rank 4.
 *
 * Owning design doc: `docs/rebuild/02-workflow-model.md` §1.2 "The bundle crossing" (lines 137-140):
 * `temp_src/workflows/<id>/descriptor.ts` (client-safe: zod + domain only) plus `index.ts` (the
 * "server barrel: pairs descriptor with its stores' impls"). Built in Phase 1 item 1d.
 *
 * Rank rationale: a workflow COMPOSES stores — its server barrel imports the stores its contracts
 * resolve in, so it must outrank `stores`. It does NOT own impls (doc 02 §1.2: "There is no
 * per-workflow `handler.ts`"), and it is itself consumed by the registry in `core` (see
 * `temp_src/domain/layers.ts` for why that inverts the old `src/` order).
 *
 * Placeholder barrel: see `temp_src/events/index.ts` for why every layer dir lands now.
 */
export {};
