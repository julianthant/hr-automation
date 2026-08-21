import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { defineWorkflow, runWorkflowBatch } from "../../../../src/core/index.js";
import { DEFAULT_DIR, dateLocal } from "../../../../src/tracker/jsonl.js";
/**
 * Tests covering the onboarding pool-mode contract:
 * - `runWorkflowBatch` in pool mode pairs `onPreEmitPending` with per-item runIds
 *   so the dashboard shows one row per email keyed on the email itself.
 * - `opts.poolSize` override propagates through `runWorkflowBatch` into
 *   `runWorkflowPool`.
 *
 * Matches the kronos-reports precedent in
 * `tests/unit/workflows/old-kronos-reports/workflow.test.ts`. Uses a stub
 * workflow so we don't launch real CRM/UCPath/I9 browsers.
 */

function fakeSlot() {
  return {
    page: { bringToFront: async () => {} } as unknown as import("playwright").Page,
    context: { close: async () => {} } as never,
    browser: { close: async () => {} } as never,
  };
}

function cleanupWorkflow(workflow: string) {
  const today = dateLocal();
  for (const suffix of [".jsonl", "-logs.jsonl"]) {
    const path = join(DEFAULT_DIR, `${workflow}-${today}${suffix}`);
    if (existsSync(path)) rmSync(path);
  }
}

test("onboarding dry run runs every step but withholds both form submissions", () => {
  const source = readFileSync(
    new URL("../../../../src/workflows/onboarding/workflow.ts", import.meta.url),
    "utf8",
  );
  const personSearch = source.indexOf('ctx.step("person-search"');
  const i9Step = source.indexOf('ctx.step("i9-creation"');
  const i9Search = source.indexOf("searchI9Employee(i9Page");
  const i9DryRunFill = source.indexOf("fillI9EmployeeProfileWithoutSaving(i9Page");
  const i9Abandon = source.indexOf("abandonI9ProfileForm(i9Page");
  const i9Create = source.indexOf("createI9Employee(i9Page");
  const transactionStep = source.indexOf('ctx.step("transaction"');
  const duplicateProbe = source.indexOf("findExistingHireTransaction(ucpathPage");
  const dryRunTerminal = source.indexOf('label: "onboarding-dry-run-transaction-filled"');
  const receiptReadback = source.indexOf("readSubmittedHireReceipt(ucpathPage");

  for (const [label, index] of [
    ["person search", personSearch],
    ["I-9 step", i9Step],
    ["I-9 search", i9Search],
    ["I-9 dry-run fill", i9DryRunFill],
    ["I-9 abandon", i9Abandon],
    ["I-9 create", i9Create],
    ["Smart HR step", transactionStep],
    ["duplicate-hire probe", duplicateProbe],
    ["dry-run transaction terminal", dryRunTerminal],
    ["receipt readback", receiptReadback],
  ] as const) {
    assert.notEqual(index, -1, `${label} marker must remain present`);
  }

  // A rehearsal must still exercise every READ: the identity check, the I-9 SSN
  // search, and the duplicate-hire probe are the checks it exists to prove.
  assert.ok(personSearch < i9Step, "the rehearsal performs the read-only identity check first");
  assert.ok(i9Search < i9DryRunFill, "the I-9 SSN search must run before the dry-run fill");
  assert.ok(duplicateProbe < dryRunTerminal, "the duplicate-hire probe must run before the dry-run terminal");

  // ...and must withhold BOTH form submissions.
  assert.ok(
    i9DryRunFill < i9Create,
    "a dry run must reach the fill-without-saving path before the live createI9Employee call",
  );
  assert.ok(
    i9Abandon < i9Create,
    "a dry run must abandon the I-9 profile form instead of saving it",
  );
  assert.ok(
    dryRunTerminal < receiptReadback,
    "a dry run must terminate before the post-submit receipt readback (nothing was submitted)",
  );
});

test("rehire mode (2026-08-21): no I-9, UC_CONC_HIRE plan on the matched Empl ID, dry run cancels the draft", () => {
  const source = readFileSync(
    new URL("../../../../src/workflows/onboarding/workflow.ts", import.meta.url),
    "utf8",
  );
  const rehireNoMatchThrow = source.indexOf("Rehire mode: UCPath person search found NO existing person");
  const rehireEidResolved = source.indexOf("rehireEmplId = eidPreApproved ? approvedEid");
  const i9Step = source.indexOf('ctx.step("i9-creation"');
  const i9SkippedRehire = source.indexOf('mode = "skipped-rehire"');
  const i9Search = source.indexOf("searchI9Employee(i9Page");
  const i9Create = source.indexOf("createI9Employee(i9Page");
  const duplicateProbe = source.indexOf("findExistingHireTransaction(ucpathPage");
  const concPlan = source.indexOf("buildConcurrentHirePlan(data, ucpathPage, rehireEmplId");
  const fullPlan = source.indexOf("buildTransactionPlan(data, ucpathPage, i9ProfileId");
  const dryRunCancel = source.indexOf("cancelConcurrentHireDraft(ucpathPage)");
  const receiptReadback = source.indexOf("readSubmittedHireReceipt(ucpathPage");

  for (const [label, index] of [
    ["rehire no-match fail-loud", rehireNoMatchThrow],
    ["rehire EID resolution", rehireEidResolved],
    ["I-9 step", i9Step],
    ["I-9 skipped-rehire marker", i9SkippedRehire],
    ["I-9 search", i9Search],
    ["I-9 create", i9Create],
    ["duplicate-hire probe", duplicateProbe],
    ["concurrent-hire plan", concPlan],
    ["full-hire plan", fullPlan],
    ["dry-run draft cancel", dryRunCancel],
    ["receipt readback", receiptReadback],
  ] as const) {
    assert.notEqual(index, -1, `${label} marker must remain present`);
  }

  // Rehire resolves its Empl ID from person-search BEFORE the I-9 step, and the
  // I-9 step returns on the rehire marker before any I-9 search/create.
  assert.ok(rehireEidResolved < i9Step, "the rehire Empl ID is resolved in person-search, before the I-9 step");
  assert.ok(i9Step < i9SkippedRehire && i9SkippedRehire < i9Search, "rehire skips the I-9 step before the SSN search");
  assert.ok(i9SkippedRehire < i9Create, "rehire never reaches createI9Employee");
  // The duplicate-hire probe still guards BOTH templates, and the plan is chosen by mode.
  assert.ok(duplicateProbe < concPlan && concPlan < fullPlan, "probe → (rehire ? UC_CONC_HIRE plan : UC_FULL_HIRE plan)");
  // A rehire dry run cancels the draft and terminates before the receipt readback.
  assert.ok(concPlan < dryRunCancel && dryRunCancel < receiptReadback, "rehire dry run cancels the draft before any receipt readback");
});

test("buildConcurrentHirePlan: name readbacks guard the EID, dry run asserts Save enabled and never adds the submit", () => {
  const source = readFileSync(
    new URL("../../../../src/workflows/onboarding/enter.ts", import.meta.url),
    "utf8",
  );
  const fn = source.indexOf("export function buildConcurrentHirePlan(");
  assert.notEqual(fn, -1, "buildConcurrentHirePlan must exist");
  const body = source.slice(fn);
  const eidGuard = body.indexOf("isUcpathEmployeeId(emplId)");
  const detailsName = body.indexOf("fillTransactionDetailsEmplId(page");
  const detailsNameRefuse = body.indexOf("refusing to file a concurrent hire against the");
  const reason = body.indexOf("selectReasonCode(page, getContentFrame(page), CONC_HIRE_REASON_CODE)");
  const ack = body.indexOf("acknowledgePersonIdExistsDialog(page, emplId)");
  const jobData = body.indexOf("fillJobData(page, getContentFrame(page), jobData)");
  const personalName = body.indexOf("readPersonalDataLegalName(frame)");
  const dryRunGuard = body.indexOf("if (options.dryRun)");
  const enabledCheck = body.indexOf("Verify Save and Submit is enabled");
  const submitStep = body.indexOf('"Save and Submit transaction"');
  const submitCall = body.indexOf("clickSaveAndSubmit(page, getContentFrame(page), emplId");
  for (const [label, index] of [
    ["EID validity guard", eidGuard], ["details name readback", detailsName],
    ["details name refusal", detailsNameRefuse], ["reason code", reason], ["person-exists ack", ack],
    ["job data", jobData], ["personal-data name readback", personalName], ["dry-run guard", dryRunGuard],
    ["enabled check", enabledCheck], ["submit step", submitStep], ["EID-keyed submit", submitCall],
  ] as const) {
    assert.notEqual(index, -1, `${label} marker must remain present`);
  }
  assert.ok(eidGuard < detailsName, "the Empl ID is validated before it is ever typed into UCPath");
  assert.ok(detailsName < detailsNameRefuse && detailsNameRefuse < reason, "the resolved name is verified BEFORE the reason code / Continue");
  assert.ok(reason < ack && ack < jobData, "Continue → acknowledge 'Person ID already exists' → Job Data");
  assert.ok(jobData < personalName, "the Personal Data legal-name readback happens after Job Data");
  assert.ok(dryRunGuard < submitStep && enabledCheck < submitStep, "dry run returns (after asserting Save enabled) before the submit step is added");
});

test("buildTransactionPlan omits Save and Submit in dry run, and asserts the button is enabled", () => {
  const source = readFileSync(
    new URL("../../../../src/workflows/onboarding/enter.ts", import.meta.url),
    "utf8",
  );
  const dryRunGuard = source.indexOf("if (options.dryRun)");
  const enabledCheck = source.indexOf("Verify Save and Submit is enabled");
  const submitStep = source.indexOf('"Save and Submit transaction"');

  assert.notEqual(dryRunGuard, -1, "dry-run guard must remain present");
  assert.notEqual(enabledCheck, -1, "dry run must verify the submit button is enabled");
  assert.notEqual(submitStep, -1, "the live Save and Submit step must remain present");

  assert.ok(
    dryRunGuard < submitStep,
    "the dry-run guard must return before Save and Submit is ever added to the plan",
  );
  assert.ok(
    enabledCheck < submitStep,
    "the enabled-button assertion belongs to the dry-run branch, before the live submit step",
  );
});

test("runWorkflowBatch (pool): onboarding-shaped onPreEmitPending paired with runId per email", async (t) => {
  const wfName = `onboarding-pool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  t.onTestFinished(() => cleanupWorkflow(wfName));

  const pendingEmissions: Array<{ email: string; runId: string }> = [];

  const wf = defineWorkflow({
    name: wfName,
    systems: [
      { id: "crm", login: async () => {} },
      { id: "ucpath", login: async () => {} },
      { id: "i9", login: async () => {} },
    ],
    steps: [
      "crm-auth",
      "extraction",
      "pdf-download",
      "ucpath-auth",
      "person-search",
      "i9-creation",
      "transaction",
    ] as const,
    schema: z.object({ email: z.string().email() }),
    batch: { mode: "pool", poolSize: 2, preEmitPending: true },
    handler: async (ctx) => {
      await ctx.step("crm-auth", async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    },
  });

  const result = await runWorkflowBatch(
    wf,
    [
      { email: "a@ucsd.edu" },
      { email: "b@ucsd.edu" },
      { email: "c@ucsd.edu" },
    ],
    {
      launchFn: () => Promise.resolve(fakeSlot()),
      trackerStub: true,
      deriveItemId: (item) => (item as { email: string }).email,
      onPreEmitPending: (item, runId) => {
        pendingEmissions.push({
          email: (item as { email: string }).email,
          runId,
        });
      },
    },
  );

  assert.equal(result.total, 3);
  assert.equal(result.succeeded, 3);
  assert.equal(result.failed, 0);

  // Each email should have fired exactly one pending callback, keyed on
  // email in input order (pre-emit is synchronous before workers start).
  assert.deepEqual(
    pendingEmissions.map((e) => e.email),
    ["a@ucsd.edu", "b@ucsd.edu", "c@ucsd.edu"],
  );
  const uniqueRunIds = new Set(pendingEmissions.map((e) => e.runId));
  assert.equal(
    uniqueRunIds.size,
    3,
    "each email should get its own unique runId",
  );
});

test("runWorkflowBatch (pool): poolSize override with 4 emails → N launches", async () => {
  let launchCalls = 0;

  const wf = defineWorkflow({
    name: "onboarding-pool-override",
    systems: [{ id: "crm", login: async () => {} }],
    steps: ["crm-auth"] as const,
    schema: z.object({ email: z.string().email() }),
    // Default poolSize is 4 — runtime override below should bring it to 2.
    batch: { mode: "pool", poolSize: 4 },
    handler: async (ctx) => {
      await ctx.step("crm-auth", async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    },
  });

  const items = [
    { email: "w1@ucsd.edu" },
    { email: "w2@ucsd.edu" },
    { email: "w3@ucsd.edu" },
    { email: "w4@ucsd.edu" },
  ];

  const result = await runWorkflowBatch(wf, items, {
    launchFn: () => {
      launchCalls++;
      return Promise.resolve(fakeSlot());
    },
    trackerStub: true,
    poolSize: 2,
  });

  assert.equal(result.succeeded, 4);
  assert.equal(
    launchCalls,
    2,
    "opts.poolSize (2) should override wf.config.batch.poolSize (4) through runWorkflowBatch → runWorkflowPool",
  );
});

test("normalizeCrmPlaceholder maps CRM 'empty' placeholders to \"\"", async () => {
  const { normalizeCrmPlaceholder } = await import(
    "../../../../src/workflows/onboarding/extract.js"
  );

  // Live 2026-08-20: a Middle Name of "N/A" was typed into the I-9 Employee
  // Profile verbatim; Save & Continue then produced no confirmation and the
  // hire failed, while a genuinely blank middle name saved fine.
  for (const placeholder of ["N/A", "n/a", " NA ", "None", "-", "--", "null", "N.A."]) {
    assert.equal(normalizeCrmPlaceholder(placeholder), "", `${placeholder} must normalize to ""`);
  }

  // Real values are preserved EXACTLY — including ones that merely contain a
  // placeholder as a substring.
  for (const real of ["Anwar", "Na", "Nana", "Anna", "Renee", "O'Brien", "Jean-Luc"]) {
    if (real.toLowerCase() === "na") continue;
    assert.equal(normalizeCrmPlaceholder(real), real, `${real} must be preserved`);
  }

  // Null/undefined pass through untouched (absent stays absent).
  assert.equal(normalizeCrmPlaceholder(null), null);
  assert.equal(normalizeCrmPlaceholder(""), "");
});
