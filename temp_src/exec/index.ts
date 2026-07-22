/**
 * Layer `exec` — rank 7.
 *
 * Owning design doc: `docs/rebuild/05-execution-parallelism.md` §2 (line 162,
 * `temp_src/exec/executor.ts` — the workflow-agnostic executor, lanes, claim loop) and §3
 * (line 186, `temp_src/exec/session-pool.ts` — page leases, single-flight login, budgets).
 * Built in master-plan Phase 1 item 1f.
 *
 * Rank rationale: the executor claims runs via the registry (`core`), drives the descriptor run
 * state machine, resolves impls in `stores`, and emits spans through `tracker` — so it outranks all
 * of them. Nothing but `server` may import it.
 *
 * Placeholder barrel: see `temp_src/events/index.ts` for why every layer dir lands now.
 */
export {};
