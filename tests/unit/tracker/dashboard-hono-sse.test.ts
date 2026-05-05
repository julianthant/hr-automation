import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createDashboardHonoApp } from "../../../src/tracker/dashboard/hono/app.js";
import {
  getActiveHonoCaptureSseSubscriberCountForTests,
  getActiveHonoDaemonLogWatcherCountForTests,
} from "../../../src/tracker/dashboard/hono/routes/events.js";
import { closeStateDbForTests, openStateDb } from "../../../src/tracker/state/db.js";
import type { TrackerEntry } from "../../../src/tracker/jsonl.js";

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
  appendFileSync(join(dir, "sessions.jsonl"), `${JSON.stringify(event)}\n`);
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
    await app().request("/events/logs?workflow=onboarding&id=no-logs&runId=no-logs%231&date=2026-04-19"),
    1,
  );
  assert.deepEqual(JSON.parse(stream.messages[0].data), []);
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
      `/events/logs?workflow=onboarding&id=${encodeURIComponent("alice@example.com")}&runId=${encodeURIComponent("alice@example.com#1")}&date=2026-04-19`,
    ),
    1,
  );
  const logs = JSON.parse(stream.messages[0].data) as Array<{ message: string }>;
  assert.deepEqual(logs.map((log) => log.message), ["legacy run one"]);
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
    await app().request("/events/run-events?workflow=onboarding&runId=run-a&date=2026-04-19"),
    1,
  );
  assert.equal((JSON.parse(first.messages[0].data) as unknown[]).length, 1);
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
    await app().request("/events/run-events?workflow=onboarding&runId=run-a&date=2026-04-19"),
    1,
  );
  const events = JSON.parse(second.messages[0].data) as Array<{ type: string }>;
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
    await app().request("/events/run-events?workflow=onboarding&runId=run-b&date=2026-04-19"),
    1,
  );
  const events = JSON.parse(stream.messages[0].data) as Array<{ type: string; workflowInstance: string }>;
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
    await app().request("/events?workflow=alpha&date=2026-04-19"),
    1,
  );
  const payload = JSON.parse(stream.messages[0].data) as { entries: Array<{ id: string }> };
  assert.deepEqual(payload.entries.map((entry) => entry.id), ["past-item"]);
  await stream.cancel();
});

test("Hono /events/daemon-log tails and releases its watcher on abort", async () => {
  const pid = 444444;
  const daemons = join(dir, "daemons");
  mkdirSync(daemons, { recursive: true });
  writeFileSync(join(daemons, "onboarding-abc.lock.json"), JSON.stringify({ pid, workflow: "onboarding" }));
  writeFileSync(join(daemons, `onboarding-${pid}.log`), "first line\n");

  const stream = await readSseMessages(
    await app().request(`/events/daemon-log?pid=${pid}`),
    1,
  );
  assert.match(stream.messages[0].data, /first line/);
  await waitFor(() => getActiveHonoDaemonLogWatcherCountForTests() === 1, "daemon log watcher to register");
  await stream.cancel();
  await waitFor(() => getActiveHonoDaemonLogWatcherCountForTests() === 0, "daemon log watcher cleanup");
});

test("Hono capture session stream starts with session-list and releases its subscription on abort", async () => {
  const stream = await readSseMessages(
    await app().request("/api/capture/sessions/stream"),
    1,
  );
  assert.equal(stream.messages[0].event, "session-list");
  assert.deepEqual(JSON.parse(stream.messages[0].data), { sessions: [] });
  await waitFor(() => getActiveHonoCaptureSseSubscriberCountForTests() === 1, "capture subscriber to register");
  await stream.cancel();
  await waitFor(() => getActiveHonoCaptureSseSubscriberCountForTests() === 0, "capture subscriber cleanup");
});
