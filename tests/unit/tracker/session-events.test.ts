import { describe, it, beforeEach, test } from "vitest";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import {
  emitSessionEvent,
  emitDaemonLog,
  generateInstanceName,
  readSessionEvents,
  getSessionsFilePath,
  workflowNameFromInstance,
} from "../../../src/tracker/session-events.js";
import { filterEventsForRun, filterLiveSessionState, rebuildSessionState } from "../../../src/tracker/dashboard.js";
import { dateLocal, sessionsDir, sessionFilePath } from "../../../src/tracker/jsonl.js";

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

  it("live session filter drops ended workflows with no live process or recent launch crash", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Sep 1" }, dir);
    emitSessionEvent({ type: "session_create", workflowInstance: "Sep 1", sessionId: "S1" }, dir);
    emitSessionEvent({
      type: "browser_launch",
      workflowInstance: "Sep 1",
      sessionId: "S1",
      browserId: "b1",
      system: "Kuali",
    }, dir);
    emitSessionEvent({ type: "workflow_end", workflowInstance: "Sep 1", finalStatus: "done" }, dir);

    const live = filterLiveSessionState(rebuildSessionState(dir));

    assert.equal(live.workflows.length, 0);
  });

  it("live session filter drops ended workflows even if the old pid has been reused", () => {
    const live = filterLiveSessionState({
      workflows: [{
        instance: "Kronos 1",
        workflow: "kronos-reports",
        active: false,
        pidAlive: true,
        currentItemId: null,
        currentTraceId: null,
        itemInFlight: false,
        currentStep: null,
        finalStatus: "done",
        sessions: [],
      }],
      duoQueue: [],
    });

    assert.equal(live.workflows.length, 0);
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

  it("bootstraps ucpathIdle.lastTouchAt from auth_complete for ucpath (with system field)", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Person Lookup 1" }, dir);
    emitSessionEvent({
      type: "session_create",
      workflowInstance: "Person Lookup 1",
      sessionId: "S1",
    }, dir);
    emitSessionEvent({
      type: "browser_launch",
      workflowInstance: "Person Lookup 1",
      sessionId: "S1",
      browserId: "b-u",
      system: "ucpath",
    }, dir);
    emitSessionEvent({
      type: "auth_complete",
      workflowInstance: "Person Lookup 1",
      browserId: "b-u",
      system: "ucpath",
    }, dir);
    const state = rebuildSessionState(dir);
    assert.ok(state.workflows[0].ucpathIdle?.lastTouchAt);
    assert.match(state.workflows[0].ucpathIdle!.lastTouchAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(state.workflows[0].ucpathIdle!.refreshing, false);
  });

  it("bootstraps ucpathIdle from auth_complete when system omitted but browser is ucpath", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Oath Signature 1" }, dir);
    emitSessionEvent({
      type: "session_create",
      workflowInstance: "Oath Signature 1",
      sessionId: "S1",
    }, dir);
    emitSessionEvent({
      type: "browser_launch",
      workflowInstance: "Oath Signature 1",
      sessionId: "S1",
      browserId: "b1",
      system: "ucpath",
    }, dir);
    emitSessionEvent({
      type: "auth_complete",
      workflowInstance: "Oath Signature 1",
      browserId: "b1",
    }, dir);
    const state = rebuildSessionState(dir);
    assert.ok(state.workflows[0].ucpathIdle?.lastTouchAt);
    assert.equal(state.workflows[0].ucpathIdle!.refreshing, false);
  });

  it("records ucpath_idle_signal refresh lifecycle + daemon_phase on workflow state", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Person Lookup 1" }, dir);
    emitSessionEvent(
      { type: "ucpath_idle_signal", workflowInstance: "Person Lookup 1", data: { kind: "touch" } },
      dir,
    );
    let state = rebuildSessionState(dir);
    assert.ok(state.workflows[0].ucpathIdle);
    assert.equal(state.workflows[0].ucpathIdle!.refreshing, false);

    emitSessionEvent(
      { type: "ucpath_idle_signal", workflowInstance: "Person Lookup 1", data: { kind: "refresh_start" } },
      dir,
    );
    state = rebuildSessionState(dir);
    assert.equal(state.workflows[0].ucpathIdle!.refreshing, true);

    emitSessionEvent(
      { type: "ucpath_idle_signal", workflowInstance: "Person Lookup 1", data: { kind: "refresh_end" } },
      dir,
    );
    state = rebuildSessionState(dir);
    assert.equal(state.workflows[0].ucpathIdle!.refreshing, false);

    emitSessionEvent(
      { type: "daemon_phase", workflowInstance: "Person Lookup 1", data: { phase: "keepalive" } },
      dir,
    );
    state = rebuildSessionState(dir);
    assert.equal(state.workflows[0].daemonPhase, "keepalive");

    emitSessionEvent(
      { type: "daemon_phase", workflowInstance: "Person Lookup 1", data: { phase: "idle" } },
      dir,
    );
    state = rebuildSessionState(dir);
    assert.equal(state.workflows[0].daemonPhase, "idle");
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
    mkdirSync(sessionsDir(dir), { recursive: true });
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
      "active stays true (workflow_end never fired) — session drawer filters on pidAlive instead",
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

  it("does NOT flag crashedOnLaunch for a stale workflow_end older than the age window", () => {
    // Write events directly with an ancient timestamp — emitSessionEvent always
    // stamps `now`, so we bypass it to simulate a crash from a previous
    // orchestrator session still sitting in append-only sessions.jsonl.
    const stale = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const path = getSessionsFilePath(dir);
    const start = {
      type: "workflow_start", timestamp: stale, pid: 999999,
      workflowInstance: "Stale Crash",
    };
    const end = {
      type: "workflow_end", timestamp: stale, pid: 999999,
      workflowInstance: "Stale Crash", finalStatus: "failed",
    };
    mkdirSync(sessionsDir(dir), { recursive: true });
    writeFileSync(path, JSON.stringify(start) + "\n" + JSON.stringify(end) + "\n");

    const state = rebuildSessionState(dir);
    const wf = state.workflows.find((w) => w.instance === "Stale Crash");
    assert.ok(wf, "workflow entry should still be built from the events");
    assert.notEqual(
      wf!.crashedOnLaunch, true,
      "stale crashes (>15m old) must not pin themselves to the live Sessions rail",
    );
  });

  it("flips pidAlive=false for in-process workflows once workflow_end fires (session drawer consistency)", () => {
    // Regression guard for the `sharepoint-download` dashboard button. Fire-and-forget
    // workflows run INSIDE the dashboard server process, so the recorded pid equals
    // the dashboard's own pid — `process.kill(pid, 0)` always succeeds while the
    // dashboard is up, which would pin the workflow box to the session drawer forever.
    // Once workflow_end fires, pidAlive must flip false so the drawer removes
    // the box, matching the behavior of spawned-child workflows whose process exits
    // shortly after end.
    emitSessionEvent({ type: "workflow_start", workflowInstance: "SharePoint Download 1" }, dir);
    emitSessionEvent({
      type: "browser_launch", workflowInstance: "SharePoint Download 1",
      sessionId: "1", browserId: "sharepoint", system: "sharepoint",
    }, dir);
    emitSessionEvent({
      type: "workflow_end", workflowInstance: "SharePoint Download 1", finalStatus: "failed",
    }, dir);
    const state = rebuildSessionState(dir);
    const wf = state.workflows.find((w) => w.instance === "SharePoint Download 1");
    assert.ok(wf);
    assert.equal(
      wf!.pidAlive, false,
      "in-process workflow (pid === process.pid) must be treated as ended once workflow_end fires",
    );
    assert.equal(
      wf!.crashedOnLaunch, undefined,
      "browser_launch was emitted, so this is NOT a crashed-on-launch case",
    );
    assert.equal(wf!.finalStatus, "failed");
  });

  it("keeps pidAlive=true for in-process workflows that have NOT yet ended", () => {
    // Corollary of the above: while a fire-and-forget run is still in-flight
    // (workflow_start fired, no workflow_end yet), pidAlive must stay true
    // so the Sessions rail shows it. Only after workflow_end do we flip it.
    emitSessionEvent({ type: "workflow_start", workflowInstance: "SharePoint Running" }, dir);
    const state = rebuildSessionState(dir);
    const wf = state.workflows.find((w) => w.instance === "SharePoint Running");
    assert.ok(wf);
    assert.equal(wf!.pidAlive, true);
    assert.equal(wf!.finalStatus, null);
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

  it("reproduces the full Separation + Person Lookup dashboard state", () => {
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

    // Person Lookup 1 with UCPath queued
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Person Lookup 1" }, dir);
    emitSessionEvent({ type: "session_create", workflowInstance: "Person Lookup 1", sessionId: "Session 1" }, dir);
    emitSessionEvent({
      type: "browser_launch", workflowInstance: "Person Lookup 1",
      sessionId: "Session 1", browserId: "b-ucp", system: "UCPath",
    }, dir);
    emitSessionEvent({ type: "auth_start", workflowInstance: "Person Lookup 1", browserId: "b-ucp", system: "UCPath" }, dir);
    emitSessionEvent({ type: "item_start", workflowInstance: "Person Lookup 1", currentItemId: "Garcia, Maria" }, dir);
    emitSessionEvent({ type: "duo_request", workflowInstance: "Person Lookup 1", system: "UCPath", duoRequestId: "person-req" }, dir);

    const state = rebuildSessionState(dir);

    // 2 workflows — both active (PID is our own process.pid, which is alive)
    assert.equal(state.workflows.length, 2);
    const sep = state.workflows.find((w) => w.instance === "Separation 1")!;
    const personLookup = state.workflows.find((w) => w.instance === "Person Lookup 1")!;
    assert.ok(sep && personLookup);
    assert.equal(sep.active, true);
    assert.equal(personLookup.active, true);

    // Separation 1: 3 browsers (Kuali authed, OldKronos authed, NewKronos duo_waiting)
    const sepBrowsers = sep.sessions[0].browsers;
    assert.equal(sepBrowsers.length, 3);
    assert.equal(sepBrowsers.find((b) => b.system === "Kuali")!.authState, "authed");
    assert.equal(sepBrowsers.find((b) => b.system === "OldKronos")!.authState, "authed");
    assert.equal(sepBrowsers.find((b) => b.system === "NewKronos")!.authState, "duo_waiting");
    assert.equal(sep.currentItemId, "DOC-2024-001");

    // Person Lookup 1: UCPath duo_waiting
    const personLookupBrowsers = personLookup.sessions[0].browsers;
    assert.equal(personLookupBrowsers.length, 1);
    assert.equal(personLookupBrowsers[0].system, "UCPath");
    assert.equal(personLookupBrowsers[0].authState, "duo_waiting");
    assert.equal(personLookup.currentItemId, "Garcia, Maria");

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
// never emitted `workflow_end`) would lock "Person Lookup 1" forever. The
// dead-pid + 60s heal below treats orphan starts as ended so legitimate new
// runs reclaim the slot, while still blocking it briefly after a recent
// start in case another process is racing.

const TMP = () => mkdtempSync(join(tmpdir(), "hrauto-gin-"));

function writeSessionsRaw(dir: string, lines: object[]): void {
  mkdirSync(sessionsDir(dir), { recursive: true });
  for (const l of lines) {
    const rec = l as { timestamp?: string };
    const tsStr = typeof rec.timestamp === "string" ? rec.timestamp : new Date().toISOString();
    const path = sessionFilePath(dateLocal(new Date(tsStr)), dir);
    appendFileSync(path, `${JSON.stringify(l)}\n`);
  }
}

test("generateInstanceName: ignores stale start whose pid is dead and >60s old", () => {
  const dir = TMP();
  const oldTs = new Date(Date.now() - 120_000).toISOString();
  writeSessionsRaw(dir, [
    // Pid 2 is practically never alive on Unix; using 0 raises EINVAL, 2 raises ESRCH.
    { type: "workflow_start", workflowInstance: "Person Lookup 1", pid: 2, timestamp: oldTs, runId: "x" },
  ]);
  const name = generateInstanceName("person-lookup", dir);
  assert.equal(name, "Person Lookup 1", "dead-pid stale start treated as ended");
});

test("generateInstanceName: keeps fresh stale start (<60s) as active", () => {
  const dir = TMP();
  const freshTs = new Date(Date.now() - 5_000).toISOString();
  writeSessionsRaw(dir, [
    { type: "workflow_start", workflowInstance: "Person Lookup 1", pid: 2, timestamp: freshTs, runId: "x" },
  ]);
  const name = generateInstanceName("person-lookup", dir);
  assert.equal(name, "Person Lookup 2", "young stale start still blocks the number");
});

test("generateInstanceName: keeps alive-pid start as active even if old", () => {
  const dir = TMP();
  const oldTs = new Date(Date.now() - 120_000).toISOString();
  writeSessionsRaw(dir, [
    { type: "workflow_start", workflowInstance: "Person Lookup 1", pid: process.pid, timestamp: oldTs, runId: "x" },
  ]);
  const name = generateInstanceName("person-lookup", dir);
  assert.equal(name, "Person Lookup 2", "alive pid blocks the number regardless of age");
});

test("generateInstanceName: paired start+end frees the number", () => {
  const dir = TMP();
  const ts = new Date(Date.now() - 5_000).toISOString();
  writeSessionsRaw(dir, [
    { type: "workflow_start", workflowInstance: "Person Lookup 1", pid: process.pid, timestamp: ts, runId: "x" },
    { type: "workflow_end", workflowInstance: "Person Lookup 1", finalStatus: "done", pid: process.pid, timestamp: ts, runId: "x" },
  ]);
  const name = generateInstanceName("person-lookup", dir);
  assert.equal(name, "Person Lookup 1", "paired start+end frees the slot");
});

test("workflowNameFromInstance resolves newly daemonized workflow labels", () => {
  assert.equal(workflowNameFromInstance("Person Lookup 1"), "person-lookup");
  assert.equal(workflowNameFromInstance("person-lookup 1"), "person-lookup");
  assert.equal(workflowNameFromInstance("Oath Upload 2"), "oath-upload");
});

test("generateInstanceName: person-lookup uses human label so dashboard stop controls can resolve it", () => {
  const dir = TMP();
  const name = generateInstanceName("person-lookup", dir);

  assert.equal(name, "Person Lookup 1");
});

describe("emitDaemonLog", () => {
  it("writes a daemon_log session event with correct type, workflowInstance, level, and message", () => {
    const dir = TMP();
    emitDaemonLog("Onboarding 1", "warn", "queue stalled", dir);

    const events = readSessionEvents(dir);
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.type, "daemon_log");
    assert.equal(e.workflowInstance, "Onboarding 1");
    assert.equal(e.data?.level, "warn");
    assert.equal(e.data?.message, "queue stalled");
  });
});

describe("rebuildSessionState — recentDaemonLogs", () => {
  let dir: string;
  beforeEach(() => { dir = tempDir(); });

  it("populates recentDaemonLogs in order and caps at 30", () => {
    emitSessionEvent({ type: "workflow_start", workflowInstance: "Onboarding 1" }, dir);
    // Emit 35 daemon_log events — expect only the last 30 to be retained.
    for (let i = 1; i <= 35; i++) {
      emitDaemonLog("Onboarding 1", "step", `msg ${i}`, dir);
    }

    const state = rebuildSessionState(dir);
    const wf = state.workflows.find((w) => w.instance === "Onboarding 1");
    assert.ok(wf, "workflow state should exist");
    assert.ok(wf!.recentDaemonLogs, "recentDaemonLogs should be populated");
    assert.equal(wf!.recentDaemonLogs!.length, 30, "capped at 30 entries");
    // The last entry must be the newest message (msg 35).
    assert.equal(
      wf!.recentDaemonLogs![29].message,
      "msg 35",
      "last entry is the most recent daemon log line",
    );
    // The first retained entry must be msg 6 (35 - 30 + 1).
    assert.equal(
      wf!.recentDaemonLogs![0].message,
      "msg 6",
      "first retained entry is the oldest within the cap window",
    );
  });

  it("filterEventsForRun does not include daemon_log events even when workflowInstance matches and ts is in window", () => {
    const instance = "Onboarding 1";
    const runId = "run-A";
    const base = "2026-05-31T10:00:00Z";

    // One direct run event and one daemon_log event for the same instance.
    // daemon_log events are machine-scoped session-log entries (no runId) and
    // must never be attributed to a per-run Events tab.
    const events = [
      {
        pid: 1234,
        timestamp: base,
        type: "item_start",
        workflowInstance: instance,
        runId,
        currentItemId: "alice",
      },
      {
        pid: 1234,
        timestamp: "2026-05-31T10:00:01Z",
        type: "daemon_log",
        workflowInstance: instance,
        // No runId — machine-scoped.
        data: { level: "step", message: "keepalive ping" },
      },
    ] as Parameters<typeof filterEventsForRun>[0];

    const trackers: Parameters<typeof filterEventsForRun>[1] = [
      {
        timestamp: base,
        runId,
        status: "running",
        data: { instance },
      },
    ];

    const out = filterEventsForRun(
      events,
      trackers,
      runId,
      Date.parse("2026-05-31T10:01:00Z"),
    );

    assert.equal(
      out.some((e) => e.type === "daemon_log"),
      false,
      "daemon_log must never appear in per-run Events (machine-scoped session-log)",
    );
    assert.equal(out.length, 1, "only the direct run event should be included");
    assert.equal(out[0].type, "item_start");
  });
});
