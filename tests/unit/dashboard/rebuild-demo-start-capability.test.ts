import { test } from "vitest";
import assert from "node:assert/strict";
import {
  DEMO_WORKFLOWS,
  DEMO_WORKFLOW_LIST,
  effectiveChoiceValues,
  defaultFlagValues,
  launcherStartMethods,
  requireStartCapability,
  requireStartMethod,
  startWorkflowGroups,
  startableWorkflows,
  unstartableWorkflows,
  visibleChoices,
  visibleFlags,
  type DemoWorkflowId,
  type StartMethodKind,
} from "../../../src/dashboard/components/dev/rebuild-demo/demo-wire.js";
import {
  UPLOAD_FILES,
  captureSessionFor,
  deriveStartPlan,
  parseEntries,
} from "../../../src/dashboard/components/dev/rebuild-demo/demo-runstart-wire.js";

/**
 * Wave 10 moved run-START capability onto the workflow descriptor, the same
 * move wave 7 made for rail categories: the Run Modal renders what a workflow
 * DECLARES, not what a component knows about it. These pin the two properties
 * that make that claim mean something —
 *
 *   1. every workflow yields the right input kinds and sub-selections, and
 *   2. a workflow with no start path is not offered,
 *
 * plus the drift the demo had accumulated against production (separations types
 * Kuali doc IDs, person-lookup takes EIDs *or* names semicolon-separated,
 * onboarding takes emails, crm-doc-download and oath-signature had no typed
 * path at all).
 */

const capabilityOf = (id: DemoWorkflowId) => requireStartCapability(DEMO_WORKFLOWS[id]);
const methodKinds = (id: DemoWorkflowId) => capabilityOf(id).methods.map((m) => m.kind);

/** the sub-selections a fresh modal shows for this workflow on this method */
function choiceKeys(id: DemoWorkflowId, method: StartMethodKind, values: Record<string, string> = {}): string[] {
  const capability = capabilityOf(id);
  const withDefaults = { ...Object.fromEntries(capability.choices.map((c) => [c.key, c.defaultValue])), ...values };
  return visibleChoices(capability, method, withDefaults).map((c) => c.key);
}

// ---------------------------------------------------------------------------
// Who is offered, and who is not
// ---------------------------------------------------------------------------

test("every workflow either declares a start or says why it has none", () => {
  for (const workflow of DEMO_WORKFLOW_LIST) {
    if (workflow.start) continue;
    assert.ok(
      workflow.notStartable && workflow.notStartable.length > 20,
      `${workflow.id} is not startable and gives no reason — a workflow that vanishes from the picker teaches the operator the list is arbitrary`,
    );
  }
});

test("a workflow with no start path is not offered", () => {
  const offered = startableWorkflows().map((w) => w.id).sort();
  assert.deepEqual(offered, [
    "crm-doc-download",
    "emergency-contact",
    "i9-check",
    "kronos-pay-rule",
    "oath-signature",
    "oath-upload",
    "ocr",
    "old-kronos-reports",
    "onbase",
    "onboarding",
    "person-lookup",
    "separations",
    "sharepoint-download",
    "work-study",
  ]);

  // The one that stays delegated-only gives its own reason. Old Kronos
  // Reports left this list in wave 12: its report timeout was a global setting
  // for a workflow the dashboard could not start, and the honest fix was to make
  // the span (and the patience that tracks it) a per-run choice.
  const blocked = unstartableWorkflows().map((b) => b.workflow.id).sort();
  assert.deepEqual(blocked, ["i9-lookup"]);
  for (const entry of unstartableWorkflows()) assert.ok(entry.reason.length > 20, `${entry.workflow.id} has no reason`);

  // ...and asking for a capability they do not have FAILS LOUD rather than
  // drawing an empty modal.
  assert.throws(() => requireStartCapability(DEMO_WORKFLOWS["i9-lookup"]), /declares no start capability/);
});

test("the picker groups by the same real categories the rail uses, empty groups dropped", () => {
  const groups = startWorkflowGroups();
  assert.deepEqual(
    groups.map((g) => g.label),
    ["Onboarding", "OnBase", "Separations", "Work Study", "Payroll", "Timekeeping", "Search", "Utils"],
  );
  // A category with no startable member is DROPPED rather than rendered as an
  // empty heading. Timekeeping used to prove that by accident (its only member
  // was unstartable); now that Old Kronos Reports is startable, the property is
  // asserted directly instead of relying on a fixture that could change again.
  const withoutTimekeeping = startWorkflowGroups(DEMO_WORKFLOW_LIST.filter((w) => w.category !== "Timekeeping"));
  assert.ok(!withoutTimekeeping.some((g) => g.label === "Timekeeping"));
  for (const group of groups) assert.ok(group.workflows.length > 0, `${group.label} rendered empty`);
});

// ---------------------------------------------------------------------------
// Input kinds — including the four drift fixes
// ---------------------------------------------------------------------------

test("every workflow declares the input kinds production actually accepts", () => {
  const expected: Record<string, StartMethodKind[]> = {
    separations: ["typed"],
    onboarding: ["typed"],
    "person-lookup": ["typed", "typed"],
    "kronos-pay-rule": ["typed"],
    "crm-doc-download": ["typed"],
    "work-study": ["typed", "spreadsheet"],
    "oath-signature": ["typed", "upload", "capture"],
    "emergency-contact": ["upload", "capture"],
    ocr: ["upload"],
    "oath-upload": ["upload"],
    onbase: ["upload"],
    "i9-check": ["upload"],
    "sharepoint-download": ["bare"],
    "old-kronos-reports": ["bare"],
  };
  for (const [id, kinds] of Object.entries(expected)) {
    assert.deepEqual(methodKinds(id as DemoWorkflowId), kinds, `${id} accepts the wrong input kinds`);
  }
  assert.equal(Object.keys(expected).length, startableWorkflows().length, "a startable workflow was added without an input-kind assertion");
});

test("the launcher excludes phone capture from both its defaults and offered methods", () => {
  assert.deepEqual(launcherStartMethods(capabilityOf("oath-signature")).map((method) => method.kind), ["typed", "upload"]);
  assert.deepEqual(launcherStartMethods(capabilityOf("emergency-contact")).map((method) => method.kind), ["upload"]);
  for (const workflow of startableWorkflows()) {
    assert.notEqual(launcherStartMethods(requireStartCapability(workflow))[0]?.kind, "capture");
  }
});

test("the typed values and separators match production, not the demo's old guesses", () => {
  const typed = (id: DemoWorkflowId) => {
    const method = requireStartMethod(capabilityOf(id), "typed");
    assert.equal(method.kind, "typed");
    if (method.kind !== "typed") throw new Error("unreachable");
    return method;
  };

  // DRIFT 1: separations types Kuali DOC IDs, not EIDs.
  assert.deepEqual(typed("separations").accepts, ["docId"]);
  assert.equal(typed("separations").separator, "comma");

  // DRIFT 2: person-lookup takes EIDs OR names, and its separator cannot be a
  // comma because a name holds one ("Battistessa, Johnnie").
  assert.deepEqual(typed("person-lookup").accepts, ["eid", "name"]);
  assert.equal(typed("person-lookup").separator, "semicolon");
  const match = requireStartMethod(capabilityOf("person-lookup"), "typed", { mode: "match" });
  assert.equal(match.kind, "typed");
  if (match.kind !== "typed") throw new Error("unreachable");
  assert.deepEqual(match.accepts, ["personMatch"]);
  assert.equal(match.separator, "semicolon");

  // DRIFT 3: onboarding is started by campus email, not by name.
  assert.deepEqual(typed("onboarding").accepts, ["email"]);

  // DRIFT 4: crm-doc-download and oath-signature had no typed path at all.
  assert.deepEqual(typed("crm-doc-download").accepts, ["eid", "email"]);
  assert.deepEqual(typed("oath-signature").accepts, ["eid"]);

  assert.deepEqual(typed("kronos-pay-rule").accepts, ["eid"]);
  assert.deepEqual(typed("work-study").accepts, ["eid"]);
});

test("only OnBase merges several files into one document", () => {
  for (const workflow of startableWorkflows()) {
    for (const method of workflow.start?.methods ?? []) {
      if (method.kind !== "upload") continue;
      assert.equal(method.merge, workflow.id === "onbase", `${workflow.id} merge flag is wrong`);
    }
  }
});

// ---------------------------------------------------------------------------
// Sub-selections
// ---------------------------------------------------------------------------

test("each workflow offers exactly the sub-selections it declares", () => {
  assert.deepEqual(choiceKeys("separations", "typed"), ["preset", "workers"]);
  assert.deepEqual(choiceKeys("onboarding", "typed"), ["workers"]);
  assert.deepEqual(choiceKeys("person-lookup", "typed"), ["mode", "workers"]);
  assert.deepEqual(choiceKeys("kronos-pay-rule", "typed"), ["workers"]);
  assert.deepEqual(choiceKeys("crm-doc-download", "typed"), ["workers"]);
  assert.deepEqual(choiceKeys("ocr", "upload"), ["formType", "rosterSource", "rosterFile", "workers"]);
  assert.deepEqual(choiceKeys("emergency-contact", "upload"), ["formType", "rosterSource", "rosterFile", "workers"]);
  assert.deepEqual(choiceKeys("onbase", "upload"), ["onbaseDocType", "rosterSource", "rosterFile", "workers"]);
  // i9-check: workers ONLY. No roster to match against and no write for a dry
  // run to suppress, so the absence is the answer, not an oversight.
  assert.deepEqual(choiceKeys("i9-check", "upload"), ["formType", "workers"]);
  // sharepoint-download declares none, and shows none — no empty scaffolding.
  assert.deepEqual(choiceKeys("sharepoint-download", "bare"), []);
  // work-study's spreadsheet path hands every setting to the intake, so it
  // shows none either — a worker count answered here would be answered again
  // there.
  assert.deepEqual(choiceKeys("work-study", "typed"), ["workers"]);
  assert.deepEqual(choiceKeys("work-study", "spreadsheet"), []);
});

test("a sub-selection scoped to a method is absent on the others", () => {
  // A typed EID has no packet, so it has no form type and no roster.
  assert.deepEqual(choiceKeys("oath-signature", "typed"), ["workers"]);
  assert.deepEqual(choiceKeys("oath-signature", "upload"), ["formType", "rosterSource", "rosterFile", "workers"]);
  assert.deepEqual(choiceKeys("oath-signature", "capture"), ["formType", "rosterSource", "rosterFile", "workers"]);
});

test("oath-upload's upload-only mode hides the roster and the workers, because it reads nothing", () => {
  assert.deepEqual(choiceKeys("oath-upload", "upload"), ["mode", "formType", "rosterSource", "rosterFile", "workers"]);
  assert.deepEqual(choiceKeys("oath-upload", "upload", { mode: "upload-only" }), ["mode", "formType"]);
});

test("the roster file picker is offered only while a local roster is the source", () => {
  assert.ok(choiceKeys("ocr", "upload", { rosterSource: "existing" }).includes("rosterFile"));
  for (const source of ["wait", "download", "none"]) {
    assert.ok(!choiceKeys("ocr", "upload", { rosterSource: source }).includes("rosterFile"), `rosterFile leaked with source=${source}`);
  }
});

test("a hidden sub-selection sends nothing", () => {
  const capability = capabilityOf("oath-upload");
  const values = { ...Object.fromEntries(capability.choices.map((c) => [c.key, c.defaultValue])), mode: "upload-only", workers: "4" };
  const sent = effectiveChoiceValues(capability, "upload", values);
  assert.deepEqual(Object.keys(sent).sort(), ["formType", "mode"]);
  assert.equal(sent.workers, undefined, "a worker count the operator cannot see must not ride the enqueue");
});

test("every choice's default is a real, available option", () => {
  for (const workflow of startableWorkflows()) {
    for (const choice of workflow.start?.choices ?? []) {
      const option = choice.options.find((o) => o.value === choice.defaultValue);
      assert.ok(option, `${workflow.id}/${choice.key} defaults to "${choice.defaultValue}", which is not an option`);
      assert.equal(option?.unavailable, undefined, `${workflow.id}/${choice.key} defaults to an option that is not wired`);
      if (choice.locked) {
        assert.equal(choice.options.length, 1, `${workflow.id}/${choice.key} is locked but offers a choice`);
        assert.ok(choice.lockedReason, `${workflow.id}/${choice.key} is locked with no reason`);
      }
    }
  }
});

test("OnBase offers all 24 document types and says which 23 are not wired", () => {
  const docType = capabilityOf("onbase").choices.find((c) => c.key === "onbaseDocType");
  assert.ok(docType);
  assert.equal(docType?.options.length, 24);
  const unwired = docType?.options.filter((o) => o.unavailable) ?? [];
  assert.equal(unwired.length, 23);
  // Offered disabled WITH the reason — hiding them would teach the operator the
  // product has never heard of a type they can see in OnBase.
  for (const option of unwired) assert.ok((option.unavailable ?? "").length > 20, `${option.value} is disabled with no reason`);
  assert.equal(docType?.defaultValue, "X_HR_Emergency Contact");
});

test("the OCR form-type picker offers all five specs; every other target locks its own", () => {
  const ocrFormType = capabilityOf("ocr").choices.find((c) => c.key === "formType");
  assert.deepEqual(ocrFormType?.options.map((o) => o.value), ["oath", "emergency-contact", "onbase-emergency-contact", "verify", "i9"]);
  assert.notEqual(ocrFormType?.locked, true, "a standalone OCR run picks its own spec");

  const locked: Record<string, string> = {
    "oath-signature": "oath",
    "oath-upload": "oath",
    "emergency-contact": "emergency-contact",
    "i9-check": "i9",
  };
  for (const [id, value] of Object.entries(locked)) {
    const choice = capabilityOf(id as DemoWorkflowId).choices.find((c) => c.key === "formType");
    assert.equal(choice?.locked, true, `${id} should lock its form type`);
    assert.equal(choice?.defaultValue, value);
  }
});

// ---------------------------------------------------------------------------
// Run flags
// ---------------------------------------------------------------------------

test("run flags are method-scoped, and absent where there is nothing to suppress", () => {
  const keys = (id: DemoWorkflowId, method: StartMethodKind) => visibleFlags(capabilityOf(id), method).map((f) => f.key);

  // oath-signature: a packet writes, so a rehearsal means something there; a
  // typed EID signs one oath and the input registry offers no dry run for it.
  assert.deepEqual(keys("oath-signature", "upload"), ["dryRun"]);
  assert.deepEqual(keys("oath-signature", "typed"), []);

  assert.deepEqual(keys("oath-upload", "upload"), ["dryRun", "duplicateCheck"]);
  assert.deepEqual(keys("i9-check", "upload"), []);
  assert.deepEqual(keys("ocr", "upload"), []);
  assert.deepEqual(keys("person-lookup", "typed"), ["crmCheck"]);
  assert.deepEqual(keys("separations", "typed"), ["dryRun"]);
});

test("Person Lookup CRM defaults follow the selected mode", () => {
  const capability = capabilityOf("person-lookup");
  assert.equal(defaultFlagValues(capability, { mode: "search" }).crmCheck, true);
  assert.equal(defaultFlagValues(capability, { mode: "match" }).crmCheck, false);
});

// ---------------------------------------------------------------------------
// Parsing — per-token discrimination, and a loud refusal per value
// ---------------------------------------------------------------------------

test("a typed box discriminates PER TOKEN across every kind it accepts", () => {
  const pl = parseEntries("10084412; Battistessa, Johnnie; 99", ["eid", "name"], "semicolon");
  assert.deepEqual(pl.map((e) => e.kind), ["eid", "name", undefined]);
  assert.equal(pl[2].problem?.code, "not-a-recognized-value");
  assert.match(pl[2].problem?.message ?? "", /8 digits/);

  const cd = parseEntries("10084412, samuel.ortiz@ucsd.edu", ["eid", "email"], "comma");
  assert.deepEqual(cd.map((e) => e.kind), ["eid", "email"]);
});

test("a single-kind box names its own rule when a value is refused", () => {
  const sep = parseEntries("3930, 39-30", ["docId"], "comma");
  assert.equal(sep[0].kind, "docId");
  assert.equal(sep[1].problem?.code, "not-a-doc-id");
  assert.match(sep[1].problem?.message ?? "", /3 to 6 digits/);

  const dupes = parseEntries("3930, 3930", ["docId"], "comma");
  assert.equal(dupes[1].problem?.code, "duplicate-entry");
});

test("a comma inside a semicolon-separated name is not a separator", () => {
  const entries = parseEntries("Battistessa, Johnnie", ["eid", "name"], "semicolon");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].value, "Battistessa, Johnnie");
});

test("Match records keep their internal commas and refuse a line with neither hard identifier", () => {
  const entries = parseEntries(
    "Reyes, Marta, 01/02/1980, x; Patel, Rina, x, 123456789; Reyes, Marta, x, x",
    ["personMatch"],
    "semicolon",
  );
  assert.deepEqual(entries.map((entry) => entry.kind), ["personMatch", "personMatch", undefined]);
  assert.match(entries[2].problem?.message ?? "", /not both/);
});

// ---------------------------------------------------------------------------
// The plan — derived from the method's coordinator shape, never from an id
// ---------------------------------------------------------------------------

const file = (id: string) => {
  const found = UPLOAD_FILES.find((f) => f.id === id);
  if (!found) throw new Error(`no fixture ${id}`);
  return found;
};

test("a document plan counts PAGES and never people", () => {
  const plan = deriveStartPlan({
    workflow: DEMO_WORKFLOWS["oath-signature"],
    method: requireStartMethod(capabilityOf("oath-signature"), "upload"),
    files: [file("oath-summer")],
  });
  assert.equal(plan.headline, "1 Group Row · 12 pages");
  assert.ok(!/\d+ people/.test(plan.headline), "the headline claimed a people count nobody can know pre-OCR");
  assert.deepEqual(plan.rows.map((r) => r.role), ["group", "review", "member"]);
  assert.equal(plan.rows[2].bornAs, "not yet created");
});

test("D6 is mechanical: oath-upload is ONE Run Row whose signers are linked elsewhere", () => {
  const plan = deriveStartPlan({
    workflow: DEMO_WORKFLOWS["oath-upload"],
    method: requireStartMethod(capabilityOf("oath-upload"), "upload"),
    files: [file("signed-oath")],
  });
  assert.deepEqual(plan.rows.map((r) => r.role), ["run", "linked"]);
  assert.equal(plan.rows[1].containment, "linked");
  assert.equal(plan.rows[1].panel, "Oath Signature");
  assert.ok(!plan.rows.some((r) => r.role === "member"), "a single-run coordinator must never draw members");
});

test("a standalone OCR run is a review that releases nothing", () => {
  const plan = deriveStartPlan({
    workflow: DEMO_WORKFLOWS.ocr,
    method: requireStartMethod(capabilityOf("ocr"), "upload"),
    files: [file("i9-scan")],
  });
  assert.deepEqual(plan.rows.map((r) => r.role), ["review"]);
  assert.equal(plan.rows[0].panel, "OCR");
  assert.match(plan.decisions.join(" "), /approval is delegation/);
});

test("OnBase merges N files into one document; everything else makes N runs", () => {
  const merged = deriveStartPlan({
    workflow: DEMO_WORKFLOWS.onbase,
    method: requireStartMethod(capabilityOf("onbase"), "upload"),
    files: [file("ec-ruiz-1"), file("ec-ruiz-2")],
  });
  assert.equal(merged.headline, "1 Group Row · 2 pages");
  assert.equal(merged.rows.filter((r) => r.role === "group").length, 1);
  assert.match(merged.decisions[0], /merged into a single/);

  const separate = deriveStartPlan({
    workflow: DEMO_WORKFLOWS["emergency-contact"],
    method: requireStartMethod(capabilityOf("emergency-contact"), "upload"),
    files: [file("ec-jul"), file("ec-ruiz-1")],
  });
  assert.equal(separate.rows.filter((r) => r.role === "group").length, 2);
  assert.match(separate.headline, /2 independent starts/);
});

test("a capture start plans off the page count the phone already pushed", () => {
  const session = captureSessionFor("emergency-contact");
  assert.ok(session);
  const plan = deriveStartPlan({
    workflow: DEMO_WORKFLOWS["emergency-contact"],
    method: requireStartMethod(capabilityOf("emergency-contact"), "capture"),
    capture: session,
  });
  assert.equal(plan.headline, `1 Group Row · ${session.photos.length} pages`);
});

test("one typed value mints a Run Row; more than one mints a Group Row", () => {
  const method = requireStartMethod(capabilityOf("separations"), "typed");
  const one = deriveStartPlan({ workflow: DEMO_WORKFLOWS.separations, method, entries: parseEntries("3930", ["docId"], "comma") });
  assert.equal(one.headline, "1 Run Row");
  assert.deepEqual(one.rows.map((r) => r.role), ["run"]);

  const many = deriveStartPlan({ workflow: DEMO_WORKFLOWS.separations, method, entries: parseEntries("3930, 3928", ["docId"], "comma") });
  assert.equal(many.headline, "1 Group Row · 2 members");
  assert.deepEqual(many.rows.map((r) => r.role), ["group", "member", "member"]);
});

test("a start with no subject is still a run", () => {
  const plan = deriveStartPlan({
    workflow: DEMO_WORKFLOWS["sharepoint-download"],
    method: requireStartMethod(capabilityOf("sharepoint-download"), "bare"),
  });
  assert.equal(plan.headline, "1 Run Row");
  assert.equal(plan.rows[0].panel, "SharePoint Download");
});

test("a spreadsheet has no plan until the intake has bound it", () => {
  const plan = deriveStartPlan({
    workflow: DEMO_WORKFLOWS["work-study"],
    method: requireStartMethod(capabilityOf("work-study"), "spreadsheet"),
  });
  assert.deepEqual(plan.rows, []);
  assert.match(plan.decisions.join(" "), /header row/);
});
