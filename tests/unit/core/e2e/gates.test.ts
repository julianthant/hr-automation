import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { awaitGateRelease, consumeFailGate, isGateHeld, waitWithSignal } from "../../../../src/core/e2e/gates.js";
import { e2eGatesDir, e2eGateHoldPath, e2eGateFailPath } from "../../../../src/tracker/paths.js";

/**
 * File-based hold gates for HRAUTO_E2E_STUBS scripted runs: a workflow-level
 * `<wf>.hold` or step-level `<wf>--<step>.hold` file under
 * `<trackerDir>/e2e-gates/` parks the scripted step until removed; the run's
 * abort signal unwinds a held step immediately (cancel path).
 */

function tmpTracker(): string {
  return mkdtempSync(join(tmpdir(), "e2e-gates-"));
}

test("no hold file → awaitGateRelease resolves immediately", async () => {
  const dir = tmpTracker();
  try {
    const ac = new AbortController();
    await awaitGateRelease({ workflow: "oath-signature", step: "transaction", trackerDir: dir, signal: ac.signal, pollMs: 10 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workflow-level hold parks until the file is removed", async () => {
  const dir = tmpTracker();
  try {
    mkdirSync(e2eGatesDir(dir), { recursive: true });
    const hold = e2eGateHoldPath("oath-signature", undefined, dir);
    writeFileSync(hold, "");
    assert.equal(isGateHeld({ workflow: "oath-signature", step: "transaction", trackerDir: dir }), true);

    const ac = new AbortController();
    let released = false;
    const wait = awaitGateRelease({
      workflow: "oath-signature",
      step: "transaction",
      trackerDir: dir,
      signal: ac.signal,
      pollMs: 10,
    }).then(() => {
      released = true;
    });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(released, false, "must stay parked while the hold file exists");
    unlinkSync(hold);
    await wait;
    assert.equal(released, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("step-level hold only parks the named step", async () => {
  const dir = tmpTracker();
  try {
    mkdirSync(e2eGatesDir(dir), { recursive: true });
    writeFileSync(e2eGateHoldPath("person-lookup", "active-status", dir), "");
    assert.equal(isGateHeld({ workflow: "person-lookup", step: "active-status", trackerDir: dir }), true);
    assert.equal(isGateHeld({ workflow: "person-lookup", step: "searching", trackerDir: dir }), false);

    const ac = new AbortController();
    await awaitGateRelease({ workflow: "person-lookup", step: "searching", trackerDir: dir, signal: ac.signal, pollMs: 10 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("abort while parked rejects (cancel path unwinds a held step)", async () => {
  const dir = tmpTracker();
  try {
    mkdirSync(e2eGatesDir(dir), { recursive: true });
    writeFileSync(e2eGateHoldPath("oath-signature", undefined, dir), "");
    const ac = new AbortController();
    const wait = awaitGateRelease({
      workflow: "oath-signature",
      step: "transaction",
      trackerDir: dir,
      signal: ac.signal,
      pollMs: 10,
    });
    ac.abort();
    await assert.rejects(wait);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waitWithSignal rejects on abort instead of running out the timer", async () => {
  const ac = new AbortController();
  const wait = waitWithSignal(5_000, ac.signal);
  ac.abort();
  await assert.rejects(wait);
});

test("consumeFailGate: no file → false (no fs mutation)", () => {
  const dir = tmpTracker();
  try {
    assert.equal(consumeFailGate({ workflow: "person-lookup", step: "active-status", trackerDir: dir }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("consumeFailGate is ONE-SHOT: fires once, then self-consumes so the retry passes", () => {
  const dir = tmpTracker();
  try {
    mkdirSync(e2eGatesDir(dir), { recursive: true });
    const fail = e2eGateFailPath("oath-signature", "transaction", dir);
    writeFileSync(fail, "");
    // First reach at the step → armed → fires (the organic fail).
    assert.equal(consumeFailGate({ workflow: "oath-signature", step: "transaction", trackerDir: dir }), true);
    assert.equal(existsSync(fail), false, "the gate file is deleted when it fires");
    // The Retry replay reaches the same step → gate gone → passes.
    assert.equal(consumeFailGate({ workflow: "oath-signature", step: "transaction", trackerDir: dir }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("consumeFailGate is step-scoped: a fail-at-<stepA> never fires stepB", () => {
  const dir = tmpTracker();
  try {
    mkdirSync(e2eGatesDir(dir), { recursive: true });
    writeFileSync(e2eGateFailPath("person-lookup", "crm-dates", dir), "");
    assert.equal(consumeFailGate({ workflow: "person-lookup", step: "searching", trackerDir: dir }), false);
    assert.equal(consumeFailGate({ workflow: "person-lookup", step: "crm-dates", trackerDir: dir }), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
