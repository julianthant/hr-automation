# SSE Multiplex Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dashboard's seven separate SSE EventSource connections with a single multiplex hub. Eliminates Chrome's HTTP/1.1 6-per-origin connection-pool saturation as a saturation risk for current and future real-time features.

**Architecture:**

- **Backend:** A new `GET /events/hub?subs=<urlencoded JSON>` endpoint owns SSE plumbing for the dashboard. Each existing topic (entries, logs, run-events, sessions, telegram, capture-sessions, daemon-log) is refactored into a `TopicEmitter<P>` function — `(params, send) => stop` — registered in a topic registry. The hub composes N emitters into one connection per client. Existing `/events/*` and `/api/capture/sessions/stream` endpoints are kept until the frontend migration completes, then deleted.
- **Frontend:** A singleton `SseHub` (`src/dashboard/lib/sse-hub.ts`) exposes `subscribe(topic, params, onMessage) => unsubscribe`. Subscription set changes are batched via `queueMicrotask` so a single render tick produces at most one EventSource reconnect. The wire format (envelope: `{sub, data, event?}`) is demuxed in the hub and dispatched to per-subscription listeners. All seven hooks rewrite their internals to use the hub, preserving public API.

**Tech Stack:** Hono SSE on the backend (existing `sseResponse` helper), browser EventSource on the frontend, Node test runner for unit tests.

**Plan caveats:**

- Tasks are **sequential on master** — they share files (topic registry, hooks file structure) and each builds on the previous. No worktrees.
- Each task ends with a commit. Subsequent tasks read the committed state.
- Existing SSE behavior must continue to work through Tasks 1–4 (legacy endpoints stay alongside hub). Removal happens only in Task 7.

---

## File Inventory

**Created:**

- `src/tracker/dashboard/hono/topics.ts` — `TopicEmitter<P>` type, `topicRegistry`, `parseSubsQuery`.
- `src/tracker/dashboard/hono/topics-emitters.ts` — Per-topic emitter implementations (extracted from existing handlers).
- `src/tracker/dashboard/hono/routes/hub.ts` — `/events/hub` route registration.
- `src/dashboard/lib/sse-hub.ts` — Singleton `SseHub` client.
- `tests/unit/dashboard/hono/hub.test.ts` — Backend hub tests.
- `tests/unit/dashboard/sse-hub-client.test.ts` — Frontend client tests.

**Modified:**

- `src/tracker/dashboard/hono/routes/events.ts` — Each handler refactored to delegate to its topic emitter (legacy endpoints become 1-line wrappers around the same emitter).
- `src/tracker/dashboard/hono/app.ts` — Register `/events/hub` route.
- `src/dashboard/components/hooks/useEntries.ts`
- `src/dashboard/components/hooks/useLogs.ts`
- `src/dashboard/components/hooks/useRunEvents.ts`
- `src/dashboard/components/hooks/useSessions.ts`
- `src/dashboard/components/hooks/useTelegramToasts.ts`
- `src/dashboard/components/hooks/useCaptureToasts.ts`
- `src/dashboard/components/hooks/useCaptureSession.ts`
- `src/dashboard/components/terminal-drawer/DaemonLogTail.tsx` (or wherever the daemon-log EventSource lives — verify path during execution).

**Deleted (Task 7 only):**

- The legacy route bodies for `/events`, `/events/logs`, `/events/run-events`, `/events/sessions`, `/events/telegram`, `/events/daemon-log`, `/api/capture/sessions/stream`. The shared emitter functions stay; only the legacy route handlers go.

---

## Wire Format

**Subscription request** (`subs` query param, URL-encoded JSON array):

```ts
type Subscription = {
  id: string;          // client-assigned, unique within the connection
  topic: string;       // matches a key in topicRegistry
  params: unknown;     // topic-specific, opaque to the hub
};
```

**Server → client envelope** (each `data:` SSE line):

```ts
type HubEnvelope = {
  sub: string;         // matches Subscription.id
  data: unknown;       // whatever the topic emitter sent
  event?: string;      // optional event name (capture-sessions topic uses this)
};
```

The hub itself only emits `event:` lines for SSE-protocol-level events (`open`, `error`); per-subscription events are encoded inside the envelope's `event` field.

---

## Topic Registry Contract

```ts
// src/tracker/dashboard/hono/topics.ts

export type TopicSend = (data: unknown, event?: string) => void;
export type TopicStop = () => void | Promise<void>;
export type TopicEmitter<P = unknown> = (params: P, send: TopicSend, deps: DashboardHonoDeps) => TopicStop;

export const topicRegistry = new Map<string, TopicEmitter<any>>();

export function registerTopic<P>(name: string, emitter: TopicEmitter<P>): void {
  topicRegistry.set(name, emitter as TopicEmitter<unknown>);
}

export function parseSubsQuery(raw: string | undefined): Subscription[] | { error: string } { ... }
```

Each topic emitter implements its own filtering, polling, and first-tick logic — same as the existing handlers, just decoupled from `sseResponse`.

---

## Task 1: Backend hub plumbing + telegram emitter

**Goal:** Land the `/events/hub` endpoint with a single emitter (telegram — the simplest, no params, periodic polling) end-to-end. Establishes the pattern for the remaining emitters.

**Files:**
- Create: `src/tracker/dashboard/hono/topics.ts`
- Create: `src/tracker/dashboard/hono/topics-emitters.ts`
- Create: `src/tracker/dashboard/hono/routes/hub.ts`
- Create: `tests/unit/dashboard/hono/hub.test.ts`
- Modify: `src/tracker/dashboard/hono/app.ts` (register the route)
- Modify: `src/tracker/dashboard/hono/routes/events.ts` (`/events/telegram` handler delegates to `telegramTopic` emitter)

**Steps:**

- [ ] **Step 1: Read existing structure.** Read `src/tracker/dashboard/hono/sse.ts`, `src/tracker/dashboard/hono/routes/events.ts:403-423` (current telegram handler), `src/tracker/dashboard/hono/app.ts` to confirm route registration pattern, `src/tracker/dashboard/hono/context.ts` for `DashboardHonoDeps` shape.

- [ ] **Step 2: Create `topics.ts` with the contract.** Export `TopicSend`, `TopicStop`, `TopicEmitter<P>`, `Subscription`, `HubEnvelope`, `topicRegistry`, `registerTopic`, `parseSubsQuery`. `parseSubsQuery` decodes a URL-encoded JSON array and returns `Subscription[]` or `{ error: string }`. Validate: must be array, each item has string `id`, string `topic`, `params` may be anything. IDs must be unique within the request.

- [ ] **Step 3: Create `topics-emitters.ts` with `telegramTopic`.** Extract the body of the current `/events/telegram` handler into `telegramTopic: TopicEmitter<{}>`: returns `setInterval(... readSessionEventsTolerant + filter + first-tick/delta, 1000)` and a stop function. `registerTopic("telegram", telegramTopic)` at module-load.

- [ ] **Step 4: Create `routes/hub.ts`.** Export `registerHubRoute(app, deps)` that adds `GET /events/hub`:
  1. Parse `c.req.query("subs")`. On invalid → 400 JSON error.
  2. Resolve each subscription's emitter from `topicRegistry`. Unknown topic → log warn + skip that sub (don't fail the whole connection).
  3. `return sseResponse((send) => { ... })` where the body composes per-sub `send` wrappers: `(data, event) => send({ sub: subId, data, ...(event ? { event } : {}) })`.
  4. Track `stops: TopicStop[]`. On cleanup: `await Promise.allSettled(stops.map(s => s()))`.

- [ ] **Step 5: Wire it into `app.ts`.** Import and call `registerHubRoute(app, deps)` next to `registerEventRoutes(app, deps)`. Order doesn't matter since paths don't overlap.

- [ ] **Step 6: Refactor `/events/telegram` to share emitter.** Update the existing handler at `routes/events.ts:403` so its body becomes `return sseResponse((send) => telegramTopic({}, send, deps));`. The duplicated polling logic now lives in one place.

- [ ] **Step 7: Write tests.** `tests/unit/dashboard/hono/hub.test.ts`:
  - Test that `parseSubsQuery` rejects malformed input (not JSON, not array, missing fields, duplicate IDs).
  - Test that `parseSubsQuery` parses a valid telegram-only request.
  - Integration: spin up `createDashboardServer` on a random port (see existing test pattern), `fetch` `/events/hub?subs=<encoded>` with a telegram sub, write a `telegram_sent` event to a temp dir's session JSONL, assert the SSE stream produces an envelope with `sub: "s1"` and the event in `data`.
  - Test that legacy `/events/telegram` still works (unchanged behavior).

- [ ] **Step 8: Run tests.** `npm run test -- tests/unit/dashboard/hono/hub.test.ts` → expect PASS. Then `npm run test` → expect no regressions. Then `npm run typecheck` and `npm run test:architecture` → expect PASS.

- [ ] **Step 9: Commit.**

```bash
git add src/tracker/dashboard/hono/topics.ts src/tracker/dashboard/hono/topics-emitters.ts src/tracker/dashboard/hono/routes/hub.ts src/tracker/dashboard/hono/app.ts src/tracker/dashboard/hono/routes/events.ts tests/unit/dashboard/hono/hub.test.ts
git commit -m "feat(dashboard): SSE multiplex hub plumbing + telegram emitter"
```

---

## Task 2: Migrate `entries` and `sessions` topics

**Goal:** Move the two always-on no-/single-param topics onto the hub. Both have a simple "compute current state every 1s, send" shape (no first-tick/delta), making them straightforward.

**Files:**
- Modify: `src/tracker/dashboard/hono/topics-emitters.ts` (add `entriesTopic`, `sessionsTopic`)
- Modify: `src/tracker/dashboard/hono/routes/events.ts` (`/events` and `/events/sessions` delegate to emitters)
- Modify: `tests/unit/dashboard/hono/hub.test.ts` (add tests)

**Steps:**

- [ ] **Step 1: Read existing handlers.** `routes/events.ts:425-457` (current `/events` and `/events/sessions`).

- [ ] **Step 2: Implement `entriesTopic`.**
  - Params: `{ workflow?: string; date?: string }` — `workflow` defaults to `getDefaultWorkflow(deps)` if absent or empty; `date` defaults to `dateLocal()`.
  - Body: copy the tick logic from the legacy handler (SQLite-or-JSONL fallback) into the emitter. Same 1s `setInterval`. Cleanup clears the interval.
  - `registerTopic("entries", entriesTopic)`.

- [ ] **Step 3: Implement `sessionsTopic`.**
  - Params: `{}`.
  - Body: copy the tick logic — `send(filterLiveSessionState(getCachedSessionState(deps.dir)))` every 1s.
  - `registerTopic("sessions", sessionsTopic)`.

- [ ] **Step 4: Refactor legacy handlers to delegate.** `/events` becomes `return sseResponse((send) => entriesTopic({ workflow: c.req.query("workflow"), date: c.req.query("date") }, send, deps));`. `/events/sessions` becomes `return sseResponse((send) => sessionsTopic({}, send, deps));`.

- [ ] **Step 5: Add tests.**
  - Hub with two subscriptions (`entries` for some workflow + `sessions`) returns two interleaved envelopes within ~2.5 seconds.
  - Legacy `/events?workflow=X` still emits the same payload shape it did before.
  - Legacy `/events/sessions` unchanged.

- [ ] **Step 6: Verify.** `npm run test`, `npm run typecheck`, `npm run test:architecture`. All PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/tracker/dashboard/hono/topics-emitters.ts src/tracker/dashboard/hono/routes/events.ts tests/unit/dashboard/hono/hub.test.ts
git commit -m "feat(dashboard): migrate entries + sessions topics to hub registry"
```

---

## Task 3: Migrate `logs` and `runEvents` topics

**Goal:** Move the two parameterized first-tick+delta topics onto the hub. These have richer params (workflow + id + runId + date) and stateful per-subscriber `sentCount` tracking.

**Files:**
- Modify: `src/tracker/dashboard/hono/topics-emitters.ts` (add `logsTopic`, `runEventsTopic`)
- Modify: `src/tracker/dashboard/hono/routes/events.ts` (`/events/logs` and `/events/run-events` delegate)
- Modify: `tests/unit/dashboard/hono/hub.test.ts`

**Steps:**

- [ ] **Step 1: Read existing handlers.** `routes/events.ts:284-326` (logs), `routes/events.ts:328-401` (run-events).

- [ ] **Step 2: Implement `logsTopic`.**
  - Params: `{ workflow?: string; id?: string; runId?: string; date?: string }`. Defaults match legacy: workflow → `getDefaultWorkflow(deps)`, others → `""`.
  - Body: identical structure to legacy (`firstTick` + `sentCount` + 500ms tick + filter by runId + date branching). Preserve the `log.e2e` calls — they're useful for debugging.
  - `registerTopic("logs", logsTopic)`.

- [ ] **Step 3: Implement `runEventsTopic`.**
  - Params: `{ workflow?: string; runId?: string; date?: string }`.
  - Body: identical structure to legacy (SQLite-or-JSONL with the projection guard, `filterEventsForRun`, 500ms tick, `firstTick` + `sentCount`).
  - `registerTopic("runEvents", runEventsTopic)`.

- [ ] **Step 4: Refactor legacy handlers to delegate.** Each becomes a 1-line `return sseResponse((send) => topic(params, send, deps));` form.

- [ ] **Step 5: Add tests.**
  - Hub subscription with `topic: "logs"` and a known workflow/id/runId/date returns the same first-tick payload as the legacy endpoint.
  - Hub subscription with `topic: "runEvents"` returns a payload that matches the legacy endpoint.
  - Two `logs` subscriptions on the same hub with different params get correctly demuxed (verify by id of the envelope).

- [ ] **Step 6: Verify.** `npm run test`, `npm run typecheck`, `npm run test:architecture`. All PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/tracker/dashboard/hono/topics-emitters.ts src/tracker/dashboard/hono/routes/events.ts tests/unit/dashboard/hono/hub.test.ts
git commit -m "feat(dashboard): migrate logs + runEvents topics to hub registry"
```

---

## Task 4: Migrate `captureSessions` and `daemonLog` topics

**Goal:** Move the remaining two emitters — capture-sessions (typed events via `event` field, ref-counted with subscriber count) and daemon-log (per-pid file watcher) — onto the hub.

**Files:**
- Modify: `src/tracker/dashboard/hono/topics-emitters.ts` (add `captureSessionsTopic`, `daemonLogTopic`)
- Modify: `src/tracker/dashboard/hono/routes/events.ts` (delegate `/events/daemon-log` and `/api/capture/sessions/stream`)
- Modify: `tests/unit/dashboard/hono/hub.test.ts`

**Steps:**

- [ ] **Step 1: Read existing handlers.** `routes/events.ts:459-506` (daemon-log), `routes/events.ts:508-521` (capture-sessions). Also read `captureStore` to understand `subscribe`/`listAll` API.

- [ ] **Step 2: Implement `captureSessionsTopic`.**
  - Params: `{}`.
  - Body: emit `{ sessions: ... }` with `event: "session-list"` on first tick; subscribe to `captureStore` and forward each event with `event: "session-event"`; 15s heartbeat with `event: "heartbeat"`. Activity counter (`activeCaptureSseSubscribers`) preserved.
  - `registerTopic("captureSessions", captureSessionsTopic)`.

- [ ] **Step 3: Implement `daemonLogTopic`.**
  - Params: `{ pid: number }`. Validate at emit time — if invalid, send an `error` envelope (`{ ok: false, error: "..." }`) and a no-op stop. Hub does not 400 — the hub connection itself is fine; only this sub is broken.
  - Body: `resolveDaemonLogPath(pid, deps.dir)` → if null, send `{ ok: false, error: "no log file for that pid" }` and return no-op stop. Otherwise replicate the legacy tail+watch logic.
  - `registerTopic("daemonLog", daemonLogTopic)`.

- [ ] **Step 4: Refactor legacy handlers to delegate.**
  - `/api/capture/sessions/stream` → `return sseResponse((send) => captureSessionsTopic({}, send, deps));`. (Note: the legacy emits typed events via the `event` arg of `send`; `sseResponse`'s `send` already supports that — verify by reading `sse.ts:29-30`.)
  - `/events/daemon-log` → keep the 400 short-circuit for missing/invalid pid (legacy behavior preserved); on valid pid, delegate to `daemonLogTopic`.

- [ ] **Step 5: Add tests.**
  - Hub with `captureSessions` subscription receives an envelope with `event: "session-list"` first.
  - Hub with `daemonLog` subscription for a non-existent pid receives an error envelope, but the hub stays open and other subs continue working.
  - Hub with `daemonLog` for a real pid path receives a tail envelope (write to a temp log file before subscribing).

- [ ] **Step 6: Verify.** `npm run test`, `npm run typecheck`, `npm run test:architecture`. All PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/tracker/dashboard/hono/topics-emitters.ts src/tracker/dashboard/hono/routes/events.ts tests/unit/dashboard/hono/hub.test.ts
git commit -m "feat(dashboard): migrate captureSessions + daemonLog topics to hub registry"
```

---

## Task 5: Frontend `SseHub` client

**Goal:** Land the singleton hub client with subscribe/unsubscribe + microtask-batched reconnect.

**Files:**
- Create: `src/dashboard/lib/sse-hub.ts`
- Create: `tests/unit/dashboard/sse-hub-client.test.ts`

**Steps:**

- [ ] **Step 1: Implement `sse-hub.ts`.**

```ts
type Listener = (data: unknown, event?: string) => void;
type Sub = { id: string; topic: string; params: unknown; listener: Listener; onError?: () => void };

export class SseHub {
  private es: EventSource | null = null;
  private subs = new Map<string, Sub>();
  private nextId = 0;
  private rebuildScheduled = false;

  subscribe<T>(topic: string, params: unknown, listener: (data: T, event?: string) => void, onError?: () => void): () => void {
    const id = `s${++this.nextId}`;
    this.subs.set(id, { id, topic, params, listener: listener as Listener, onError });
    this.scheduleRebuild();
    return () => {
      this.subs.delete(id);
      this.scheduleRebuild();
    };
  }

  private scheduleRebuild() {
    if (this.rebuildScheduled) return;
    this.rebuildScheduled = true;
    queueMicrotask(() => {
      this.rebuildScheduled = false;
      this.rebuild();
    });
  }

  private rebuild() {
    if (this.es) { this.es.close(); this.es = null; }
    if (this.subs.size === 0) return;
    const subsArray = [...this.subs.values()].map(({ id, topic, params }) => ({ id, topic, params }));
    const url = `/events/hub?subs=${encodeURIComponent(JSON.stringify(subsArray))}`;
    const es = new EventSource(url);
    es.onmessage = (ev) => {
      try {
        const env = JSON.parse(ev.data) as { sub: string; data: unknown; event?: string };
        this.subs.get(env.sub)?.listener(env.data, env.event);
      } catch {
        // malformed envelope — ignore
      }
    };
    es.onerror = () => {
      for (const sub of this.subs.values()) sub.onError?.();
      // Browser EventSource auto-reconnects; we don't manually rebuild on error.
    };
    this.es = es;
  }
}

export const sseHub = new SseHub();
```

- [ ] **Step 2: Write tests.** Use a minimal `EventSource` mock (the project uses `node:test` — install nothing). Test:
  - `subscribe` returns an unsubscribe.
  - Two subscriptions in the same microtask result in **one** EventSource construction.
  - Subscribe → unsubscribe within the same tick → no EventSource opened.
  - Envelope dispatch routes `data` to the right listener by `sub` id.
  - `onError` callback fires on EventSource error event.
  - Unsubscribe of the last sub closes the EventSource.

- [ ] **Step 3: Verify.** `npm run test -- tests/unit/dashboard/sse-hub-client.test.ts` PASS. `npm run typecheck` PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/dashboard/lib/sse-hub.ts tests/unit/dashboard/sse-hub-client.test.ts
git commit -m "feat(dashboard): SseHub frontend client (singleton with microtask-batched reconnect)"
```

---

## Task 6: Migrate hooks to `sseHub`

**Goal:** Switch all seven SSE-using hooks/components from `new EventSource(...)` to `sseHub.subscribe(...)`. Public API of each hook stays identical so call sites don't change.

**Files modified (each file replaces its `new EventSource(...)` + `es.onmessage` + `es.close` block with `sseHub.subscribe(topic, params, listener)` + the returned unsubscribe in the effect cleanup):**

- `src/dashboard/components/hooks/useEntries.ts` — topic `"entries"`, params `{ workflow, date }`.
- `src/dashboard/components/hooks/useLogs.ts` — topic `"logs"`, params `{ workflow, id, runId, date }`.
- `src/dashboard/components/hooks/useRunEvents.ts` — topic `"runEvents"`, params `{ workflow, runId, date }` (note: legacy didn't take `id`, neither does the topic).
- `src/dashboard/components/hooks/useSessions.ts` — topic `"sessions"`, params `{}`.
- `src/dashboard/components/hooks/useTelegramToasts.ts` — topic `"telegram"`, params `{}`.
- `src/dashboard/components/hooks/useCaptureToasts.ts` — topic `"captureSessions"`, params `{}`. **Important:** this hook uses typed events (`session-list`, `session-event`, `heartbeat`); the `subscribe` listener receives both `data` and `event`. Branch on `event` like the legacy `es.addEventListener("session-event", ...)` did.
- `src/dashboard/components/hooks/useCaptureSession.ts` — topic `"captureSessions"`, params `{}`. Same typed-event handling as above.
- The daemon-log component (find it via grep — likely `src/dashboard/components/terminal-drawer/DaemonLogTail.tsx` or similar): topic `"daemonLog"`, params `{ pid }`.

**Steps:**

- [ ] **Step 1: Find the daemon-log call site.** `grep -rn "/events/daemon-log\|EventSource.*daemon" src/dashboard/`. Note the file path for editing.

- [ ] **Step 2: Migrate `useEntries.ts`.** Replace lines 47-129 (the EventSource block). Keep all message-processing logic identical; only the source of `e.data` changes. Pseudocode of the new shape:

```ts
useEffect(() => {
  setLoading(true);
  setEntriesKey("");
  prevHashRef.current = "";

  const today = dateLocal();
  const params: { workflow: string; date?: string } = { workflow };
  if (date && date !== today) params.date = date;

  const unsubscribe = sseHub.subscribe(
    "entries",
    params,
    (data) => {
      setConnected(true);
      // ... existing message-processing logic, with `data` in place of `JSON.parse(e.data)` ...
    },
    () => {
      setConnected(false);
      setLoading(false);
    },
  );

  return () => {
    unsubscribe();
    setConnected(false);
  };
}, [workflow, date]);
```

- [ ] **Step 3: Migrate `useLogs.ts`, `useRunEvents.ts`, `useSessions.ts`, `useTelegramToasts.ts`.** Same mechanical pattern. Match params to the topic definitions above.

- [ ] **Step 4: Migrate `useCaptureToasts.ts` and `useCaptureSession.ts`.** Both subscribe to `"captureSessions"`. Listener signature is `(data, event) => ...`. Branch on `event === "session-list" | "session-event" | "heartbeat"` to mirror the legacy `addEventListener` branches. Both hooks subscribe — but because they hit the same hub topic with the same params, the hub serves them both off the same backend connection (the backend creates one subscriber-state per `id`, but they're cheap; the operative benefit is one EventSource on the wire).

- [ ] **Step 5: Migrate the daemon-log component.** Replace its `new EventSource("/events/daemon-log?pid=X")` with `sseHub.subscribe("daemonLog", { pid }, listener)`. Adapt to the listener signature.

- [ ] **Step 6: Verify in Chrome.** Start the dashboard (`npm run dashboard`), open Chrome DevTools → Network tab, filter to `eventsource`. **Expect: exactly ONE active SSE connection** (`/events/hub?subs=...`) regardless of which entry is selected, modal state, etc. Reload the page repeatedly — should NOT hang.

- [ ] **Step 7: Verify in Safari (smoke).** Open the dashboard in Safari, click around, confirm queue + log panel + sessions update normally.

- [ ] **Step 8: Run automated tests.** `npm run test`, `npm run typecheck`, `npm run test:architecture`. All PASS.

- [ ] **Step 9: Commit.**

```bash
git add src/dashboard/components/hooks/ src/dashboard/components/terminal-drawer/
git commit -m "refactor(dashboard): migrate all SSE hooks to SseHub multiplex client"
```

---

## Task 7: Remove legacy SSE endpoints

**Goal:** Delete the legacy `/events/*` and `/api/capture/sessions/stream` route registrations now that no frontend code reaches them. Keep the topic emitter functions (they're the canonical implementation) and keep `sseResponse` (still used by the hub).

**Files modified:**

- `src/tracker/dashboard/hono/routes/events.ts` — Remove the seven legacy `app.get(...)` registrations. Keep the imports the topic emitters need.
- `src/tracker/dashboard/CLAUDE.md` — Update the SSE table: remove old endpoint rows, add a single `/events/hub` entry. Add a dated lessons-learned entry.

**Steps:**

- [ ] **Step 1: Verify no remaining callers.** Run:

```bash
grep -rn "/events/logs\|/events/run-events\|/events/sessions\|/events/telegram\|/events/daemon-log\|/api/capture/sessions/stream" src/ tests/ scripts/
```

The only remaining matches should be inside `routes/events.ts` (the routes themselves) and `topics-emitters.ts` (string constants if any). Anything else is a missed migration — fix in Task 6 before proceeding.

- [ ] **Step 2: Delete the legacy registrations.** Each `app.get("/events/<topic>", ...)` block becomes empty. Delete them entirely.

- [ ] **Step 3: Update the CLAUDE.md.**
  - Replace the SSE rows in the endpoint table with a single hub row:
    > `/events/hub?subs=<encoded JSON>` — SSE — multiplexed envelopes per subscription. See `src/tracker/dashboard/hono/topics.ts` for topic registry.
  - Add a lessons-learned entry under "Lessons Learned" section dated 2026-05-08:
    > **2026-05-08: SSE multiplexed onto a single `/events/hub` endpoint.** All seven dashboard SSE streams (entries, logs, runEvents, sessions, telegram, captureSessions, daemonLog) now share one EventSource connection per client. Topic emitters live in `src/tracker/dashboard/hono/topics-emitters.ts` and register against `topicRegistry` in `topics.ts`. The frontend `SseHub` (singleton in `src/dashboard/lib/sse-hub.ts`) batches subscription changes via `queueMicrotask` so a single render tick produces at most one reconnect. Why this exists: Chrome's HTTP/1.1 6-per-origin connection limit was being saturated by the previous architecture (6+ EventSources at once), causing reload to hang in Chrome only. Adding new real-time features no longer requires triaging "which SSE can we drop?" — multiplexed.

- [ ] **Step 4: Verify.** `npm run test`, `npm run typecheck`, `npm run test:architecture`. All PASS.

- [ ] **Step 5: Manual verify in Chrome.** Reload dashboard 5+ times. No hangs. DevTools → Network shows one active EventSource.

- [ ] **Step 6: Commit.**

```bash
git add src/tracker/dashboard/hono/routes/events.ts src/dashboard/CLAUDE.md
git commit -m "refactor(dashboard): remove legacy per-topic SSE endpoints (hub is now the only path)"
```

---

## Self-review

- **Spec coverage:** All 7 SSE endpoints have a corresponding topic emitter task. Frontend client + hook migration covered. Legacy cleanup covered.
- **Type consistency:** `TopicEmitter`, `TopicSend`, `TopicStop`, `Subscription`, `HubEnvelope` defined once in `topics.ts` and used consistently across backend + tests. Frontend uses an inline `Listener` type that matches the envelope shape.
- **Placeholders:** None — every step has either concrete code, a concrete file/line reference, or a concrete shell command.
- **Risks:**
  - The `daemonLog` topic's error-on-bad-pid behavior is intentionally different from the legacy endpoint's 400 response (the legacy hub-less endpoint would just return 400 to the client; in the hub, only the affected subscription errors out). The legacy `/events/daemon-log` keeps its 400 short-circuit until Task 7, so no regression during migration.
  - `useCaptureToasts` and `useCaptureSession` both subscribing to `captureSessions` produces two distinct subscribers on the backend, which means two `captureStore.subscribe(...)` callbacks. That's the same number of `captureStore` listeners the legacy code created (one per EventSource), so no regression. The wire savings come from collapsing two HTTP connections into one multiplexed stream.
