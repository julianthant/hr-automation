import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Server } from "node:http";

import { parseSubsQuery } from "../../../../src/tracker/dashboard/hono/topics.js";
import { createDashboardServer } from "../../../../src/tracker/dashboard.js";
import { closeStateDbForTests } from "../../../../src/tracker/state/db.js";

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

/**
 * Collect the first SSE `data:` payload from a legacy endpoint (returns raw
 * data value, not an envelope).
 */
async function collectOneLegacySsePayload(url: string, timeoutMs = 2000): Promise<unknown> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
  try {
    const res = await fetch(url, { signal });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const match = /^data: (.+)$/m.exec(buffered);
      if (match) {
        await reader.cancel();
        return JSON.parse(match[1]);
      }
    }
  } catch {
    // timeout or abort
  } finally {
    controller.abort();
  }
  assert.fail("timed out waiting for first SSE payload");
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

  test("legacy /events/telegram emits same payload shape as before", async () => {
    // Write a sessions file with a telegram_sent event
    const datedFile = join(dir, `sessions-${new Date().toISOString().slice(0, 10)}.jsonl`);
    appendFileSync(
      datedFile,
      JSON.stringify({
        type: "telegram_sent",
        timestamp: new Date().toISOString(),
        pid: process.pid,
        message: "Hello from legacy",
      }) + "\n",
    );

    const payload = await collectOneLegacySsePayload(
      `http://localhost:${port}/events/telegram`,
    );

    assert.ok(Array.isArray(payload), "legacy endpoint should emit an array");
    const events = payload as Array<{ type: string }>;
    assert.ok(
      events.some((e) => e.type === "telegram_sent"),
      "expected telegram_sent in legacy payload",
    );
  });

  test("hub emits correct envelope when sessions dir uses legacy sessions.jsonl", async () => {
    // Also test the legacy non-dated sessions.jsonl path that readSessionEventsTolerant handles
    const legacyFile = join(dir, "sessions.jsonl");
    appendFileSync(
      legacyFile,
      JSON.stringify({
        type: "telegram_sent",
        timestamp: new Date().toISOString(),
        pid: process.pid,
        message: "Legacy file message",
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

  test("legacy /events?workflow=X emits entries payload shape", async () => {
    const payload = await collectOneLegacySsePayload(
      `http://localhost:${port}/events?workflow=onboarding`,
    );

    assert.ok(payload !== null && typeof payload === "object", "expected object payload");
    const data = payload as Record<string, unknown>;
    assert.ok(Array.isArray(data.entries), "payload.entries must be an array");
    assert.ok(Array.isArray(data.workflows), "payload.workflows must be an array");
    assert.ok(data.wfCounts !== null && typeof data.wfCounts === "object", "payload.wfCounts must be an object");
    assert.ok(data.failureCounts !== null && typeof data.failureCounts === "object", "payload.failureCounts must be an object");
  });

  test("legacy /events/sessions emits SessionState shape", async () => {
    const payload = await collectOneLegacySsePayload(
      `http://localhost:${port}/events/sessions`,
    );

    assert.ok(payload !== null && typeof payload === "object", "expected object payload");
    const data = payload as Record<string, unknown>;
    assert.ok(Array.isArray(data.workflows), "payload.workflows must be an array");
    assert.ok(Array.isArray(data.duoQueue), "payload.duoQueue must be an array");
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
