/**
 * Layer `server` — rank 8 (top of the backend tree).
 *
 * Owning design doc: `docs/rebuild/03-tracker-dashboard.md` §2.2, line 269 —
 * `// temp_src/server/topics.ts — SSE topic payloads (all change-gated snapshots, as today)`;
 * §5 lists "new SSE server" as Phase 1 work. Built in master-plan Phase 1 item 1e.
 *
 * Rank rationale: the HTTP/SSE edge. It serves tracker projections, enqueues runs through the
 * registry, and controls executors — so it imports downward across the whole backend and is
 * imported by nothing except `dashboard` (rank 9, not yet created).
 *
 * Placeholder barrel: see `temp_src/events/index.ts` for why every layer dir lands now.
 */
export {};
