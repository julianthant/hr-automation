import { describe, it, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, appendFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { rowFilePath, rowsDir, sessionFilePath, sessionsDir } from "../../../src/tracker/paths.js";
import type { Server } from "http";
import { once } from "node:events";
import {
  createDashboardServer,
  filterEventsForRun,
  resolveInstanceForRun,
  resolveInstanceForOperationCoordinator,
} from "../../../src/tracker/dashboard.js";
import type { SessionEvent } from "../../../src/tracker/session-events.js";
import { dateLocal, type TrackerEntry } from "../../../src/tracker/jsonl.js";

async function listeningPort(server: Server): Promise<number> {
  if (!server.listening) await once(server, "listening");
  return (server.address() as { port: number }).port;
}

function appendEvent(dir: string, event: Record<string, unknown> & { timestamp?: string }): void {
  const tsStr = typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString();
  const day = dateLocal(new Date(tsStr));
  mkdirSync(sessionsDir(dir), { recursive: true });
  appendFileSync(sessionFilePath(day, dir), JSON.stringify(event) + "\n");
}

function appendTrackerEntry(dir: string, workflow: string, date: string, entry: TrackerEntry): void {
  mkdirSync(rowsDir(dir), { recursive: true });
  appendFileSync(rowFilePath(workflow, date, dir), JSON.stringify(entry) + "\n");
}

async function collectSSE(
  url: string,
  opts: { stopAfter: number; timeoutMs: number },
): Promise<string[]> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(opts.timeoutMs)]);
  const messages: string[] = [];
  try {
    const res = await fetch(url, { signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (messages.length < opts.stopAfter) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      // Parse complete SSE blocks (double-newline delimited) to avoid splitting mid-envelope
      let splitAt = buffered.indexOf("\n\n");
      while (splitAt >= 0 && messages.length < opts.stopAfter) {
        const block = buffered.slice(0, splitAt);
        buffered = buffered.slice(splitAt + 2);
        const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
        if (dataLine) {
          // Unwrap hub envelope: { sub, data, event? } → serialize data back to JSON string
          const envelope = JSON.parse(dataLine.slice(6)) as { sub: string; data: unknown; event?: string };
          messages.push(JSON.stringify(envelope.data));
        }
        splitAt = buffered.indexOf("\n\n");
      }
    }
  } catch {
    // AbortError or any read error — return whatever we gathered.
  } finally {
    controller.abort();
  }
  return messages;
}

function trackerEntry(runId: string, instance?: string, timestamp: string = "2026-04-23T10:00:00Z"): TrackerEntry {
  return {
    workflow: "onboarding",
    timestamp,
    id: "alice@example.com",
    runId,
    status: "running",
    data: instance ? { instance } : {},
  };
}

function ev(partial: Record<string, unknown>): SessionEvent {
  return {
    pid: 1234,
    timestamp: "2026-04-23T10:00:00Z",
    workflowInstance: "Onboarding 1",
    ...partial,
  } as unknown as SessionEvent;
}

describe("resolveInstanceForRun", () => {
  it("returns instance from the matching tracker entry", () => {
    const trackers = [
      trackerEntry("A", "Onboarding 1"),
      trackerEntry("B", "Onboarding 2"),
    ];
    assert.equal(resolveInstanceForRun(trackers, "B"), "Onboarding 2");
  });

  it("returns undefined when no tracker entry matches", () => {
    assert.equal(resolveInstanceForRun([trackerEntry("A", "X")], "B"), undefined);
  });

  it("returns undefined when the entry lacks data.instance", () => {
    assert.equal(resolveInstanceForRun([trackerEntry("A")], "A"), undefined);
  });

  it("returns undefined for an empty runId", () => {
    assert.equal(resolveInstanceForRun([trackerEntry("A", "X")], ""), undefined);
  });
});

describe("filterEventsForRun", () => {
  it("returns events directly matching runId", () => {
    const events: SessionEvent[] = [
      ev({ type: "item_start", runId: "A", timestamp: "2026-04-23T10:00:01Z", currentItemId: "alice@example.com" }),
      ev({ type: "item_start", runId: "B", timestamp: "2026-04-23T10:00:02Z", currentItemId: "bob@example.com" }),
    ];
    const out = filterEventsForRun(events, [trackerEntry("A")], "A");
    assert.equal(out.length, 1);
    assert.equal(out[0].runId, "A");
  });

  it("pulls batch-scope events (no runId) via matching workflowInstance", () => {
    const events: SessionEvent[] = [
      ev({ type: "workflow_start", timestamp: "2026-04-23T10:00:00Z", workflowInstance: "Onboarding 1" }),
      ev({ type: "browser_launch", timestamp: "2026-04-23T10:00:01Z", workflowInstance: "Onboarding 1", sessionId: "s1", browserId: "b1", system: "crm" }),
      ev({ type: "auth_start", timestamp: "2026-04-23T10:00:02Z", workflowInstance: "Onboarding 1", browserId: "b1", system: "crm" }),
      ev({ type: "item_start", runId: "A", timestamp: "2026-04-23T10:00:03Z", workflowInstance: "Onboarding 1", currentItemId: "alice@example.com" }),
    ];
    const out = filterEventsForRun(events, [trackerEntry("A", "Onboarding 1")], "A");
    assert.equal(out.length, 4);
    assert.deepEqual(
      out.map((e) => e.type),
      ["workflow_start", "browser_launch", "auth_start", "item_start"],
    );
  });

  it("isolates daemon-processed batches by workflowInstance, not pid", () => {
    const events: SessionEvent[] = [
      // Batch 1: Onboarding 1 — same daemon pid as batch 2.
      ev({ pid: 7777, type: "workflow_start", timestamp: "2026-04-23T10:00:00Z", workflowInstance: "Onboarding 1" }),
      ev({ pid: 7777, type: "browser_launch", timestamp: "2026-04-23T10:00:01Z", workflowInstance: "Onboarding 1", sessionId: "s1", browserId: "b1", system: "crm" }),
      ev({ pid: 7777, type: "item_start", runId: "A", timestamp: "2026-04-23T10:00:02Z", workflowInstance: "Onboarding 1", currentItemId: "alice@example.com" }),
      // Batch 2: Onboarding 2 — SAME pid (daemon reused), different instance.
      ev({ pid: 7777, type: "workflow_start", timestamp: "2026-04-23T10:10:00Z", workflowInstance: "Onboarding 2" }),
      ev({ pid: 7777, type: "browser_launch", timestamp: "2026-04-23T10:10:01Z", workflowInstance: "Onboarding 2", sessionId: "s2", browserId: "b2", system: "crm" }),
      ev({ pid: 7777, type: "item_start", runId: "B", timestamp: "2026-04-23T10:10:02Z", workflowInstance: "Onboarding 2", currentItemId: "bob@example.com" }),
    ];
    const trackers = [
      trackerEntry("A", "Onboarding 1"),
      trackerEntry("B", "Onboarding 2"),
    ];

    const out = filterEventsForRun(events, trackers, "B");
    // Must NOT include batch 1's events despite the shared pid.
    assert.equal(out.length, 3);
    for (const e of out) assert.equal(e.workflowInstance, "Onboarding 2");
  });

  it("degrades to primary-only when no tracker entry is present", () => {
    const events: SessionEvent[] = [
      ev({ type: "item_start", runId: "A", timestamp: "2026-04-23T10:00:01Z", workflowInstance: "Onboarding 1", currentItemId: "alice@example.com" }),
      ev({ type: "browser_launch", timestamp: "2026-04-23T10:00:00Z", workflowInstance: "Onboarding 1", sessionId: "s1", browserId: "b1", system: "crm" }),
    ];
    const out = filterEventsForRun(events, [], "A");
    assert.equal(out.length, 1);
    assert.equal(out[0].runId, "A");
  });

  it("degrades to primary-only when tracker entry lacks data.instance", () => {
    const events: SessionEvent[] = [
      ev({ type: "item_start", runId: "A", timestamp: "2026-04-23T10:00:01Z", workflowInstance: "Onboarding 1", currentItemId: "alice@example.com" }),
      ev({ type: "browser_launch", timestamp: "2026-04-23T10:00:00Z", workflowInstance: "Onboarding 1", sessionId: "s1", browserId: "b1", system: "crm" }),
    ];
    const out = filterEventsForRun(events, [trackerEntry("A")], "A");
    assert.equal(out.length, 1);
    assert.equal(out[0].runId, "A");
  });

  it("isolates items within a single daemon instance via time window", () => {
    // Daemon mode: one workflowInstance spans many items across time.
    // Daemon startup auth runs 10:00:00–10:00:45.
    // Item A (first) inherits real authTimings — its synthetic auth
    // tracker rows stamp its runStart at 10:00:00.
    // Item B (subsequent) gets zero-duration synthetic rows at claim
    // time (10:11:00) — daemon startup events fall OUT of its window.
    const events: SessionEvent[] = [
      // Daemon startup (orphan events, no runId)
      ev({ type: "workflow_start", timestamp: "2026-04-23T10:00:00Z", workflowInstance: "Separation 1" }),
      ev({ type: "browser_launch", timestamp: "2026-04-23T10:00:10Z", workflowInstance: "Separation 1", sessionId: "s1", browserId: "b1", system: "kuali" }),
      ev({ type: "auth_start", timestamp: "2026-04-23T10:00:30Z", workflowInstance: "Separation 1", browserId: "b1", system: "kuali" }),
      // Item A direct events
      ev({ type: "item_start", runId: "A", timestamp: "2026-04-23T10:01:00Z", workflowInstance: "Separation 1", currentItemId: "3924" }),
      ev({ type: "item_complete", runId: "A", timestamp: "2026-04-23T10:05:00Z", workflowInstance: "Separation 1", currentItemId: "3924" }),
      // Orphan between items — keepalive or similar, belongs to the daemon
      // lifetime but no specific item.
      ev({ type: "browser_launch", timestamp: "2026-04-23T10:07:00Z", workflowInstance: "Separation 1", sessionId: "s2", browserId: "b2", system: "kuali" }),
      // Item B direct events
      ev({ type: "item_start", runId: "B", timestamp: "2026-04-23T10:11:00Z", workflowInstance: "Separation 1", currentItemId: "3927" }),
      ev({ type: "item_complete", runId: "B", timestamp: "2026-04-23T10:15:00Z", workflowInstance: "Separation 1", currentItemId: "3927" }),
    ];
    // Item A's first tracker entry is at daemon startup (real authTimings
    // injected synthetic tracker rows). Item B's first tracker entry is at
    // claim time (zero-duration synthetic rows).
    const trackers = [
      trackerEntry("A", "Separation 1", "2026-04-23T10:00:00Z"),
      trackerEntry("A", "Separation 1", "2026-04-23T10:05:00Z"),
      trackerEntry("B", "Separation 1", "2026-04-23T10:11:00Z"),
      trackerEntry("B", "Separation 1", "2026-04-23T10:15:00Z"),
    ];

    // View of A: daemon startup events + A's direct events. The between-items
    // 10:07 browser_launch is AFTER A's window, must not appear.
    const outA = filterEventsForRun(events, trackers, "A", Date.parse("2026-04-23T10:06:00Z"));
    assert.deepEqual(
      outA.map((e) => ({ type: e.type, runId: e.runId ?? null, ts: e.timestamp })),
      [
        { type: "workflow_start", runId: null, ts: "2026-04-23T10:00:00Z" },
        { type: "browser_launch", runId: null, ts: "2026-04-23T10:00:10Z" },
        { type: "auth_start", runId: null, ts: "2026-04-23T10:00:30Z" },
        { type: "item_start", runId: "A", ts: "2026-04-23T10:01:00Z" },
        { type: "item_complete", runId: "A", ts: "2026-04-23T10:05:00Z" },
      ],
    );

    // View of B: only B's window. No leak from the daemon startup events OR
    // the between-items browser_launch.
    const outB = filterEventsForRun(events, trackers, "B", Date.parse("2026-04-23T10:16:00Z"));
    assert.deepEqual(
      outB.map((e) => ({ type: e.type, runId: e.runId ?? null, ts: e.timestamp })),
      [
        { type: "item_start", runId: "B", ts: "2026-04-23T10:11:00Z" },
        { type: "item_complete", runId: "B", ts: "2026-04-23T10:15:00Z" },
      ],
    );
  });

  it("extends run window to now for in-progress items (no terminal tracker entry)", () => {
    // Item is running (no item_complete), only an auth_start tracker ts.
    // The direct item_start event is AFTER the tracker's recorded ts, so the
    // window must extend to include it. The runEndFallback (Date.now()
    // default, here overridden to a future ts) ensures live events attach.
    const events: SessionEvent[] = [
      ev({ type: "auth_start", timestamp: "2026-04-23T10:00:00Z", workflowInstance: "Separation 1", browserId: "b1", system: "kuali" }),
      ev({ type: "item_start", runId: "A", timestamp: "2026-04-23T10:01:00Z", workflowInstance: "Separation 1", currentItemId: "3927" }),
      ev({ type: "browser_launch", timestamp: "2026-04-23T10:02:00Z", workflowInstance: "Separation 1", sessionId: "s1", browserId: "b2", system: "kuali" }),
    ];
    const trackers = [trackerEntry("A", "Separation 1", "2026-04-23T10:00:00Z")];

    const out = filterEventsForRun(events, trackers, "A", Date.parse("2026-04-23T10:03:00Z"));
    // All three events should appear: auth_start is at runStart (boundary),
    // item_start is direct, browser_launch is orphan but within the extended window.
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((e) => e.type), ["auth_start", "item_start", "browser_launch"]);
  });

  it("excludes orphan events after runEndFallback for a completed run", () => {
    // Item completed at 10:05. A daemon-level event at 10:07 (after the run
    // ended) must not be attributed to the completed run, even though it
    // shares the workflowInstance.
    const events: SessionEvent[] = [
      ev({ type: "item_start", runId: "A", timestamp: "2026-04-23T10:01:00Z", workflowInstance: "Separation 1", currentItemId: "3924" }),
      ev({ type: "item_complete", runId: "A", timestamp: "2026-04-23T10:05:00Z", workflowInstance: "Separation 1", currentItemId: "3924" }),
      ev({ type: "browser_launch", timestamp: "2026-04-23T10:07:00Z", workflowInstance: "Separation 1", sessionId: "s1", browserId: "b1", system: "kuali" }),
    ];
    const trackers = [
      trackerEntry("A", "Separation 1", "2026-04-23T10:01:00Z"),
      trackerEntry("A", "Separation 1", "2026-04-23T10:05:00Z"),
    ];

    // Simulate "now" = 10:06 (before the 10:07 orphan event).
    const out = filterEventsForRun(events, trackers, "A", Date.parse("2026-04-23T10:06:00Z"));
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((e) => e.type), ["item_start", "item_complete"]);
  });
});

// ── operation coordinator row tests ──────────────────────────────────────────

function coordinatorEntry(
  coordinatorRunId: string,
  timestamp: string = "2026-04-23T10:00:00Z",
): TrackerEntry {
  return {
    workflow: "separations",
    timestamp,
    id: `input-run-${coordinatorRunId.slice(0, 8)}`,
    runId: coordinatorRunId,
    status: "pending",
    // Coordinator rows have archetype:"operation" but NO data.instance — the
    // daemon runs member items, each carrying the real workflowInstance.
    data: { archetype: "operation", queueRowKind: "person" },
  };
}

function memberEntry(
  memberRunId: string,
  parentRunId: string,
  instance: string,
  timestamp: string = "2026-04-23T10:01:00Z",
): TrackerEntry {
  return {
    workflow: "separations",
    timestamp,
    id: "alice@example.com",
    runId: memberRunId,
    parentRunId,
    status: "running",
    data: { archetype: "operation-member", instance },
  };
}

describe("resolveInstanceForOperationCoordinator", () => {
  it("returns undefined when coordinator has no direct instance and no children", () => {
    const trackers = [coordinatorEntry("COORD-1")];
    assert.equal(resolveInstanceForOperationCoordinator(trackers, "COORD-1"), undefined);
  });

  it("returns the direct instance when the coordinator row carries data.instance", () => {
    const trackers = [
      { ...coordinatorEntry("COORD-1"), data: { archetype: "operation", instance: "Separations 1" } },
    ];
    assert.equal(resolveInstanceForOperationCoordinator(trackers, "COORD-1"), "Separations 1");
  });

  it("falls back to a child member's instance when coordinator lacks data.instance", () => {
    const trackers = [
      coordinatorEntry("COORD-1"),
      memberEntry("MEMBER-A", "COORD-1", "Separations 1"),
      memberEntry("MEMBER-B", "COORD-1", "Separations 1"),
    ];
    assert.equal(resolveInstanceForOperationCoordinator(trackers, "COORD-1"), "Separations 1");
  });

  it("does not cross-contaminate: returns undefined for a sibling coordinator", () => {
    const trackers = [
      coordinatorEntry("COORD-1"),
      coordinatorEntry("COORD-2"),
      memberEntry("MEMBER-A", "COORD-1", "Separations 1"),
    ];
    // COORD-2 has no children → undefined
    assert.equal(resolveInstanceForOperationCoordinator(trackers, "COORD-2"), undefined);
    // COORD-1 resolves via its child
    assert.equal(resolveInstanceForOperationCoordinator(trackers, "COORD-1"), "Separations 1");
  });

  it("a normal member run still resolves its own instance directly", () => {
    const trackers = [
      coordinatorEntry("COORD-1"),
      memberEntry("MEMBER-A", "COORD-1", "Separations 1"),
    ];
    // resolveInstanceForOperationCoordinator is also safe to call on member
    // runs — the direct lookup succeeds for the member
    assert.equal(resolveInstanceForOperationCoordinator(trackers, "MEMBER-A"), "Separations 1");
  });
});

describe("filterEventsForRun — operation coordinator lifecycle attribution", () => {
  it("attributes daemon lifecycle events to the coordinator via child instance fallback", () => {
    // The coordinator runId has archetype:"operation" but no data.instance.
    // Members share parentRunId === coordinatorRunId and carry data.instance.
    // Orphan session lifecycle events (no runId) have the same workflowInstance.
    const coordinatorRunId = "COORD-1";
    const memberRunId = "MEMBER-A";
    const instance = "Separations 1";

    const events: SessionEvent[] = [
      // Daemon lifecycle — orphan (no runId), emitted at instance scope
      ev({ type: "workflow_start", timestamp: "2026-04-23T10:00:00Z", workflowInstance: instance }),
      ev({ type: "browser_launch", timestamp: "2026-04-23T10:00:05Z", workflowInstance: instance, sessionId: "s1", browserId: "b1", system: "kuali" }),
      ev({ type: "auth_start", timestamp: "2026-04-23T10:00:10Z", workflowInstance: instance, browserId: "b1", system: "kuali" }),
      ev({ type: "auth_complete", timestamp: "2026-04-23T10:00:30Z", workflowInstance: instance, browserId: "b1", system: "kuali" }),
      // Member item events (carry runId)
      ev({ type: "item_start", runId: memberRunId, timestamp: "2026-04-23T10:01:00Z", workflowInstance: instance, currentItemId: "alice@example.com" }),
      ev({ type: "item_complete", runId: memberRunId, timestamp: "2026-04-23T10:05:00Z", workflowInstance: instance, currentItemId: "alice@example.com" }),
    ];

    const trackers: TrackerEntry[] = [
      coordinatorEntry(coordinatorRunId, "2026-04-23T10:00:00Z"),
      memberEntry(memberRunId, coordinatorRunId, instance, "2026-04-23T10:01:00Z"),
      { ...memberEntry(memberRunId, coordinatorRunId, instance, "2026-04-23T10:05:00Z"), status: "done" },
    ];

    // The coordinator view includes:
    // - orphan lifecycle events (no runId) attributed via workflowInstance + time window
    // - direct events with runId === coordinatorRunId (there are none here — the
    //   coordinator is a display-only row; member item events carry memberRunId)
    // - each member's `item_start` (runId: "MEMBER-A") — the coordinator is the
    //   consolidated event tracker, so "member began processing" markers show
    //   here too. Member `item_complete` is NOT pulled in (it would duplicate the
    //   per-member summary line the log panel already folds in).
    const outCoordinator = filterEventsForRun(
      events,
      trackers,
      coordinatorRunId,
      Date.parse("2026-04-23T10:06:00Z"),
    );

    assert.deepEqual(
      outCoordinator.map((e) => ({ type: e.type, runId: (e.runId as string | undefined) ?? null })),
      [
        { type: "workflow_start", runId: null },
        { type: "browser_launch", runId: null },
        { type: "auth_start", runId: null },
        { type: "auth_complete", runId: null },
        { type: "item_start", runId: "MEMBER-A" },
      ],
    );
  });

  it("keeps the coordinator window open past a completed member (daemon-scope event lands after the done member row)", () => {
    // Regression for the early-cap bug: a member reaching `done` must NOT close
    // the coordinator's timeline window. The coordinator row is a display-only
    // `pending` row, so its window stays open to `runEndFallback` — a
    // daemon-scope event (here `browser_health`, no runId) that lands AFTER the
    // done-member tracker row but BEFORE `runEndFallback` must still appear in
    // the consolidated coordinator view. (Pre-fix: termination keyed off ALL
    // run entries, so the done member capped `runEnd` at the last member row's
    // timestamp and this event was dropped.)
    const coordinatorRunId = "COORD-1";
    const memberRunId = "MEMBER-A";
    const instance = "Separations 1";

    const events: SessionEvent[] = [
      ev({ type: "workflow_start", timestamp: "2026-04-23T10:00:00Z", workflowInstance: instance }),
      ev({ type: "item_start", runId: memberRunId, timestamp: "2026-04-23T10:01:00Z", workflowInstance: instance, currentItemId: "alice@example.com" }),
      ev({ type: "item_complete", runId: memberRunId, timestamp: "2026-04-23T10:05:00Z", workflowInstance: instance, currentItemId: "alice@example.com" }),
      // Daemon-scope health event AFTER the done member row (10:05:00) but
      // BEFORE runEndFallback (10:06:00). No runId → must attach via the
      // open coordinator window.
      ev({ type: "browser_health", timestamp: "2026-04-23T10:05:30Z", workflowInstance: instance, browserId: "b1", system: "kuali", data: { status: "healthy" } }),
    ];

    const trackers: TrackerEntry[] = [
      coordinatorEntry(coordinatorRunId, "2026-04-23T10:00:00Z"), // pending — never terminal
      memberEntry(memberRunId, coordinatorRunId, instance, "2026-04-23T10:01:00Z"),
      { ...memberEntry(memberRunId, coordinatorRunId, instance, "2026-04-23T10:05:00Z"), status: "done" },
    ];

    const out = filterEventsForRun(
      events,
      trackers,
      coordinatorRunId,
      Date.parse("2026-04-23T10:06:00Z"),
    );
    const types = out.map((e) => e.type);
    assert.ok(
      types.includes("browser_health"),
      `coordinator window must stay open past a completed member to include the later daemon-scope browser_health event (got: ${JSON.stringify(types)})`,
    );
    // The member's item_start is still surfaced on the coordinator timeline.
    assert.ok(types.includes("item_start"), "member item_start should remain on the coordinator view");
  });

  it("operation-member rows get only their own item events — no lifecycle bleed", () => {
    // Members must NOT receive the coordinator's lifecycle events — those
    // belong to the coordinator view only. Members have archetype:"operation-member"
    // which filterEventsForRun excludes from batch-scope attribution.
    const coordinatorRunId = "COORD-1";
    const memberRunId = "MEMBER-A";
    const instance = "Separations 1";

    const events: SessionEvent[] = [
      ev({ type: "workflow_start", timestamp: "2026-04-23T10:00:00Z", workflowInstance: instance }),
      ev({ type: "browser_launch", timestamp: "2026-04-23T10:00:05Z", workflowInstance: instance, sessionId: "s1", browserId: "b1", system: "kuali" }),
      ev({ type: "item_start", runId: memberRunId, timestamp: "2026-04-23T10:01:00Z", workflowInstance: instance, currentItemId: "alice@example.com" }),
      ev({ type: "item_complete", runId: memberRunId, timestamp: "2026-04-23T10:05:00Z", workflowInstance: instance, currentItemId: "alice@example.com" }),
    ];

    const trackers: TrackerEntry[] = [
      coordinatorEntry(coordinatorRunId, "2026-04-23T10:00:00Z"),
      memberEntry(memberRunId, coordinatorRunId, instance, "2026-04-23T10:01:00Z"),
      { ...memberEntry(memberRunId, coordinatorRunId, instance, "2026-04-23T10:05:00Z"), status: "done" },
    ];

    const outMember = filterEventsForRun(
      events,
      trackers,
      memberRunId,
      Date.parse("2026-04-23T10:06:00Z"),
    );

    // Member sees only its own direct events; no orphan lifecycle bleed
    assert.deepEqual(
      outMember.map((e) => ({ type: e.type, runId: (e.runId as string | undefined) ?? null })),
      [
        { type: "item_start", runId: memberRunId },
        { type: "item_complete", runId: memberRunId },
      ],
    );
  });
});

describe("/events/run-events operation coordinator SSE (HTTP)", () => {
  let tmp: string;
  let server: Server | undefined;
  let port: number;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "run-events-coord-"));
  });

  afterEach(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("streams daemon lifecycle events for the coordinator runId via child instance fallback", async () => {
    const today = dateLocal();
    const tsBase = `${today}T10:00:0`;
    const coordinatorRunId = "coord-run-id-1234";
    const memberRunId = "member-run-id-5678";
    const coordinatorItemId = `input-run-${coordinatorRunId.slice(0, 8)}`;
    const instance = "Separations 1";

    // Coordinator row: archetype:"operation", NO data.instance
    const coordEntry: TrackerEntry = {
      workflow: "separations",
      timestamp: `${tsBase}0Z`,
      id: coordinatorItemId,
      runId: coordinatorRunId,
      status: "pending",
      data: { archetype: "operation", queueRowKind: "person" },
    };
    // Member row: carries parentRunId + data.instance
    const membEntry: TrackerEntry = {
      workflow: "separations",
      timestamp: `${tsBase}3Z`,
      id: "alice@example.com",
      runId: memberRunId,
      parentRunId: coordinatorRunId,
      status: "running",
      data: { archetype: "operation-member", instance },
    };

    appendTrackerEntry(tmp, "separations", today, coordEntry);
    appendTrackerEntry(tmp, "separations", today, membEntry);

    // Daemon lifecycle events — no runId (batch scope)
    appendEvent(tmp, { type: "workflow_start", timestamp: `${tsBase}0Z`, pid: 9999, workflowInstance: instance });
    appendEvent(tmp, { type: "browser_launch", timestamp: `${tsBase}1Z`, pid: 9999, workflowInstance: instance, sessionId: "s1", browserId: "b1", system: "kuali" });
    appendEvent(tmp, { type: "auth_start", timestamp: `${tsBase}2Z`, pid: 9999, workflowInstance: instance, browserId: "b1", system: "kuali" });
    // Member item event (has runId)
    appendEvent(tmp, { type: "item_start", timestamp: `${tsBase}3Z`, pid: 9999, workflowInstance: instance, runId: memberRunId, currentItemId: "alice@example.com" });

    server = createDashboardServer({ port: 0, dir: tmp, noClean: true });
    port = await listeningPort(server);

    const hubSubs = encodeURIComponent(
      JSON.stringify([{
        id: "s1",
        topic: "runEvents",
        params: { workflow: "separations", id: coordinatorItemId, runId: coordinatorRunId, date: today },
      }]),
    );
    const messages = await collectSSE(
      `http://localhost:${port}/events/hub?subs=${hubSubs}`,
      { stopAfter: 1, timeoutMs: 1500 },
    );
    const data = messages.map((m) => JSON.parse(m)).flat();

    // Coordinator view must include daemon lifecycle events (workflow_start,
    // browser_launch, auth_start) AND each member's item_start (the consolidated
    // event tracker surfaces "member began processing" markers).
    assert.ok(data.length >= 4, `expected ≥4 events, got ${data.length}: ${JSON.stringify(data.map((e: {type: string}) => e.type))}`);
    const types = (data as Array<{type: string}>).map((e) => e.type).sort();
    assert.ok(types.includes("workflow_start"), "coordinator SSE must include workflow_start");
    assert.ok(types.includes("browser_launch"), "coordinator SSE must include browser_launch");
    assert.ok(types.includes("auth_start"), "coordinator SSE must include auth_start");
    assert.ok(types.includes("item_start"), "coordinator SSE must include the member item_start");
  });
});

describe("/events/run-events instance-based fallback (HTTP)", () => {
  let tmp: string;
  let server: Server | undefined;
  let port: number;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "run-events-inst-"));
  });

  afterEach(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("streams batch-scope events attributed via workflowInstance", async () => {
    const today = dateLocal();
    // Use today's date in event timestamps so the SQLite projection (scoped
    // per-day in rebuildProjectionForDate) picks them up at server start.
    const tsBase = `${today}T10:00:0`;
    appendTrackerEntry(tmp, "onboarding", today, trackerEntry("A", "Onboarding 1"));

    appendEvent(tmp, { type: "workflow_start", timestamp: `${tsBase}0Z`, pid: 1234, workflowInstance: "Onboarding 1" });
    appendEvent(tmp, { type: "browser_launch", timestamp: `${tsBase}1Z`, pid: 1234, workflowInstance: "Onboarding 1", sessionId: "s1", browserId: "b1", system: "crm" });
    appendEvent(tmp, { type: "auth_start", timestamp: `${tsBase}2Z`, pid: 1234, workflowInstance: "Onboarding 1", browserId: "b1", system: "crm" });
    appendEvent(tmp, { type: "item_start", timestamp: `${tsBase}3Z`, pid: 1234, workflowInstance: "Onboarding 1", runId: "A", currentItemId: "alice@example.com" });
    // Different batch, different instance — must be excluded even though pid is shared.
    appendEvent(tmp, { type: "browser_launch", timestamp: `${tsBase}4Z`, pid: 1234, workflowInstance: "Onboarding 2", sessionId: "s2", browserId: "b2", system: "ucpath" });

    // Start server AFTER seeding so the projection rebuild reads the events.
    server = createDashboardServer({ port: 0, dir: tmp, noClean: true });
    port = await listeningPort(server);

    const hubSubs = encodeURIComponent(
      JSON.stringify([{ id: "s1", topic: "runEvents", params: { workflow: "onboarding", id: "alice@example.com", runId: "A", date: today } }]),
    );
    const messages = await collectSSE(
      `http://localhost:${port}/events/hub?subs=${hubSubs}`,
      { stopAfter: 1, timeoutMs: 1500 },
    );
    const data = messages.map((m) => JSON.parse(m)).flat();

    assert.equal(data.length, 4);
    const types = data.map((e: { type: string }) => e.type).sort();
    assert.deepEqual(types, ["auth_start", "browser_launch", "item_start", "workflow_start"]);
    for (const e of data) {
      assert.equal((e as { workflowInstance: string }).workflowInstance, "Onboarding 1");
    }
  });
});
