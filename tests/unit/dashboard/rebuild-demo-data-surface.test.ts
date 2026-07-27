import { test } from "vitest";
import assert from "node:assert/strict";
import {
  actionsAt,
  buildRecordCorrections,
  deriveActions,
  DEMO_WORKFLOWS,
  type ActionPolicyContext,
} from "../../../src/dashboard/components/dev/rebuild-demo/demo-wire.js";
import { DEMO_ROWS } from "../../../src/dashboard/components/dev/rebuild-demo/demo-data.js";
import type { DemoRowSpec } from "../../../src/dashboard/components/dev/rebuild-demo/demo-data.js";
import type { ProposedStatus } from "../../../src/dashboard/components/dev/rebuild-demo/demo-status.js";
import { candidateCaptureFor } from "../../../src/dashboard/components/dev/rebuild-demo/demo-evidence-wire.js";

/**
 * The merged Data surface (D19c) offers exactly two outcomes, and which two
 * depends on the run's state. These pin the parts a component must never
 * re-derive: the client renders `actions[]` at the `data` placement and nothing
 * else, so what the policy sends IS what the operator can do.
 */

function spec(status: ProposedStatus, reads = 2): DemoRowSpec {
  return {
    id: `t-${status}`,
    rowType: "run",
    workflowId: "separations",
    title: "Test Person",
    runId4: "0000",
    status,
    run: 1,
    enqueuedAt: "2026-07-25T13:00:00",
    outcome: { tone: "muted", text: "" },
    steps: [],
    lines: [],
    data: Array.from({ length: reads }, (_, i) => ({
      step: "Kuali extraction",
      dir: "read" as const,
      field: `Field ${i}`,
      value: `v${i}`,
      system: "kuali" as const,
      ts: "1:00:00",
    })),
    receipt: { tone: "muted", headline: "" },
    shots: [],
  };
}

function ctx(status: ProposedStatus): ActionPolicyContext {
  return {
    status,
    projectedVersion: 1,
    memberCount: 0,
    rejectedCount: 0,
    title: "Test Person",
    workflow: DEMO_WORKFLOWS.separations,
    stagedWrites: 0,
  };
}

const dataCommands = (status: ProposedStatus, reads = 2) =>
  actionsAt(deriveActions(spec(status, reads), ctx(status)), "data").map((a) => a.command);

test("a stopped run is offered BOTH outcomes, and continuing it is the primary one", () => {
  for (const status of ["failed", "cancelled"] as const) {
    const actions = actionsAt(deriveActions(spec(status), ctx(status)), "data");
    assert.deepEqual(
      actions.map((a) => a.command),
      ["continue-with-data", "rerun-with-existing-data"],
      `${status} must offer continue-this-run and start-a-new-run, in that order`,
    );
    // Exactly one primary per surface, and on a run with work left to release
    // it is the one that releases it.
    assert.deepEqual(
      actions.map((a) => a.intent),
      ["primary", "neutral"],
    );
    // The labels are the operator-facing difference between the two outcomes;
    // if they ever read the same the surface has stopped keeping them apart.
    assert.match(actions[0].label, /continue this run/i);
    assert.match(actions[1].label, /new run/i);
  }
});

test("a run with nothing left to continue is offered a correction, not a resume", () => {
  for (const status of ["verifiedDone", "doneWarnings", "waiting"] as const) {
    const actions = actionsAt(deriveActions(spec(status), ctx(status)), "data");
    assert.deepEqual(
      actions.map((a) => a.command),
      ["edit-checkpoint", "rerun-with-existing-data"],
      `${status} has no stopped work to release, so it gets a save and a new run`,
    );
    assert.deepEqual(
      actions.map((a) => a.intent),
      ["neutral", "primary"],
    );
  }
});

test("a PARKED run is sent no data command at all — starting a run from an unknown write is a duplicate", () => {
  assert.deepEqual(dataCommands("parked"), []);
  // and the real parked fixture proves it end to end
  const parked = DEMO_ROWS["sep-rosa"];
  assert.equal(parked.status, "parked");
  assert.deepEqual(actionsAt(parked.actions, "data"), []);
});

test("a live run owns its checkpoint, and a run that read nothing has nothing to edit", () => {
  assert.deepEqual(dataCommands("running"), []);
  assert.deepEqual(dataCommands("queued"), []);
  assert.deepEqual(dataCommands("failed", 0), []);
});

/**
 * A correction is the one value on a review surface that no machine observed.
 * These pin the two facts that keep it honest: the machine's reading survives
 * on the correction, and its confidence does not follow the new value.
 */
test("a correction keeps the machine's reading and its confidence on the OLD value", () => {
  const corrections = buildRecordCorrections(
    "rec-1",
    [
      { label: "Printed name", value: "Ana Alvarez", source: "paper", confidence: 0.97 },
      { label: "Employee ID", value: "10510221", source: "paper", confidence: 0.44 },
      { label: "Department", value: "000371", source: "ucpath" },
    ],
    { "rec-1:Employee ID": "10510229" },
    "2026-07-25T14:26:00",
    "local-operator",
  );
  assert.equal(corrections.length, 1);
  assert.deepEqual(corrections[0], {
    recordId: "rec-1",
    field: "Employee ID",
    from: "10510221",
    to: "10510229",
    priorSource: "paper",
    priorConfidence: 0.44,
    correctedBy: "local-operator",
    correctedAt: "2026-07-25T14:26:00",
  });
});

test("typing the same value back is not a correction, and another record's edits never bleed in", () => {
  const fields = [{ label: "Printed name", value: "Ana Alvarez", source: "paper" as const, confidence: 0.97 }];
  assert.deepEqual(
    buildRecordCorrections("rec-1", fields, { "rec-1:Printed name": "Ana Alvarez" }, "2026-07-25T14:26:00"),
    [],
  );
  assert.deepEqual(
    buildRecordCorrections("rec-1", fields, { "rec-2:Printed name": "Someone Else" }, "2026-07-25T14:26:00"),
    [],
  );
});

/**
 * Identity-candidate evidence is fetched by id like every other record in the
 * evidence store. A candidate with no capture must resolve to NOTHING rather
 * than to a neighbour's — the whole point of showing a capture is that it is
 * the capture of the person you are about to pick.
 */
test("every identity gate's candidates resolve their own capture, or honestly none", () => {
  const gated = Object.values(DEMO_ROWS).filter((r) => r.gate?.kind === "identity");
  assert.ok(gated.length > 0, "the corpus must carry at least one identity gate");

  const seen = new Set<string>();
  for (const row of gated) {
    const candidates = row.gate?.candidates ?? [];
    assert.ok(candidates.length >= 2, `${row.id} — an identity gate asks about at least two people`);
    for (const c of candidates) {
      const capture = candidateCaptureFor(c.captureId);
      if (c.captureId === undefined) {
        assert.equal(capture, undefined);
        continue;
      }
      assert.ok(capture, `${row.id} — captureId ${c.captureId} resolves to nothing`);
      assert.equal(capture.id, c.captureId);
      assert.ok(capture.system, `${row.id} — a candidate capture names the system it was taken in`);
      assert.equal(seen.has(c.captureId), false, `${c.captureId} is shared between two candidates`);
      seen.add(c.captureId);
    }
  }
  assert.equal(candidateCaptureFor(undefined), undefined);
  assert.equal(candidateCaptureFor("cap-does-not-exist"), undefined);
});

test("a gate supports more than two candidates — the demo carries a three-way one", () => {
  const three = Object.values(DEMO_ROWS).find((r) => (r.gate?.candidates?.length ?? 0) > 2);
  assert.ok(three, "no gate in the corpus asks about more than two people");
  const candidates = three.gate?.candidates ?? [];
  // Every candidate that names an EID must be answerable: the gate has to carry
  // an option that binds it, or the surface shows a person you cannot pick.
  for (const c of candidates) {
    if (!c.eid) continue;
    const answer = three.gate?.options.some((o) => o.resolution === `pick-eid:${c.eid}`);
    assert.ok(answer, `${three.id} shows candidate ${c.eid} with no option that picks it`);
  }
});
