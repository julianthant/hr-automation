# Performance Review — Tier 1: Daemon Fetch Timeouts

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A wedged daemon must not hang dashboard ops endpoints (`/api/retry`, `/api/daemons/spawn`, `/api/daemons/stop`, `/api/daemon/stop`, OCR `approve-batch`). Add `AbortSignal.timeout()` to every `fetch()` against `127.0.0.1:<daemon-port>` so a hung daemon's socket is dropped after a bounded wait and the calling handler can return.

**Architecture:** Four call sites all use the same shape — `fetch('http://127.0.0.1:${port}/...', { method: 'POST', ... }).catch(() => {})`. Adding `signal: AbortSignal.timeout(ms)` causes `fetch` to reject with an `AbortError` after the deadline; the existing `.catch(() => {})` handlers absorb it. No new error types, no new fields, no caller-side changes.

Timeout policy:
- `/wake` (fire-and-forget on enqueue): **2000ms**. Wake is best-effort; on loopback this is generous.
- `/stop`, `/force-current`: **5000ms**. These can legitimately wait for a cooperative drain.

**Tech Stack:** Node 26 (uses `AbortSignal.timeout`, no polyfill needed).

**Verification (run before and after each task):**
- `npm run typecheck` — must pass.
- `npm run test:architecture` — must pass.

**Out of scope:** No HTTP `Agent` / `keepAlive` changes — connection-pool exhaustion is **not** the real bottleneck on loopback (each daemon is its own origin; undici's default per-origin pool is fine). Two independent perf reviews concluded the same. Don't be tempted.

---

## Task 1: Add timeouts to all four daemon-port `fetch` sites

**Files:**
- Modify: `src/core/daemon/client.ts:286-292` (`/wake` fan-out)
- Modify: `src/core/daemon/client.ts:333-343` (`/stop` fan-out)
- Modify: `src/tracker/dashboard/ops/cancel.ts:94-98` (`/force-current`)
- Modify: `src/tracker/dashboard/ops/worker-control.ts:57-61` (`/stop`)

- [ ] **Step 1: Verify baseline is green**

```bash
npm run typecheck
npm run test:architecture
```

Expected: both pass. If either fails, stop — do not start editing. Report what failed.

- [ ] **Step 2: Edit `src/core/daemon/client.ts:286-292` — `/wake` fan-out (2s timeout)**

Replace:

```ts
    // Step 5: wake every alive daemon (alive ∪ spawned). Fire-and-forget;
    // a wake failure on one daemon doesn't block the others.
    await Promise.all(
      daemons.map((d) =>
        fetch(`http://127.0.0.1:${d.port}/wake`, { method: 'POST' }).catch(() => {
          /* ignore — wake is best-effort */
        }),
      ),
    )
```

With:

```ts
    // Step 5: wake every alive daemon (alive ∪ spawned). Fire-and-forget;
    // a wake failure on one daemon doesn't block the others. The 2s timeout
    // bounds the wait when a daemon's event loop is wedged — without it,
    // a hung daemon would block this Promise.all until the OS times out
    // the socket (typically ~120s), pegging the dashboard's enqueue path.
    await Promise.all(
      daemons.map((d) =>
        fetch(`http://127.0.0.1:${d.port}/wake`, {
          method: 'POST',
          signal: AbortSignal.timeout(2_000),
        }).catch(() => {
          /* ignore — wake is best-effort (incl. AbortError on timeout) */
        }),
      ),
    )
```

- [ ] **Step 3: Edit `src/core/daemon/client.ts:333-343` — `/stop` fan-out (5s timeout)**

Replace:

```ts
  await Promise.all(
    alive.map((d) =>
      fetch(`http://127.0.0.1:${d.port}/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force }),
      }).catch(() => {
        /* ignore — the daemon may already be tearing down */
      }),
    ),
  )
```

With:

```ts
  await Promise.all(
    alive.map((d) =>
      fetch(`http://127.0.0.1:${d.port}/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force }),
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {
        /* ignore — the daemon may already be tearing down (incl. AbortError) */
      }),
    ),
  )
```

- [ ] **Step 4: Edit `src/tracker/dashboard/ops/cancel.ts:94-98` — `/force-current` (5s timeout)**

Replace:

```ts
    const res = await fetch(`http://127.0.0.1:${worker.port}/force-current`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId, runId }),
    });
    return res.ok;
```

With:

```ts
    const res = await fetch(`http://127.0.0.1:${worker.port}/force-current`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId, runId }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
```

- [ ] **Step 5: Edit `src/tracker/dashboard/ops/worker-control.ts:57-61` — `/stop` (5s timeout)**

Replace:

```ts
    const res = await fetch(`http://127.0.0.1:${worker.port}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
    return res.ok;
```

With:

```ts
    const res = await fetch(`http://127.0.0.1:${worker.port}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
```

- [ ] **Step 6: Re-run verification**

```bash
npm run typecheck
npm run test:architecture
```

Expected: both pass. The change is type-safe (`AbortSignal.timeout` is in lib.dom.d.ts and lib.es2024) and adds no inline selectors, default exports, or other architecture-test triggers.

- [ ] **Step 7: Commit**

```bash
git add src/core/daemon/client.ts src/tracker/dashboard/ops/cancel.ts src/tracker/dashboard/ops/worker-control.ts
git commit -m "$(cat <<'EOF'
perf(daemon): add AbortSignal.timeout to cross-daemon fetch sites

A wedged daemon's HTTP server (mid-Playwright RPC, mid-keepalive
healthCheck, sync DB write) keeps its socket open until the OS times
out — typically ~120s. The dashboard's /api/retry, /api/daemons/spawn,
/api/daemons/stop, /api/daemon/stop, and OCR approve-batch handlers
await Promise.all over fetch(...) on every alive daemon's port; one
hung daemon blocks the whole handler until the socket drops, freezing
the UI.

Add AbortSignal.timeout to every fetch against 127.0.0.1:<daemon-port>:
- /wake fan-out: 2s (fire-and-forget on enqueue)
- /stop, /force-current: 5s (allows cooperative drain)

The existing .catch(() => {}) handlers absorb the AbortError. No
behavior change in the happy path; bounded wait in the wedged case.

Surfaced by a perf-review pass on the daemon + dashboard subsystems.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Expected: commit succeeds.

---

## Self-review checklist

- [ ] All four call sites edited (search: `rg "fetch\(\`http://127\.0\.0\.1" src/`).
- [ ] `npm run typecheck` passes.
- [ ] `npm run test:architecture` passes.
- [ ] Commit message names the four call sites.
- [ ] No `http.Agent`, no `keepAlive`, no library swap — purely additive `signal:` field on existing fetches.

---

## Handoff to Tier 2

Once Tier 1 has merged to master, **start a fresh session in `/Users/julianhein/Documents/hr-automation`** and paste the prompt below. Each tier intentionally runs in its own session: Tier 2 has nine independent tasks that benefit from a fresh subagent context per task, and parallel dispatch needs a fresh orchestrator unblocked by stale tool state.

```
Read docs/superpowers/plans/2026-05-07-perf-tier-2-high-impact.md and execute it via superpowers:subagent-driven-development. Tier 1 (daemon fetch timeouts) is already merged on master — verify with `git log --oneline -5` before starting. Default subagent model is Sonnet; you (the orchestrator) are Opus. Dispatch tasks in parallel where the plan says they're independent (each subagent gets a worktree + branch per ~/.claude/CLAUDE.md), sequential where it says sequential. Don't review subagent diffs between tasks — trust the per-task verification gates (typecheck + test:architecture + relevant unit test); I'll review at the end.
```
