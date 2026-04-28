import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, appendFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Server } from "http";
import {
  createDashboardServer,
  filterEventsForRun,
  resolveInstanceForRun,
} from "../../../src/tracker/dashboard.js";
import type { SessionEvent } from "../../../src/tracker/session-events.js";
import { dateLocal, type TrackerEntry } from "../../../src/tracker/jsonl.js";

function appendEvent(dir: string, event: object): void {
  appendFileSync(join(dir, "sessions.jsonl"), JSON.stringify(event) + "\n");
}

function appendTrackerEntry(dir: string, workflow: string, date: string, entry: TrackerEntry): void {
  appendFileSync(join(dir, `${workflow}-${date}.jsonl`), JSON.stringify(entry) + "\n");
}

async function collectSSE(
  url: string,
  opts: { stopAfter: number; timeoutMs: number },
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const messages: string[] = [];
  try {
    const res = await fetch(url, { signal: controller.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    while (messages.length < opts.stopAfter) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      for (const line of text.split("\n")) {
        if (line.startsWith("data: ")) messages.push(line.slice(6));
      }
    }
  } catch {
    // AbortError or any read error — return whatever we gathered.
  } finally {
    clearTimeout(timer);
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

describe("/events/run-events instance-based fallback (HTTP)", () => {
  let tmp: string;
  let server: Server;
  let port: number;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "run-events-inst-"));
    server = createDashboardServer({ port: 0, dir: tmp, noClean: true });
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("streams batch-scope events attributed via workflowInstance", async () => {
    const today = dateLocal();
    appendTrackerEntry(tmp, "onboarding", today, trackerEntry("A", "Onboarding 1"));

    appendEvent(tmp, { type: "workflow_start", timestamp: "2026-04-23T10:00:00Z", pid: 1234, workflowInstance: "Onboarding 1" });
    appendEvent(tmp, { type: "browser_launch", timestamp: "2026-04-23T10:00:01Z", pid: 1234, workflowInstance: "Onboarding 1", sessionId: "s1", browserId: "b1", system: "crm" });
    appendEvent(tmp, { type: "auth_start", timestamp: "2026-04-23T10:00:02Z", pid: 1234, workflowInstance: "Onboarding 1", browserId: "b1", system: "crm" });
    appendEvent(tmp, { type: "item_start", timestamp: "2026-04-23T10:00:03Z", pid: 1234, workflowInstance: "Onboarding 1", runId: "A", currentItemId: "alice@example.com" });
    // Different batch, different instance — must be excluded even though pid is shared.
    appendEvent(tmp, { type: "browser_launch", timestamp: "2026-04-23T10:00:04Z", pid: 1234, workflowInstance: "Onboarding 2", sessionId: "s2", browserId: "b2", system: "ucpath" });

    const messages = await collectSSE(
      `http://localhost:${port}/events/run-events?workflow=onboarding&id=alice@example.com&runId=A&date=${today}`,
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
