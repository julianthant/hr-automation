import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

import { enqueueFromHttp } from "../../../src/core/daemon/enqueue-dispatch.js";
import { dateLocal, type TrackerEntry } from "../../../src/tracker/jsonl.js";
import { rowFilePath } from "../../../src/tracker/paths.js";

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

function readRows(trackerDir: string, workflow: string): TrackerEntry[] {
  const path = rowFilePath(workflow, dateLocal(), trackerDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TrackerEntry);
}

beforeEach(async () => {
  (await enqueueMock()).mockClear();
});

test("enqueueFromHttp keeps a single input-run item unparented so it renders as one row", async () => {
  const result = await enqueueFromHttp("person-lookup", [{ name: "Doe, Jane" }], {
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

test("enqueueFromHttp forwards an explicit worker count as { parallel: N } daemon flags", async () => {
  const result = await enqueueFromHttp("person-lookup", [{ name: "Doe, Jane" }], {
    trackerDir: tempTrackerDir(),
    runOptions: { parallelWorkers: 4 },
  });

  assert.equal(result.ok, true);

  const mock = await enqueueMock();
  const [, , flags] = mock.mock.calls[0] as [unknown, unknown, unknown];
  assert.deepEqual(flags, { parallel: 4 });
});

test("enqueueFromHttp passes {} flags for Auto (no runOptions) and for an explicit 1", async () => {
  await enqueueFromHttp("person-lookup", [{ name: "Doe, Jane" }], { trackerDir: tempTrackerDir() });
  await enqueueFromHttp("person-lookup", [{ name: "Roe, Ann" }], {
    trackerDir: tempTrackerDir(),
    runOptions: { parallelWorkers: 1 },
  });

  const mock = await enqueueMock();
  const [, , autoFlags] = mock.mock.calls[0] as [unknown, unknown, unknown];
  const [, , oneFlags] = mock.mock.calls[1] as [unknown, unknown, unknown];
  assert.deepEqual(autoFlags, {}, "Auto → no daemon flags");
  assert.deepEqual(oneFlags, {}, "explicit 1 → no daemon flags (default reuse-or-spawn-one)");
});

test("enqueueFromHttp marks multi-value input-run batches as normal batch members", async () => {
  const result = await enqueueFromHttp(
    "person-lookup",
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
  assert.equal((queuedInputs[0] as { __runtimeOptions: Record<string, unknown> }).__runtimeOptions.rowShape, "batch-member");
  assert.equal((queuedInputs[1] as { __runtimeOptions: Record<string, unknown> }).__runtimeOptions.rowShape, "batch-member");
});

test("enqueueFromHttp pre-emits person-lookup input-run batches as batch members", async () => {
  const trackerDir = tempTrackerDir();
  const result = await enqueueFromHttp(
    "person-lookup",
    [
      { emplId: "10000001" },
      { name: "Doe, Jane" },
    ],
    { trackerDir },
  );

  assert.equal(result.ok, true);

  const mock = await enqueueMock();
  const [, queuedInputs, , opts] = mock.mock.calls[0] as [
    unknown,
    unknown[],
    unknown,
    {
      parentRunId?: string;
      onPreEmitPending: (
        item: unknown,
        runId: string,
        parentRunId: string | undefined,
        itemId: string,
      ) => void;
    },
  ];

  assert.equal(typeof opts.parentRunId, "string");
  opts.onPreEmitPending(queuedInputs[0], "run-1", opts.parentRunId, "10000001");
  opts.onPreEmitPending(queuedInputs[1], "run-2", opts.parentRunId, "Doe, Jane");

  const rows = readRows(trackerDir, "person-lookup");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.parentRunId), [opts.parentRunId, opts.parentRunId]);
  assert.deepEqual(rows.map((row) => row.data?.archetype), ["batch-member", "batch-member"]);
});

test("enqueueFromHttp batches a SINGLE oath-signature EID input run (alwaysBatchInputRun)", async () => {
  // oath-signature is never a standalone single row — even one manual EID is a
  // one-member batch (delegation.alwaysBatchInputRun). person-lookup (the first
  // test) intentionally stays unparented for a single input.
  const trackerDir = tempTrackerDir();
  const result = await enqueueFromHttp("oath-signature", [{ emplId: "10000001" }], { trackerDir });

  assert.equal(result.ok, true);

  const mock = await enqueueMock();
  const [, queuedInputs, , opts] = mock.mock.calls[0] as [
    unknown,
    unknown[],
    unknown,
    {
      parentRunId?: string;
      onPreEmitPending: (
        item: unknown,
        runId: string,
        parentRunId: string | undefined,
        itemId: string,
      ) => void;
    },
  ];

  assert.equal(queuedInputs.length, 1);
  assert.equal(typeof opts.parentRunId, "string", "single oath EID still gets a batch parentRunId");
  assert.equal(
    (queuedInputs[0] as { __runtimeOptions: Record<string, unknown> }).__runtimeOptions.rowShape,
    "batch-member",
  );
  opts.onPreEmitPending(queuedInputs[0], "run-1", opts.parentRunId, "10000001");
  const rows = readRows(trackerDir, "oath-signature");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.parentRunId, opts.parentRunId);
  assert.equal(rows[0]?.data?.archetype, "batch-member");
});

test("enqueueFromHttp pre-emits oath-signature multi-EID input runs as batch members", async () => {
  const trackerDir = tempTrackerDir();
  const result = await enqueueFromHttp(
    "oath-signature",
    [
      { emplId: "10000001" },
      { emplId: "10000002" },
    ],
    { trackerDir },
  );

  assert.equal(result.ok, true);

  const mock = await enqueueMock();
  const [, queuedInputs, , opts] = mock.mock.calls[0] as [
    unknown,
    unknown[],
    unknown,
    {
      parentRunId?: string;
      onPreEmitPending: (
        item: unknown,
        runId: string,
        parentRunId: string | undefined,
        itemId: string,
      ) => void;
    },
  ];

  assert.equal(typeof opts.parentRunId, "string");
  opts.onPreEmitPending(queuedInputs[0], "run-1", opts.parentRunId, "10000001");
  opts.onPreEmitPending(queuedInputs[1], "run-2", opts.parentRunId, "10000002");

  const rows = readRows(trackerDir, "oath-signature");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.parentRunId), [opts.parentRunId, opts.parentRunId]);
  assert.deepEqual(rows.map((row) => row.data?.archetype), ["batch-member", "batch-member"]);
});
