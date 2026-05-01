import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildSharePointRosterDownloadHandler, _resetInFlightForTests } from "../../../../src/workflows/sharepoint-download/handler.js";

test("SharePoint download handler accepts parentRunId and forwards to runWorkflow", async () => {
  _resetInFlightForTests();
  const dir = join(tmpdir(), `sp-parent-${Date.now()}`);
  mkdirSync(dir, { recursive: true });

  let capturedInput: any = null;
  const handler = buildSharePointRosterDownloadHandler({
    outDir: dir,
    runWorkflowFn: async (_wf, input) => {
      capturedInput = input;
    },
    getEnv: (n) => (n === "ONBOARDING_ROSTER_URL" ? "https://example.com/file.xlsx" : undefined),
  });

  const resp = await handler({ id: "onboarding", parentRunId: "parent-run-xyz" });
  assert.equal(resp.status, 202);
  // Allow the fire-and-forget closure to run.
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(capturedInput);
  assert.equal(capturedInput.parentRunId, "parent-run-xyz");

  rmSync(dir, { recursive: true, force: true });
});
