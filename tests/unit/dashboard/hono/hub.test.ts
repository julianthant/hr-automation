import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";

import { parseSubsQuery } from "../../../../src/tracker/dashboard/hono/topics.js";
import { createDashboardServer } from "../../../../src/tracker/dashboard.js";
import { closeStateDbForTests } from "../../../../src/tracker/state/db.js";
import { emitSessionEvent } from "../../../../src/tracker/session-events.js";
import { dateLocal } from "../../../../src/tracker/jsonl.js";

// ── parseSubsQuery validation tests ──────────────────────────────────────────

describe("parseSubsQuery", () => {
  test("rejects undefined input", () => {
    const result = parseSubsQuery(undefined);
    assert.ok("error" in result, "should return error for undefined");
  });

  test("rejects malformed JSON", () => {
    const result = parseSubsQuery("not-json{{{");
    assert.ok("error" in result, "should return error for invalid JSON");
    assert.ok((result as { error: string }).error.includes("not valid JSON"));
  });

  test("rejects non-array JSON", () => {
    const result = parseSubsQuery(JSON.stringify({ id: "s1", topic: "telegram" }));
    assert.ok("error" in result, "should return error for non-array");
    assert.ok((result as { error: string }).error.includes("array"));
  });

  test("rejects element with missing id field", () => {
    const result = parseSubsQuery(JSON.stringify([{ topic: "telegram", params: {} }]));
    assert.ok("error" in result, "should return error for missing id");
  });

  test("rejects element with missing topic field", () => {
    const result = parseSubsQuery(JSON.stringify([{ id: "s1", params: {} }]));
    assert.ok("error" in result, "should return error for missing topic");
  });

  test("rejects duplicate subscription ids", () => {
    const result = parseSubsQuery(
      JSON.stringify([
        { id: "s1", topic: "telegram", params: {} },
        { id: "s1", topic: "sessions", params: {} },
      ]),
    );
    assert.ok("error" in result, "should return error for duplicate ids");
    assert.ok((result as { error: string }).error.includes("duplicate"));
  });

  test("parses a valid telegram-only subscription", () => {
    const raw = JSON.stringify([{ id: "s1", topic: "telegram", params: {} }]);
    const result = parseSubsQuery(raw);
    assert.ok(!("error" in result), `unexpected error: ${JSON.stringify(result)}`);
    const subs = result as Array<{ id: string; topic: string; params: unknown }>;
    assert.equal(subs.length, 1);
    assert.equal(subs[0].id, "s1");
    assert.equal(subs[0].topic, "telegram");
  });

  test("parses multiple subscriptions with different ids", () => {
    const raw = JSON.stringify([
      { id: "s1", topic: "telegram", params: {} },
      { id: "s2", topic: "sessions", params: {} },
    ]);
    const result = parseSubsQuery(raw);
    assert.ok(!("error" in result));
    const subs = result as Array<{ id: string; topic: string }>;
    assert.equal(subs.length, 2);
    assert.equal(subs[0].id, "s1");
    assert.equal(subs[1].id, "s2");
  });

  test("returns error for empty string", () => {
    const result = parseSubsQuery("");
    assert.ok("error" in result);
  });
});

// ── Integration tests ─────────────────────────────────────────────────────────

/**
 * Collect SSE `data:` payloads until `stopAfter` messages arrive or
 * `timeoutMs` elapses.  Parses each `data:` line as JSON and returns both the
 * raw string (for the SSE-level check) and the parsed envelope.
 */
async function collectHubEnvelopes(
  url: string,
  opts: { stopAfter: number; timeoutMs: number },
): Promise<Array<{ sub: string; data: unknown; event?: string }>> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(opts.timeoutMs)]);
  const envelopes: Array<{ sub: string; data: unknown; event?: string }> = [];
  try {
    const res = await fetch(url, { signal });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (envelopes.length < opts.stopAfter) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let splitAt = buffered.indexOf("\n\n");
      while (splitAt >= 0 && envelopes.length < opts.stopAfter) {
        const block = buffered.slice(0, splitAt);
        buffered = buffered.slice(splitAt + 2);
        const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
        if (dataLine) {
          envelopes.push(JSON.parse(dataLine.slice("data: ".length)) as {
            sub: string;
            data: unknown;
            event?: string;
          });
        }
        splitAt = buffered.indexOf("\n\n");
      }
    }
  } catch {
    // AbortError or timeout — return what we have.
  } finally {
    controller.abort();
  }
  return envelopes;
}


describe("/events/hub integration", () => {
  let dir: string;
  let server: Server;
  let port: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-test-"));
    // sessions dir is the tracker dir itself
    server = createDashboardServer({ port: 0, dir, noClean: true, uploadPort: null });
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeStateDbForTests(dir);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  test("returns 400 for invalid subs param", async () => {
    const res = await fetch(`http://localhost:${port}/events/hub?subs=not-json`);
    assert.equal(res.status, 400);
    const body = await res.json() as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.ok(typeof body.error === "string" && body.error.length > 0);
  });

  test("returns 400 for non-array subs param", async () => {
    const subs = encodeURIComponent(JSON.stringify({ id: "s1", topic: "telegram" }));
    const res = await fetch(`http://localhost:${port}/events/hub?subs=${subs}`);
    assert.equal(res.status, 400);
  });

  test("skips unknown topic but keeps connection open", async () => {
    // Two subs: one unknown, one telegram — hub should still emit for telegram
    const subs = encodeURIComponent(
      JSON.stringify([
        { id: "u1", topic: "no-such-topic", params: {} },
        { id: "t1", topic: "telegram", params: {} },
      ]),
    );
    const envelopes = await collectHubEnvelopes(
      `http://localhost:${port}/events/hub?subs=${subs}`,
      { stopAfter: 1, timeoutMs: 2500 },
    );
    // The telegram sub should have emitted at least one envelope
    assert.ok(envelopes.length >= 1, "expected at least 1 envelope");
    assert.equal(envelopes[0].sub, "t1");
  });

  test("hub emits envelope with sub id and data for telegram subscription", async () => {
    // Write a telegram_sent session event so the first tick has data
    const sessionsDated = join(dir, `sessions-${new Date().toISOString().slice(0, 10)}.jsonl`);
    appendFileSync(
      sessionsDated,
      JSON.stringify({
        type: "telegram_sent",
        timestamp: new Date().toISOString(),
        pid: process.pid,
        message: "Test telegram message",
      }) + "\n",
    );

    const subs = encodeURIComponent(
      JSON.stringify([{ id: "s1", topic: "telegram", params: {} }]),
    );
    const envelopes = await collectHubEnvelopes(
      `http://localhost:${port}/events/hub?subs=${subs}`,
      { stopAfter: 1, timeoutMs: 2500 },
    );

    assert.ok(envelopes.length >= 1, "expected at least 1 envelope");
    const first = envelopes[0];
    assert.equal(first.sub, "s1");
    assert.ok(Array.isArray(first.data), "data should be an array of session events");
    const events = first.data as Array<{ type: string }>;
    assert.ok(
      events.some((e) => e.type === "telegram_sent"),
      "expected telegram_sent in data",
    );
  });

  test("legacy /events/telegram returns 404 (removed — use /events/hub)", async () => {
    const res = await fetch(`http://localhost:${port}/events/telegram`);
    assert.equal(res.status, 404, "legacy endpoint should return 404 after removal");
  });

  test("hub emits telegram envelope when events live in a dated sessions file", async () => {
    const iso = new Date().toISOString();
    const sessionsFile = join(dir, `sessions-${dateLocal(new Date(iso))}.jsonl`);
    appendFileSync(
      sessionsFile,
      JSON.stringify({
        type: "telegram_sent",
        timestamp: iso,
        pid: process.pid,
        message: "Dated snapshot file message",
      }) + "\n",
    );

    const subs = encodeURIComponent(
      JSON.stringify([{ id: "s1", topic: "telegram", params: {} }]),
    );
    const envelopes = await collectHubEnvelopes(
      `http://localhost:${port}/events/hub?subs=${subs}`,
      { stopAfter: 1, timeoutMs: 2500 },
    );

    assert.ok(envelopes.length >= 1);
    assert.equal(envelopes[0].sub, "s1");
    const events = envelopes[0].data as Array<{ type: string }>;
    assert.ok(events.some((e) => e.type === "telegram_sent"));
  });

  test("hub emits envelope with no event field for telegram (event is undefined)", async () => {
    const subs = encodeURIComponent(
      JSON.stringify([{ id: "s1", topic: "telegram", params: {} }]),
    );
    const envelopes = await collectHubEnvelopes(
      `http://localhost:${port}/events/hub?subs=${subs}`,
      { stopAfter: 1, timeoutMs: 2500 },
    );

    assert.ok(envelopes.length >= 1);
    // telegram topic doesn't use the event field
    assert.equal(envelopes[0].event, undefined);
  });
});

// ── entries + sessions topic integration tests ────────────────────────────────

describe("/events/hub entries + sessions topics", () => {
  let dir: string;
  let server: Server;
  let port: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-entries-test-"));
    mkdirSync(dir, { recursive: true });
    server = createDashboardServer({ port: 0, dir, noClean: true, uploadPort: null });
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeStateDbForTests(dir);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  test("hub with entries + sessions subs gets both envelopes within 2.5s", async () => {
    const subs = encodeURIComponent(
      JSON.stringify([
        { id: "e1", topic: "entries", params: { workflow: "onboarding" } },
        { id: "s1", topic: "sessions", params: {} },
      ]),
    );
    const envelopes = await collectHubEnvelopes(
      `http://localhost:${port}/events/hub?subs=${subs}`,
      { stopAfter: 2, timeoutMs: 2500 },
    );

    assert.ok(envelopes.length >= 2, `expected at least 2 envelopes, got ${envelopes.length}`);

    const subIds = new Set(envelopes.map((e) => e.sub));
    assert.ok(subIds.has("e1"), "expected envelope with sub id 'e1' (entries)");
    assert.ok(subIds.has("s1"), "expected envelope with sub id 's1' (sessions)");
  });

  test("hub entries envelope has entries/workflows/wfCounts/failureCounts shape", async () => {
    const subs = encodeURIComponent(
      JSON.stringify([
        { id: "e1", topic: "entries", params: { workflow: "onboarding" } },
      ]),
    );
    const envelopes = await collectHubEnvelopes(
      `http://localhost:${port}/events/hub?subs=${subs}`,
      { stopAfter: 1, timeoutMs: 2500 },
    );

    assert.ok(envelopes.length >= 1, "expected at least 1 envelope");
    const env = envelopes.find((e) => e.sub === "e1");
    assert.ok(env, "expected envelope with sub=e1");
    const data = env!.data as Record<string, unknown>;
    assert.ok(Array.isArray(data.entries), "data.entries must be an array");
    assert.ok(Array.isArray(data.workflows), "data.workflows must be an array");
    assert.ok(data.wfCounts !== null && typeof data.wfCounts === "object", "data.wfCounts must be an object");
    assert.ok(data.failureCounts !== null && typeof data.failureCounts === "object", "data.failureCounts must be an object");
  });

  test("hub sessions envelope has workflows and duoQueue shape", async () => {
    const subs = encodeURIComponent(
      JSON.stringify([
        { id: "s1", topic: "sessions", params: {} },
      ]),
    );
    const envelopes = await collectHubEnvelopes(
      `http://localhost:${port}/events/hub?subs=${subs}`,
      { stopAfter: 1, timeoutMs: 2500 },
    );

    assert.ok(envelopes.length >= 1, "expected at least 1 envelope");
    const env = envelopes.find((e) => e.sub === "s1");
    assert.ok(env, "expected envelope with sub=s1");
    const data = env!.data as Record<string, unknown>;
    assert.ok(Array.isArray(data.workflows), "data.workflows must be an array");
    assert.ok(Array.isArray(data.duoQueue), "data.duoQueue must be an array");
  });

  test("legacy /events?workflow=X returns 404 (removed — use /events/hub)", async () => {
    const res = await fetch(`http://localhost:${port}/events?workflow=onboarding`);
    assert.equal(res.status, 404, "legacy endpoint should return 404 after removal");
  });

  test("legacy /events/sessions returns 404 (removed — use /events/hub)", async () => {
    const res = await fetch(`http://localhost:${port}/events/sessions`);
    assert.equal(res.status, 404, "legacy endpoint should return 404 after removal");
  });

  test("entries topic emits default workflow when no workflow param given", async () => {
    // No workflow param — should use getDefaultWorkflow (= "onboarding")
    const subs = encodeURIComponent(
      JSON.stringify([
        { id: "e1", topic: "entries", params: {} },
      ]),
    );
    const envelopes = await collectHubEnvelopes(
      `http://localhost:${port}/events/hub?subs=${subs}`,
      { stopAfter: 1, timeoutMs: 2500 },
    );

    assert.ok(envelopes.length >= 1, "expected at least 1 envelope");
    const env = envelopes.find((e) => e.sub === "e1");
    assert.ok(env, "expected envelope with sub=e1");
    const data = env!.data as Record<string, unknown>;
    // The emitter fell back to default workflow; payload still has the right shape
    assert.ok(Array.isArray(data.entries), "data.entries must be an array");
  });
});

// ── logs + runEvents topic integration tests ──────────────────────────────────

describe("/events/hub logs + runEvents topics", () => {
  let dir: string;
  let server: Server;
  let port: number;
  const today = dateLocal();
  const testWorkflow = "onboarding";
  const testItemId = "test-item-1";
  const testRunId = `${testItemId}#1`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-logs-test-"));
    mkdirSync(dir, { recursive: true });

    // Write a couple of log entries so the logs topic has data to return.
    const logsFile = join(dir, `${testWorkflow}-${today}-logs.jsonl`);
    appendFileSync(
      logsFile,
      JSON.stringify({
        workflow: testWorkflow,
        itemId: testItemId,
        runId: testRunId,
        level: "step",
        message: "starting step",
        ts: new Date().toISOString(),
      }) + "\n",
    );
    appendFileSync(
      logsFile,
      JSON.stringify({
        workflow: testWorkflow,
        itemId: testItemId,
        runId: testRunId,
        level: "success",
        message: "step complete",
        ts: new Date().toISOString(),
      }) + "\n",
    );

    // Write a tracker entry + session event for runEvents topic.
    const trackerFile = join(dir, `${testWorkflow}-${today}.jsonl`);
    appendFileSync(
      trackerFile,
      JSON.stringify({
        workflow: testWorkflow,
        id: testItemId,
        runId: testRunId,
        status: "running",
        step: "ucpath-auth",
        timestamp: new Date().toISOString(),
        data: { instance: "Onboarding 1" },
      }) + "\n",
    );
    const sessionsDatedFile = join(dir, `sessions-${today}.jsonl`);
    appendFileSync(
      sessionsDatedFile,
      JSON.stringify({
        type: "item_start",
        timestamp: new Date().toISOString(),
        pid: process.pid,
        workflowInstance: "Onboarding 1",
        runId: testRunId,
        currentItemId: testItemId,
      }) + "\n",
    );

    server = createDashboardServer({ port: 0, dir, noClean: true, uploadPort: null });
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeStateDbForTests(dir);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  test("hub logs subscription returns first-tick array of log entries matching runId", async () => {
    const subs = encodeURIComponent(
      JSON.stringify([
        {
          id: "l1",
          topic: "logs",
          params: { workflow: testWorkflow, id: testItemId, runId: testRunId, date: today },
        },
      ]),
    );
    const envelopes = await collectHubEnvelopes(
      `http://localhost:${port}/events/hub?subs=${subs}`,
      { stopAfter: 1, timeoutMs: 2500 },
    );

    assert.ok(envelopes.length >= 1, "expected at least 1 envelope");
    const env = envelopes[0];
    assert.equal(env.sub, "l1");
    assert.ok(Array.isArray(env.data), "data should be an array of log entries");
    const entries = env.data as Array<{ runId?: string; message: string }>;
    assert.ok(entries.length >= 2, `expected at least 2 log entries, got ${entries.length}`);
    assert.ok(
      entries.every((e) => !e.runId || e.runId === testRunId),
      "all entries should match the requested runId",
    );
  });

  test("hub runEvents subscription returns first-tick array filtered for the run", async () => {
    const subs = encodeURIComponent(
      JSON.stringify([
        {
          id: "r1",
          topic: "runEvents",
          params: { workflow: testWorkflow, runId: testRunId, date: today },
        },
      ]),
    );
    const envelopes = await collectHubEnvelopes(
      `http://localhost:${port}/events/hub?subs=${subs}`,
      { stopAfter: 1, timeoutMs: 2500 },
    );

    assert.ok(envelopes.length >= 1, "expected at least 1 envelope");
    const env = envelopes[0];
    assert.equal(env.sub, "r1");
    assert.ok(Array.isArray(env.data), "data should be an array of session events");
    const events = env.data as Array<{ type: string }>;
    // The item_start event should be included (has the matching runId)
    assert.ok(
      events.some((e) => e.type === "item_start"),
      "expected item_start event in run events",
    );
  });

  test("hub runEvents subscription resolves workflowInstance past pending tracker rows that lack data.instance (regression: 2026-05-08)", async () => {
    // The scenario: a pending tracker row is emitted FIRST (no data.instance),
    // then later running rows carry the batch instance. Walking the tracker
    // entries with `Array.find` returns the pending row, leaves wfInstance
    // undefined, the SQLite query runs without workflowInstance, and
    // batch-scope session events (workflow_start, browser_launch, auth_*,
    // duo_*) — which have no runId — are never returned. Operator-visible
    // symptom: Events tab shows ONLY runId-direct events (step_change,
    // screenshot) and is missing every batch-scope event for the run.
    //
    // The fix uses `resolveInstanceForRun` instead, which loops past pending
    // rows and returns the first row carrying `data.instance`.

    // Prepend a pending row (no data.instance) BEFORE the running row that
    // beforeEach already wrote. Append-order matters — pending must come
    // first in the file so `Array.find` would have returned it.
    const trackerFile = join(dir, `${testWorkflow}-${today}.jsonl`);
    const existingContents = readFileSync(trackerFile, "utf-8");
    const pendingRow =
      JSON.stringify({
        workflow: testWorkflow,
        id: testItemId,
        runId: testRunId,
        status: "pending",
        timestamp: new Date(Date.now() - 5000).toISOString(),
        data: { __subject: "Onboarding test-item-1" }, // NO `instance` field
      }) + "\n";
    writeFileSync(trackerFile, pendingRow + existingContents);

    // Add batch-scope session events (no runId) tagged with the matching
    // workflowInstance. These are the events that were missing in the bug.
    // Use `emitSessionEvent` (not raw appendFileSync) so the SQLite live
    // projection picks them up — the SQLite path is what this test exercises.
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Onboarding 1" }, dir);
    emitSessionEvent({ type: "browser_launch", workflowInstance: "Onboarding 1" }, dir);

    const subs = encodeURIComponent(
      JSON.stringify([
        {
          id: "r1",
          topic: "runEvents",
          params: { workflow: testWorkflow, runId: testRunId, date: today },
        },
      ]),
    );
    const envelopes = await collectHubEnvelopes(
      `http://localhost:${port}/events/hub?subs=${subs}`,
      { stopAfter: 1, timeoutMs: 2500 },
    );

    assert.ok(envelopes.length >= 1, "expected at least 1 envelope");
    const env = envelopes[0];
    const events = env.data as Array<{ type: string; runId?: string; workflowInstance?: string }>;
    // Both batch-scope events should be attributed to this run via
    // workflowInstance fallback. The runId-direct item_start must also still
    // be present.
    assert.ok(
      events.some((e) => e.type === "workflow_start"),
      "expected workflow_start (batch-scope) attributed via workflowInstance",
    );
    assert.ok(
      events.some((e) => e.type === "browser_launch"),
      "expected browser_launch (batch-scope) attributed via workflowInstance",
    );
    assert.ok(
      events.some((e) => e.type === "item_start"),
      "expected item_start (runId-direct) preserved",
    );
  });

  test("two logs subscriptions on the same hub with different params get correctly demuxed", async () => {
    // Write a second item's log entry
    const logsFile = join(dir, `${testWorkflow}-${today}-logs.jsonl`);
    const secondItemId = "test-item-2";
    const secondRunId = `${secondItemId}#1`;
    appendFileSync(
      logsFile,
      JSON.stringify({
        workflow: testWorkflow,
        itemId: secondItemId,
        runId: secondRunId,
        level: "step",
        message: "second item step",
        ts: new Date().toISOString(),
      }) + "\n",
    );

    const subs = encodeURIComponent(
      JSON.stringify([
        {
          id: "l1",
          topic: "logs",
          params: { workflow: testWorkflow, id: testItemId, runId: testRunId, date: today },
        },
        {
          id: "l2",
          topic: "logs",
          params: { workflow: testWorkflow, id: secondItemId, runId: secondRunId, date: today },
        },
      ]),
    );
    const envelopes = await collectHubEnvelopes(
      `http://localhost:${port}/events/hub?subs=${subs}`,
      { stopAfter: 2, timeoutMs: 3000 },
    );

    assert.ok(envelopes.length >= 2, `expected at least 2 envelopes, got ${envelopes.length}`);
    const subIds = new Set(envelopes.map((e) => e.sub));
    assert.ok(subIds.has("l1"), "expected envelope with sub id 'l1'");
    assert.ok(subIds.has("l2"), "expected envelope with sub id 'l2'");

    // Verify each envelope only contains the logs for its own item
    const l1Env = envelopes.find((e) => e.sub === "l1");
    const l2Env = envelopes.find((e) => e.sub === "l2");
    assert.ok(l1Env, "missing l1 envelope");
    assert.ok(l2Env, "missing l2 envelope");

    const l1Entries = l1Env!.data as Array<{ itemId: string }>;
    const l2Entries = l2Env!.data as Array<{ itemId: string }>;
    assert.ok(
      l1Entries.every((e) => e.itemId === testItemId),
      "l1 entries should all belong to testItemId",
    );
    assert.ok(
      l2Entries.every((e) => e.itemId === secondItemId),
      "l2 entries should all belong to secondItemId",
    );
  });

  test("legacy /events/logs?... returns 404 (removed — use /events/hub)", async () => {
    const params = new URLSearchParams({
      workflow: testWorkflow,
      id: testItemId,
      runId: testRunId,
      date: today,
    });
    const res = await fetch(`http://localhost:${port}/events/logs?${params}`);
    assert.equal(res.status, 404, "legacy endpoint should return 404 after removal");
  });

  test("legacy /events/run-events?... returns 404 (removed — use /events/hub)", async () => {
    const params = new URLSearchParams({
      workflow: testWorkflow,
      runId: testRunId,
      date: today,
    });
    const res = await fetch(`http://localhost:${port}/events/run-events?${params}`);
    assert.equal(res.status, 404, "legacy endpoint should return 404 after removal");
  });
});

// ── captureSessions topic integration tests ───────────────────────────────────
// Note: daemonLog topic removed 2026-05-08 — no frontend consumer exists.
// DaemonLogTail component was deleted in c5df7639; the topic was unused backend-only code.

describe("/events/hub captureSessions topic", () => {
  let dir: string;
  let server: Server;
  let port: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-capture-test-"));
    mkdirSync(dir, { recursive: true });
    server = createDashboardServer({ port: 0, dir, noClean: true, uploadPort: null });
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeStateDbForTests(dir);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  test("hub captureSessions subscription — first envelope has event: session-list with sessions array", async () => {
    const subs = encodeURIComponent(
      JSON.stringify([{ id: "c1", topic: "captureSessions", params: {} }]),
    );
    const envelopes = await collectHubEnvelopes(
      `http://localhost:${port}/events/hub?subs=${subs}`,
      { stopAfter: 1, timeoutMs: 2500 },
    );

    assert.ok(envelopes.length >= 1, "expected at least 1 envelope");
    const first = envelopes[0];
    assert.equal(first.sub, "c1");
    assert.equal(first.event, "session-list", "first envelope event should be 'session-list'");
    const data = first.data as Record<string, unknown>;
    assert.ok(Array.isArray(data.sessions), "data.sessions must be an array");
  });

  test("legacy /api/capture/sessions/stream returns 404 (removed — use /events/hub)", async () => {
    const res = await fetch(`http://localhost:${port}/api/capture/sessions/stream`);
    assert.equal(res.status, 404, "legacy endpoint should return 404 after removal");
  });

  test("legacy /events/daemon-log with invalid pid returns 404 (removed — use /events/hub)", async () => {
    const res = await fetch(`http://localhost:${port}/events/daemon-log?pid=not-a-number`);
    assert.equal(res.status, 404, "legacy endpoint should return 404 after removal");
  });

  test("legacy /events/daemon-log with pid=0 returns 404 (removed — use /events/hub)", async () => {
    const res = await fetch(`http://localhost:${port}/events/daemon-log?pid=0`);
    assert.equal(res.status, 404, "legacy endpoint should return 404 after removal");
  });
});

// ── Manifest check ────────────────────────────────────────────────────────────

test("/events/hub is registered in the Hono app", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-manifest-"));
  const server = createDashboardServer({ port: 0, dir, noClean: true, uploadPort: null });
  const port = (server.address() as { port: number }).port;

  try {
    // A GET with no subs should return 400, not 404 — proves the route exists
    const res = await fetch(`http://localhost:${port}/events/hub`);
    assert.equal(res.status, 400, "expected 400 (route exists, missing subs param)");
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeStateDbForTests(dir);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});
