import { describe, it, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  emitSessionEvent,
  generateInstanceName,
  readSessionEvents,
  getSessionsFilePath,
} from "../../../src/tracker/session-events.js";
import { rebuildSessionState } from "../../../src/tracker/dashboard.js";

function tempDir(): string {
  const d = join(tmpdir(), `sessions-test-${randomUUID()}`);
  mkdirSync(d, { recursive: true });
  return d;
}

describe("emitSessionEvent + readSessionEvents roundtrip", () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });

  it("writes and reads events preserving type and fields", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Test 1" }, dir);
    emitSessionEvent({
      type: "browser_launch",
      workflowInstance: "Test 1",
      sessionId: "Session 1",
      browserId: "b1",
      system: "Kuali",
    }, dir);

    const events = readSessionEvents(dir);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "workflow_start");
    assert.equal(events[0].workflowInstance, "Test 1");
    assert.equal(events[0].pid, process.pid);
    assert.equal(events[1].type, "browser_launch");
    assert.equal(events[1].browserId, "b1");
    assert.equal(events[1].system, "Kuali");
  });

  it("returns empty array when file does not exist", () => {
    const empty = tempDir();
    rmSync(empty, { recursive: true, force: true });
    assert.deepEqual(readSessionEvents(empty), []);
  });

  it("includes pid and timestamp automatically", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "T" }, dir);
    const [e] = readSessionEvents(dir);
    assert.equal(e.pid, process.pid);
    assert.ok(e.timestamp.match(/^\d{4}-\d{2}-\d{2}T/));
  });
});

describe("rebuildSessionState — workflows", () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });

  it("creates a workflow entry from workflow_start", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Sep 1" }, dir);
    const state = rebuildSessionState(dir);
    assert.equal(state.workflows.length, 1);
    assert.equal(state.workflows[0].instance, "Sep 1");
    assert.equal(state.workflows[0].active, true);
  });

  it("marks workflow inactive on workflow_end", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Sep 1" }, dir);
    emitSessionEvent({ type: "workflow_end", workflowInstance: "Sep 1" }, dir);
    const state = rebuildSessionState(dir);
    assert.equal(state.workflows[0].active, false);
  });

  it("attaches sessions and browsers to the workflow", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Sep 1" }, dir);
    emitSessionEvent({ type: "session_create", workflowInstance: "Sep 1", sessionId: "Session 1" }, dir);
    emitSessionEvent({
      type: "browser_launch", workflowInstance: "Sep 1",
      sessionId: "Session 1", browserId: "b-kuali", system: "Kuali",
    }, dir);
    emitSessionEvent({
      type: "browser_launch", workflowInstance: "Sep 1",
      sessionId: "Session 1", browserId: "b-oldk", system: "OldKronos",
    }, dir);

    const state = rebuildSessionState(dir);
    const wf = state.workflows[0];
    assert.equal(wf.sessions.length, 1);
    assert.equal(wf.sessions[0].browsers.length, 2);
    assert.deepEqual(
      wf.sessions[0].browsers.map((b) => b.system).sort(),
      ["Kuali", "OldKronos"],
    );
  });

  it("transitions browser authState: idle → authenticating → authed", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Sep 1" }, dir);
    emitSessionEvent({ type: "session_create", workflowInstance: "Sep 1", sessionId: "S1" }, dir);
    emitSessionEvent({
      type: "browser_launch", workflowInstance: "Sep 1",
      sessionId: "S1", browserId: "b1", system: "Kuali",
    }, dir);
    assert.equal(
      rebuildSessionState(dir).workflows[0].sessions[0].browsers[0].authState,
      "idle",
    );

    emitSessionEvent({
      type: "auth_start", workflowInstance: "Sep 1", browserId: "b1", system: "Kuali",
    }, dir);
    assert.equal(
      rebuildSessionState(dir).workflows[0].sessions[0].browsers[0].authState,
      "authenticating",
    );

    emitSessionEvent({
      type: "auth_complete", workflowInstance: "Sep 1", browserId: "b1", system: "Kuali",
    }, dir);
    assert.equal(
      rebuildSessionState(dir).workflows[0].sessions[0].browsers[0].authState,
      "authed",
    );
  });

  it("removes browser on browser_close", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Sep 1" }, dir);
    emitSessionEvent({ type: "session_create", workflowInstance: "Sep 1", sessionId: "S1" }, dir);
    emitSessionEvent({
      type: "browser_launch", workflowInstance: "Sep 1",
      sessionId: "S1", browserId: "b1", system: "Kuali",
    }, dir);
    emitSessionEvent({
      type: "browser_close", workflowInstance: "Sep 1", browserId: "b1", system: "Kuali",
    }, dir);

    const state = rebuildSessionState(dir);
    assert.equal(state.workflows[0].sessions[0].browsers.length, 0);
  });

  it("sets currentItemId from item_start and keeps it after item_complete", () => {
    // The dashboard deliberately preserves the last item id after the workflow ends
    // so users can see which record/employee the session was for. Only item_start
    // replaces the value; item_complete is a no-op for currentItemId.
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Sep 1" }, dir);
    emitSessionEvent({ type: "item_start", workflowInstance: "Sep 1", currentItemId: "DOC-1" }, dir);
    assert.equal(rebuildSessionState(dir).workflows[0].currentItemId, "DOC-1");

    emitSessionEvent({ type: "item_complete", workflowInstance: "Sep 1", currentItemId: "DOC-1" }, dir);
    assert.equal(rebuildSessionState(dir).workflows[0].currentItemId, "DOC-1");
  });

  it("marks workflow's pidAlive=false when start PID is dead (crash recovery)", () => {
    // Emit workflow_start, then overwrite the file with a fake dead PID (PID 1 is typically
    // the init process; on Windows it does not exist and process.kill(1, 0) throws).
    // Use 999999 which is essentially guaranteed not to be alive.
    const path = getSessionsFilePath(dir);
    const event = {
      type: "workflow_start",
      workflowInstance: "Stale",
      timestamp: new Date().toISOString(),
      pid: 999999,
    };
    // Write directly to bypass the auto-pid injection
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(event) + "\n");

    const state = rebuildSessionState(dir);
    assert.equal(state.workflows.length, 1);
    assert.equal(
      state.workflows[0].pidAlive,
      false,
      "Workflow with dead start-PID should have pidAlive=false",
    );
    assert.equal(
      state.workflows[0].active,
      true,
      "active stays true (workflow_end never fired) — SessionPanel filters on pidAlive instead",
    );
  });

  it("keeps workflow active when start PID is alive", () => {
    // Use this process's own PID — guaranteed alive
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Live" }, dir);
    const state = rebuildSessionState(dir);
    assert.equal(state.workflows[0].active, true);
    assert.equal(state.workflows[0].pidAlive, true);
  });

  it("flags workflow as crashedOnLaunch when end=failed and no browser_launch occurred", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Crashed 1" }, dir);
    emitSessionEvent({
      type: "workflow_end", workflowInstance: "Crashed 1", finalStatus: "failed",
    }, dir);
    const state = rebuildSessionState(dir);
    const wf = state.workflows.find((w) => w.instance === "Crashed 1");
    assert.ok(wf, "workflow entry should exist");
    assert.equal(wf!.crashedOnLaunch, true);
    assert.equal(wf!.finalStatus, "failed");
  });

  it("does NOT flag crashedOnLaunch when browser_launch emitted before failure", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Partial 1" }, dir);
    emitSessionEvent({
      type: "session_create", workflowInstance: "Partial 1", sessionId: "S1",
    }, dir);
    emitSessionEvent({
      type: "browser_launch", workflowInstance: "Partial 1",
      sessionId: "S1", browserId: "b1", system: "Kuali",
    }, dir);
    emitSessionEvent({
      type: "workflow_end", workflowInstance: "Partial 1", finalStatus: "failed",
    }, dir);
    const state = rebuildSessionState(dir);
    const wf = state.workflows.find((w) => w.instance === "Partial 1");
    assert.ok(wf);
    assert.notEqual(wf!.crashedOnLaunch, true);
  });
});

describe("rebuildSessionState — duoQueue", () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });

  it("adds duo_request to queue as 'waiting' until duo_start", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Sep 1" }, dir);
    emitSessionEvent({
      type: "duo_request", workflowInstance: "Sep 1",
      system: "NewKronos", duoRequestId: "req-1",
    }, dir);

    const state = rebuildSessionState(dir);
    assert.equal(state.duoQueue.length, 1);
    assert.equal(state.duoQueue[0].state, "waiting");
    assert.equal(state.duoQueue[0].system, "NewKronos");
    assert.equal(state.duoQueue[0].instance, "Sep 1");
    assert.equal(state.duoQueue[0].position, 1);
  });

  it("marks duo entry 'active' after duo_start", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Sep 1" }, dir);
    emitSessionEvent({
      type: "duo_request", workflowInstance: "Sep 1",
      system: "NewKronos", duoRequestId: "req-1",
    }, dir);
    emitSessionEvent({
      type: "duo_start", workflowInstance: "Sep 1",
      system: "NewKronos", duoRequestId: "req-1",
    }, dir);

    const state = rebuildSessionState(dir);
    assert.equal(state.duoQueue[0].state, "active");
  });

  it("removes resolved entries (duo_complete) from queue", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Sep 1" }, dir);
    emitSessionEvent({
      type: "duo_request", workflowInstance: "Sep 1",
      system: "NewKronos", duoRequestId: "req-1",
    }, dir);
    emitSessionEvent({
      type: "duo_complete", workflowInstance: "Sep 1",
      system: "NewKronos", duoRequestId: "req-1",
    }, dir);

    assert.equal(rebuildSessionState(dir).duoQueue.length, 0);
  });

  it("assigns incrementing positions across multiple queued requests", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Sep 1" }, dir);
    emitSessionEvent({ type: "workflow_start", workflowInstance: "EID 1" }, dir);
    emitSessionEvent({
      type: "duo_request", workflowInstance: "Sep 1",
      system: "NewKronos", duoRequestId: "req-1",
    }, dir);
    emitSessionEvent({
      type: "duo_request", workflowInstance: "EID 1",
      system: "UCPath", duoRequestId: "req-2",
    }, dir);

    const state = rebuildSessionState(dir);
    assert.equal(state.duoQueue.length, 2);
    assert.equal(state.duoQueue[0].position, 1);
    assert.equal(state.duoQueue[1].position, 2);
  });

  it("overlays duo_waiting onto browser authState when pending Duo matches system+instance", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Sep 1" }, dir);
    emitSessionEvent({ type: "session_create", workflowInstance: "Sep 1", sessionId: "S1" }, dir);
    emitSessionEvent({
      type: "browser_launch", workflowInstance: "Sep 1",
      sessionId: "S1", browserId: "b-newk", system: "NewKronos",
    }, dir);
    emitSessionEvent({
      type: "auth_start", workflowInstance: "Sep 1",
      browserId: "b-newk", system: "NewKronos",
    }, dir);
    emitSessionEvent({
      type: "duo_request", workflowInstance: "Sep 1",
      system: "NewKronos", duoRequestId: "req-1",
    }, dir);

    const state = rebuildSessionState(dir);
    const browser = state.workflows[0].sessions[0].browsers[0];
    assert.equal(
      browser.authState,
      "duo_waiting",
      "Browser auth state should be overlaid to duo_waiting when a matching duo_request is pending",
    );
  });
});

describe("rebuildSessionState — screenshot scenario", () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });

  it("reproduces the full Separation + EID Lookup dashboard state", () => {
    // Separation 1 with 3 browsers, NewKronos duo active
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Separation 1" }, dir);
    emitSessionEvent({ type: "session_create", workflowInstance: "Separation 1", sessionId: "Session 1" }, dir);
    for (const [id, sys] of [["b-kuali", "Kuali"], ["b-oldk", "OldKronos"], ["b-newk", "NewKronos"]] as const) {
      emitSessionEvent({
        type: "browser_launch", workflowInstance: "Separation 1",
        sessionId: "Session 1", browserId: id, system: sys,
      }, dir);
    }
    emitSessionEvent({ type: "auth_complete", workflowInstance: "Separation 1", browserId: "b-kuali", system: "Kuali" }, dir);
    emitSessionEvent({ type: "auth_complete", workflowInstance: "Separation 1", browserId: "b-oldk", system: "OldKronos" }, dir);
    emitSessionEvent({ type: "auth_start", workflowInstance: "Separation 1", browserId: "b-newk", system: "NewKronos" }, dir);
    emitSessionEvent({ type: "item_start", workflowInstance: "Separation 1", currentItemId: "DOC-2024-001" }, dir);
    emitSessionEvent({ type: "duo_request", workflowInstance: "Separation 1", system: "NewKronos", duoRequestId: "sep-req" }, dir);
    emitSessionEvent({ type: "duo_start", workflowInstance: "Separation 1", system: "NewKronos", duoRequestId: "sep-req" }, dir);

    // EID Lookup 1 with UCPath queued
    emitSessionEvent({ type: "workflow_start", workflowInstance: "EID Lookup 1" }, dir);
    emitSessionEvent({ type: "session_create", workflowInstance: "EID Lookup 1", sessionId: "Session 1" }, dir);
    emitSessionEvent({
      type: "browser_launch", workflowInstance: "EID Lookup 1",
      sessionId: "Session 1", browserId: "b-ucp", system: "UCPath",
    }, dir);
    emitSessionEvent({ type: "auth_start", workflowInstance: "EID Lookup 1", browserId: "b-ucp", system: "UCPath" }, dir);
    emitSessionEvent({ type: "item_start", workflowInstance: "EID Lookup 1", currentItemId: "Garcia, Maria" }, dir);
    emitSessionEvent({ type: "duo_request", workflowInstance: "EID Lookup 1", system: "UCPath", duoRequestId: "eid-req" }, dir);

    const state = rebuildSessionState(dir);

    // 2 workflows — both active (PID is our own process.pid, which is alive)
    assert.equal(state.workflows.length, 2);
    const sep = state.workflows.find((w) => w.instance === "Separation 1")!;
    const eid = state.workflows.find((w) => w.instance === "EID Lookup 1")!;
    assert.ok(sep && eid);
    assert.equal(sep.active, true);
    assert.equal(eid.active, true);

    // Separation 1: 3 browsers (Kuali authed, OldKronos authed, NewKronos duo_waiting)
    const sepBrowsers = sep.sessions[0].browsers;
    assert.equal(sepBrowsers.length, 3);
    assert.equal(sepBrowsers.find((b) => b.system === "Kuali")!.authState, "authed");
    assert.equal(sepBrowsers.find((b) => b.system === "OldKronos")!.authState, "authed");
    assert.equal(sepBrowsers.find((b) => b.system === "NewKronos")!.authState, "duo_waiting");
    assert.equal(sep.currentItemId, "DOC-2024-001");

    // EID Lookup 1: UCPath duo_waiting
    const eidBrowsers = eid.sessions[0].browsers;
    assert.equal(eidBrowsers.length, 1);
    assert.equal(eidBrowsers[0].system, "UCPath");
    assert.equal(eidBrowsers[0].authState, "duo_waiting");
    assert.equal(eid.currentItemId, "Garcia, Maria");

    // Duo queue: NewKronos active (#1), UCPath waiting (#2)
    assert.equal(state.duoQueue.length, 2);
    assert.equal(state.duoQueue[0].system, "NewKronos");
    assert.equal(state.duoQueue[0].state, "active");
    assert.equal(state.duoQueue[0].position, 1);
    assert.equal(state.duoQueue[1].system, "UCPath");
    assert.equal(state.duoQueue[1].state, "waiting");
    assert.equal(state.duoQueue[1].position, 2);
  });
});

// ── generateInstanceName: dead-pid self-heal ─────────────────
//
// generateInstanceName walks sessions.jsonl counting start/end pairs to find
// the next free slot. A `workflow_start` without a matching `workflow_end`
// keeps its slot locked — which used to be the right call (protect in-flight
// runs) but also meant a crashed process (kill -9, pre-fix pool runner that
// never emitted `workflow_end`) would lock "EID Lookup 1" forever. The
// dead-pid + 60s heal below treats orphan starts as ended so legitimate new
// runs reclaim the slot, while still blocking it briefly after a recent
// start in case another process is racing.

const TMP = () => mkdtempSync(join(tmpdir(), "hrauto-gin-"));

function writeSessionsRaw(dir: string, lines: object[]): void {
  writeFileSync(
    join(dir, "sessions.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

test("generateInstanceName: ignores stale start whose pid is dead and >60s old", () => {
  const dir = TMP();
  const oldTs = new Date(Date.now() - 120_000).toISOString();
  writeSessionsRaw(dir, [
    // Pid 2 is practically never alive on Unix; using 0 raises EINVAL, 2 raises ESRCH.
    { type: "workflow_start", workflowInstance: "EID Lookup 1", pid: 2, timestamp: oldTs, runId: "x" },
  ]);
  const name = generateInstanceName("eid-lookup", dir);
  assert.equal(name, "EID Lookup 1", "dead-pid stale start treated as ended");
});

test("generateInstanceName: keeps fresh stale start (<60s) as active", () => {
  const dir = TMP();
  const freshTs = new Date(Date.now() - 5_000).toISOString();
  writeSessionsRaw(dir, [
    { type: "workflow_start", workflowInstance: "EID Lookup 1", pid: 2, timestamp: freshTs, runId: "x" },
  ]);
  const name = generateInstanceName("eid-lookup", dir);
  assert.equal(name, "EID Lookup 2", "young stale start still blocks the number");
});

test("generateInstanceName: keeps alive-pid start as active even if old", () => {
  const dir = TMP();
  const oldTs = new Date(Date.now() - 120_000).toISOString();
  writeSessionsRaw(dir, [
    { type: "workflow_start", workflowInstance: "EID Lookup 1", pid: process.pid, timestamp: oldTs, runId: "x" },
  ]);
  const name = generateInstanceName("eid-lookup", dir);
  assert.equal(name, "EID Lookup 2", "alive pid blocks the number regardless of age");
});

test("generateInstanceName: paired start+end frees the number", () => {
  const dir = TMP();
  const ts = new Date(Date.now() - 5_000).toISOString();
  writeSessionsRaw(dir, [
    { type: "workflow_start", workflowInstance: "EID Lookup 1", pid: process.pid, timestamp: ts, runId: "x" },
    { type: "workflow_end", workflowInstance: "EID Lookup 1", finalStatus: "done", pid: process.pid, timestamp: ts, runId: "x" },
  ]);
  const name = generateInstanceName("eid-lookup", dir);
  assert.equal(name, "EID Lookup 1", "paired start+end frees the slot");
});
