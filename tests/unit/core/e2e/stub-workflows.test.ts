import { test, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeWrapE2EStub } from "../../../../src/core/e2e/stub-workflows.js";
import { loadWorkflow, type AnyRegisteredWorkflow } from "../../../../src/core/workflow-loaders.js";
import { e2eGatesDir, e2eGateHoldPath } from "../../../../src/tracker/paths.js";
import { oathSignatureWorkflow } from "../../../../src/workflows/oath-signature/index.js";

/**
 * HRAUTO_E2E_STUBS bridge: `loadWorkflow` wraps mapped workflows with
 * scripted handlers — same metadata/steps/schema/trace code, `systems: []`,
 * per-step operator data from the real input, hold-gate aware. Unmapped
 * workflows load REAL (loudly) so sweeps/metadata loading keep working.
 */

afterEach(() => {
  delete process.env.HRAUTO_E2E_STUBS;
});

interface FakeCtxCall {
  kind: "step" | "data";
  step?: string;
  patch?: Record<string, string>;
}

function makeFakeCtx(trackerDir: string) {
  const calls: FakeCtxCall[] = [];
  const data: Record<string, string> = {};
  const ac = new AbortController();
  const ctx = {
    signal: ac.signal,
    trackerDir,
    runId: "00000000-0000-4000-8000-000000000000",
    updateData: (patch: Record<string, string>) => {
      Object.assign(data, patch);
      calls.push({ kind: "data", patch });
    },
    step: async (name: string, fn: () => Promise<void>) => {
      calls.push({ kind: "step", step: name });
      await fn();
    },
    markStep: () => {},
    skipStep: () => {},
    screenshot: async () => ({ kind: "form", label: "", step: null, ts: 0, files: [] }),
    page: async () => {
      throw new Error("stub handlers must never acquire a real page");
    },
  };
  return { ctx, calls, data, ac };
}

const wrappedOathSignature = (): AnyRegisteredWorkflow =>
  maybeWrapE2EStub(
    "oath-signature",
    oathSignatureWorkflow as unknown as AnyRegisteredWorkflow,
  );

test("unmapped workflow returns the same object untouched", () => {
  const fake = { config: { name: "separations", systems: [{ id: "kuali" }] } } as unknown as AnyRegisteredWorkflow;
  assert.equal(maybeWrapE2EStub("separations", fake), fake);
});

test("wrapped workflow keeps metadata but drops systems", () => {
  const stub = wrappedOathSignature();
  assert.equal(stub.config.name, "oath-signature");
  assert.equal(stub.code, "os");
  assert.deepEqual([...stub.config.steps], ["ucpath-auth", "transaction"]);
  assert.deepEqual(stub.config.systems, []);
  assert.notEqual(stub.config.handler, oathSignatureWorkflow.config.handler);
  // The real registered workflow is untouched (clone, not mutation).
  assert.equal(oathSignatureWorkflow.config.systems.length, 1);
});

test("scripted handler walks the real steps and stamps operator data from the input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-stub-"));
  try {
    const stub = wrappedOathSignature();
    const { ctx, calls, data } = makeFakeCtx(dir);
    await stub.config.handler(
      ctx as never,
      { emplId: "10000001", name: "Doe, Jane", date: "06/11/2026", dryRun: true } as never,
    );
    const steps = calls.filter((c) => c.kind === "step").map((c) => c.step);
    assert.deepEqual(steps, ["ucpath-auth", "transaction"]);
    assert.equal(data.e2eStub, "true");
    assert.equal(data.emplId, "10000001");
    assert.equal(data.name, "Doe, Jane");
    assert.equal(data.date, "06/11/2026");
    assert.equal(data.status, "Dry Run Complete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scripted handler parks at a held step and resumes on release", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-stub-hold-"));
  try {
    mkdirSync(e2eGatesDir(dir), { recursive: true });
    const hold = e2eGateHoldPath("oath-signature", "transaction", dir);
    writeFileSync(hold, "");

    const stub = wrappedOathSignature();
    const { ctx, calls } = makeFakeCtx(dir);
    let finished = false;
    const run = stub.config
      .handler(ctx as never, { emplId: "10000002" } as never)
      .then(() => {
        finished = true;
      });

    // Poll until the handler reaches the held step, then verify it parks.
    for (let i = 0; i < 100 && !calls.some((c) => c.step === "transaction"); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(calls.some((c) => c.step === "transaction"), "handler should reach the held step");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(finished, false, "must stay parked while the hold file exists");

    unlinkSync(hold);
    await run;
    assert.equal(finished, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadWorkflow wraps only when HRAUTO_E2E_STUBS=1", async () => {
  delete process.env.HRAUTO_E2E_STUBS;
  const real = await loadWorkflow("oath-signature");
  assert.ok(real);
  assert.equal(real.config.systems.length, 1);

  process.env.HRAUTO_E2E_STUBS = "1";
  const stub = await loadWorkflow("oath-signature");
  assert.ok(stub);
  assert.equal(stub.config.systems.length, 0);
  assert.equal(stub.config.name, "oath-signature");
});

test("oath-upload stub runs the REAL handler with ServiceNow legs stubbed (upload-only path)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-stub-ou-"));
  try {
    process.env.HRAUTO_E2E_STUBS = "1";
    const stub = await loadWorkflow("oath-upload");
    assert.ok(stub);
    assert.equal(stub.config.systems.length, 0);

    const { ctx, data } = makeFakeCtx(dir);
    await stub.config.handler(
      ctx as never,
      {
        pdfPath: join(dir, "fake.pdf"),
        pdfOriginalName: "fake.pdf",
        sessionId: "e2e-session-1",
        mode: "upload-only",
        rosterMode: "existing",
      } as never,
    );
    assert.equal(data.e2eStub, "true");
    assert.equal(data.ticketNumber, "HRC0E2E001");
    assert.equal(data.status, "filed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
