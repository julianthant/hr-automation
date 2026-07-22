/**
 * Layer `stores` — rank 3.
 *
 * Owning design doc: `docs/rebuild/01-task-contract.md` §3.1 (`temp_src/stores/<system>/` layout at
 * line 374: `index.ts` = `defineStore(...)`, `session.ts`, `selectors.ts`, `impl/`, `tasks/`), §3.4
 * (the `extraction` / `ocr` / `roster` service stores, D4). Built in Phase 1 items 1c and 1h.
 *
 * Rank rationale: per-system task impls. They consume `base` (`defineTask`/`defineStore`) and
 * `domain` (contracts), and are consumed by workflow composition above. A store never imports a
 * workflow — charter §1 makes tasks peer-reusable, so reuse flows the other way.
 *
 * Placeholder barrel: see `temp_src/events/index.ts` for why every layer dir lands now.
 */
export {};
