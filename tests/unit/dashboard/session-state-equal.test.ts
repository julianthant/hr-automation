import { test } from "vitest";
import assert from "node:assert/strict";

import {
  browsersEqual,
  duoEntryEqual,
  sessionStateEqual,
  sessionsEqual,
  workflowEqual,
} from "../../../src/dashboard/components/hooks/session-state-equal.js";
import type {
  BrowserState,
  DuoQueueEntry,
  SessionInfo,
  SessionState,
  WorkflowInstanceState,
} from "../../../src/dashboard/components/shared/types.js";

function makeBrowser(authState: BrowserState["authState"], id = "ucpath"): BrowserState {
  return { browserId: id, system: "ucpath", authState };
}

function makeSession(browsers: BrowserState[]): SessionInfo {
  return { sessionId: "1", browsers };
}

function makeWorkflow(sessions: SessionInfo[]): WorkflowInstanceState {
  return {
    instance: "Active Check 1",
    workflow: "active-check",
    startedAt: "2026-05-08T20:14:09.947Z",
    active: true,
    pidAlive: true,
    currentItemId: null,
    itemInFlight: false,
    currentStep: null,
    finalStatus: null,
    sessions,
  };
}

test("browsersEqual returns true for identical browsers", () => {
  const a = [makeBrowser("authed")];
  const b = [makeBrowser("authed")];
  assert.equal(browsersEqual(a, b), true);
});

test("browsersEqual detects authState change (regression: was missed by length-only compare)", () => {
  const before = [makeBrowser("authenticating")];
  const after = [makeBrowser("authed")];
  assert.equal(browsersEqual(before, after), false);
});

test("browsersEqual detects browserId change", () => {
  const a = [makeBrowser("authed", "ucpath")];
  const b = [makeBrowser("authed", "i9")];
  assert.equal(browsersEqual(a, b), false);
});

test("browsersEqual detects length change", () => {
  const a = [makeBrowser("authed")];
  const b = [makeBrowser("authed"), makeBrowser("authed", "i9")];
  assert.equal(browsersEqual(a, b), false);
});

test("sessionsEqual detects sessionId change", () => {
  const a = [{ sessionId: "1", browsers: [makeBrowser("authed")] }];
  const b = [{ sessionId: "2", browsers: [makeBrowser("authed")] }];
  assert.equal(sessionsEqual(a, b), false);
});

test("sessionsEqual detects nested browser authState change", () => {
  const a = [makeSession([makeBrowser("authenticating")])];
  const b = [makeSession([makeBrowser("authed")])];
  assert.equal(sessionsEqual(a, b), false);
});

test("sessionsEqual returns true for identical session arrays", () => {
  const a = [makeSession([makeBrowser("authed")])];
  const b = [makeSession([makeBrowser("authed")])];
  assert.equal(sessionsEqual(a, b), true);
});

test("workflowEqual returns false when only nested authState changed", () => {
  const before = makeWorkflow([makeSession([makeBrowser("authenticating")])]);
  const after = makeWorkflow([makeSession([makeBrowser("authed")])]);
  assert.equal(workflowEqual(before, after), false);
});

test("workflowEqual returns true for identical workflow", () => {
  const before = makeWorkflow([makeSession([makeBrowser("authed")])]);
  const after = makeWorkflow([makeSession([makeBrowser("authed")])]);
  assert.equal(workflowEqual(before, after), true);
});

test("duoEntryEqual compares the documented fields", () => {
  const a: DuoQueueEntry = {
    position: 1,
    requestId: "r-1",
    system: "ucpath",
    instance: "Active Check 1",
    state: "waiting",
  };
  const b: DuoQueueEntry = { ...a };
  assert.equal(duoEntryEqual(a, b), true);
  assert.equal(duoEntryEqual(a, { ...a, state: "active" }), false);
  assert.equal(duoEntryEqual(a, { ...a, position: 2 }), false);
  assert.equal(duoEntryEqual(a, { ...a, requestId: "r-2" }), false);
});

test("sessionStateEqual returns false when nested browser authState changes (the regression)", () => {
  const before: SessionState = {
    workflows: [makeWorkflow([makeSession([makeBrowser("authenticating")])])],
    duoQueue: [],
  };
  const after: SessionState = {
    workflows: [makeWorkflow([makeSession([makeBrowser("authed")])])],
    duoQueue: [],
  };
  assert.equal(sessionStateEqual(before, after), false);
});

test("sessionStateEqual returns true for identical state (avoid unnecessary re-render)", () => {
  const a: SessionState = {
    workflows: [makeWorkflow([makeSession([makeBrowser("authed")])])],
    duoQueue: [],
  };
  const b: SessionState = {
    workflows: [makeWorkflow([makeSession([makeBrowser("authed")])])],
    duoQueue: [],
  };
  assert.equal(sessionStateEqual(a, b), true);
});

test("sessionStateEqual short-circuits on reference equality", () => {
  const state: SessionState = {
    workflows: [makeWorkflow([makeSession([makeBrowser("authed")])])],
    duoQueue: [],
  };
  assert.equal(sessionStateEqual(state, state), true);
});
