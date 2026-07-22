/**
 * Layer `core` — rank 6.
 *
 * Owning design doc: `docs/rebuild/02-workflow-model.md` §1.2, line 161 —
 * `// temp_src/core/workflow-registry.ts      (server only — the WORKFLOW_LOADERS successor)`,
 * whose `SERVER_REGISTRY` maps each workflow id to `{ descriptor, loadStores }`.
 * Built in master-plan Phase 1 item 1d.
 *
 * Rank rationale (the deliberate inversion): `core` holds each workflow's descriptor and the lazy
 * store loaders, so it imports `workflows/<id>/descriptor.ts`. That is the OPPOSITE of the old
 * `src/` order (`core → control/workflows`, project CLAUDE.md). Full argument + citation in
 * `temp_src/domain/layers.ts`.
 *
 * Placeholder barrel: see `temp_src/events/index.ts` for why every layer dir lands now.
 */
export {};
