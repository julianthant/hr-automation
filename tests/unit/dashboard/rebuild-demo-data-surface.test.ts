import { test } from "vitest";
import assert from "node:assert/strict";
import {
  actionsAt,
  buildRecordCorrections,
  deriveActions,
  DEMO_WORKFLOWS,
  fmtClock,
  type ActionDescriptorWire,
  type ActionPolicyContext,
} from "../../../src/dashboard/components/dev/rebuild-demo/demo-wire.js";
import { DEMO_ROWS } from "../../../src/dashboard/components/dev/rebuild-demo/demo-data.js";
import type { DemoDataPoint, DemoRow, DemoRowSpec } from "../../../src/dashboard/components/dev/rebuild-demo/demo-data.js";
import { submitDemoCommand } from "../../../src/dashboard/components/dev/rebuild-demo/demo-commands.js";
import {
  appliedCorrectionsFor,
  checkpointAge,
  checkpointBaseValue,
  checkpointFor,
  editPolicyFor,
  resetAppliedCorrections,
} from "../../../src/dashboard/components/dev/rebuild-demo/demo-flows-wire.js";
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

test("OCR approval is available only inside the record-by-record Review surface", () => {
  const packet = DEMO_ROWS["oath-summer"];
  const review = DEMO_ROWS["ocr-summer"];

  assert.equal(
    actionsAt(packet.actions, "banner").some((action) => action.resolution?.startsWith("approve:")),
    false,
    "the packet gate must route into Review instead of offering bulk approval",
  );
  assert.equal(
    actionsAt(review.actions, "banner").some((action) => action.resolution?.startsWith("approve:")),
    false,
    "the OCR log gate must not bypass the page-by-page review",
  );

  const reviewApproval = actionsAt(review.actions, "review").filter((action) => action.resolution?.startsWith("approve:"));
  assert.equal(reviewApproval.length, 1, "the delegated OCR Review surface must retain its approval command");
  assert.equal(reviewApproval[0].label, "Approve 5 of 6");
});

test("a stopped run is offered BOTH outcomes, and continuing it is the primary one", () => {
  for (const status of ["failed", "cancelled"] as const) {
    const actions = actionsAt(deriveActions(spec(status), ctx(status)), "data");
    assert.deepEqual(
      actions.map((a) => a.command),
      ["continue-with-data", "rerun-with-existing-data"],
      `${status} must offer continue-this-run and start-a-custom-run, in that order`,
    );
    // Exactly one primary per surface, and on a run with work left to release
    // it is the one that releases it.
    assert.deepEqual(
      actions.map((a) => a.intent),
      ["primary", "neutral"],
    );
    // The labels are the operator-facing difference between the two outcomes;
    // if they ever read the same the surface has stopped keeping them apart.
    // They are SHORT because they share one action row inside the resting
    // Run Data panel — the long form lives on each descriptor's `detail`, which the
    // button carries as its title.
    assert.match(actions[0].label, /continue/i);
    assert.equal(actions[1].label, "Start custom run");
    assert.match(actions[1].detail ?? "", /complete data set/i);
    assert.match(actions[0].detail ?? "", /releases the SAME run/i);
  }
});

test("a run with nothing left to continue is offered a correction, not a resume", () => {
  for (const status of ["verifiedDone", "doneWarnings", "waiting"] as const) {
    const actions = actionsAt(deriveActions(spec(status), ctx(status)), "data");
    assert.deepEqual(
      actions.map((a) => a.command),
      ["edit-checkpoint", "rerun-with-existing-data"],
      `${status} has no stopped work to release, so it gets a save and a custom run`,
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

// ===========================================================================
// A save that says "saved" must have SAVED
// ===========================================================================
//
// The defect these pin was the sharpest kind this product forbids: the Data
// surface built a patch, called the command service, showed "Checkpoint saved"
// and then changed nothing — so the corrected field stayed amber and dirty
// forever underneath a success toast. Success styling over a world that did not
// move is the pixel-level version of the fail-loud rule's worst case.
//
// The store is module state, so every test here clears it first.

function savableRow(): DemoRow {
  const row = Object.values(DEMO_ROWS).find(
    (r) =>
      actionsAt(r.actions, "data").some((a) => a.command === "edit-checkpoint" || a.command === "continue-with-data") &&
      r.data.some((d) => d.dir === "read" && editPolicyFor(r, d).editable),
  );
  assert.ok(row, "the corpus must carry a row whose checkpoint can be corrected");
  return row;
}

function saveAction(row: DemoRow): ActionDescriptorWire {
  const action = actionsAt(row.actions, "data").find(
    (a) => a.command === "edit-checkpoint" || a.command === "continue-with-data",
  );
  assert.ok(action, `${row.id} offers no save arm`);
  return action;
}

function editableRead(row: DemoRow): DemoDataPoint {
  const point = row.data.find((d) => d.dir === "read" && editPolicyFor(row, d).editable);
  assert.ok(point, `${row.id} has no editable read`);
  return point;
}

test("an APPLIED save lands in the checkpoint, so the base value IS the correction and nothing stays dirty", () => {
  resetAppliedCorrections();
  const row = savableRow();
  const point = editableRead(row);
  const before = checkpointFor(row);
  const typed = `${point.value}-corrected`;

  const result = submitDemoCommand(row, {
    ...saveAction(row),
    payload: { expectedGeneration: String(before.heldGeneration), [point.field]: typed },
  });

  assert.equal(result.state, "applied");
  // The SERVER mints the generation and the client adopts it — a surface that
  // computes `held + 1` disagrees silently the first time anything else writes.
  assert.ok(result.checkpoint, "an applied save must return the generation it landed at");
  assert.ok(result.checkpoint.generation > before.serverGeneration);
  assert.deepEqual(result.checkpoint.corrected, [point.field]);

  const after = checkpointFor(row);
  assert.equal(after.serverGeneration, result.checkpoint.generation);
  assert.equal(after.heldGeneration, result.checkpoint.generation, "held and server agree again after a save");
  // The one that matters: the ledger's base value for that field is now the
  // correction, so an input rendering `base` has nothing left to be dirty about.
  assert.equal(checkpointBaseValue(after, point, after.heldGeneration), typed);
  // …and the machine's reading survives beside it. A correction never overwrites
  // what was observed; the receipt prints both.
  assert.equal(appliedCorrectionsFor(row.runId)?.observed[point.field], point.value);
  resetAppliedCorrections();
});

test("a CONFLICTED save writes NOTHING, so the operator's edit is still theirs to decide about", () => {
  resetAppliedCorrections();
  // `onb-jordan` is the CAS specimen: the server moved to generation 5 while the
  // operator's surface still holds 4.
  const row = DEMO_ROWS["onb-jordan"];
  const cp = checkpointFor(row);
  assert.notEqual(cp.heldGeneration, cp.serverGeneration, "the stale fixture must actually be stale");
  const point = editableRead(row);

  const result = submitDemoCommand(row, {
    ...saveAction(row),
    payload: { expectedGeneration: String(cp.heldGeneration), [point.field]: "typed-by-the-operator" },
  });

  assert.equal(result.state, "conflict");
  assert.equal(result.checkpoint, undefined, "a refused save must not report a generation it did not mint");
  assert.equal(appliedCorrectionsFor(row.runId), undefined, "nothing may be written on a conflict");
  const after = checkpointFor(row);
  assert.equal(after.serverGeneration, cp.serverGeneration, "the checkpoint did not move");
  assert.notEqual(
    checkpointBaseValue(after, point, after.heldGeneration),
    "typed-by-the-operator",
    "the conflicted value must NOT appear as the server's — the edit is still the operator's to resolve",
  );

  // Re-saving against the generation the server actually holds is what clears it.
  const retry = submitDemoCommand(row, {
    ...saveAction(row),
    payload: { expectedGeneration: String(after.serverGeneration), [point.field]: "typed-by-the-operator" },
  });
  assert.equal(retry.state, "applied");
  assert.equal(checkpointBaseValue(checkpointFor(row), point, retry.checkpoint!.generation), "typed-by-the-operator");
  resetAppliedCorrections();
});

test("a save carrying a generation the server has moved past is refused, however it got stale", () => {
  resetAppliedCorrections();
  const row = savableRow();
  const point = editableRead(row);
  const first = submitDemoCommand(row, {
    ...saveAction(row),
    payload: { expectedGeneration: String(checkpointFor(row).heldGeneration), [point.field]: "one" },
  });
  assert.equal(first.state, "applied");

  // A second tab still holding the pre-save generation must not overwrite it.
  const stale = submitDemoCommand(row, {
    ...saveAction(row),
    payload: { expectedGeneration: String(first.checkpoint!.generation - 1), [point.field]: "two" },
  });
  assert.equal(stale.state, "conflict");
  assert.equal(checkpointBaseValue(checkpointFor(row), point, first.checkpoint!.generation), "one");
  resetAppliedCorrections();
});

test("an applied save leaves a checkpoint the surface can still READ — capturedAt is an INSTANT", () => {
  resetAppliedCorrections();
  const row = savableRow();
  const point = editableRead(row);

  const result = submitDemoCommand(row, {
    ...saveAction(row),
    payload: { expectedGeneration: String(checkpointFor(row).heldGeneration), [point.field]: "corrected" },
  });
  assert.equal(result.state, "applied");

  // Both of these parse `<date>T<hh:mm:ss>` and THROW on anything else, and the
  // Data rail calls them on every one-second tick. The first version of the
  // save wrote a FORMATTED clock (`2:26:49`) into `capturedAt`, so the panel
  // crashed the instant a correction landed — a success toast over a dead
  // surface. Caught by the demo's own fail-loud parse, which is the argument
  // for the parse: the quiet alternative is a checkpoint that reports an age of
  // zero forever and never tells anyone its values went stale.
  const after = checkpointFor(row);
  assert.doesNotThrow(() => fmtClock(after.capturedAt), "capturedAt must stay a demo instant after a save");
  assert.match(checkpointAge(after, 0), /\d/, "a saved checkpoint must still be able to state its age");
  resetAppliedCorrections();
});

// ---------------------------------------------------------------------------
// The DIRTY flag, pinned against a model of what `DataSection` actually renders
// ---------------------------------------------------------------------------
//
// The store test above proves the world moved. This one proves the SURFACE
// notices: `DataSection` renders `value = edits[field] ?? base` and marks a row
// dirty on `value !== base`, so "the field stayed amber forever under a success
// toast" is a statement about those three lines and nothing else. Modelling
// them here is what keeps the fix from silently regressing the next time the
// save handler is edited — the demo has no component harness, so this reducer
// IS the render contract.

/** exactly the three derivations `LedgerRow` is given, for one field */
function renderState(row: DemoRow, point: DemoDataPoint, edits: Record<string, string>, baseGeneration: number | null) {
  const cp = checkpointFor(row);
  const held = baseGeneration ?? cp.heldGeneration;
  const base = checkpointBaseValue(cp, point, held);
  const value = edits[point.field] ?? base;
  return { base, value, dirty: value !== base };
}

/** exactly what `submitSave` does with each of the three results */
function applyResultToSurface(
  result: { state: string; checkpoint?: { generation: number } },
  edits: Record<string, string>,
  baseGeneration: number | null,
) {
  if (result.state === "applied") return { edits: {} as Record<string, string>, baseGeneration: result.checkpoint?.generation ?? baseGeneration };
  // conflict and rejected both HOLD the patch — nothing was written, so there
  // is nothing for the operator to lose and nothing for us to decide for them.
  return { edits, baseGeneration };
}

test("APPLIED clears dirty on the surface — the base value moved under the edit, so there is nothing left to save", () => {
  resetAppliedCorrections();
  const row = savableRow();
  const point = editableRead(row);
  const typed = `${point.value}-typed`;

  let edits: Record<string, string> = { [point.field]: typed };
  let baseGeneration: number | null = null;
  assert.equal(renderState(row, point, edits, baseGeneration).dirty, true, "typing must mark the row dirty");

  const result = submitDemoCommand(row, {
    ...saveAction(row),
    payload: { expectedGeneration: String(checkpointFor(row).heldGeneration), [point.field]: typed },
  });
  assert.equal(result.state, "applied");
  ({ edits, baseGeneration } = applyResultToSurface(result, edits, baseGeneration));

  const after = renderState(row, point, edits, baseGeneration);
  assert.deepEqual(edits, {}, "an applied patch is dropped — it is the checkpoint now");
  assert.equal(after.base, typed, "the base value IS the correction");
  assert.equal(after.value, typed, "and the field still shows it");
  assert.equal(after.dirty, false, "so the row is no longer dirty — the toast and the pixels agree");
  resetAppliedCorrections();
});

test("CONFLICT keeps the edit on the surface — a refused save may not quietly discard what the operator typed", () => {
  resetAppliedCorrections();
  // `onb-jordan` is the CAS specimen: the server is a generation ahead.
  const row = DEMO_ROWS["onb-jordan"];
  const point = editableRead(row);
  const typed = "typed-by-the-operator";

  let edits: Record<string, string> = { [point.field]: typed };
  let baseGeneration: number | null = null;

  const result = submitDemoCommand(row, {
    ...saveAction(row),
    payload: { expectedGeneration: String(checkpointFor(row).heldGeneration), [point.field]: typed },
  });
  assert.equal(result.state, "conflict");
  ({ edits, baseGeneration } = applyResultToSurface(result, edits, baseGeneration));

  const after = renderState(row, point, edits, baseGeneration);
  assert.equal(edits[point.field], typed, "the patch is held");
  assert.equal(after.value, typed, "and still on screen");
  assert.equal(after.dirty, true, "still dirty, because it genuinely is unsaved");
  assert.notEqual(after.base, typed, "the server's value is unchanged underneath it");
  resetAppliedCorrections();
});
