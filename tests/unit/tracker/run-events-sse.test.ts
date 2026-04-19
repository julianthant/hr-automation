import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, appendFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Server } from "http";
import { createDashboardServer } from "../../../src/tracker/dashboard.js";

function appendEvent(dir: string, event: object): void {
  appendFileSync(join(dir, "sessions.jsonl"), JSON.stringify(event) + "\n");
}

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

describe("/events/run-events SSE", () => {
  let tmp: string;
  let server: Server;
  let port: number;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "run-evt-sse-"));
    server = createDashboardServer({ port: 0, dir: tmp, noClean: true });
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("filters events by runId on first tick", async () => {
    appendEvent(tmp, { type: "workflow_start", timestamp: "2026-04-19T10:00:00Z", pid: 1, workflowInstance: "I", runId: "A" });
    appendEvent(tmp, { type: "browser_launch", timestamp: "2026-04-19T10:00:01Z", pid: 1, workflowInstance: "I", runId: "A", system: "crm" });
    appendEvent(tmp, { type: "workflow_start", timestamp: "2026-04-19T10:01:00Z", pid: 2, workflowInstance: "J", runId: "B" });

    const messages = await collectSSE(
      `http://localhost:${port}/events/run-events?workflow=onboarding&id=alice@example.com&runId=A&date=2026-04-19`,
      { stopAfter: 1, timeoutMs: 1500 },
    );
    const allEvents = messages.flatMap((m) => JSON.parse(m));
    assert.ok(allEvents.every((e: { runId: string }) => e.runId === "A"));
    assert.equal(allEvents.length, 2);
  });

  it("emits delta on subsequent ticks (only new events)", async () => {
    appendEvent(tmp, { type: "workflow_start", timestamp: "2026-04-19T10:00:00Z", pid: 1, workflowInstance: "I", runId: "A" });

    // Kick off collection in the background; append the second event mid-flight
    // so the server's next 500ms tick picks it up and emits a delta message.
    const pending = collectSSE(
      `http://localhost:${port}/events/run-events?workflow=onboarding&id=alice@example.com&runId=A&date=2026-04-19`,
      { stopAfter: 2, timeoutMs: 2500 },
    );
    await new Promise((r) => setTimeout(r, 200));
    appendEvent(tmp, { type: "auth_complete", timestamp: "2026-04-19T10:00:05Z", pid: 1, workflowInstance: "I", runId: "A", system: "crm" });

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
    appendEvent(tmp, { type: "workflow_start", timestamp: "2026-04-19T10:00:00Z", pid: 1, workflowInstance: "I", runId: "A" });
    appendFileSync(join(tmp, "sessions.jsonl"), "{not-valid-json\n");
    appendEvent(tmp, { type: "auth_complete", timestamp: "2026-04-19T10:00:05Z", pid: 1, workflowInstance: "I", runId: "A", system: "crm" });

    const messages = await collectSSE(
      `http://localhost:${port}/events/run-events?workflow=onboarding&id=alice@example.com&runId=A&date=2026-04-19`,
      { stopAfter: 1, timeoutMs: 1500 },
    );
    const allEvents = messages.flatMap((m) => JSON.parse(m));
    assert.equal(allEvents.length, 2);
    assert.deepEqual(allEvents.map((e: { type: string }) => e.type), ["workflow_start", "auth_complete"]);
  });
});
