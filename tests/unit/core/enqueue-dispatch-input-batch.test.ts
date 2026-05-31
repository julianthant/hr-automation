import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, beforeEach, vi } from "vitest";
import assert from "node:assert/strict";

import { enqueueFromHttp } from "../../../src/core/daemon/enqueue-dispatch.js";
import { dateLocal, type TrackerEntry } from "../../../src/tracker/jsonl.js";

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
  const path = join(trackerDir, `${workflow}-${dateLocal()}.jsonl`);
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

test("enqueueFromHttp pre-emits oath-signature multi-EID input runs as batch members", async () => {
  const trackerDir = tempTrackerDir();
  const result = await enqueueFromHttp(
    "oath-signature",
    [
      { kind: "signer", emplId: "10000001" },
      { kind: "signer", emplId: "10000002" },
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
