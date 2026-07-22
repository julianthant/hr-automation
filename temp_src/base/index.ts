/**
 * Layer `base` — rank 2.
 *
 * Owning design doc: `docs/rebuild/01-task-contract.md` — `temp_src/base/task.ts` (line 95:
 * "server-side (may import Playwright types)"), `base/store.ts` (line 407), `base/decorate.ts`
 * (line 494), `base/session.ts` (line 593), plus `base/errors.ts` (§3.1 layout, line 374).
 * Built in master-plan Phase 1 item 1c.
 *
 * Rank rationale: the impl-side primitives (`defineTask`, `defineStore`, the error taxonomy, the
 * session/ctx types). It sits directly above `domain` because it binds contracts to impls — it may
 * import Playwright types, which is exactly what keeps it out of `domain`.
 *
 * Placeholder barrel: see `temp_src/events/index.ts` for why every layer dir lands now.
 */
export {};
