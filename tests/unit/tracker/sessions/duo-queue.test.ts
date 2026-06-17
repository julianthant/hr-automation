import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  runDuoQueueTurn,
  DUO_QUEUE_MAX_WAIT_MS,
  DUO_QUEUE_STALE_REQUEST_MS,
  type DuoQueueTurnDeps,
} from "../../../../src/tracker/sessions/duo-queue.js";
import type { SessionEvent } from "../../../../src/tracker/session-events.js";

// Minimal duo_request builder. Only the fields the queue loop reads are set.
const req = (id: string, opts: { pid?: number; ageMs?: number; now?: number } = {}): SessionEvent => {
  const now = opts.now ?? 1_000_000;
  const ts = new Date(now - (opts.ageMs ?? 0)).toISOString();
  return {
    type: "duo_request",
    timestamp: ts,
    pid: opts.pid ?? 4242,
    workflowInstance: `wf-${id}`,
    system: "ucpath",
    duoRequestId: id,
  };
};

const done = (id: string): SessionEvent => ({
  type: "duo_complete",
  timestamp: new Date().toISOString(),
  pid: 1,
  workflowInstance: "",
  system: "ucpath",
  duoRequestId: id,
});

const timeout = (id: string): SessionEvent => ({
  type: "duo_timeout",
  timestamp: new Date().toISOString(),
  pid: 1,
  workflowInstance: "",
  system: "ucpath",
  duoRequestId: id,
});

/** A controllable test harness around `runDuoQueueTurn`'s injectable deps. */
const makeHarness = (init: {
  events: SessionEvent[];
  /** PIDs reported alive; everything else is dead. */
  alivePids?: number[];
  /** Starting clock value (ms). Advances by `tickMs` on each `sleep`. */
  startNow?: number;
  tickMs?: number;
  /**
   * Request id whose timestamp is re-stamped to `now()` on every read so it
   * never crosses the stale threshold — models a head request that is always
   * "fresh" (still progressing) so ONLY the max-wait budget can fire.
   */
  freshHeadId?: string;
}) => {
  const events = [...init.events];
  const alive = new Set(init.alivePids ?? [4242]);
  let clock = init.startNow ?? 1_000_000;
  const tick = init.tickMs ?? 600; // one poll interval per sleep
  const emitted: Array<{ duoRequestId: string }> = [];
  let sleeps = 0;

  const deps: DuoQueueTurnDeps = {
    readEvents: () => {
      if (init.freshHeadId) {
        for (const e of events) {
          if (e.type === "duo_request" && e.duoRequestId === init.freshHeadId) {
            e.timestamp = new Date(clock).toISOString();
          }
        }
      }
      return events;
    },
    emitTimeout: (e) => {
      emitted.push({ duoRequestId: e.duoRequestId });
      // Mirror production: a duo_timeout resolves that request, advancing the queue.
      events.push(timeout(e.duoRequestId));
    },
    isAlive: (pid) => alive.has(pid),
    now: () => clock,
    sleep: async () => {
      sleeps += 1;
      clock += tick;
    },
  };

  return {
    deps,
    emitted,
    get sleeps() {
      return sleeps;
    },
    advanceClock: (ms: number) => {
      clock += ms;
    },
    pushEvent: (e: SessionEvent) => events.push(e),
  };
};

describe("runDuoQueueTurn", () => {
  it("returns immediately when this request is already at the head of the queue", async () => {
    const h = makeHarness({ events: [req("mine")] });
    await runDuoQueueTurn("mine", undefined, h.deps);
    assert.equal(h.emitted.length, 0);
    assert.equal(h.sleeps, 0);
  });

  it("waits behind a healthy in-progress request, then proceeds when it completes", async () => {
    const h = makeHarness({ events: [req("ahead"), req("mine")] });
    // After one poll, mark `ahead` complete so `mine` becomes the head.
    const original = h.deps.sleep;
    h.deps.sleep = async (ms, signal) => {
      h.pushEvent(done("ahead"));
      await original(ms, signal);
    };
    await runDuoQueueTurn("mine", undefined, h.deps);
    assert.equal(h.emitted.length, 0, "a healthy completing request is never timed out");
    assert.equal(h.sleeps, 1);
  });

  it("advances past a dead (PID-gone) head-of-queue request", async () => {
    // `ahead` PID is NOT in the alive set → dead → timed out immediately.
    const h = makeHarness({ events: [req("ahead", { pid: 9999 }), req("mine", { pid: 4242 })], alivePids: [4242] });
    await runDuoQueueTurn("mine", undefined, h.deps);
    assert.deepEqual(h.emitted.map((e) => e.duoRequestId), ["ahead"]);
  });

  it("advances past a LIVE-but-too-old head-of-queue request (time-based stale advance)", async () => {
    // `ahead` PID is alive, but its request is older than the stale threshold,
    // so it is wedged and must be timed out so the queue advances.
    const now = 5_000_000;
    const h = makeHarness({
      events: [
        req("ahead", { pid: 4242, ageMs: DUO_QUEUE_STALE_REQUEST_MS + 5_000, now }),
        req("mine", { pid: 4242, ageMs: 1_000, now }),
      ],
      alivePids: [4242],
      startNow: now,
    });
    await runDuoQueueTurn("mine", undefined, h.deps);
    assert.deepEqual(
      h.emitted.map((e) => e.duoRequestId),
      ["ahead"],
      "a live but over-age head request is timed out",
    );
  });

  it("does NOT time out a live head request that is still within the stale window", async () => {
    const now = 5_000_000;
    const h = makeHarness({
      events: [
        req("ahead", { pid: 4242, ageMs: DUO_QUEUE_STALE_REQUEST_MS - 10_000, now }),
        req("mine", { pid: 4242, ageMs: 1_000, now }),
      ],
      alivePids: [4242],
      startNow: now,
      tickMs: 500,
    });
    // It should wait (not advance) until either the head completes or it ages
    // out / hits max-wait. Mark it complete after a couple polls to end cleanly.
    let polls = 0;
    const original = h.deps.sleep;
    h.deps.sleep = async (ms, signal) => {
      polls += 1;
      if (polls === 2) h.pushEvent(done("ahead"));
      await original(ms, signal);
    };
    await runDuoQueueTurn("mine", undefined, h.deps);
    assert.equal(h.emitted.length, 0, "an in-window live request is not preempted");
  });

  it("throws when the worker exceeds the max-wait budget (fail fast, do not block the pool)", async () => {
    // `ahead` stays the head forever (alive + within stale window, never
    // completes), but each sleep advances the clock past the max-wait budget.
    const now = 1_000_000;
    const h = makeHarness({
      events: [req("ahead", { pid: 4242, ageMs: 1_000, now }), req("mine", { pid: 4242, now })],
      alivePids: [4242],
      startNow: now,
      // Keep `ahead` perpetually fresh so it never ages out — only the
      // max-wait budget can end this loop.
      freshHeadId: "ahead",
      // Each poll jumps the clock ~1/3 of the budget, so the max-wait trips in a
      // few iterations without any real waiting.
      tickMs: Math.ceil(DUO_QUEUE_MAX_WAIT_MS / 3) + 1,
    });
    await assert.rejects(
      () => runDuoQueueTurn("mine", undefined, h.deps),
      /Timed out after .*waiting for a Duo turn/i,
    );
    assert.equal(h.emitted.length, 0, "max-wait failure does not falsely time out the head request");
  });

  it("propagates an abort while waiting", async () => {
    const controller = new AbortController();
    const h = makeHarness({ events: [req("ahead"), req("mine")], alivePids: [4242] });
    h.deps.sleep = async () => {
      controller.abort(new Error("daemon stop"));
    };
    await assert.rejects(() => runDuoQueueTurn("mine", controller.signal, h.deps), /daemon stop|aborted/i);
  });

  it("max-wait is comfortably above the stale-request threshold (a healthy prompt is never cut off)", () => {
    assert.ok(DUO_QUEUE_MAX_WAIT_MS > DUO_QUEUE_STALE_REQUEST_MS);
    // Stale threshold sits above the longest manual Duo timeout (180s).
    assert.ok(DUO_QUEUE_STALE_REQUEST_MS > 180_000);
  });
});
