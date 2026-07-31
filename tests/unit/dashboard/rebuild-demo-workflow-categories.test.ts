import { test } from "vitest";
import assert from "node:assert/strict";
import {
  buildWorkflowCategoryGroups,
  DEMO_CATEGORY_ORDER,
  DEMO_CATEGORY_OTHER,
  DEMO_WORKFLOWS,
  DEMO_WORKFLOW_LIST,
  type DemoWorkflowRef,
} from "../../../src/dashboard/components/dev/rebuild-demo/demo-wire.js";

/**
 * The rail groups by each workflow descriptor's OWN `category`, with only the
 * display ORDER hardcoded — the same mechanism production uses
 * (`WorkflowRail.computeDisplayGroups` + `PREFERRED_CATEGORY_ORDER`).
 *
 * The demo previously invented a closed three-value union (People / Documents /
 * Data) and re-binned every workflow into it, so Oath Signature read as
 * `Documents` here and `Onboarding` in the product the demo exists to plan.
 * These pin the real taxonomy, the ordering rules, and the two mechanical
 * properties that stop it drifting back: an empty group is dropped, and an
 * uncategorised workflow lands in a trailing `Other` rather than vanishing.
 */

/** the production categories, in production's order */
test("the demo registry declares the product's own categories", () => {
  assert.deepEqual(
    [...DEMO_CATEGORY_ORDER],
    ["Onboarding", "OnBase", "Separations", "Work Study", "Payroll", "Timekeeping", "Search", "Utils"],
  );
  // Nothing in the registry sits under a heading the product does not use.
  for (const w of DEMO_WORKFLOW_LIST) {
    assert.ok(
      DEMO_CATEGORY_ORDER.includes(w.category) || w.category === DEMO_CATEGORY_OTHER,
      `${w.id} declares category "${w.category}", which the rail does not order`,
    );
  }
});

test("each workflow sits in the group its production descriptor declares", () => {
  // Mirrors `grep -n 'category:' src/workflows/*/workflow.ts` exactly.
  const expected: Record<string, string> = {
    separations: "Separations",
    "i9-check": "Separations",
    onboarding: "Onboarding",
    "oath-signature": "Onboarding",
    "oath-upload": "Onboarding",
    "emergency-contact": "Onboarding",
    onbase: "OnBase",
    "work-study": "Work Study",
    "kronos-pay-rule": "Payroll",
    "old-kronos-reports": "Timekeeping",
    "person-lookup": "Search",
    "i9-lookup": "Search",
    ocr: "Utils",
    "crm-doc-download": "Utils",
    "sharepoint-download": "Utils",
  };
  for (const [id, category] of Object.entries(expected)) {
    const workflow = DEMO_WORKFLOWS[id as keyof typeof DEMO_WORKFLOWS];
    assert.ok(workflow, `the registry no longer serves ${id}`);
    assert.equal(workflow.category, category, `${id} moved out of ${category}`);
  }
  assert.equal(DEMO_WORKFLOW_LIST.length, Object.keys(expected).length, "a workflow was added without a category assertion");
});

test("the two defects the survey found are closed", () => {
  // i9-lookup was absent from the registry entirely.
  assert.equal(DEMO_WORKFLOWS["i9-lookup"].code, "i9");
  assert.equal(DEMO_WORKFLOWS["i9-lookup"].category, "Search");
  // `kronos-reports` reused production's `kr` code under a different id/label.
  assert.equal(DEMO_WORKFLOWS["old-kronos-reports"].code, "kr");
  assert.equal(DEMO_WORKFLOWS["old-kronos-reports"].label, "Old Kronos Reports");
  // ...and a code is still unique across the registry, since it prefixes every
  // one of a workflow's trace ids.
  const codes = DEMO_WORKFLOW_LIST.map((w) => w.code);
  assert.equal(new Set(codes).size, codes.length, `duplicate workflow code: ${codes.join(", ")}`);
});

test("groups render in the hardcoded order, and every registered workflow is in exactly one", () => {
  const groups = buildWorkflowCategoryGroups();
  assert.deepEqual(
    groups.map((g) => g.label),
    ["Onboarding", "OnBase", "Separations", "Work Study", "Payroll", "Timekeeping", "Search", "Utils"],
  );
  const placed = groups.flatMap((g) => g.workflows.map((w) => w.id));
  assert.equal(placed.length, DEMO_WORKFLOW_LIST.length);
  assert.equal(new Set(placed).size, DEMO_WORKFLOW_LIST.length, "a workflow was rendered in two groups");
});

test("a category with no members is DROPPED, never rendered as an empty heading", () => {
  // Production's dashboard process never imports Old Kronos Reports, so its
  // `Timekeeping` group renders empty and disappears. The order list keeps the
  // entry so registering it later needs no rail edit.
  const withoutTimekeeping = DEMO_WORKFLOW_LIST.filter((w) => w.category !== "Timekeeping");
  const groups = buildWorkflowCategoryGroups(withoutTimekeeping);
  assert.ok(!groups.some((g) => g.label === "Timekeeping"));
  assert.ok(groups.every((g) => g.workflows.length > 0));
});

test("an uncategorised workflow falls into a trailing Other, and an unlisted category is appended before it", () => {
  const invented: DemoWorkflowRef[] = [
    { ...DEMO_WORKFLOWS.separations, id: "separations", category: "Separations" },
    // a category the order list has never heard of
    { ...DEMO_WORKFLOWS.ocr, id: "ocr", category: "Recruiting" },
    // and one that declares none at all
    { ...DEMO_WORKFLOWS["sharepoint-download"], id: "sharepoint-download", category: "" },
  ];
  const groups = buildWorkflowCategoryGroups(invented);
  assert.deepEqual(
    groups.map((g) => g.label),
    ["Separations", "Recruiting", DEMO_CATEGORY_OTHER],
  );
  assert.deepEqual(
    groups[2].workflows.map((w) => w.id),
    ["sharepoint-download"],
  );
});

test("member order inside a group is registration order", () => {
  const onboarding = buildWorkflowCategoryGroups().find((g) => g.label === "Onboarding");
  assert.ok(onboarding);
  assert.deepEqual(
    onboarding.workflows.map((w) => w.id),
    DEMO_WORKFLOW_LIST.filter((w) => w.category === "Onboarding").map((w) => w.id),
  );
});
