import { describe, it, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, appendFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type Server } from "http";
import { getRequestListener } from "@hono/node-server";
import { once } from "node:events";
import { createDashboardServer } from "../../../src/tracker/dashboard.js";
import { createDashboardHonoApp } from "../../../src/tracker/dashboard/hono/app.js";
import { closeStateDbForTests, openStateDb, stateDbPath } from "../../../src/tracker/state/db.js";
import { emitSessionEvent, readSessionEvents } from "../../../src/tracker/session-events.js";
import { querySessionEventsForRun } from "../../../src/tracker/state/queries.js";
import { dateLocal } from "../../../src/tracker/jsonl.js";
import { rowFilePath, rowsDir, sessionFilePath, sessionsDir } from "../../../src/tracker/paths.js";

async function listeningPort(server: Server): Promise<number> {
  if (!server.listening) await once(server, "listening");
  return (server.address() as { port: number }).port;
}

/**
 * Build a hub URL for a single subscription.
 */
function hubUrl(port: number, topic: string, params: unknown): string {
  const subs = encodeURIComponent(JSON.stringify([{ id: "s1", topic, params }]));
  return `http://localhost:${port}/events/hub?subs=${subs}`;
}

/**
 * Collect SSE hub envelopes from `url` until either `stopAfter` messages
 * have arrived or `timeoutMs` elapses. Unwraps the hub envelope to return
 * the inner `data` field as a JSON string, so callers can parse it identically
 * to the legacy SSE behavior.
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
    let buffered = "";
    while (messages.length < opts.stopAfter) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      buffered += text;
      // Parse complete SSE blocks (double-newline delimited)
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

describe("/events/run-events SSE", () => {
  let tmp: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "run-evt-sse-"));
    // Open the DB first so that emitSessionEvent can populate SQLite via the
    // live projection path (applySessionEventLive -> isStateDbReady -> true).
    openStateDb(tmp);
    server = createDashboardServer({ port: 0, dir: tmp, noClean: true });
    port = await listeningPort(server);
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
      hubUrl(port, "runEvents", { workflow: "onboarding", id: "alice@example.com", runId: "A", date: "2026-04-19" }),
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
      hubUrl(port, "runEvents", { workflow: "onboarding", id: "alice@example.com", runId: "A", date: "2026-04-19" }),
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

  it("does not fall back to JSONL when projection-ready SQLite returns zero rows", async () => {
    // Projection-ready SQLite is authoritative. A zero-row result means the
    // run currently has no projected session events; falling back to JSONL
    // would reintroduce a full session-file scan on every empty tick.
    emitSessionEvent({ type: "workflow_start", workflowInstance: "I", runId: "Z" }, tmp);
    // Clear SQLite while leaving JSONL intact. The handler's SQLite branch
    // sees `[]` and should keep that result.
    const db = openStateDb(tmp);
    db.exec("DELETE FROM session_events");

    const messages = await collectSSE(
      hubUrl(port, "runEvents", { workflow: "onboarding", id: "alice@example.com", runId: "Z", date: "2026-04-19" }),
      { stopAfter: 1, timeoutMs: 1500 },
    );
    const allEvents = messages.flatMap((m) => JSON.parse(m));
    assert.equal(allEvents.length, 0);
  });

  it("falls back to JSONL when the SQLite query throws", async () => {
    // Regression test for the run-events handler's missing try/catch
    // (added 2026-05-07). Drop the table the handler queries to force a
    // SQLite-side throw — the handler must catch, log a warn, and continue
    // through to the JSONL fallback rather than emit an empty stream.
    emitSessionEvent({ type: "workflow_start", workflowInstance: "I", runId: "T" }, tmp);
    const db = openStateDb(tmp);
    db.exec("DROP TABLE session_events");

    const messages = await collectSSE(
      hubUrl(port, "runEvents", { workflow: "onboarding", id: "alice@example.com", runId: "T", date: "2026-04-19" }),
      { stopAfter: 1, timeoutMs: 1500 },
    );
    const allEvents = messages.flatMap((m) => JSON.parse(m));
    assert.equal(allEvents.length, 1);
    assert.equal(allEvents[0].type, "workflow_start");
    assert.equal(allEvents[0].runId, "T");
  });

  it("skips malformed JSONL lines without crashing", async () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "I", runId: "A" }, tmp);
    const sessionDay = dateLocal();
    mkdirSync(sessionsDir(tmp), { recursive: true });
    appendFileSync(sessionFilePath(sessionDay, tmp), "{not-valid-json\n");
    emitSessionEvent({ type: "auth_complete", workflowInstance: "I", runId: "A", system: "crm", browserId: "b1" }, tmp);

    const messages = await collectSSE(
      hubUrl(port, "runEvents", { workflow: "onboarding", id: "alice@example.com", runId: "A", date: "2026-04-19" }),
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
      mkdirSync(rowsDir(tmp), { recursive: true });
      appendFileSync(rowFilePath("onboarding", date, tmp), JSON.stringify({
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
        // Use the hub endpoint instead of the removed legacy /events endpoint
        const subs = encodeURIComponent(JSON.stringify([{ id: "s1", topic: "entries", params: { workflow: "onboarding", date } }]));
        const controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(1500)]);
        let envelopeData: unknown;
        try {
          const res = await fetch(`http://localhost:${port}/events/hub?subs=${subs}`, { signal });
          assert.equal(res.status, 200);
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let buffered = "";
          outer: while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffered += decoder.decode(value, { stream: true });
            let splitAt = buffered.indexOf("\n\n");
            while (splitAt >= 0) {
              const block = buffered.slice(0, splitAt);
              buffered = buffered.slice(splitAt + 2);
              const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
              if (dataLine) {
                const envelope = JSON.parse(dataLine.slice(6)) as { sub: string; data: unknown };
                envelopeData = envelope.data;
                await reader.cancel();
                break outer;
              }
              splitAt = buffered.indexOf("\n\n");
            }
          }
        } catch {
          // timeout
        } finally {
          controller.abort();
        }
        assert.ok(envelopeData, "expected one SSE payload");
        const payload = envelopeData as { entries: Array<{ id: string }>; source?: unknown };
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
