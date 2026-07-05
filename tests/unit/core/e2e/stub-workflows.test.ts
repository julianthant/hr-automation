import { test, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeWrapE2EStub } from "../../../../src/core/e2e/stub-workflows.js";
import { E2EScriptedFailError } from "../../../../src/core/e2e/gates.js";
import { loadWorkflow, type AnyRegisteredWorkflow } from "../../../../src/core/workflow-loaders.js";
import { e2eGatesDir, e2eGateHoldPath, e2eGateFailPath } from "../../../../src/tracker/paths.js";
import { oathSignatureWorkflow } from "../../../../src/workflows/oath-signature/index.js";
import { onbaseWorkflow } from "../../../../src/workflows/onbase/workflow.js";
import { personLookupWorkflow } from "../../../../src/workflows/person-lookup/index.js";
import { resolveQueueRowPresentation } from "../../../../src/domain/queue-row-presentation.js";

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
  assert.deepEqual([...stub.config.steps], ["crm-verify", "ucpath-auth", "transaction"]);
  assert.deepEqual(stub.config.systems, []);
  assert.notEqual(stub.config.handler, oathSignatureWorkflow.config.handler);
  // The real registered workflow is untouched (clone, not mutation) — crm + ucpath.
  assert.equal(oathSignatureWorkflow.config.systems.length, 2);
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
    assert.deepEqual(steps, ["crm-verify", "ucpath-auth", "transaction"]);
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

test("scripted handler throws at an armed fail gate, stamps no success data, then the retry replay passes (organic fail → retry)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-stub-fail-"));
  try {
    mkdirSync(e2eGatesDir(dir), { recursive: true });
    writeFileSync(e2eGateFailPath("oath-signature", "transaction", dir), "");

    const stub = wrappedOathSignature();

    // First run: the fail gate fires at `transaction` — handler rejects with a
    // non-cancel error (kernel → terminal `failed` row + Retry), and the
    // failed step never stamped its success data (emplId/name).
    const first = makeFakeCtx(dir);
    await assert.rejects(
      stub.config.handler(first.ctx as never, { emplId: "10000009", name: "Fail, Test", date: "06/12/2026" } as never),
      (err: unknown) => err instanceof E2EScriptedFailError,
    );
    assert.equal(first.data.e2eStub, "true");
    assert.ok(first.calls.some((c) => c.step === "transaction"), "reached the failing step");
    assert.equal(first.data.emplId, undefined, "a failed step stamps no success data");

    // Retry replays the SAME original input; the gate self-consumed, so the
    // replay walks both steps to completion.
    const retry = makeFakeCtx(dir);
    await stub.config.handler(retry.ctx as never, { emplId: "10000009", name: "Fail, Test", date: "06/12/2026" } as never);
    const steps = retry.calls.filter((c) => c.kind === "step").map((c) => c.step);
    assert.deepEqual(steps, ["crm-verify", "ucpath-auth", "transaction"]);
    assert.equal(retry.data.emplId, "10000009", "retry stamps the step data the first run never reached");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadWorkflow wraps only when HRAUTO_E2E_STUBS=1", async () => {
  delete process.env.HRAUTO_E2E_STUBS;
  const real = await loadWorkflow("oath-signature");
  assert.ok(real);
  assert.equal(real.config.systems.length, 2);

  process.env.HRAUTO_E2E_STUBS = "1";
  const stub = await loadWorkflow("oath-signature");
  assert.ok(stub);
  assert.equal(stub.config.systems.length, 0);
  assert.equal(stub.config.name, "oath-signature");
});

test("person-lookup EID-only stub echoes a resolved name so the row title is not the bare EID (ISS-008)", async () => {
  // RED pin: an EID-only person-lookup row finishes `done` but, in stub mode,
  // never gets a resolved name echoed onto its data — so `data.name` is unset
  // and `data.searchName` stays the bare EID. The person-kind title resolver
  // then falls through to that EID, titling the row "10514074" instead of a
  // person name. The REAL handler stamps `searchName = result.name` (the
  // UCPath-resolved name), so the stub is the layer that must echo a name.
  const dir = mkdtempSync(join(tmpdir(), "e2e-stub-pl-eid-"));
  try {
    const stub = maybeWrapE2EStub(
      "person-lookup",
      personLookupWorkflow as unknown as AnyRegisteredWorkflow,
    );
    const { ctx, data } = makeFakeCtx(dir);
    await stub.config.handler(ctx as never, { emplId: "10514074" } as never);

    // Project the finished row's data through the single title/subtitle resolver
    // as a person-kind row (what an EID person-lookup row renders as).
    const presentation = resolveQueueRowPresentation({
      id: "row-1",
      data: { ...data, queueRowKind: "person" },
    });
    assert.ok(presentation, "person-kind row should resolve a presentation");
    assert.notEqual(
      presentation.title,
      "10514074",
      "an EID-only person-lookup row must title on a resolved name, not the bare EID",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("onbase scripted stub is registered, walks all four steps, and stamps operator data from the input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-stub-ob-"));
  try {
    const stub = maybeWrapE2EStub("onbase", onbaseWorkflow as unknown as AnyRegisteredWorkflow);
    // Metadata preserved; systems dropped.
    assert.equal(stub.config.name, "onbase");
    assert.deepEqual([...stub.config.steps], ["authenticate", "prepare-import", "fill-keywords", "import"]);
    assert.deepEqual(stub.config.systems, []);

    const { ctx, calls, data } = makeFakeCtx(dir);
    await stub.config.handler(
      ctx as never,
      {
        ucpathId: "10001234",
        sourcePage: 3,
        pdfFileId: "file-abc",
        documentType: "X_HR_Emergency Contact",
        employeeName: "Smith, Jane",
        dryRun: true,
      } as never,
    );

    const steps = calls.filter((c) => c.kind === "step").map((c) => c.step);
    assert.deepEqual(steps, ["authenticate", "prepare-import", "fill-keywords", "import"]);

    // Upfront fields (mirroring real handler's pre-step ctx.updateData).
    assert.equal(data.e2eStub, "true");
    assert.equal(data.ucpathId, "10001234");
    assert.equal(data.employeeName, "Smith, Jane");
    assert.equal(data.documentType, "X_HR_Emergency Contact");
    assert.equal(data.sourcePage, "3");

    // fill-keywords stamps keysetAutofilled.
    assert.equal(data.keysetAutofilled, "true");

    // import stamps dry-run status.
    assert.equal(data.status, "Dry Run Complete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("onbase scripted stub stamps 'Imported' status on a non-dry-run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "e2e-stub-ob-live-"));
  try {
    const stub = maybeWrapE2EStub("onbase", onbaseWorkflow as unknown as AnyRegisteredWorkflow);
    const { ctx, data } = makeFakeCtx(dir);
    await stub.config.handler(
      ctx as never,
      { ucpathId: "10009999", sourcePage: 1, pdfFileId: "file-xyz", documentType: "X_HR_Emergency Contact" } as never,
    );
    assert.equal(data.status, "Imported");
    assert.equal(data.keysetAutofilled, "true");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
