import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, appendFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Server } from "http";
import { createDashboardServer } from "../../../src/tracker/dashboard.js";

const today = new Date().toISOString().slice(0, 10);

function appendEntry(dir: string, entry: object): void {
  appendFileSync(join(dir, `onboarding-${today}.jsonl`), JSON.stringify(entry) + "\n");
}

function appendEvent(dir: string, event: object): void {
  appendFileSync(join(dir, "sessions.jsonl"), JSON.stringify(event) + "\n");
}

describe("/events enriches entries with cacheHits and cacheStepAvgs", () => {
  let tmp: string;
  let server: Server;
  let port: number;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cache-enrich-"));
    server = createDashboardServer({ port: 0, dir: tmp, noClean: true });
    port = (server.address() as { port: number }).port;
  });

  afterEach(() => {
    server.close();
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  async function readFirstTick(url: string): Promise<unknown> {
    const res = await fetch(url);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    reader.cancel();
    const text = new TextDecoder().decode(value);
    const line = text.split("\n").find((l) => l.startsWith("data: "));
    return line ? JSON.parse(line.slice(6)) : null;
  }

  it("attaches cacheHits to entry whose runId has cache_hit events", async () => {
    appendEntry(tmp, { workflow: "onboarding", id: "alice@example.com", runId: "alice@example.com#1", status: "running", step: "i9-creation", timestamp: new Date().toISOString() });
    appendEvent(tmp, { type: "cache_hit", timestamp: new Date().toISOString(), pid: 1, workflowInstance: "I", currentItemId: "alice@example.com", runId: "alice@example.com#1", step: "extraction" });
    appendEvent(tmp, { type: "cache_hit", timestamp: new Date().toISOString(), pid: 1, workflowInstance: "I", currentItemId: "alice@example.com", runId: "alice@example.com#1", step: "pdf-download" });

    const payload = await readFirstTick(`http://localhost:${port}/events?workflow=onboarding`) as { entries: Array<{ runId: string; cacheHits?: string[] }> };
    const entry = payload.entries.find((e) => e.runId === "alice@example.com#1");
    assert.ok(entry, "entry present");
    assert.deepEqual(entry!.cacheHits, ["extraction", "pdf-download"]);
  });

  it("dedupes repeated cache_hit events for the same step", async () => {
    appendEntry(tmp, { workflow: "onboarding", id: "alice@example.com", runId: "alice@example.com#1", status: "running", step: "i9-creation", timestamp: new Date().toISOString() });
    appendEvent(tmp, { type: "cache_hit", timestamp: new Date().toISOString(), pid: 1, workflowInstance: "I", currentItemId: "alice@example.com", runId: "alice@example.com#1", step: "extraction" });
    appendEvent(tmp, { type: "cache_hit", timestamp: new Date().toISOString(), pid: 1, workflowInstance: "I", currentItemId: "alice@example.com", runId: "alice@example.com#1", step: "extraction" });

    const payload = await readFirstTick(`http://localhost:${port}/events?workflow=onboarding`) as { entries: Array<{ runId: string; cacheHits?: string[] }> };
    const entry = payload.entries.find((e) => e.runId === "alice@example.com#1");
    assert.deepEqual(entry!.cacheHits, ["extraction"]);
  });

  it("populates cacheStepAvgs from prior-day step durations", async () => {
    appendEntry(tmp, { workflow: "onboarding", id: "alice@example.com", runId: "alice@example.com#1", status: "running", step: "i9-creation", timestamp: new Date().toISOString() });
    appendEvent(tmp, { type: "cache_hit", timestamp: new Date().toISOString(), pid: 1, workflowInstance: "I", currentItemId: "alice@example.com", runId: "alice@example.com#1", step: "extraction" });

    // Yesterday's run: extraction step took 47 seconds
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const yPath = join(tmp, `onboarding-${yesterday}.jsonl`);
    const t0 = new Date(`${yesterday}T10:00:00Z`).toISOString();
    const t47 = new Date(`${yesterday}T10:00:47Z`).toISOString();
    const t60 = new Date(`${yesterday}T10:01:00Z`).toISOString();
    appendFileSync(yPath, JSON.stringify({ workflow: "onboarding", id: "bob@example.com", runId: "bob@example.com#1", status: "running", step: "extraction", timestamp: t0 }) + "\n");
    appendFileSync(yPath, JSON.stringify({ workflow: "onboarding", id: "bob@example.com", runId: "bob@example.com#1", status: "running", step: "pdf-download", timestamp: t47 }) + "\n");
    appendFileSync(yPath, JSON.stringify({ workflow: "onboarding", id: "bob@example.com", runId: "bob@example.com#1", status: "done", timestamp: t60 }) + "\n");

    const payload = await readFirstTick(`http://localhost:${port}/events?workflow=onboarding`) as { entries: Array<{ runId: string; cacheStepAvgs?: Record<string, number> }> };
    const entry = payload.entries.find((e) => e.runId === "alice@example.com#1");
    assert.ok(entry!.cacheStepAvgs, "cacheStepAvgs present");
    assert.ok(entry!.cacheStepAvgs!.extraction >= 46000 && entry!.cacheStepAvgs!.extraction <= 48000,
      `expected ~47000ms, got ${entry!.cacheStepAvgs!.extraction}`);
  });

  it("omits cacheHits and cacheStepAvgs for entries with no cache_hit events", async () => {
    appendEntry(tmp, { workflow: "onboarding", id: "carol@example.com", runId: "carol@example.com#1", status: "running", step: "extraction", timestamp: new Date().toISOString() });

    const payload = await readFirstTick(`http://localhost:${port}/events?workflow=onboarding`) as { entries: Array<{ runId: string; cacheHits?: string[] }> };
    const entry = payload.entries.find((e) => e.runId === "carol@example.com#1");
    assert.deepEqual(entry!.cacheHits ?? [], []);
  });
});
