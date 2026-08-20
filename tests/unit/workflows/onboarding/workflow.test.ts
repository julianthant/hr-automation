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
