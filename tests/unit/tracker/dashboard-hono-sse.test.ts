import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDashboardHonoApp } from "../../../src/tracker/dashboard/hono/app.js";
import { getActiveHonoCaptureSseSubscriberCountForTests } from "../../../src/tracker/dashboard/hono/sse.js";
import { closeStateDbForTests, openStateDb } from "../../../src/tracker/state/db.js";
import { dateLocal, type TrackerEntry } from "../../../src/tracker/jsonl.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hono-sse-"));
});

afterEach(() => {
  closeStateDbForTests(dir);
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function app() {
  return createDashboardHonoApp({
    dir,
    stateDb: openStateDb(dir),
    workflow: "onboarding",
    projectionReady: false,
  });
}

function appendSessionEvent(event: Record<string, unknown>): void {
  const tsStr = typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString();
  const day = dateLocal(new Date(tsStr));
  appendFileSync(join(dir, `sessions-${day}.jsonl`), `${JSON.stringify(event)}\n`);
}

function appendTrackerEntry(workflow: string, date: string, entry: Partial<TrackerEntry>): void {
  const full: TrackerEntry = {
    workflow,
    timestamp: "2026-04-19T10:00:00.000Z",
    id: "alice@example.com",
    runId: "run-a",
    status: "running",
    data: {},
    ...entry,
  };
  appendFileSync(join(dir, `${workflow}-${date}.jsonl`), `${JSON.stringify(full)}\n`);
}

function appendLog(workflow: string, date: string, log: Record<string, unknown>): void {
  appendFileSync(join(dir, `${workflow}-${date}-logs.jsonl`), `${JSON.stringify(log)}\n`);
}

async function readSseMessages(
  response: Response,
  count: number,
  timeoutMs = 750,
): Promise<{ messages: Array<{ event?: string; data: string }>; cancel: () => Promise<void> }> {
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const messages: Array<{ event?: string; data: string }> = [];
  let buffered = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel();
  }, timeoutMs);

  try {
    while (messages.length < count && !timedOut) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let splitAt = buffered.indexOf("\n\n");
      while (splitAt >= 0) {
        const block = buffered.slice(0, splitAt);
        buffered = buffered.slice(splitAt + 2);
        const eventLine = block.split("\n").find((line) => line.startsWith("event: "));
        const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
        if (dataLine) {
          messages.push({
            ...(eventLine ? { event: eventLine.slice("event: ".length) } : {}),
            data: dataLine.slice("data: ".length),
          });
        }
        splitAt = buffered.indexOf("\n\n");
      }
    }
  } finally {
    clearTimeout(timer);
  }

  return {
    messages,
    cancel: async () => {
      try {
        await reader.cancel();
      } catch {
        /* already canceled */
      }
    },
  };
}

/** Build a hub URL for a single subscription. */
function hubUrl(topic: string, params: unknown): string {
  const subs = encodeURIComponent(JSON.stringify([{ id: "s1", topic, params }]));
  return `/events/hub?subs=${subs}`;
}

/** Extract the inner `data` field from a hub envelope message. */
function unpack(msg: { data: string }): unknown {
  const envelope = JSON.parse(msg.data) as { sub: string; data: unknown; event?: string };
  return envelope.data;
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 750;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("Hono /events/logs sends an empty first tick and aborts cleanly", async () => {
  const stream = await readSseMessages(
    await app().request(hubUrl("logs", { workflow: "onboarding", id: "no-logs", runId: "no-logs#1", date: "2026-04-19" })),
    1,
  );
  assert.deepEqual(unpack(stream.messages[0]), []);
  await stream.cancel();
});

test("Hono /events/logs filters runId and treats missing runId as #1", async () => {
  appendLog("onboarding", "2026-04-19", {
    workflow: "onboarding",
    itemId: "alice@example.com",
    level: "step",
    message: "legacy run one",
    ts: "2026-04-19T10:00:01.000Z",
  });
  appendLog("onboarding", "2026-04-19", {
    workflow: "onboarding",
    itemId: "alice@example.com",
    runId: "alice@example.com#2",
    level: "step",
    message: "second run",
    ts: "2026-04-19T10:00:02.000Z",
  });

  const stream = await readSseMessages(
    await app().request(
      hubUrl("logs", { workflow: "onboarding", id: "alice@example.com", runId: "alice@example.com#1", date: "2026-04-19" }),
    ),
    1,
  );
  const logs = unpack(stream.messages[0]) as Array<{ message: string }>;
  assert.deepEqual(logs.map((log) => log.message), ["legacy run one"]);
  await stream.cancel();
});

test("Hono /events/logs replays snapshot when source length shrinks", async () => {
  appendLog("onboarding", "2026-04-19", {
    workflow: "onboarding",
    itemId: "alice@example.com",
    runId: "run-a",
    level: "step",
    message: "first",
    ts: "2026-04-19T10:00:01.000Z",
  });
  appendLog("onboarding", "2026-04-19", {
    workflow: "onboarding",
    itemId: "alice@example.com",
    runId: "run-a",
    level: "step",
    message: "second",
    ts: "2026-04-19T10:00:02.000Z",
  });

  const response = await app().request(
    hubUrl("logs", { workflow: "onboarding", id: "alice@example.com", runId: "run-a", date: "2026-04-19" }),
  );
  setTimeout(() => {
    writeFileSync(
      join(dir, "onboarding-2026-04-19-logs.jsonl"),
      `${JSON.stringify({
        workflow: "onboarding",
        itemId: "alice@example.com",
        runId: "run-a",
        level: "step",
        message: "replacement",
        ts: "2026-04-19T10:00:03.000Z",
      })}\n`,
    );
  }, 50);

  const stream = await readSseMessages(response, 2, 1_500);
  assert.deepEqual((unpack(stream.messages[0]) as Array<{ message: string }>).map((log) => log.message), ["first", "second"]);
  assert.deepEqual((unpack(stream.messages[1]) as Array<{ message: string }>).map((log) => log.message), ["replacement"]);
  await stream.cancel();
});

test("Hono /events/run-events reconnect replays full relevant history", async () => {
  appendSessionEvent({
    type: "workflow_start",
    timestamp: "2026-04-19T10:00:00.000Z",
    pid: 111,
    workflowInstance: "Onboarding 1",
    runId: "run-a",
  });

  const first = await readSseMessages(
    await app().request(hubUrl("runEvents", { workflow: "onboarding", runId: "run-a", date: "2026-04-19" })),
    1,
  );
  assert.equal((unpack(first.messages[0]) as unknown[]).length, 1);
  await first.cancel();

  appendSessionEvent({
    type: "auth_complete",
    timestamp: "2026-04-19T10:00:05.000Z",
    pid: 111,
    workflowInstance: "Onboarding 1",
    runId: "run-a",
    system: "crm",
  });

  const second = await readSseMessages(
    await app().request(hubUrl("runEvents", { workflow: "onboarding", runId: "run-a", date: "2026-04-19" })),
    1,
  );
  const events = unpack(second.messages[0]) as Array<{ type: string }>;
  assert.deepEqual(events.map((event) => event.type), ["workflow_start", "auth_complete"]);
  await second.cancel();
});

test("Hono /events/run-events includes batch-scope events via workflowInstance and excludes sibling instances", async () => {
  appendTrackerEntry("onboarding", "2026-04-19", {
    id: "alice@example.com",
    runId: "run-a",
    data: { instance: "Onboarding 1" },
    timestamp: "2026-04-19T10:00:00.000Z",
  });
  appendTrackerEntry("onboarding", "2026-04-19", {
    id: "bob@example.com",
    runId: "run-b",
    data: { instance: "Onboarding 2" },
    timestamp: "2026-04-19T10:10:00.000Z",
  });
  appendSessionEvent({
    type: "browser_launch",
    timestamp: "2026-04-19T10:00:01.000Z",
    pid: 777,
    workflowInstance: "Onboarding 1",
    system: "crm",
  });
  appendSessionEvent({
    type: "browser_launch",
    timestamp: "2026-04-19T10:10:01.000Z",
    pid: 777,
    workflowInstance: "Onboarding 2",
    system: "crm",
  });
  appendSessionEvent({
    type: "item_start",
    timestamp: "2026-04-19T10:10:02.000Z",
    pid: 777,
    workflowInstance: "Onboarding 2",
    runId: "run-b",
    currentItemId: "bob@example.com",
  });

  const stream = await readSseMessages(
    await app().request(hubUrl("runEvents", { workflow: "onboarding", runId: "run-b", date: "2026-04-19" })),
    1,
  );
  const events = unpack(stream.messages[0]) as Array<{ type: string; workflowInstance: string }>;
  assert.deepEqual(events.map((event) => `${event.workflowInstance}:${event.type}`), [
    "Onboarding 2:browser_launch",
    "Onboarding 2:item_start",
  ]);
  await stream.cancel();
});

test("Hono /events JSONL fallback reads the requested historical date", async () => {
  appendTrackerEntry("alpha", "2026-04-19", {
    workflow: "alpha",
    id: "past-item",
    runId: "past-run",
    status: "done",
    timestamp: "2026-04-19T10:00:00.000Z",
  });
  appendTrackerEntry("alpha", "2026-04-20", {
    workflow: "alpha",
    id: "today-ish-item",
    runId: "other-run",
    status: "done",
    timestamp: "2026-04-20T10:00:00.000Z",
  });

  const stream = await readSseMessages(
    await app().request(hubUrl("entries", { workflow: "alpha", date: "2026-04-19" })),
    1,
  );
  const payload = unpack(stream.messages[0]) as { entries: Array<{ id: string }> };
  assert.deepEqual(payload.entries.map((entry) => entry.id), ["past-item"]);
  await stream.cancel();
});

test("Hono capture session stream starts with session-list and releases its subscription on abort", async () => {
  const stream = await readSseMessages(
    await app().request(hubUrl("captureSessions", {})),
    1,
  );
  // Hub envelope: { sub, data: { sessions: [] }, event: "session-list" }
  const envelope = JSON.parse(stream.messages[0].data) as { sub: string; data: unknown; event?: string };
  assert.equal(envelope.event, "session-list");
  assert.deepEqual(envelope.data, { sessions: [] });
  await waitFor(() => getActiveHonoCaptureSseSubscriberCountForTests() === 1, "capture subscriber to register");
  await stream.cancel();
  await waitFor(() => getActiveHonoCaptureSseSubscriberCountForTests() === 0, "capture subscriber cleanup");
});
