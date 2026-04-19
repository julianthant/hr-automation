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

describe("/events/run-events runId fallback (pid + time-window)", () => {
  let tmp: string;
  let server: Server;
  let port: number;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fallback-"));
    server = createDashboardServer({ port: 0, dir: tmp, noClean: true });
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("includes pre-feature events (no runId) by pid match within active window", async () => {
    appendEvent(tmp, { type: "browser_launch", timestamp: "2026-04-19T10:00:01Z", pid: 1234, workflowInstance: "I", system: "crm" });
    appendEvent(tmp, { type: "duo_request", timestamp: "2026-04-19T10:00:02Z", pid: 1234, workflowInstance: "I", system: "crm" });
    appendEvent(tmp, { type: "workflow_start", timestamp: "2026-04-19T10:00:00Z", pid: 1234, workflowInstance: "I", runId: "A" });
    appendEvent(tmp, { type: "browser_launch", timestamp: "2026-04-19T10:00:01Z", pid: 9999, workflowInstance: "J", system: "ucpath" });

    const messages = await collectSSE(
      `http://localhost:${port}/events/run-events?workflow=onboarding&id=alice@example.com&runId=A&date=2026-04-19`,
      { stopAfter: 1, timeoutMs: 1500 },
    );
    const data = messages.map((m) => JSON.parse(m)).flat();

    assert.equal(data.length, 3);
    const types = data.map((e: { type: string }) => e.type).sort();
    assert.deepEqual(types, ["browser_launch", "duo_request", "workflow_start"]);
    assert.equal(data.find((e: { pid: number }) => e.pid === 9999), undefined);
  });
});
