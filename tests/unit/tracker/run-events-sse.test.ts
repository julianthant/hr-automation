import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, appendFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type Server } from "http";
import { getRequestListener } from "@hono/node-server";
import { createDashboardServer } from "../../../src/tracker/dashboard.js";
import { createDashboardHonoApp } from "../../../src/tracker/dashboard/hono/app.js";
import { closeStateDbForTests, openStateDb, stateDbPath } from "../../../src/tracker/state/db.js";
import { emitSessionEvent, readSessionEvents } from "../../../src/tracker/session-events.js";
import { querySessionEventsForRun } from "../../../src/tracker/state/queries.js";

/**
 * Collect SSE `data:` payloads from `url` until either `stopAfter` messages
 * have arrived or `timeoutMs` elapses. Uses an AbortController to tear down
 * the underlying fetch cleanly — no dangling reader promises left behind
 * for `node:test` to flag as "resolution still pending."
 */
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
    controller.abort();
  }
  return messages;
}

describe("/events/run-events SSE", () => {
  let tmp: string;
  let server: Server;
  let port: number;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "run-evt-sse-"));
    // Open the DB first so that emitSessionEvent can populate SQLite via the
    // live projection path (applySessionEventLive -> isStateDbReady -> true).
    openStateDb(tmp);
    server = createDashboardServer({ port: 0, dir: tmp, noClean: true });
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeStateDbForTests(tmp);
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("filters events by runId on first tick", async () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "I", runId: "A" }, tmp);
    emitSessionEvent({ type: "browser_launch", workflowInstance: "I", runId: "A", system: "crm", sessionId: "s1", browserId: "b1" }, tmp);
    emitSessionEvent({ type: "workflow_start", workflowInstance: "J", runId: "B" }, tmp);

    const messages = await collectSSE(
      `http://localhost:${port}/events/run-events?workflow=onboarding&id=alice@example.com&runId=A&date=2026-04-19`,
      { stopAfter: 1, timeoutMs: 1500 },
    );
    const allEvents = messages.flatMap((m) => JSON.parse(m));
    assert.ok(allEvents.every((e: { runId: string }) => e.runId === "A"));
    assert.equal(allEvents.length, 2);
  });

  it("emits delta on subsequent ticks (only new events)", async () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "I", runId: "A" }, tmp);

    // Kick off collection in the background; emit the second event mid-flight
    // so the server's next 500ms tick picks it up and emits a delta message.
    const pending = collectSSE(
      `http://localhost:${port}/events/run-events?workflow=onboarding&id=alice@example.com&runId=A&date=2026-04-19`,
      { stopAfter: 2, timeoutMs: 2500 },
    );
    await new Promise((r) => setTimeout(r, 200));
    emitSessionEvent({ type: "auth_complete", workflowInstance: "I", runId: "A", system: "crm", browserId: "b1" }, tmp);

    const messages = await pending;

    assert.ok(messages.length >= 2, `expected ≥2 data messages, got ${messages.length}`);
    const tick1 = JSON.parse(messages[0]);
    const tick2 = JSON.parse(messages[1]);
    assert.equal(tick1.length, 1);
    assert.equal(tick1[0].type, "workflow_start");
    assert.equal(tick2.length, 1);
    assert.equal(tick2[0].type, "auth_complete");
  });

  it("skips malformed JSONL lines without crashing", async () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "I", runId: "A" }, tmp);
    // Malformed line in JSONL does not affect SQLite; both events should be readable.
    appendFileSync(join(tmp, "sessions.jsonl"), "{not-valid-json\n");
    emitSessionEvent({ type: "auth_complete", workflowInstance: "I", runId: "A", system: "crm", browserId: "b1" }, tmp);

    const messages = await collectSSE(
      `http://localhost:${port}/events/run-events?workflow=onboarding&id=alice@example.com&runId=A&date=2026-04-19`,
      { stopAfter: 1, timeoutMs: 1500 },
    );
    const allEvents = messages.flatMap((m) => JSON.parse(m));
    assert.equal(allEvents.length, 2);
    assert.deepEqual(allEvents.map((e: { type: string }) => e.type), ["workflow_start", "auth_complete"]);
  });
});

describe("/events/run-events SQLite vs JSONL parity", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "run-evt-parity-"));
    // Initialize SQLite so that emitSessionEvent populates both JSONL and
    // SQLite via the live projection path (applySessionEventLive).
    openStateDb(tmp);
  });

  afterEach(() => {
    closeStateDbForTests(tmp);
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("querySessionEventsForRun returns the same events as readSessionEvents filtered by runId", () => {
    // Seed via the normal emit path so both JSONL and SQLite are populated.
    emitSessionEvent({ type: "workflow_start", workflowInstance: "I", runId: "r1" }, tmp);
    emitSessionEvent({ type: "auth_complete", workflowInstance: "I", runId: "r1", system: "ucpath", browserId: "b1" }, tmp);
    // A second run that should NOT appear.
    emitSessionEvent({ type: "workflow_start", workflowInstance: "J", runId: "r2" }, tmp);

    const db = openStateDb(tmp);

    // SQLite path: query by runId.
    const fromSqlite = querySessionEventsForRun(db, { runId: "r1" })
      .map((e) => ({ ...e }));

    // JSONL path: read all events and filter by runId (mirrors what filterEventsForRun does).
    const fromJsonl = readSessionEvents(tmp)
      .filter((e) => e.runId === "r1")
      .map((e) => ({ ...e }));

    // Both paths should return the same two events.
    assert.equal(fromSqlite.length, 2, "SQLite should return 2 events for r1");
    assert.equal(fromJsonl.length, 2, "JSONL should return 2 events for r1");

    // Event types must match (order may differ by fractional ms; sort to compare).
    const sqliteTypes = fromSqlite.map((e) => e.type).sort();
    const jsonlTypes = fromJsonl.map((e) => e.type).sort();
    assert.deepEqual(sqliteTypes, jsonlTypes, "event types should match between SQLite and JSONL paths");

    // runId must be present on all returned events.
    assert.ok(fromSqlite.every((e) => e.runId === "r1"), "all SQLite events should have runId r1");
    assert.ok(fromJsonl.every((e) => e.runId === "r1"), "all JSONL events should have runId r1");
  });
});

describe("/events SSE JSONL fallback", () => {
  it("keeps the JSONL-derived shape when projection is disabled", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "events-jsonl-fallback-"));
    const date = "2026-04-19";
    try {
      appendFileSync(join(tmp, `onboarding-${date}.jsonl`), JSON.stringify({
        workflow: "onboarding",
        timestamp: "2026-04-19T10:00:00Z",
        id: "alice@example.com",
        runId: "run-1",
        status: "running",
        step: "extraction",
      }) + "\n");
      const app = createDashboardHonoApp({
        workflow: "onboarding",
        port: 0,
        dir: tmp,
        stateDb: openStateDb(tmp),
        projectionReady: false,
      });
      const listener = getRequestListener(app.fetch);
      const server = createServer(listener);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      try {
        const port = (server.address() as { port: number }).port;
        const messages = await collectSSE(
          `http://localhost:${port}/events?workflow=onboarding&date=${date}`,
          { stopAfter: 1, timeoutMs: 1500 },
        );
        assert.ok(messages[0], "expected one SSE payload");
        const payload = JSON.parse(messages[0]);
        assert.equal(Array.isArray(payload.entries), true);
        assert.equal(payload.source, undefined);
        assert.equal(payload.entries[0].id, "alice@example.com");
      } finally {
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      closeStateDbForTests(tmp);
      if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
    }
  });
});
