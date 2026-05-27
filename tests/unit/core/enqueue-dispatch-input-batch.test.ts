import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

import { enqueueFromHttp } from "../../../src/core/daemon/enqueue-dispatch.js";

vi.mock("../../../src/core/daemon/client.js", () => ({
  ensureDaemonsAndEnqueue: vi.fn().mockResolvedValue({ enqueued: [], daemons: [] }),
}));

async function enqueueMock() {
  const client = await import("../../../src/core/daemon/client.js");
  return client.ensureDaemonsAndEnqueue as ReturnType<typeof vi.fn>;
}

function tempTrackerDir(): string {
  return mkdtempSync(join(tmpdir(), "enqueue-dispatch-input-batch-"));
}

beforeEach(async () => {
  (await enqueueMock()).mockClear();
});

test("enqueueFromHttp keeps a single input-run item unparented so it renders as one row", async () => {
  const result = await enqueueFromHttp("eid-lookup", [{ name: "Doe, Jane" }], {
    trackerDir: tempTrackerDir(),
  });

  assert.equal(result.ok, true);

  const mock = await enqueueMock();
  assert.equal(mock.mock.calls.length, 1);
  const [, queuedInputs, , opts] = mock.mock.calls[0] as [unknown, unknown[], unknown, { parentRunId?: string }];

  assert.equal(queuedInputs.length, 1);
  assert.equal(opts.parentRunId, undefined);
  assert.equal((queuedInputs[0] as { __runtimeOptions?: unknown }).__runtimeOptions, undefined);
});

test("enqueueFromHttp marks multi-value input-run batches as normal batch members", async () => {
  const result = await enqueueFromHttp(
    "eid-lookup",
    [
      { name: "Doe, Jane", __runtimeOptions: { preset: "lookup-only" } },
      { name: "Smith, John" },
    ],
    { trackerDir: tempTrackerDir() },
  );

  assert.equal(result.ok, true);

  const mock = await enqueueMock();
  assert.equal(mock.mock.calls.length, 1);
  const [, queuedInputs, , opts] = mock.mock.calls[0] as [unknown, unknown[], unknown, { parentRunId?: string }];

  assert.equal(queuedInputs.length, 2);
  assert.equal(typeof opts.parentRunId, "string");
  assert.equal((queuedInputs[0] as { __runtimeOptions: Record<string, unknown> }).__runtimeOptions.preset, "lookup-only");
  assert.equal((queuedInputs[0] as { __runtimeOptions: Record<string, unknown> }).__runtimeOptions.rowArchetype, "delegate-child");
  assert.equal((queuedInputs[1] as { __runtimeOptions: Record<string, unknown> }).__runtimeOptions.rowArchetype, "delegate-child");
});
