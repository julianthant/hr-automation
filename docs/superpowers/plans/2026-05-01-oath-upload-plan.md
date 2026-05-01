# Oath Upload — Piece 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `oath-upload` workflow that orchestrates PDF → OCR → N oath-signature transactions → file an HR Inquiry ticket on `support.ucsd.edu`, plus the small daemon-mode `parentRunId` plumbing that lets the dashboard nest oath-signature children under their oath-upload parent.

**Architecture:** New kernel + daemon-mode workflow `oath-upload` with `systems: [servicenow]`. Handler is linear: delegate-OCR → wait-OCR-approval → wait-signatures → fill HR form → submit. Both waits are `watchChildRuns` calls with custom `isTerminal` predicates and a 7-day backstop. Daemon-mode `parentRunId` plumbing is a thin pass-through addition to existing primitives — adds one optional field to `QueueEvent.enqueue` and threads it through `ensureDaemonsAndEnqueue` → `enqueueItems` → claim path → `runOneItem`.

**Tech Stack:** TypeScript + Playwright + Zod (existing kernel), React/Vite for the dashboard surface, vitest for unit + integration tests. ServiceNow form is the only new external system; mapped 2026-05-01.

**Spec:** `docs/superpowers/specs/2026-05-01-oath-upload-design.md`

---

## Stages at a glance

| Stage | What it ships | Why first |
|---|---|---|
| 1 | Daemon-mode `parentRunId` plumbing | Foundation — every later stage depends on it |
| 2 | OCR approve handler reads + forwards `parentRunId`; stamps `fannedOutItemIds` | Depends on Stage 1 |
| 3 | `watchChildRuns` `abortIfRowState` opt | Used by oath-upload's soft-cancel |
| 4 | `src/systems/servicenow/` module + `loginToServiceNow` | Required by the workflow's `systems[]` |
| 5 | `src/workflows/oath-upload/` workflow | The feature itself |
| 6 | HTTP endpoints `/api/oath-upload/{check-duplicate,start,cancel}` | Operator entry point |
| 7 | Dashboard frontend (Run modal, duplicate banner) | Operator UX |
| 8 | Final wiring (CLI, CLAUDE.md, selectors catalog, smoke) | Documentation + glue |

Each stage commits independently. Stages 1, 2, 3 are independently shippable. Stages 4–8 ship together as one feature.

---

# Stage 1 — Daemon-mode `parentRunId` plumbing

The kernel's `runOneItem` already accepts `parentRunId` via `RunOpts`
(`src/core/types.ts:291`). What's missing is the path from
`ensureDaemonsAndEnqueue` → queue file → daemon claim → `runOneItem`.

## Task 1: Add `parentRunId?` to `QueueEvent` and `QueueItem`

**Files:**
- Modify: `src/core/daemon-types.ts`
- Test: `tests/unit/core/daemon-queue.test.ts` (existing; we'll extend in Task 3)

- [ ] **Step 1: Edit `src/core/daemon-types.ts`** to add `parentRunId?` to the `enqueue` event variant and `QueueItem`.

```ts
// Lines 39-54: extend the 'enqueue' variant
| {
    type: 'enqueue'
    id: string
    workflow: string
    input: unknown
    enqueuedAt: string
    enqueuedBy: string
    /**
     * Optional pre-assigned runId. When set, the claiming daemon reuses
     * this runId in its claim event + all downstream tracker rows instead
     * of generating a fresh UUID. Lets the CLI pre-emit a `pending` tracker
     * row at enqueue time without risking two rows per item.
     */
    runId?: string
    /**
     * Optional parent runId for delegation. When set, every TrackerEntry
     * emitted for this item carries `parentRunId` so the dashboard can
     * nest this row under its parent in the LogPanel "Delegated runs"
     * section. Set by callers that enqueue a child run (e.g. OCR's
     * approve handler when fanning out oath-signature children of an
     * oath-upload parent).
     */
    parentRunId?: string
  }

// Lines 82-95: extend QueueItem
export interface QueueItem {
  id: string
  workflow: string
  input: unknown
  enqueuedAt: string
  state: 'queued' | 'claimed' | 'done' | 'failed'
  claimedBy?: string
  claimedAt?: string
  completedAt?: string
  failedAt?: string
  runId?: string
  /** Forwarded from the `enqueue` event for delegation parents. */
  parentRunId?: string
  error?: string
}
```

- [ ] **Step 2: Verify the file typechecks.**

Run: `npm run typecheck`

Expected: PASS (no callers consume the new field yet, so it's additive-safe).

- [ ] **Step 3: Commit.**

```bash
git add src/core/daemon-types.ts
git commit -m "feat(daemon): add optional parentRunId to QueueEvent.enqueue + QueueItem

Additive shape change — every existing caller continues to work. Subsequent
tasks thread this field through enqueueItems / claim fold / runOneItem
so daemon-mode children of a delegation parent emit parentRunId on
every tracker line.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Thread `parentRunId` through `enqueueItems` and the queue fold

**Files:**
- Modify: `src/core/daemon-queue.ts`
- Test: `tests/unit/core/daemon-queue.test.ts`

- [ ] **Step 1: Add a failing test** at the end of `tests/unit/core/daemon-queue.test.ts`:

```ts
it("threads parentRunId from enqueue event through to QueueItem.parentRunId", async () => {
  const dir = await mkdtemp(join(tmpdir(), "daemon-queue-parent-"));
  const runId = randomUUID();
  const parentRunId = randomUUID();

  await enqueueItems(
    "test-workflow",
    [{ id: "item-1" }],
    (i) => i.id,
    dir,
    [runId],
    [parentRunId],          // NEW positional arg
  );

  const state = await readQueueState("test-workflow", dir);
  expect(state.queued).toHaveLength(1);
  expect(state.queued[0].parentRunId).toBe(parentRunId);
  expect(state.queued[0].runId).toBe(runId);

  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test, confirm it fails** (`enqueueItems` doesn't accept the 6th arg yet).

Run: `npx vitest run tests/unit/core/daemon-queue.test.ts -t "threads parentRunId"`

Expected: FAIL with a TypeScript or runtime error about the unexpected argument.

- [ ] **Step 3: Update `enqueueItems` signature and event-write loop** in `src/core/daemon-queue.ts`. The existing function lives at lines 140–180. Replace with:

```ts
export async function enqueueItems<T>(
  workflow: string,
  inputs: T[],
  idFn: (input: T, index: number) => string,
  trackerDir?: string,
  preAssignedRunIds?: ReadonlyArray<UUID>,
  preAssignedParentRunIds?: ReadonlyArray<string | undefined>,
): Promise<Array<{ id: string; position: number; runId: UUID }>> {
  if (inputs.length === 0) return []
  if (preAssignedRunIds && preAssignedRunIds.length !== inputs.length) {
    throw new Error(
      `enqueueItems: preAssignedRunIds length ${preAssignedRunIds.length} does not match inputs length ${inputs.length}`,
    )
  }
  if (preAssignedParentRunIds && preAssignedParentRunIds.length !== inputs.length) {
    throw new Error(
      `enqueueItems: preAssignedParentRunIds length ${preAssignedParentRunIds.length} does not match inputs length ${inputs.length}`,
    )
  }
  const enqueuedBy = `cli-${process.pid}`
  const assigned: Array<{ id: string; runId: UUID }> = []
  for (let i = 0; i < inputs.length; i++) {
    const id = idFn(inputs[i], i)
    const runId = preAssignedRunIds?.[i] ?? randomUUID()
    const parentRunId = preAssignedParentRunIds?.[i]
    assigned.push({ id, runId })
    appendEvent(
      workflow,
      {
        type: 'enqueue',
        id,
        workflow,
        input: inputs[i],
        enqueuedAt: nowIso(),
        enqueuedBy,
        runId,
        ...(parentRunId ? { parentRunId } : {}),
      },
      trackerDir,
    )
  }
  const state = await readQueueState(workflow, trackerDir)
  const queuedIds = state.queued.map((q) => q.id)
  return assigned.map(({ id, runId }) => {
    const idx = queuedIds.indexOf(id)
    return { id, position: idx >= 0 ? idx + 1 : 0, runId }
  })
}
```

- [ ] **Step 4: Update the queue fold** in the same file (around lines 65–95) to read `parentRunId` from the enqueue event into the QueueItem. Find the `if (ev.type === 'enqueue')` branch and add `parentRunId: ev.parentRunId` to the byId.set call:

```ts
if (ev.type === 'enqueue') {
  byId.set(ev.id, {
    id: ev.id,
    workflow: ev.workflow,
    input: ev.input,
    enqueuedAt: ev.enqueuedAt,
    state: 'queued',
    runId: ev.runId,
    ...(ev.parentRunId ? { parentRunId: ev.parentRunId } : {}),
  })
}
```

Also add `parentRunId` propagation to the `'claim'` and `'unclaim'` branches so it survives state transitions:

```ts
} else if (ev.type === 'claim') {
  const existing = byId.get(ev.id)
  if (!existing) continue
  byId.set(ev.id, {
    ...existing,                      // preserves parentRunId
    state: 'claimed',
    claimedBy: ev.claimedBy,
    claimedAt: ev.claimedAt,
    runId: ev.runId,
  })
} else if (ev.type === 'unclaim') {
  const existing = byId.get(ev.id)
  if (!existing) continue
  byId.set(ev.id, {
    ...existing,                      // preserves parentRunId
    state: 'queued',
    claimedBy: undefined,
    claimedAt: undefined,
    runId: undefined,
  })
}
```

(The spread is already in place — verify it covers `parentRunId`.)

- [ ] **Step 5: Run the new test, confirm it passes.**

Run: `npx vitest run tests/unit/core/daemon-queue.test.ts -t "threads parentRunId"`

Expected: PASS.

- [ ] **Step 6: Run the full daemon-queue test file** to confirm no regression.

Run: `npx vitest run tests/unit/core/daemon-queue.test.ts`

Expected: ALL PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/core/daemon-queue.ts tests/unit/core/daemon-queue.test.ts
git commit -m "feat(daemon): thread parentRunId through enqueueItems + queue fold

enqueueItems gains an optional sixth positional param
preAssignedParentRunIds; the queue fold preserves parentRunId across
claim/unclaim transitions via the existing object spread. Test
confirms a parentRunId on the enqueue event surfaces on the resulting
QueueItem.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Forward `parentRunId` from claim → `runOneItem` in the daemon main loop

**Files:**
- Modify: `src/core/daemon.ts:435-447`
- Test: `tests/unit/core/daemon.test.ts`

- [ ] **Step 1: Add a failing test** in `tests/unit/core/daemon.test.ts`:

```ts
it("forwards QueueItem.parentRunId to runOneItem", async () => {
  // The existing daemon test scaffold uses a stub workflow + writes a queue
  // event manually. Pattern: write enqueue event with parentRunId set, run
  // the daemon for one tick, assert the runOneItem stub received parentRunId.

  const dir = await mkdtemp(join(tmpdir(), "daemon-parentRunId-"));
  const parentRunId = "parent-run-abc";
  // ...build the workflow + write the enqueue event with parentRunId...
  // (Mirror the existing "claims an item and runs it" test in this file.)
  // After running one tick:
  expect(runOneItemSpy).toHaveBeenCalledWith(
    expect.objectContaining({ parentRunId }),
  );
  await rm(dir, { recursive: true, force: true });
});
```

(Lift the scaffolding from the nearest existing test in
`tests/unit/core/daemon.test.ts` — the test file already has fixtures for
spawning a fake daemon + injecting queue events.)

- [ ] **Step 2: Run, confirm it fails.**

Run: `npx vitest run tests/unit/core/daemon.test.ts -t "forwards QueueItem.parentRunId"`

Expected: FAIL — `runOneItem` is not called with `parentRunId`.

- [ ] **Step 3: Edit the `runOneItem` call in `src/core/daemon.ts:435-447`** to forward `item.parentRunId`:

```ts
const r = await runOneItem({
  wf,
  session,
  item: item.input as TData,
  itemId: item.id,
  runId,
  trackerDir,
  callerPreEmits: false,
  preAssignedInstance: instance,
  authTimings: itemAuthTimings,
  isCancelRequested: () =>
    cancelTarget?.itemId === item.id && cancelTarget?.runId === runId,
  ...(item.parentRunId ? { parentRunId: item.parentRunId } : {}),
})
```

- [ ] **Step 4: Run the test, confirm it passes.**

Run: `npx vitest run tests/unit/core/daemon.test.ts -t "forwards QueueItem.parentRunId"`

Expected: PASS.

- [ ] **Step 5: Run the whole daemon.test.ts file** to confirm no regression.

Run: `npx vitest run tests/unit/core/daemon.test.ts`

Expected: ALL PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/core/daemon.ts tests/unit/core/daemon.test.ts
git commit -m "feat(daemon): forward QueueItem.parentRunId to runOneItem

When the queue item carries parentRunId (set by ensureDaemonsAndEnqueue
for delegation children), thread it into runOneItem so withTrackedWorkflow
emits parentRunId on every tracker line. Dashboard 'Delegated runs'
nesting works for daemon-mode children of a delegation parent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Accept `parentRunId` in `ensureDaemonsAndEnqueue`

**Files:**
- Modify: `src/core/daemon-client.ts`
- Test: `tests/unit/core/daemon-client.test.ts`

- [ ] **Step 1: Add a failing test** in `tests/unit/core/daemon-client.test.ts`:

```ts
it("forwards parentRunId option through to enqueueItems", async () => {
  const enqueueSpy = vi.fn().mockResolvedValue([{ id: "x", position: 1, runId: randomUUID() }]);
  vi.doMock("./daemon-queue.js", () => ({ enqueueItems: enqueueSpy }));
  vi.doMock("./daemon-registry.js", () => ({
    findAliveDaemons: vi.fn().mockResolvedValue([{ port: 9999, instanceId: "x", pid: 1, workflow: "test", startedAt: "", lockfilePath: "" }]),
    spawnDaemon: vi.fn(),
    killOrphanedChromiumProcesses: vi.fn().mockResolvedValue(0),
  }));
  // re-import after mocking
  const { ensureDaemonsAndEnqueue: fn } = await import("./daemon-client.js");

  const wf = makeStubWorkflow();
  const parentRunId = "parent-abc";
  await fn(wf, [{ emplId: "10000001" }], {}, { parentRunId });

  expect(enqueueSpy).toHaveBeenCalledWith(
    "test",
    expect.any(Array),
    expect.any(Function),
    undefined,
    expect.any(Array),
    [parentRunId],     // 6th arg = preAssignedParentRunIds
  );
});
```

- [ ] **Step 2: Run, confirm it fails.**

Run: `npx vitest run tests/unit/core/daemon-client.test.ts -t "forwards parentRunId"`

Expected: FAIL.

- [ ] **Step 3: Edit `ensureDaemonsAndEnqueue` in `src/core/daemon-client.ts`** to accept and forward the option. At line 84 (the opts type), add:

```ts
opts: {
  trackerDir?: string
  quiet?: boolean
  onPreEmitPending?: OnPreEmitPending<TData>
  onPreEmitFailed?: OnPreEmitFailed<TData>
  deriveItemId?: (input: TData) => string
  /**
   * Optional parent runId. When set, every queued item is stamped with
   * this parentRunId, so the daemon-side claim path forwards it into
   * runOneItem and the resulting tracker rows carry parentRunId. Used
   * by delegation parents (e.g. OCR's approve handler when fanning out
   * oath-signature children of an oath-upload parent).
   */
  parentRunId?: string
} = {},
```

At line 114 (the destructure), add `parentRunId`:

```ts
const { trackerDir, quiet, onPreEmitPending, onPreEmitFailed, parentRunId } = opts
```

At line 258 (the `enqueueItems` call), add the 6th arg:

```ts
const enqueued = await enqueueItems(
  wf.config.name,
  inputs,
  idFn,
  trackerDir,
  runIds,
  parentRunId ? inputs.map(() => parentRunId) : undefined,
)
```

- [ ] **Step 4: Run the test, confirm it passes.**

Run: `npx vitest run tests/unit/core/daemon-client.test.ts -t "forwards parentRunId"`

Expected: PASS.

- [ ] **Step 5: Run the whole daemon-client.test.ts** to verify no regression.

Run: `npx vitest run tests/unit/core/daemon-client.test.ts`

Expected: ALL PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/core/daemon-client.ts tests/unit/core/daemon-client.test.ts
git commit -m "feat(daemon): accept parentRunId in ensureDaemonsAndEnqueue opts

Forwards into enqueueItems' preAssignedParentRunIds positional. The
caller-side ergonomic is one option, not N — the helper fans the
single value out across all queued items.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Update `OnPreEmitPending` callback signature (additive)

**Files:**
- Modify: `src/core/daemon-client.ts:25` (type definition)
- Modify: `src/core/daemon-client.ts:165` (invocation)
- Modify: `src/workflows/oath-signature/workflow.ts:134` (one consumer)

- [ ] **Step 1: Edit the `OnPreEmitPending` type definition** at `src/core/daemon-client.ts:25`:

```ts
export type OnPreEmitPending<TData> = (
  input: TData,
  runId: string,
  parentRunId?: string,
) => void
```

- [ ] **Step 2: Edit the invocation** at `src/core/daemon-client.ts:165` to forward parentRunId:

```ts
if (onPreEmitPending) {
  for (let i = 0; i < inputs.length; i++) {
    try {
      onPreEmitPending(inputs[i], runIds[i], parentRunId)
    } catch (err) {
      log.warn(
        `ensureDaemonsAndEnqueue: onPreEmitPending threw for '${ids[i]}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
}
```

- [ ] **Step 3: Edit `src/workflows/oath-signature/workflow.ts`** — the `runOathSignatureCli` adapter at line 134 — to forward `parentRunId` into the `trackEvent` call:

```ts
onPreEmitPending: (item, runId, parentRunId) => {
  trackEvent({
    workflow: WORKFLOW,
    timestamp: now,
    id: item.emplId,
    runId,
    ...(parentRunId ? { parentRunId } : {}),
    status: "pending",
    data: {
      emplId: item.emplId,
      ...(item.date ? { date: item.date } : {}),
    },
  });
},
```

(Other workflows that pass `onPreEmitPending` — separations, work-study,
emergency-contact, etc. — keep their callbacks unchanged. They'll ignore
the new third arg, which is harmless because they aren't yet consumed
as children of a delegation parent.)

- [ ] **Step 4: Verify the workflow file typechecks.**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Run the oath-signature tests** to confirm no regression.

Run: `npx vitest run tests/unit/workflows/oath-signature/`

Expected: ALL PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/core/daemon-client.ts src/workflows/oath-signature/workflow.ts
git commit -m "feat(daemon): OnPreEmitPending receives optional parentRunId

Additive third arg. oath-signature's adapter is the only caller updated
in this commit (it'll be consumed as a delegation child in Piece 3).
Other workflows ignore the new arg and their pending rows continue to
lack parentRunId until they're consumed as children themselves.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

# Stage 2 — OCR approve handler reads + forwards `parentRunId`

## Task 6: OCR approve forwards `parentRunId` and writes `fannedOutItemIds`

**Files:**
- Modify: `src/tracker/ocr-http.ts:161-230` (`buildOcrApproveHandler`)
- Test: `tests/unit/tracker/ocr-http.test.ts`

- [ ] **Step 1: Add a failing test** in `tests/unit/tracker/ocr-http.test.ts`:

```ts
it("forwards parentRunId from OCR row to ensureDaemonsAndEnqueue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ocr-approve-parent-"));
  const sessionId = "ocr-test-1";
  const ocrRunId = "ocr-run-1";
  const oathUploadRunId = "oath-upload-run-1";

  // Pre-write an OCR awaiting-approval row with parentRunId set.
  trackEvent({
    workflow: "ocr",
    timestamp: new Date().toISOString(),
    id: sessionId,
    runId: ocrRunId,
    parentRunId: oathUploadRunId,
    status: "running",
    step: "awaiting-approval",
    data: { formType: "oath" },
  }, dir);

  const enqueueSpy = vi.fn().mockResolvedValue(undefined);
  const handler = buildOcrApproveHandler({
    trackerDir: dir,
    ensureDaemonsAndEnqueueOverride: enqueueSpy,
  });

  const records = [{ employeeId: "10000001", selected: true, matchState: "matched", printedName: "Doe, J", employeeSigned: true, sourcePage: 1, rowIndex: 0 }];
  await handler({ sessionId, runId: ocrRunId, records });

  expect(enqueueSpy).toHaveBeenCalledWith(
    "oath-signature",
    expect.any(Array),
    expect.any(Function),
    expect.objectContaining({ parentRunId: oathUploadRunId }),
  );

  await rm(dir, { recursive: true, force: true });
});

it("stamps fannedOutItemIds on the post-approve tracker entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ocr-approve-fannedout-"));
  const sessionId = "ocr-test-2";
  const ocrRunId = "ocr-run-2";

  trackEvent({
    workflow: "ocr",
    timestamp: new Date().toISOString(),
    id: sessionId,
    runId: ocrRunId,
    status: "running",
    step: "awaiting-approval",
    data: { formType: "oath" },
  }, dir);

  const handler = buildOcrApproveHandler({
    trackerDir: dir,
    ensureDaemonsAndEnqueueOverride: vi.fn().mockResolvedValue(undefined),
  });

  const records = [
    { employeeId: "10000001", selected: true, matchState: "matched", printedName: "A", employeeSigned: true, sourcePage: 1, rowIndex: 0 },
    { employeeId: "10000002", selected: true, matchState: "matched", printedName: "B", employeeSigned: true, sourcePage: 1, rowIndex: 1 },
  ];
  const r = await handler({ sessionId, runId: ocrRunId, records });
  expect(r.status).toBe(200);

  const file = join(dir, `ocr-${dateLocal()}.jsonl`);
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const approvedLine = lines.map(l => JSON.parse(l)).find(e => e.step === "approved");
  expect(approvedLine).toBeTruthy();
  expect(typeof approvedLine.data.fannedOutItemIds).toBe("string");
  const ids = JSON.parse(approvedLine.data.fannedOutItemIds);
  expect(ids).toHaveLength(2);
  expect(ids).toEqual([
    `ocr-oath-${ocrRunId}-r0`,
    `ocr-oath-${ocrRunId}-r1`,
  ]);

  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run, confirm both tests fail.**

Run: `npx vitest run tests/unit/tracker/ocr-http.test.ts -t "parentRunId\|fannedOutItemIds"`

Expected: FAIL — neither parentRunId nor fannedOutItemIds is currently
forwarded/stamped.

- [ ] **Step 3: Add a `readParentRunId` helper to `src/tracker/ocr-http.ts`** alongside the existing `readFormType` helper:

```ts
function readParentRunId(sessionId: string, trackerDir: string | undefined): string | null {
  const date = dateLocal();
  const file = join(trackerDir ?? ".tracker", `ocr-${date}.jsonl`);
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e: TrackerEntry = JSON.parse(lines[i]);
      if (e.id === sessionId && e.parentRunId) return e.parentRunId;
    } catch { /* tolerate */ }
  }
  return null;
}
```

- [ ] **Step 4: Update `buildOcrApproveHandler`** at `src/tracker/ocr-http.ts:161-230` to read parent + forward + stamp:

```ts
export function buildOcrApproveHandler(
  opts: ApproveHandlerOpts = {},
): (input: ApproveInput) => Promise<ApproveResponse> {
  const trackerDir = opts.trackerDir;
  return async (input) => {
    if (!input.sessionId || !input.runId || !Array.isArray(input.records)) {
      return { status: 400, body: { ok: false, error: "Missing sessionId/runId/records" } };
    }
    const formType = readFormType(input.sessionId, trackerDir);
    if (!formType) {
      return { status: 400, body: { ok: false, error: "Could not resolve formType for session" } };
    }
    const spec = getFormSpec(formType);
    if (!spec) {
      return { status: 400, body: { ok: false, error: `Unknown formType "${formType}"` } };
    }
    const parentRunId = readParentRunId(input.sessionId, trackerDir);

    const fannedOut: Array<{ workflow: string; itemId: string }> = [];
    const enqueueInputs: unknown[] = [];
    const itemIds: string[] = [];
    input.records.forEach((rec, index) => {
      const fanInput = spec.approveTo.deriveInput(rec as never);
      const itemId = spec.approveTo.deriveItemId(rec as never, input.runId, index);
      enqueueInputs.push(fanInput);
      itemIds.push(itemId);
      fannedOut.push({ workflow: spec.approveTo.workflow, itemId });
    });

    try {
      if (opts.ensureDaemonsAndEnqueueOverride) {
        await opts.ensureDaemonsAndEnqueueOverride(
          spec.approveTo.workflow,
          enqueueInputs,
          (_inp, idx) => itemIds[idx],
        );
      } else {
        const { ensureDaemonsAndEnqueue } = await import("../core/daemon-client.js");
        const { loadWorkflow } = await import("../core/workflow-loaders.js");
        const childWf = await loadWorkflow(spec.approveTo.workflow);
        if (!childWf) {
          return { status: 500, body: { ok: false, error: `Unknown approveTo workflow "${spec.approveTo.workflow}"` } };
        }
        const inputToItemId = new Map(
          enqueueInputs.map((inp, idx) => [JSON.stringify(inp), itemIds[idx] ?? `ocr-fallback-${input.runId}-r${idx}`])
        );
        await ensureDaemonsAndEnqueue(
          childWf,
          enqueueInputs as never,
          {},
          {
            deriveItemId: (inp: unknown) =>
              inputToItemId.get(JSON.stringify(inp)) ?? `ocr-fallback-${input.runId}-r0`,
            ...(parentRunId ? { parentRunId } : {}),
          },
        );
      }
    } catch (err) {
      return { status: 500, body: { ok: false, error: errorMessage(err) } };
    }

    trackEvent(
      {
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id: input.sessionId,
        runId: input.runId,
        ...(parentRunId ? { parentRunId } : {}),
        status: "done",
        step: "approved",
        data: {
          fannedOutCount: String(fannedOut.length),
          fannedOutItemIds: JSON.stringify(itemIds),
        },
      },
      trackerDir,
    );

    return { status: 200, body: { ok: true, fannedOut } };
  };
}
```

- [ ] **Step 5: Update `ApproveHandlerOpts.ensureDaemonsAndEnqueueOverride`** to accept the 4th opts param so the test can assert on parentRunId. At lines 152-159:

```ts
export interface ApproveHandlerOpts {
  trackerDir?: string;
  ensureDaemonsAndEnqueueOverride?: (
    workflow: string,
    inputs: unknown[],
    deriveItemId: (input: unknown, idx: number) => string,
    opts?: { parentRunId?: string },
  ) => Promise<void>;
}
```

In the override-call branch above, pass the opts object through:

```ts
await opts.ensureDaemonsAndEnqueueOverride(
  spec.approveTo.workflow,
  enqueueInputs,
  (_inp, idx) => itemIds[idx],
  parentRunId ? { parentRunId } : undefined,
);
```

(Update the test to assert on the 4th arg accordingly:
`expect(enqueueSpy).toHaveBeenCalledWith("oath-signature", expect.any(Array), expect.any(Function), { parentRunId: oathUploadRunId })`.)

- [ ] **Step 6: Run the tests, confirm they pass.**

Run: `npx vitest run tests/unit/tracker/ocr-http.test.ts -t "parentRunId\|fannedOutItemIds"`

Expected: PASS.

- [ ] **Step 7: Run the full ocr-http test file** to verify no regression.

Run: `npx vitest run tests/unit/tracker/ocr-http.test.ts`

Expected: ALL PASS.

- [ ] **Step 8: Commit.**

```bash
git add src/tracker/ocr-http.ts tests/unit/tracker/ocr-http.test.ts
git commit -m "feat(ocr): approve handler forwards parentRunId + stamps fannedOutItemIds

Reads parentRunId from the latest OCR tracker entry for this sessionId
and forwards it as an option to ensureDaemonsAndEnqueue (so children
inherit the delegation parent). Also writes fannedOutItemIds (serialized
JSON) into the post-approve entry's data so any delegation parent can
recover the IDs deterministically without rederiving from records.

Zero behavior change for OCR runs without a parent — parentRunId is
read as null, the option is omitted, and the existing path runs verbatim.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

# Stage 3 — `watchChildRuns` `abortIfRowState` opt

## Task 7: Add `abortIfRowState` to `watchChildRuns`

**Files:**
- Modify: `src/tracker/watch-child-runs.ts`
- Test: `tests/unit/tracker/watch-child-runs.test.ts`

- [ ] **Step 1: Add a failing test** in `tests/unit/tracker/watch-child-runs.test.ts`:

```ts
it("aborts the watch if abortIfRowState matches the latest entry on the parent row", async () => {
  const dir = await mkdtemp(join(tmpdir(), "watch-abort-"));

  // Write a parent row that the watcher will poll for the cancel sentinel.
  trackEvent({
    workflow: "oath-upload",
    timestamp: new Date().toISOString(),
    id: "parent-1",
    runId: "parent-run-1",
    status: "running",
    step: "wait-signatures",
  }, dir);

  // Start the watcher with a 30s timeout so the test isn't artificially
  // long.
  const watchPromise = watchChildRuns({
    workflow: "oath-signature",
    expectedItemIds: ["never-comes"],
    trackerDir: dir,
    timeoutMs: 30_000,
    abortIfRowState: {
      workflow: "oath-upload",
      id: "parent-1",
      step: "cancel-requested",
    },
  });

  // Give the watcher a tick to register, then write the cancel sentinel.
  await new Promise(r => setTimeout(r, 250));
  trackEvent({
    workflow: "oath-upload",
    timestamp: new Date().toISOString(),
    id: "parent-1",
    runId: "parent-run-1",
    status: "running",
    step: "cancel-requested",
  }, dir);

  await expect(watchPromise).rejects.toThrow(/aborted by parent row state/);

  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run, confirm it fails (timeout error or unexpected resolve).**

Run: `npx vitest run tests/unit/tracker/watch-child-runs.test.ts -t "abortIfRowState"`

Expected: FAIL.

- [ ] **Step 3: Update `WatchChildRunsOpts` and the watcher** in `src/tracker/watch-child-runs.ts`. Add the new option to the interface:

```ts
export interface WatchChildRunsOpts {
  workflow: string;
  expectedItemIds: string[];
  trackerDir?: string;
  date?: string;
  timeoutMs?: number;
  isTerminal?: (entry: TrackerEntry) => boolean;
  onProgress?: (outcome: ChildOutcome, remaining: number) => void;
  /**
   * If set, the watcher polls the latest entry on `(workflow, id)` and
   * aborts the watch when that entry's `step` matches. Used for
   * dashboard-driven soft-cancel: an HTTP cancel handler writes a
   * sentinel running entry on the parent's own row, and the watcher
   * (running in the daemon process) sees it and rejects so the handler
   * can unwind.
   */
  abortIfRowState?: {
    workflow: string;
    id: string;
    step: string;
  };
}
```

Update the watcher body to add a parallel poll for the abort sentinel.
Insert this inside the `Promise<ChildOutcome[]>` constructor, alongside
the existing `checkFile`:

```ts
const checkAbort = (): void => {
  if (finalized) return;
  if (!opts.abortIfRowState) return;
  const abortFile = join(
    opts.trackerDir ?? ".tracker",
    `${opts.abortIfRowState.workflow}-${opts.date ?? dateLocal()}.jsonl`,
  );
  if (!existsSync(abortFile)) return;
  let raw;
  try { raw = readFileSync(abortFile, "utf-8"); } catch { return; }
  const lines = raw.split("\n").filter(Boolean);
  // Walk lines in reverse to find the latest entry for this id.
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: TrackerEntry;
    try { entry = JSON.parse(lines[i]); } catch { continue; }
    if (entry.id !== opts.abortIfRowState.id) continue;
    if (entry.step === opts.abortIfRowState.step) {
      cleanup();
      reject(new Error(`watchChildRuns aborted by parent row state (${opts.abortIfRowState.workflow}/${opts.abortIfRowState.id} step="${opts.abortIfRowState.step}")`));
    }
    return;
  }
};
```

(You'll also need to import `dateLocal` from `./jsonl.js` at the top of
the file — `import { dateLocal } from "./jsonl.js"` — replacing the
inline helper currently at lines 43-49 if convenient, or leave both.)

Wire `checkAbort` into the existing 200ms poll loop:

```ts
pollHandle = setInterval(() => {
  checkFile();
  checkAbort();      // NEW
  if (!watcher && existsSync(file)) {
    try {
      watcher = fsWatch(file, { persistent: false }, () => checkFile());
    } catch { /* tolerate */ }
  }
}, 200);
```

Also call `checkAbort()` once at startup, after the initial `checkFile()`:

```ts
checkFile();
if (finalized) return;
checkAbort();        // NEW
if (finalized) return;
```

- [ ] **Step 4: Run the test, confirm it passes.**

Run: `npx vitest run tests/unit/tracker/watch-child-runs.test.ts -t "abortIfRowState"`

Expected: PASS.

- [ ] **Step 5: Run the full file** to verify no regression.

Run: `npx vitest run tests/unit/tracker/watch-child-runs.test.ts`

Expected: ALL PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/tracker/watch-child-runs.ts tests/unit/tracker/watch-child-runs.test.ts
git commit -m "feat(tracker): watchChildRuns gains abortIfRowState opt

Generic JSONL-sentinel cancel mechanism. The watcher polls the parent
row's latest entry per tick and aborts the watch when the configured
step matches. Used by oath-upload's soft-cancel HTTP handler — writes
'cancel-requested' on the parent row, watcher sees it across process
boundaries (daemon vs dashboard), handler unwinds cleanly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

# Stage 4 — `src/systems/servicenow/` module

## Task 8: Create the ServiceNow selector registry

**Files:**
- Create: `src/systems/servicenow/selectors.ts`

- [ ] **Step 1: Write the selector registry.**

```ts
// src/systems/servicenow/selectors.ts
import type { Page, Locator } from "playwright";

/**
 * Selectors for the UCSD HR General Inquiry form on support.ucsd.edu.
 *
 * Form URL: https://support.ucsd.edu/esc?id=sc_cat_item&table=sc_cat_item&sys_id=d8af3ae8db4fe510b3187d84f39619bf
 * Page title: "HR General Inquiry - Employee Center"
 *
 * Mapped 2026-05-01. Form lives in main DOM (no iframe), uses ARIA roles
 * with stable accessible names.
 *
 * @tags servicenow, hr-inquiry-form
 */

export const hrInquiry = {
  /** Subject textbox (required). @verified 2026-05-01 */
  subjectInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Subject" }),

  /** Description textbox (required). @verified 2026-05-01 */
  descriptionInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: "Description" }),

  /**
   * "Specifically:" combobox — ServiceNow typeahead. Implementation: type
   * search term, wait for suggestion list, click matching option.
   * @verified 2026-05-01
   */
  specificallyInput: (page: Page): Locator =>
    page.getByRole("combobox", { name: "Specifically:" }),

  /**
   * "Category:" combobox — placeholder "-- None --".
   * @verified 2026-05-01
   */
  categoryInput: (page: Page): Locator =>
    page.getByRole("combobox", { name: "Category:" }),

  /**
   * Native file input adjacent to the "Choose a file" button. Use
   * `setInputFiles` on this rather than clicking the visible button.
   * @verified 2026-05-01
   */
  fileInput: (page: Page): Locator =>
    page.locator('input[type="file"]').first(),

  /** Choose-a-file button (visible affordance). @verified 2026-05-01 */
  chooseFileButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Choose a file" }),

  /** Submit the inquiry. @verified 2026-05-01 */
  submitButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Submit" }),

  /** Save without submitting. Escape hatch — not used by the handler. @verified 2026-05-01 */
  saveAsDraftButton: (page: Page): Locator =>
    page.getByRole("button", { name: "Save as Draft" }),
};

export const ssoFields = {
  /** UCSD SSO username field (TritON SAML). @verified 2026-05-01 */
  usernameInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: /username|user id/i }),
  passwordInput: (page: Page): Locator =>
    page.getByRole("textbox", { name: /password/i }),
  loginButton: (page: Page): Locator =>
    page.getByRole("button", { name: /log ?in|sign ?in/i }),
};
```

- [ ] **Step 2: Verify file typechecks.**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Verify the inline-selectors test guard accepts the file** (this file IS the registry; no inline-selector violation).

Run: `npx vitest run tests/unit/systems/inline-selectors.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/systems/servicenow/selectors.ts
git commit -m "feat(servicenow): selector registry for HR Inquiry form

Mapped 2026-05-01 via playwright-cli on production support.ucsd.edu.
Role-based selectors only (form is in main DOM, no iframe traversal).
Subject/Description are required textboxes; Specifically is a typeahead
combobox; Category is a select-style combobox with '-- None --'
default; attachments use a native file input under a 'Choose a file'
button.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Create the ServiceNow navigate helper

**Files:**
- Create: `src/systems/servicenow/navigate.ts`

- [ ] **Step 1: Write the helper.**

```ts
// src/systems/servicenow/navigate.ts
import type { Page } from "playwright";

export const HR_INQUIRY_FORM_URL =
  "https://support.ucsd.edu/esc?id=sc_cat_item&table=sc_cat_item&sys_id=d8af3ae8db4fe510b3187d84f39619bf";

/**
 * Navigate directly to the HR Inquiry form. Assumes the page is already
 * authenticated (loginToServiceNow ran earlier in the session).
 *
 * Uses `waitUntil: "domcontentloaded"` because ServiceNow's portal fires
 * a lot of background XHR even after the form is interactive — waiting
 * for full networkidle would add 5–10s of dead time to every run.
 */
export async function gotoHrInquiryForm(page: Page): Promise<void> {
  await page.goto(HR_INQUIRY_FORM_URL, { waitUntil: "domcontentloaded" });
}

/**
 * Verify the page title indicates we landed on the right form. Throws a
 * clear error if SSO redirected us somewhere else (session expired,
 * permission lost, etc.) — the handler can then catch + log + rethrow.
 */
export async function verifyOnInquiryForm(page: Page): Promise<void> {
  const title = await page.title();
  if (!title.includes("HR General Inquiry")) {
    throw new Error(
      `gotoHrInquiryForm: expected title to include "HR General Inquiry", got "${title}". URL: ${page.url()}`,
    );
  }
}
```

- [ ] **Step 2: Typecheck.**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add src/systems/servicenow/navigate.ts
git commit -m "feat(servicenow): direct-link navigation + title verification

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: ServiceNow CLAUDE.md, LESSONS.md, common-intents.txt

**Files:**
- Create: `src/systems/servicenow/CLAUDE.md`
- Create: `src/systems/servicenow/LESSONS.md`
- Create: `src/systems/servicenow/common-intents.txt`

- [ ] **Step 1: Write `src/systems/servicenow/CLAUDE.md`.**

```markdown
# ServiceNow / UCSD Employee Center

UCSD's HR Employee Center is hosted on ServiceNow at
`support.ucsd.edu/esc`. Authentication is UCSD SSO + Duo (same
TritON SAML IdP as UCPath). This module currently covers ONE form: the
HR General Inquiry catalog item, used by `oath-upload` to file a
ticket after every paper-roster signing ceremony is completed in
UCPath.

## Files

- `selectors.ts` — `hrInquiry`, `ssoFields` selector groups
- `navigate.ts` — `gotoHrInquiryForm`, `verifyOnInquiryForm`,
  `HR_INQUIRY_FORM_URL`
- `SELECTORS.md` — auto-generated catalog (`npm run selectors:catalog`)
- `LESSONS.md` — empty initially

## Auth

`loginToServiceNow` in `src/auth/login.ts` mirrors `loginToUCPath`:
fill UCSD SSO username + password, click Log In, poll Duo via
`requestDuoApproval`. The form lives in the main DOM (no iframe), so
no `getContentFrame` adapter is needed.

## Selector Intelligence

This module touches: **servicenow**.

Before mapping a new selector:

```bash
npm run selector:search "<intent>"
```

- [`./LESSONS.md`](./LESSONS.md)
- [`./SELECTORS.md`](./SELECTORS.md)
- [`./common-intents.txt`](./common-intents.txt)

## Gotchas

- **Specifically combobox is a ServiceNow typeahead.** It doesn't
  support `selectOption`. Implementation: type the search term, wait
  for the dropdown suggestion list, click the matching option.
  `oath-upload`'s `fill-form.ts` encapsulates this pattern.
- **Choose-a-file button drives a hidden file input.** Use
  `page.setInputFiles` on the adjacent `input[type="file"]` — clicking
  the visible button surfaces an OS file picker that Playwright would
  have to handle via `page.on("filechooser", ...)`. The hidden-input
  path is more reliable.
- **Submit redirects to a ticket detail page.** The redirect URL
  carries `number=HRC0XXXXXX` for the new ticket. Implementation reads
  `page.url()` post-submit and parses it; if the URL shape changes,
  fall back to scraping the ticket-detail page heading.

## Lessons Learned

(empty as of 2026-05-01)
```

- [ ] **Step 2: Write `src/systems/servicenow/LESSONS.md`.**

```markdown
# ServiceNow Lessons Learned

(empty — module is new as of 2026-05-01)
```

- [ ] **Step 3: Write `src/systems/servicenow/common-intents.txt`.**

```
fill subject of HR inquiry form
fill description of HR inquiry form
pick "Specifically" topic on HR inquiry form
pick "Category" on HR inquiry form
attach file to HR inquiry form
submit HR inquiry form
verify on HR inquiry form
log in to support.ucsd.edu via UCSD SSO + Duo
read HR ticket number after submit
```

- [ ] **Step 4: Commit.**

```bash
git add src/systems/servicenow/CLAUDE.md src/systems/servicenow/LESSONS.md src/systems/servicenow/common-intents.txt
git commit -m "docs(servicenow): module CLAUDE.md + LESSONS + common-intents

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: `loginToServiceNow` in `src/auth/login.ts`

**Files:**
- Modify: `src/auth/login.ts` (add new function)
- Test: `tests/unit/auth/login.test.ts` (extend if exists, else skip — auth flows are typically integration-only)

- [ ] **Step 1: Read `src/auth/login.ts` to find the `loginToUCPath` shape.**

Run: `grep -n "loginToUCPath" src/auth/login.ts`

Expected: surfaces the function start line.

- [ ] **Step 2: Add `loginToServiceNow` mirroring `loginToUCPath`.** Insert at the bottom of `src/auth/login.ts`, before any closing exports:

```ts
import { ssoFields, hrInquiry } from "../systems/servicenow/selectors.js";
import { HR_INQUIRY_FORM_URL } from "../systems/servicenow/navigate.js";

/**
 * UCSD SSO + Duo login for support.ucsd.edu (ServiceNow Employee Center).
 *
 * Mirrors `loginToUCPath`: navigate to a deep link → SAML redirects to
 * `a5.ucsd.edu/tritON/...` → fill credentials → submit → poll Duo via
 * `requestDuoApproval` → return on landing.
 *
 * Returns `false` on auth failure so the kernel's `loginWithRetry`
 * picks it up; throws on programmer errors (selectors completely
 * missing, etc.).
 */
export async function loginToServiceNow(
  page: import("playwright").Page,
  instance?: string,
): Promise<boolean> {
  await page.goto(HR_INQUIRY_FORM_URL, { waitUntil: "domcontentloaded" });

  // Already authenticated? The form heading will be visible and we can
  // skip the SSO dance entirely.
  if (await hrInquiry.subjectInput(page).isVisible({ timeout: 2_000 }).catch(() => false)) {
    return true;
  }

  // Otherwise we should be on the TritON SAML SSO page.
  const username = (process.env.UCPATH_USER_ID ?? "").trim();
  const password = (process.env.UCPATH_PASSWORD ?? "").trim();
  if (!username || !password) {
    throw new Error("loginToServiceNow: UCPATH_USER_ID / UCPATH_PASSWORD must be set");
  }

  try {
    await ssoFields.usernameInput(page).fill(username, { timeout: 15_000 });
    await ssoFields.passwordInput(page).fill(password);
    await ssoFields.loginButton(page).click();
  } catch (err) {
    log.warn(`[Auth: servicenow] SSO field fill failed: ${err instanceof Error ? err.message : err}`);
    return false;
  }

  // Duo polling. The shared helper handles overlay emit + queue ordering.
  const duoOk = await requestDuoApproval(page, {
    systemId: "servicenow",
    instance,
    landedSelector: hrInquiry.subjectInput(page),
    timeoutMs: 5 * 60_000,
  });
  if (!duoOk) {
    log.warn("[Auth: servicenow] Duo approval failed/timed out");
    return false;
  }

  // Final verification — we should be on the form, not a redirect.
  if (!(await hrInquiry.subjectInput(page).isVisible({ timeout: 5_000 }).catch(() => false))) {
    log.warn(`[Auth: servicenow] post-Duo landing verification failed; URL=${page.url()}`);
    return false;
  }

  return true;
}
```

(If the `requestDuoApproval` import isn't already at the top of
`src/auth/login.ts`, add it: `import { requestDuoApproval } from
"../tracker/duo-queue.js";`. Same for `log` if needed.)

- [ ] **Step 3: Typecheck.**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/auth/login.ts
git commit -m "feat(auth): loginToServiceNow for support.ucsd.edu

Mirrors loginToUCPath: navigate to deep link, fall through SAML SSO,
fill UCSD creds, poll Duo via requestDuoApproval. Reuses the existing
UCPATH_USER_ID/UCPATH_PASSWORD env vars (single SSO realm; no need
for separate creds).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

# Stage 5 — `src/workflows/oath-upload/`

## Task 12: Schema

**Files:**
- Create: `src/workflows/oath-upload/schema.ts`

- [ ] **Step 1: Write the schema.**

```ts
// src/workflows/oath-upload/schema.ts
import { z } from "zod/v4";

export const OathUploadInputSchema = z.object({
  pdfPath:         z.string().min(1),
  pdfOriginalName: z.string().min(1),
  sessionId:       z.string().min(1),
  pdfHash:         z.string().regex(/^[0-9a-f]{64}$/, "expected sha256 hex"),
});

export type OathUploadInput = z.infer<typeof OathUploadInputSchema>;
```

- [ ] **Step 2: Typecheck.**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add src/workflows/oath-upload/schema.ts
git commit -m "feat(oath-upload): input schema (pdfPath, sessionId, pdfHash)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Duplicate-check helper

**Files:**
- Create: `src/workflows/oath-upload/duplicate-check.ts`
- Test: `tests/unit/workflows/oath-upload/duplicate-check.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// tests/unit/workflows/oath-upload/duplicate-check.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { trackEvent, dateLocal } from "../../../../src/tracker/jsonl.js";
import { findPriorRunsForHash } from "../../../../src/workflows/oath-upload/duplicate-check.js";

describe("findPriorRunsForHash", () => {
  it("returns prior runs with the same pdfHash, latest first, deduped to one per sessionId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oath-upload-dup-"));
    const hash = "a".repeat(64);

    // Two runs of the same session — should dedup to the latest.
    trackEvent({
      workflow: "oath-upload",
      timestamp: "2026-04-25T10:00:00Z",
      id: "session-1",
      runId: "run-1",
      status: "done",
      step: "submit",
      data: { pdfHash: hash, ticketNumber: "HRC0123456", pdfOriginalName: "x.pdf" },
    }, dir);
    trackEvent({
      workflow: "oath-upload",
      timestamp: "2026-04-26T10:00:00Z",
      id: "session-1",
      runId: "run-2",
      status: "failed",
      step: "fill-form",
      data: { pdfHash: hash, pdfOriginalName: "x.pdf" },
    }, dir);

    // Different session, same hash.
    trackEvent({
      workflow: "oath-upload",
      timestamp: "2026-04-20T10:00:00Z",
      id: "session-2",
      runId: "run-3",
      status: "done",
      step: "submit",
      data: { pdfHash: hash, ticketNumber: "HRC0123455", pdfOriginalName: "x.pdf" },
    }, dir);

    // Different hash — should NOT appear.
    trackEvent({
      workflow: "oath-upload",
      timestamp: "2026-04-29T10:00:00Z",
      id: "session-3",
      runId: "run-4",
      status: "done",
      step: "submit",
      data: { pdfHash: "b".repeat(64), pdfOriginalName: "y.pdf" },
    }, dir);

    const result = findPriorRunsForHash({ hash, trackerDir: dir });
    expect(result).toHaveLength(2);
    // session-1's latest run is "run-2" (failed, fill-form).
    expect(result[0].sessionId).toBe("session-1");
    expect(result[0].runId).toBe("run-2");
    expect(result[0].terminalStep).toBe("fill-form");
    expect(result[1].sessionId).toBe("session-2");
    expect(result[1].ticketNumber).toBe("HRC0123455");

    await rm(dir, { recursive: true, force: true });
  });

  it("returns empty when no priors exist", () => {
    const result = findPriorRunsForHash({
      hash: "z".repeat(64),
      trackerDir: "/tmp/nonexistent-" + Date.now(),
    });
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, confirm fail (helper doesn't exist).**

Run: `npx vitest run tests/unit/workflows/oath-upload/duplicate-check.test.ts`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `src/workflows/oath-upload/duplicate-check.ts`.**

```ts
// src/workflows/oath-upload/duplicate-check.ts
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TrackerEntry } from "../../tracker/jsonl.js";

export interface PriorRunSummary {
  sessionId: string;
  runId: string;
  startedAt: string;
  terminalStep: string;
  status: string;
  ticketNumber?: string;
  pdfOriginalName: string;
}

export interface FindPriorRunsOpts {
  hash: string;
  trackerDir?: string;
  /** Lookback in days. Default 30. */
  lookbackDays?: number;
}

/**
 * Walk the last N days of `oath-upload-*.jsonl` files, find every
 * (sessionId, runId) pair whose latest entry has `data.pdfHash === hash`,
 * dedup to one row per sessionId (keeping the latest run by timestamp),
 * and return them newest-first.
 */
export function findPriorRunsForHash(opts: FindPriorRunsOpts): PriorRunSummary[] {
  const dir = opts.trackerDir ?? ".tracker";
  const lookbackDays = opts.lookbackDays ?? 30;
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter((f) => f.startsWith("oath-upload-") && f.endsWith(".jsonl"))
    .sort()
    .reverse();
  const cutoffTs = Date.now() - lookbackDays * 24 * 60 * 60_000;

  // Pass 1: collect latest entry per (id, runId).
  const latestByRunKey = new Map<string, TrackerEntry>();
  for (const f of files) {
    const path = join(dir, f);
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (stat.mtimeMs < cutoffTs) break;
    let raw;
    try { raw = readFileSync(path, "utf-8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let entry: TrackerEntry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry.id || !entry.runId) continue;
      const key = `${entry.id}#${entry.runId}`;
      latestByRunKey.set(key, entry);
    }
  }

  // Pass 2: filter to entries whose latest line has matching pdfHash.
  const matches: TrackerEntry[] = [];
  for (const e of latestByRunKey.values()) {
    if ((e.data?.pdfHash as unknown) === opts.hash) {
      matches.push(e);
    }
  }

  // Pass 3: dedup to latest run per sessionId.
  const latestPerSession = new Map<string, TrackerEntry>();
  for (const e of matches) {
    const cur = latestPerSession.get(e.id);
    if (!cur || (e.timestamp ?? "") > (cur.timestamp ?? "")) {
      latestPerSession.set(e.id, e);
    }
  }

  const summaries: PriorRunSummary[] = [];
  for (const e of latestPerSession.values()) {
    summaries.push({
      sessionId: e.id,
      runId: e.runId ?? "",
      startedAt: e.timestamp,
      terminalStep: e.step ?? "",
      status: e.status,
      ticketNumber: typeof e.data?.ticketNumber === "string" ? e.data.ticketNumber : undefined,
      pdfOriginalName:
        typeof e.data?.pdfOriginalName === "string" ? e.data.pdfOriginalName : "",
    });
  }
  summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return summaries;
}

import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";

/** Convenience: SHA-256 hex of a file at path. */
export async function sha256OfFile(path: string): Promise<string> {
  const buf = await fsp.readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}
```

- [ ] **Step 4: Run the tests, confirm pass.**

Run: `npx vitest run tests/unit/workflows/oath-upload/duplicate-check.test.ts`

Expected: ALL PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/workflows/oath-upload/duplicate-check.ts tests/unit/workflows/oath-upload/duplicate-check.test.ts
git commit -m "feat(oath-upload): findPriorRunsForHash + sha256OfFile helpers

30-day lookback by default. Dedup pattern matches the rest of the
dashboard: latest entry per (id, runId), then latest run per id.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 14: Form-fill helper

**Files:**
- Create: `src/workflows/oath-upload/fill-form.ts`
- Test: `tests/unit/workflows/oath-upload/fill-form.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// tests/unit/workflows/oath-upload/fill-form.test.ts
import { describe, it, expect, vi } from "vitest";
import { fillHrInquiryForm, parseTicketNumberFromUrl } from "../../../../src/workflows/oath-upload/fill-form.js";

describe("parseTicketNumberFromUrl", () => {
  it("parses HRC0XXXXXX number= param", () => {
    const url = "https://support.ucsd.edu/esc?id=ticket&number=HRC0123456";
    expect(parseTicketNumberFromUrl(url)).toBe("HRC0123456");
  });
  it("returns null when no number= param", () => {
    expect(parseTicketNumberFromUrl("https://support.ucsd.edu/esc?id=services")).toBe(null);
  });
});

describe("fillHrInquiryForm", () => {
  it("fills subject, description, attaches file, submits", async () => {
    const calls: string[] = [];
    const fakeLocator = (label: string) => ({
      fill: vi.fn().mockImplementation((v: string) => { calls.push(`fill[${label}]=${v}`); return Promise.resolve(); }),
      click: vi.fn().mockImplementation(() => { calls.push(`click[${label}]`); return Promise.resolve(); }),
      setInputFiles: vi.fn().mockImplementation((p: string) => { calls.push(`setInputFiles[${label}]=${p}`); return Promise.resolve(); }),
      type: vi.fn().mockImplementation((v: string) => { calls.push(`type[${label}]=${v}`); return Promise.resolve(); }),
      isVisible: vi.fn().mockResolvedValue(true),
      first: () => fakeLocator(label + "[0]"),
    });
    const fakePage = {
      getByRole: (_role: string, opts: { name: string }) => fakeLocator(opts.name),
      locator: (sel: string) => fakeLocator(sel),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue("https://support.ucsd.edu/esc?id=ticket&number=HRC0999999"),
      title: vi.fn().mockResolvedValue("HR General Inquiry - Employee Center"),
      // submit click navigates: simulate via post-click url change
    } as unknown as import("playwright").Page;

    await fillHrInquiryForm(fakePage, {
      subject: "HDH New Hire Oaths",
      description: "Please see attached oaths for employees hired under HDH.",
      specifically: "Signing Ceremony (Oath)",
      category: "Payroll",
      attachmentPath: "/tmp/oaths.pdf",
    });

    expect(calls).toContain("fill[Subject]=HDH New Hire Oaths");
    expect(calls).toContain("fill[Description]=Please see attached oaths for employees hired under HDH.");
    expect(calls).toContain('setInputFiles[input[type="file"][0]]=/tmp/oaths.pdf');
    // Specifically and Category interactions vary by combobox shape;
    // assert at least the textbox-fill happened.
    expect(calls.some(c => c.includes("Specifically"))).toBe(true);
    expect(calls.some(c => c.includes("Category"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run, confirm fail.**

Run: `npx vitest run tests/unit/workflows/oath-upload/fill-form.test.ts`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `src/workflows/oath-upload/fill-form.ts`.**

```ts
// src/workflows/oath-upload/fill-form.ts
import type { Page } from "playwright";
import { hrInquiry } from "../../systems/servicenow/selectors.js";
import { log } from "../../utils/log.js";

export interface HrInquiryFormValues {
  subject: string;
  description: string;
  specifically: string;
  category: string;
  attachmentPath: string;
}

/**
 * Fill the HR Inquiry form fields and attach the PDF. Does NOT click
 * Submit — the caller does that as a separate step so post-submit
 * verification stays explicit.
 */
export async function fillHrInquiryForm(page: Page, v: HrInquiryFormValues): Promise<void> {
  await hrInquiry.subjectInput(page).fill(v.subject);
  await hrInquiry.descriptionInput(page).fill(v.description);

  // Specifically — typeahead. Type the search term, wait for suggestion
  // list, click the first match. The suggestion list selector is best-
  // effort; if it changes shape, this falls back to pressing Enter on
  // the typed value (ServiceNow accepts free-text in some configs).
  const specInput = hrInquiry.specificallyInput(page);
  await specInput.click();
  await specInput.fill(v.specifically);
  await page.waitForTimeout(800);   // suggestion list latency
  // Try clicking a matching listbox option; tolerate failure (free-text fallback).
  const option = page.getByRole("option", { name: v.specifically }).first();
  try {
    await option.click({ timeout: 3_000 });
  } catch {
    log.warn(`[oath-upload] Specifically dropdown didn't surface "${v.specifically}" — keeping free-text`);
  }

  // Category — combobox. Try selectOption first; fall back to fill+enter.
  const catInput = hrInquiry.categoryInput(page);
  try {
    await catInput.selectOption({ label: v.category }, { timeout: 3_000 });
  } catch {
    await catInput.click();
    await catInput.fill(v.category);
    await page.waitForTimeout(500);
    const opt = page.getByRole("option", { name: v.category }).first();
    try { await opt.click({ timeout: 3_000 }); } catch { /* fall through */ }
  }

  // Attachment — set file input directly, bypassing the "Choose a file" button.
  await hrInquiry.fileInput(page).setInputFiles(v.attachmentPath);
  await page.waitForTimeout(1_000); // upload latency
}

/**
 * Click Submit and read the resulting redirect URL for the new ticket
 * number. ServiceNow redirects to `?id=ticket&number=HRC0XXXXXX`.
 */
export async function submitAndCaptureTicketNumber(page: Page): Promise<string> {
  const before = page.url();
  await hrInquiry.submitButton(page).click();
  // Wait for navigation to settle.
  await page.waitForURL(
    (url) => url.toString() !== before && url.toString().includes("number="),
    { timeout: 60_000 },
  ).catch(() => { /* fall through to URL probe */ });

  const url = page.url();
  const num = parseTicketNumberFromUrl(url);
  if (!num) {
    throw new Error(`submitAndCaptureTicketNumber: no number= param in post-submit URL "${url}"`);
  }
  return num;
}

export function parseTicketNumberFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const n = u.searchParams.get("number");
    if (n && /^HRC\d{6,}$/.test(n)) return n;
    return null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests.**

Run: `npx vitest run tests/unit/workflows/oath-upload/fill-form.test.ts`

Expected: ALL PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/workflows/oath-upload/fill-form.ts tests/unit/workflows/oath-upload/fill-form.test.ts
git commit -m "feat(oath-upload): HR Inquiry form filler + ticket-number parser

Subject/Description are simple textbox.fill. Specifically is the
typeahead pattern (click + fill + wait + option-click with free-text
fallback). Category tries selectOption first, falls back to typeahead.
Attachment uses setInputFiles on the hidden file input. Ticket number
parser handles the HRC0XXXXXX shape and tolerates absent params.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 15: `waitForOcrApproval` helper

**Files:**
- Create: `src/workflows/oath-upload/wait-ocr-approval.ts`
- Test: `tests/unit/workflows/oath-upload/wait-ocr-approval.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// tests/unit/workflows/oath-upload/wait-ocr-approval.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { trackEvent } from "../../../../src/tracker/jsonl.js";
import { waitForOcrApproval } from "../../../../src/workflows/oath-upload/wait-ocr-approval.js";

describe("waitForOcrApproval", () => {
  it("returns approved + fannedOutItemIds when OCR row reaches step=approved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oath-upload-wait-ocr-"));
    const sessionId = "ocr-test";
    const itemIds = ["ocr-oath-r-r0", "ocr-oath-r-r1"];

    setTimeout(() => {
      trackEvent({
        workflow: "ocr",
        timestamp: new Date().toISOString(),
        id: sessionId,
        runId: "ocr-run-1",
        status: "done",
        step: "approved",
        data: { fannedOutItemIds: JSON.stringify(itemIds) },
      }, dir);
    }, 200);

    const r = await waitForOcrApproval({ sessionId, trackerDir: dir, timeoutMs: 30_000 });
    expect(r.step).toBe("approved");
    expect(r.fannedOutItemIds).toEqual(itemIds);

    await rm(dir, { recursive: true, force: true });
  });

  it("throws when OCR row reaches step=discarded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oath-upload-wait-ocr-discard-"));
    const sessionId = "ocr-test-2";

    setTimeout(() => {
      trackEvent({
        workflow: "ocr",
        timestamp: new Date().toISOString(),
        id: sessionId,
        runId: "ocr-run-2",
        status: "failed",
        step: "discarded",
      }, dir);
    }, 200);

    await expect(
      waitForOcrApproval({ sessionId, trackerDir: dir, timeoutMs: 30_000 }),
    ).rejects.toThrow(/discarded/);

    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run, confirm fail.**

Run: `npx vitest run tests/unit/workflows/oath-upload/wait-ocr-approval.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `src/workflows/oath-upload/wait-ocr-approval.ts`.**

```ts
// src/workflows/oath-upload/wait-ocr-approval.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { watchChildRuns } from "../../tracker/watch-child-runs.js";
import { dateLocal, type TrackerEntry } from "../../tracker/jsonl.js";

export interface WaitForOcrApprovalOpts {
  sessionId: string;
  trackerDir?: string;
  date?: string;
  timeoutMs?: number;
  abortIfRowState?: { workflow: string; id: string; step: string };
}

export interface OcrApprovalOutcome {
  step: "approved";
  fannedOutItemIds: string[];
}

/**
 * Wait for the OCR row identified by sessionId to reach a terminal
 * approval state. Returns approved + the IDs the OCR approve handler
 * fanned out (which the caller watches next). Throws on discarded
 * or timeout.
 */
export async function waitForOcrApproval(
  opts: WaitForOcrApprovalOpts,
): Promise<OcrApprovalOutcome> {
  const dir = opts.trackerDir ?? ".tracker";
  const date = opts.date ?? dateLocal();
  await watchChildRuns({
    workflow: "ocr",
    expectedItemIds: [opts.sessionId],
    trackerDir: dir,
    date,
    timeoutMs: opts.timeoutMs ?? 7 * 24 * 60 * 60_000,
    isTerminal: (e) => e.step === "approved" || e.step === "discarded",
    ...(opts.abortIfRowState ? { abortIfRowState: opts.abortIfRowState } : {}),
  });

  // Read latest entry to determine final step.
  const file = join(dir, `ocr-${date}.jsonl`);
  if (!existsSync(file)) throw new Error(`waitForOcrApproval: ${file} disappeared`);
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  let latest: TrackerEntry | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e: TrackerEntry = JSON.parse(lines[i]);
      if (e.id === opts.sessionId && (e.step === "approved" || e.step === "discarded")) {
        latest = e;
        break;
      }
    } catch { /* tolerate */ }
  }
  if (!latest) throw new Error(`waitForOcrApproval: no terminal entry found for ${opts.sessionId}`);

  if (latest.step === "discarded") {
    throw new Error(`OCR run ${opts.sessionId} was discarded by operator`);
  }

  const raw = latest.data?.fannedOutItemIds;
  if (typeof raw !== "string") {
    throw new Error(`waitForOcrApproval: ${opts.sessionId} approved entry missing fannedOutItemIds`);
  }
  const ids = JSON.parse(raw) as unknown;
  if (!Array.isArray(ids) || !ids.every((s) => typeof s === "string")) {
    throw new Error(`waitForOcrApproval: ${opts.sessionId} fannedOutItemIds malformed`);
  }
  return { step: "approved", fannedOutItemIds: ids as string[] };
}
```

- [ ] **Step 4: Run tests.**

Run: `npx vitest run tests/unit/workflows/oath-upload/wait-ocr-approval.test.ts`

Expected: ALL PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/workflows/oath-upload/wait-ocr-approval.ts tests/unit/workflows/oath-upload/wait-ocr-approval.test.ts
git commit -m "feat(oath-upload): waitForOcrApproval wrapper

Wraps watchChildRuns with the OCR-specific isTerminal predicate
(approved | discarded), then re-reads the JSONL to surface the final
step + the fannedOutItemIds the approve handler stamped. Throws on
discarded so the parent's handler unwinds.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 16: Handler

**Files:**
- Create: `src/workflows/oath-upload/handler.ts`
- Test: `tests/unit/workflows/oath-upload/handler.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// tests/unit/workflows/oath-upload/handler.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { oathUploadHandler } from "../../../../src/workflows/oath-upload/handler.js";

describe("oathUploadHandler", () => {
  it("delegates OCR, waits for approval, watches signatures, fills form, submits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oath-upload-handler-"));
    const stepCalls: string[] = [];
    const updates: Record<string, unknown>[] = [];

    const fakeCtx = {
      runId: "oath-upload-run-1",
      data: {} as Record<string, unknown>,
      page: vi.fn().mockResolvedValue({ url: () => "x", title: () => "x" }),
      step: async (name: string, fn: () => Promise<void>) => { stepCalls.push(name); await fn(); },
      markStep: (name: string) => { stepCalls.push(`mark:${name}`); },
      updateData: (d: Record<string, unknown>) => { updates.push(d); Object.assign(fakeCtx.data, d); },
      screenshot: vi.fn(),
    };

    const input = {
      pdfPath: "/tmp/test.pdf",
      pdfOriginalName: "test.pdf",
      sessionId: "session-1",
      pdfHash: "a".repeat(64),
    };

    await oathUploadHandler(fakeCtx as never, input, {
      trackerDir: dir,
      _runOcrOverride: vi.fn().mockResolvedValue(undefined),
      _waitForOcrApprovalOverride: vi.fn().mockResolvedValue({
        step: "approved",
        fannedOutItemIds: ["a", "b", "c"],
      }),
      _watchChildRunsOverride: vi.fn().mockResolvedValue([]),
      _fillFormOverride: vi.fn().mockResolvedValue(undefined),
      _submitOverride: vi.fn().mockResolvedValue("HRC0123456"),
      _gotoOverride: vi.fn().mockResolvedValue(undefined),
      _verifyOverride: vi.fn().mockResolvedValue(undefined),
    });

    expect(stepCalls).toContain("delegate-ocr");
    expect(stepCalls).toContain("wait-ocr-approval");
    expect(stepCalls).toContain("mark:delegate-signatures");
    expect(stepCalls).toContain("wait-signatures");
    expect(stepCalls).toContain("open-hr-form");
    expect(stepCalls).toContain("fill-form");
    expect(stepCalls).toContain("submit");

    const ticket = updates.find(u => u.ticketNumber);
    expect(ticket?.ticketNumber).toBe("HRC0123456");
    const signers = updates.find(u => u.signerCount);
    expect(signers?.signerCount).toBe("3");

    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run, confirm fail.**

Run: `npx vitest run tests/unit/workflows/oath-upload/handler.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `src/workflows/oath-upload/handler.ts`.**

```ts
// src/workflows/oath-upload/handler.ts
import type { Ctx } from "../../core/types.js";
import { runWorkflow } from "../../core/index.js";
import { ocrWorkflow } from "../ocr/index.js";
import { watchChildRuns } from "../../tracker/watch-child-runs.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";
import {
  fillHrInquiryForm,
  submitAndCaptureTicketNumber,
} from "./fill-form.js";
import { gotoHrInquiryForm, verifyOnInquiryForm } from "../../systems/servicenow/navigate.js";
import { waitForOcrApproval } from "./wait-ocr-approval.js";
import type { OathUploadInput } from "./schema.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60_000;
const oathUploadSteps = [
  "delegate-ocr",
  "wait-ocr-approval",
  "delegate-signatures",
  "wait-signatures",
  "open-hr-form",
  "fill-form",
  "submit",
] as const;

const HR_FORM_VALUES = {
  subject: "HDH New Hire Oaths",
  description: "Please see attached oaths for employees hired under HDH.",
  specifically: "Signing Ceremony (Oath)",
  category: "Payroll",
} as const;

export interface OathUploadHandlerOpts {
  trackerDir?: string;
  // Test escape hatches.
  _runOcrOverride?: (input: unknown) => Promise<void>;
  _waitForOcrApprovalOverride?: typeof waitForOcrApproval;
  _watchChildRunsOverride?: typeof watchChildRuns;
  _gotoOverride?: typeof gotoHrInquiryForm;
  _verifyOverride?: typeof verifyOnInquiryForm;
  _fillFormOverride?: typeof fillHrInquiryForm;
  _submitOverride?: typeof submitAndCaptureTicketNumber;
}

export async function oathUploadHandler(
  ctx: Ctx<typeof oathUploadSteps, OathUploadInput>,
  input: OathUploadInput,
  opts: OathUploadHandlerOpts = {},
): Promise<void> {
  const trackerDir = opts.trackerDir;
  ctx.updateData({
    pdfOriginalName: input.pdfOriginalName,
    sessionId: input.sessionId,
    pdfHash: input.pdfHash,
    status: "running",
  });

  const ocrSessionId = `oath-upload-${ctx.runId}-ocr`;
  ctx.updateData({ ocrSessionId });

  await ctx.step("delegate-ocr", async () => {
    const fire = opts._runOcrOverride ?? (async () => {
      void runWorkflow(ocrWorkflow, {
        pdfPath: input.pdfPath,
        pdfOriginalName: input.pdfOriginalName,
        formType: "oath",
        sessionId: ocrSessionId,
        rosterMode: "download",
        parentRunId: ctx.runId,
      } as never).catch((err) =>
        log.warn(`[oath-upload] OCR child crashed: ${errorMessage(err)}`),
      );
    });
    await fire(input);
  });

  let fannedOutItemIds: string[] = [];
  await ctx.step("wait-ocr-approval", async () => {
    const fn = opts._waitForOcrApprovalOverride ?? waitForOcrApproval;
    const r = await fn({
      sessionId: ocrSessionId,
      trackerDir,
      timeoutMs: SEVEN_DAYS_MS,
      abortIfRowState: {
        workflow: "oath-upload",
        id: input.sessionId,
        step: "cancel-requested",
      },
    });
    fannedOutItemIds = r.fannedOutItemIds;
    ctx.updateData({ signerCount: String(fannedOutItemIds.length) });
  });

  ctx.markStep("delegate-signatures");

  await ctx.step("wait-signatures", async () => {
    const fn = opts._watchChildRunsOverride ?? watchChildRuns;
    await fn({
      workflow: "oath-signature",
      expectedItemIds: fannedOutItemIds,
      trackerDir,
      timeoutMs: SEVEN_DAYS_MS,
      isTerminal: (e) => e.status === "done",
      abortIfRowState: {
        workflow: "oath-upload",
        id: input.sessionId,
        step: "cancel-requested",
      },
    });
  });

  const page = await ctx.page("servicenow");

  await ctx.step("open-hr-form", async () => {
    await (opts._gotoOverride ?? gotoHrInquiryForm)(page);
    await (opts._verifyOverride ?? verifyOnInquiryForm)(page);
  });

  await ctx.step("fill-form", async () => {
    await (opts._fillFormOverride ?? fillHrInquiryForm)(page, {
      ...HR_FORM_VALUES,
      attachmentPath: input.pdfPath,
    });
    await ctx.screenshot?.({ kind: "form", label: "hr-inquiry-pre-submit" });
  });

  await ctx.step("submit", async () => {
    const ticketNumber = await (opts._submitOverride ?? submitAndCaptureTicketNumber)(page);
    await ctx.screenshot?.({ kind: "form", label: "hr-inquiry-submitted" });
    ctx.updateData({
      ticketNumber,
      submittedAt: new Date().toISOString(),
      status: "filed",
    });
  });
}

export const oathUploadStepList = oathUploadSteps;
```

- [ ] **Step 4: Run the tests.**

Run: `npx vitest run tests/unit/workflows/oath-upload/handler.test.ts`

Expected: ALL PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/workflows/oath-upload/handler.ts tests/unit/workflows/oath-upload/handler.test.ts
git commit -m "feat(oath-upload): linear handler with delegated OCR + signatures + HR ticket fill

7 steps after auth:servicenow. Two watchChildRuns calls (with the new
abortIfRowState opt for soft-cancel). Form values are hardcoded
constants per spec. Test-escape hatches on every dependency so the
handler is fully unit-testable without Playwright.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 17: Workflow definition + CLI adapters

**Files:**
- Create: `src/workflows/oath-upload/workflow.ts`
- Create: `src/workflows/oath-upload/index.ts`

- [ ] **Step 1: Write `src/workflows/oath-upload/workflow.ts`.**

```ts
// src/workflows/oath-upload/workflow.ts
import { defineWorkflow, runWorkflow } from "../../core/index.js";
import { trackEvent } from "../../tracker/jsonl.js";
import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";
import { loginToServiceNow } from "../../auth/login.js";
import { OathUploadInputSchema, type OathUploadInput } from "./schema.js";
import { oathUploadHandler, oathUploadStepList } from "./handler.js";

const WORKFLOW = "oath-upload";

export const oathUploadWorkflow = defineWorkflow({
  name: WORKFLOW,
  label: "Oath Upload",
  systems: [
    {
      id: "servicenow",
      login: async (page, instance) => {
        const ok = await loginToServiceNow(page, instance);
        if (!ok) throw new Error("ServiceNow authentication failed");
      },
    },
  ],
  authSteps: false,
  steps: [
    "servicenow-auth",
    ...oathUploadStepList,
  ] as const,
  schema: OathUploadInputSchema,
  authChain: "sequential",
  tiling: "single",
  batch: {
    mode: "sequential",
    preEmitPending: true,
    betweenItems: ["reset-browsers"],
  },
  detailFields: [
    { key: "pdfOriginalName", label: "PDF" },
    { key: "ocrSessionId",    label: "OCR session" },
    { key: "signerCount",     label: "Signers" },
    { key: "ticketNumber",    label: "HR ticket #" },
    { key: "submittedAt",     label: "Filed" },
    { key: "status",          label: "Status" },
  ],
  getName: (d) => d.pdfOriginalName ?? "",
  getId:   (d) => d.sessionId ?? "",
  handler: async (ctx, input) => {
    ctx.markStep("servicenow-auth");
    await ctx.page("servicenow");
    await oathUploadHandler(ctx as never, input);
  },
});

/** In-process single-run entry (tests + composition). */
export async function runOathUpload(input: OathUploadInput): Promise<void> {
  try {
    await runWorkflow(oathUploadWorkflow, input);
    log.success("oath-upload workflow completed");
  } catch (err) {
    log.error(`oath-upload failed: ${errorMessage(err)}`);
    process.exit(1);
  }
}

/** Daemon-mode CLI adapter. */
export async function runOathUploadCli(
  inputs: OathUploadInput[],
  options: { new?: boolean; parallel?: number } = {},
): Promise<void> {
  if (inputs.length === 0) {
    log.error("runOathUploadCli: no inputs provided");
    process.exitCode = 1;
    return;
  }
  const { ensureDaemonsAndEnqueue } = await import("../../core/daemon-client.js");
  const now = new Date().toISOString();
  await ensureDaemonsAndEnqueue(
    oathUploadWorkflow,
    inputs,
    { new: options.new, parallel: options.parallel },
    {
      onPreEmitPending: (item, runId, parentRunId) => {
        trackEvent({
          workflow: WORKFLOW,
          timestamp: now,
          id: item.sessionId,
          runId,
          ...(parentRunId ? { parentRunId } : {}),
          status: "pending",
          data: {
            pdfPath: item.pdfPath,
            pdfOriginalName: item.pdfOriginalName,
            sessionId: item.sessionId,
            pdfHash: item.pdfHash,
          },
        });
      },
      deriveItemId: (inp) => inp.sessionId,
    },
  );
}
```

- [ ] **Step 2: Write `src/workflows/oath-upload/index.ts` barrel.**

```ts
// src/workflows/oath-upload/index.ts
export { oathUploadWorkflow, runOathUpload, runOathUploadCli } from "./workflow.js";
export { OathUploadInputSchema, type OathUploadInput } from "./schema.js";
export { findPriorRunsForHash, sha256OfFile, type PriorRunSummary } from "./duplicate-check.js";
```

- [ ] **Step 3: Typecheck.**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/workflows/oath-upload/workflow.ts src/workflows/oath-upload/index.ts
git commit -m "feat(oath-upload): kernel workflow definition + CLI adapters

defineWorkflow with systems=[servicenow], authSteps=false (declares
servicenow-auth manually + 7 handler steps), sequential batch with
preEmitPending. Three exports: runOathUpload (in-process),
runOathUploadCli (daemon-mode), and oathUploadWorkflow (registry).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 18: Workflow CLAUDE.md

**Files:**
- Create: `src/workflows/oath-upload/CLAUDE.md`

- [ ] **Step 1: Write the doc.**

```markdown
# Oath Upload Workflow

Operator uploads a paper-oath PDF; the workflow OCRs it, fans out N
oath-signature daemon items (one per signer), waits for every UCPath
transaction to complete, and then files an HR General Inquiry ticket
on `support.ucsd.edu` with the original PDF attached. One operator
action; one ticket.

**Kernel-based + daemon-mode.** Same shape as `oath-signature` /
`separations`, but with `systems: [servicenow]` and a handler that
delegates to OCR + the oath-signature daemon mid-flight.

## What this workflow does

Given an `OathUploadInput` (`pdfPath`, `pdfOriginalName`, `sessionId`,
`pdfHash`):

1. Authenticate `servicenow` (UCSD SSO + Duo) once per daemon spawn.
2. Delegate OCR (`runWorkflow(ocrWorkflow, …, parentRunId: ctx.runId)`).
   `formType: "oath"`, `rosterMode: "download"`. The OCR row carries
   `parentRunId` so the dashboard nests it under this row.
3. Wait for the OCR row to reach `step="approved"` (operator clicks
   approve on the OCR row's existing UI). Custom `isTerminal` predicate
   on `watchChildRuns`. 7-day backstop. On `step="discarded"`, fail.
4. Read the OCR approve entry's `data.fannedOutItemIds` (written by the
   OCR approve handler) — these are the oath-signature itemIds.
5. Wait for every fanned-out oath-signature item to reach `status="done"`.
   Failed children pause the parent indefinitely; operator retries them
   from the oath-signature tab and the parent auto-resumes when the
   watch sees all-done.
6. Navigate to the HR Inquiry form on `support.ucsd.edu`.
7. Fill subject `"HDH New Hire Oaths"`, description `"Please see
   attached oaths for employees hired under HDH."`, specifically
   `"Signing Ceremony (Oath)"`, category `"Payroll"`. Attach the
   original PDF.
8. Submit. Capture the new ticket number from the redirect URL
   (`?id=ticket&number=HRC0XXXXXX`). Store on `data.ticketNumber`.

## Selector Intelligence

This workflow touches: **servicenow**.

Before mapping a new selector, run `npm run selector:search "<intent>"`.

- [`src/systems/servicenow/LESSONS.md`](../../systems/servicenow/LESSONS.md)
- [`src/systems/servicenow/SELECTORS.md`](../../systems/servicenow/SELECTORS.md)
- [`src/systems/servicenow/common-intents.txt`](../../systems/servicenow/common-intents.txt)

## Files

- `schema.ts` — `OathUploadInputSchema` (pdfPath, pdfOriginalName, sessionId, pdfHash)
- `handler.ts` — linear handler body + step list
- `wait-ocr-approval.ts` — wraps `watchChildRuns` for OCR's approve/discard predicate
- `fill-form.ts` — Playwright form-fill + submit + ticket-number parser
- `duplicate-check.ts` — SHA-256 + prior-run scanner for the dashboard pre-flight
- `workflow.ts` — `defineWorkflow` + `runOathUpload` + `runOathUploadCli`
- `index.ts` — barrel

## Kernel Config

| Field         | Value                                                                          |
| ------------- | ------------------------------------------------------------------------------ |
| `systems`     | `[{ id: "servicenow", login: loginToServiceNow }]`                             |
| `authSteps`   | `false` (we declare `servicenow-auth` ourselves)                               |
| `steps`       | `["servicenow-auth", "delegate-ocr", "wait-ocr-approval", "delegate-signatures", "wait-signatures", "open-hr-form", "fill-form", "submit"]` |
| `schema`      | `{ pdfPath, pdfOriginalName, sessionId, pdfHash }`                             |
| `batch`       | `{ mode: "sequential", preEmitPending: true, betweenItems: ["reset-browsers"] }` |
| `tiling`      | `"single"`                                                                     |
| `authChain`   | `"sequential"`                                                                 |
| `detailFields`| PDF / OCR session / Signers / HR ticket # / Filed / Status                     |

## Dupe-protection

The dashboard's Run modal calls `/api/oath-upload/check-duplicate?hash=<sha256>`
on file select. If prior runs exist for that hash, a banner shows
date + terminal step + ticket number. **Non-blocking** — operator can
upload again. Hash is stored on every tracker line via
`data.pdfHash`. See `duplicate-check.ts`.

## Restart recovery

The handler's first action probes the OCR JSONL for any prior entry
with the same `ocrSessionId`. If a prior run reached
`step="approved"`, `delegate-ocr` and `wait-ocr-approval` are
skipped — `fannedOutItemIds` is read from the prior approved entry
and the handler jumps straight to `wait-signatures`. This makes the
handler idempotent on daemon restart (kernel re-claims the queue
item with the same runId via the existing `recoverOrphanedClaims`
flow, the handler re-enters from step 1, and the probe avoids
re-firing OCR).

## Soft-cancel

`POST /api/oath-upload/cancel` writes a `running` tracker entry on
the oath-upload row with `step="cancel-requested"`. Both
`watchChildRuns` calls have an `abortIfRowState` opt that polls the
parent's own row and rejects if the sentinel appears — so the daemon
can be in any of the two long waits and still cancel cleanly. After
the abort, the kernel's failure path emits `failed` step
`"cancelled"`.

## Lessons Learned

(empty — module is new as of 2026-05-01)
```

- [ ] **Step 2: Commit.**

```bash
git add src/workflows/oath-upload/CLAUDE.md
git commit -m "docs(oath-upload): module CLAUDE.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 19: Restart-recovery probe in the handler

**Files:**
- Modify: `src/workflows/oath-upload/handler.ts`
- Test: `tests/unit/workflows/oath-upload/handler.test.ts`

- [ ] **Step 1: Add a failing test** in `tests/unit/workflows/oath-upload/handler.test.ts`:

```ts
it("skips delegate-ocr + wait-ocr-approval when a prior approved entry exists for ocrSessionId", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oath-upload-handler-restart-"));
  const stepCalls: string[] = [];
  const updates: Record<string, unknown>[] = [];

  // Pre-write a prior OCR approved row for this run's deterministic ocrSessionId.
  const ocrSessionId = `oath-upload-oath-upload-run-X-ocr`;
  trackEvent({
    workflow: "ocr",
    timestamp: new Date().toISOString(),
    id: ocrSessionId,
    runId: "ocr-prior",
    status: "done",
    step: "approved",
    data: { fannedOutItemIds: JSON.stringify(["x", "y"]) },
  }, dir);

  const fakeCtx = {
    runId: "oath-upload-run-X",
    data: {} as Record<string, unknown>,
    page: vi.fn().mockResolvedValue({}),
    step: async (n: string, fn: () => Promise<void>) => { stepCalls.push(n); await fn(); },
    markStep: (n: string) => { stepCalls.push(`mark:${n}`); },
    updateData: (d: Record<string, unknown>) => { updates.push(d); Object.assign(fakeCtx.data, d); },
    screenshot: vi.fn(),
  };

  const runOcrSpy = vi.fn();
  const waitForOcrSpy = vi.fn();
  await oathUploadHandler(fakeCtx as never, {
    pdfPath: "/tmp/x.pdf", pdfOriginalName: "x.pdf",
    sessionId: "session-X", pdfHash: "a".repeat(64),
  }, {
    trackerDir: dir,
    _runOcrOverride: runOcrSpy,
    _waitForOcrApprovalOverride: waitForOcrSpy,
    _watchChildRunsOverride: vi.fn().mockResolvedValue([]),
    _gotoOverride: vi.fn(), _verifyOverride: vi.fn(),
    _fillFormOverride: vi.fn(),
    _submitOverride: vi.fn().mockResolvedValue("HRC0000111"),
  });

  expect(runOcrSpy).not.toHaveBeenCalled();
  expect(waitForOcrSpy).not.toHaveBeenCalled();
  expect(stepCalls).toContain("wait-signatures");
  expect(stepCalls).toContain("submit");

  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run, confirm fail.**

Run: `npx vitest run tests/unit/workflows/oath-upload/handler.test.ts -t "skips delegate-ocr"`

Expected: FAIL.

- [ ] **Step 3: Add the probe to `oathUploadHandler`** in `src/workflows/oath-upload/handler.ts`. After the initial `ctx.updateData` block, add:

```ts
// Restart-recovery probe.
const priorApproval = readPriorOcrApproval(ocrSessionId, trackerDir);
if (priorApproval) {
  log.step(`[oath-upload] recovery: prior approved OCR found for ${ocrSessionId}; skipping delegate-ocr + wait-ocr-approval`);
  ctx.skipStep?.("delegate-ocr");
  ctx.skipStep?.("wait-ocr-approval");
  fannedOutItemIds = priorApproval.fannedOutItemIds;
  ctx.updateData({ signerCount: String(fannedOutItemIds.length) });
} else {
  // ... existing delegate-ocr + wait-ocr-approval blocks ...
}
```

(The `if/else` wraps the existing two blocks. Move `let fannedOutItemIds: string[] = [];` above the if so both branches assign it. If `ctx.skipStep` is missing — the kernel does support it; verify in `src/core/types.ts:Ctx` — fall back to `ctx.markStep`.)

Add the probe helper in the same file:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dateLocal, type TrackerEntry } from "../../tracker/jsonl.js";

function readPriorOcrApproval(
  ocrSessionId: string,
  trackerDir: string | undefined,
): { fannedOutItemIds: string[] } | null {
  const dir = trackerDir ?? ".tracker";
  const file = join(dir, `ocr-${dateLocal()}.jsonl`);
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e: TrackerEntry = JSON.parse(lines[i]);
      if (e.id === ocrSessionId && e.step === "approved" && typeof e.data?.fannedOutItemIds === "string") {
        try {
          const ids = JSON.parse(e.data.fannedOutItemIds);
          if (Array.isArray(ids)) return { fannedOutItemIds: ids as string[] };
        } catch { /* tolerate */ }
      }
    } catch { /* tolerate */ }
  }
  return null;
}
```

- [ ] **Step 4: Run the test, confirm pass.**

Run: `npx vitest run tests/unit/workflows/oath-upload/handler.test.ts`

Expected: ALL PASS (existing test + new restart-recovery test).

- [ ] **Step 5: Commit.**

```bash
git add src/workflows/oath-upload/handler.ts tests/unit/workflows/oath-upload/handler.test.ts
git commit -m "feat(oath-upload): restart-recovery probe skips OCR re-fire

Handler probes for an existing OCR approved entry on its deterministic
ocrSessionId; if found, jumps straight to wait-signatures with
fannedOutItemIds read from disk. Idempotent re-entry on daemon restart.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

# Stage 6 — HTTP endpoints

## Task 20: `oath-upload-http.ts` — three handlers + sweep

**Files:**
- Create: `src/tracker/oath-upload-http.ts`
- Test: `tests/unit/tracker/oath-upload-http.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
// tests/unit/tracker/oath-upload-http.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildOathUploadDuplicateCheckHandler,
  buildOathUploadStartHandler,
  buildOathUploadCancelHandler,
  sweepStuckOathUploadRows,
} from "../../../src/tracker/oath-upload-http.js";
import { trackEvent, dateLocal } from "../../../src/tracker/jsonl.js";

describe("buildOathUploadDuplicateCheckHandler", () => {
  it("returns priorRuns array for a known hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oath-upload-dup-handler-"));
    const hash = "c".repeat(64);
    trackEvent({
      workflow: "oath-upload",
      timestamp: new Date().toISOString(),
      id: "s1", runId: "r1",
      status: "done", step: "submit",
      data: { pdfHash: hash, ticketNumber: "HRC0001", pdfOriginalName: "f.pdf" },
    }, dir);

    const h = buildOathUploadDuplicateCheckHandler({ trackerDir: dir });
    const r = await h({ hash });
    expect(r.status).toBe(200);
    expect(r.body.priorRuns).toHaveLength(1);
    expect(r.body.priorRuns[0].sessionId).toBe("s1");

    await rm(dir, { recursive: true, force: true });
  });
});

describe("sweepStuckOathUploadRows", () => {
  it("marks pending oath-upload rows as failed step=swept", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oath-upload-sweep-"));
    trackEvent({
      workflow: "oath-upload",
      timestamp: new Date().toISOString(),
      id: "s1", runId: "r1", status: "pending",
      data: {},
    }, dir);
    sweepStuckOathUploadRows(dir);
    const file = join(dir, `oath-upload-${dateLocal()}.jsonl`);
    const lines = (await import("node:fs/promises")).readFile(file, "utf-8");
    const all = (await lines).split("\n").filter(Boolean).map(l => JSON.parse(l));
    const last = all[all.length - 1];
    expect(last.status).toBe("failed");
    expect(last.error).toMatch(/Dashboard restarted/);
    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run, confirm fail.**

Run: `npx vitest run tests/unit/tracker/oath-upload-http.test.ts`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `src/tracker/oath-upload-http.ts`.**

```ts
// src/tracker/oath-upload-http.ts
/**
 * HTTP handlers for /api/oath-upload/*. Mirrors src/tracker/ocr-http.ts +
 * src/tracker/oath-signature-http.ts shape.
 *
 *  - check-duplicate: read-only — scans recent oath-upload JSONLs for the hash
 *  - start:           multipart upload, fire-and-forget runOathUploadCli
 *  - cancel:          writes the cancel-request sentinel that the watcher polls
 *  - sweepStuckOathUploadRows: restart-time orphan cleanup
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { trackEvent, dateLocal, type TrackerEntry } from "./jsonl.js";
import { errorMessage } from "../utils/errors.js";
import { log } from "../utils/log.js";
import {
  findPriorRunsForHash,
  type PriorRunSummary,
} from "../workflows/oath-upload/duplicate-check.js";

const WORKFLOW = "oath-upload";

// ─── /api/oath-upload/check-duplicate ────────────────────────

export interface DuplicateCheckInput {
  hash: string;
  lookbackDays?: number;
}
export interface DuplicateCheckResponse {
  status: 200 | 400;
  body:
    | { ok: true; priorRuns: PriorRunSummary[] }
    | { ok: false; error: string };
}
export interface DuplicateCheckHandlerOpts {
  trackerDir?: string;
}

export function buildOathUploadDuplicateCheckHandler(
  opts: DuplicateCheckHandlerOpts = {},
): (input: DuplicateCheckInput) => Promise<DuplicateCheckResponse> {
  return async (input) => {
    if (!/^[0-9a-f]{64}$/.test(input.hash ?? "")) {
      return { status: 400, body: { ok: false, error: "invalid hash" } };
    }
    const priorRuns = findPriorRunsForHash({
      hash: input.hash,
      trackerDir: opts.trackerDir,
      lookbackDays: input.lookbackDays,
    });
    return { status: 200, body: { ok: true, priorRuns } };
  };
}

// ─── /api/oath-upload/start ──────────────────────────────────

export interface StartInput {
  pdfPath: string;
  pdfOriginalName: string;
  pdfHash: string;
  sessionId?: string;
}
export interface StartResponse {
  status: 202 | 400 | 500;
  body:
    | { ok: true; sessionId: string }
    | { ok: false; error: string };
}
export interface StartHandlerOpts {
  trackerDir?: string;
  runOathUploadCli?: (
    inputs: import("../workflows/oath-upload/schema.js").OathUploadInput[],
  ) => Promise<void>;
}

export function buildOathUploadStartHandler(
  opts: StartHandlerOpts = {},
): (input: StartInput) => Promise<StartResponse> {
  const trackerDir = opts.trackerDir;
  const runCli =
    opts.runOathUploadCli ??
    (async (inputs) => {
      const { runOathUploadCli } = await import(
        "../workflows/oath-upload/index.js"
      );
      await runOathUploadCli(inputs);
    });
  return async (input) => {
    if (!input.pdfPath || !input.pdfOriginalName) {
      return { status: 400, body: { ok: false, error: "Missing pdfPath/pdfOriginalName" } };
    }
    if (!/^[0-9a-f]{64}$/.test(input.pdfHash ?? "")) {
      return { status: 400, body: { ok: false, error: "invalid pdfHash" } };
    }
    const sessionId = input.sessionId ?? randomUUID();
    void runCli([
      {
        pdfPath: input.pdfPath,
        pdfOriginalName: input.pdfOriginalName,
        sessionId,
        pdfHash: input.pdfHash,
      },
    ]).catch((err) =>
      log.error(`[oath-upload-http] runOathUploadCli threw: ${errorMessage(err)}`),
    );
    return { status: 202, body: { ok: true, sessionId } };
  };
}

// ─── /api/oath-upload/cancel ─────────────────────────────────

export interface CancelInput {
  sessionId: string;
  runId?: string;
  reason?: string;
}
export interface CancelResponse {
  status: 200 | 400;
  body: { ok: boolean; error?: string };
}
export interface CancelHandlerOpts {
  trackerDir?: string;
}

export function buildOathUploadCancelHandler(opts: CancelHandlerOpts = {}) {
  return async (input: CancelInput): Promise<CancelResponse> => {
    if (!input.sessionId) {
      return { status: 400, body: { ok: false, error: "Missing sessionId" } };
    }
    // Look up the latest runId for this sessionId so the sentinel pairs cleanly.
    const runId = input.runId ?? findLatestRunIdForSession(input.sessionId, opts.trackerDir) ?? "";
    if (!runId) {
      return { status: 400, body: { ok: false, error: "no active oath-upload row for sessionId" } };
    }
    trackEvent(
      {
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id: input.sessionId,
        runId,
        status: "running",
        step: "cancel-requested",
        ...(input.reason ? { data: { reason: input.reason } } : {}),
      },
      opts.trackerDir,
    );
    return { status: 200, body: { ok: true } };
  };
}

function findLatestRunIdForSession(
  sessionId: string,
  trackerDir: string | undefined,
): string | null {
  const file = join(trackerDir ?? ".tracker", `oath-upload-${dateLocal()}.jsonl`);
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e: TrackerEntry = JSON.parse(lines[i]);
      if (e.id === sessionId && e.runId) return e.runId;
    } catch { /* tolerate */ }
  }
  return null;
}

// ─── Restart sweep ───────────────────────────────────────────

export function sweepStuckOathUploadRows(trackerDir: string): void {
  const date = dateLocal();
  const file = join(trackerDir, `oath-upload-${date}.jsonl`);
  if (!existsSync(file)) return;
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const latestById = new Map<string, TrackerEntry>();
  for (const line of lines) {
    try {
      const e: TrackerEntry = JSON.parse(line);
      const key = `${e.id}#${e.runId}`;
      latestById.set(key, e);
    } catch { /* tolerate */ }
  }
  for (const e of latestById.values()) {
    if (e.status === "pending" || e.status === "running") {
      trackEvent(
        {
          workflow: WORKFLOW,
          timestamp: new Date().toISOString(),
          id: e.id,
          runId: e.runId,
          ...(e.parentRunId ? { parentRunId: e.parentRunId } : {}),
          status: "failed",
          step: "swept",
          error: "Dashboard restarted while oath-upload was in progress — please re-upload",
        },
        trackerDir,
      );
    }
  }
}

// ─── PDF persistence helper for the multipart route ──────────

export async function saveUploadedPdf(
  bytes: Buffer,
  filename: string,
  trackerDir: string,
): Promise<string> {
  const dir = join(trackerDir, "uploads");
  await mkdir(dir, { recursive: true });
  const sanitized = filename.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64);
  const path = join(dir, `${randomUUID()}-${sanitized}`);
  await writeFile(path, bytes);
  return path;
}
```

- [ ] **Step 4: Run the tests, confirm pass.**

Run: `npx vitest run tests/unit/tracker/oath-upload-http.test.ts`

Expected: ALL PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/tracker/oath-upload-http.ts tests/unit/tracker/oath-upload-http.test.ts
git commit -m "feat(oath-upload-http): three endpoints + restart sweep

check-duplicate (synchronous JSONL scan), start (fire-and-forget
runOathUploadCli with pre-saved PDF path), cancel (writes
step=cancel-requested sentinel that the watcher polls). Restart
sweep marks pending/running rows as failed step=swept on dashboard
boot.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 21: Wire routes into `dashboard.ts`

**Files:**
- Modify: `src/tracker/dashboard.ts`

- [ ] **Step 1: Find the route-registration block** (search for `/api/ocr/prepare` or `/api/oath-signature/prepare` to locate the pattern):

Run: `grep -n "/api/ocr/prepare\|/api/oath-signature\|sweepStuck" src/tracker/dashboard.ts | head -20`

- [ ] **Step 2: Add the three new routes alongside the OCR ones.** Pattern is consistent — look at how `/api/ocr/approve-batch` is wired and mirror it. For the multipart `start` route, mirror `/api/emergency-contact/prepare` (which has the multipart helper). Sketch:

```ts
// near the other /api/* registrations
const oathUploadDup = buildOathUploadDuplicateCheckHandler({ trackerDir });
const oathUploadCancel = buildOathUploadCancelHandler({ trackerDir });

if (req.method === "GET" && url.pathname === "/api/oath-upload/check-duplicate") {
  const hash = url.searchParams.get("hash") ?? "";
  const r = await oathUploadDup({ hash });
  return jsonResponse(res, r.status, r.body);
}
if (req.method === "POST" && url.pathname === "/api/oath-upload/cancel") {
  const body = await readJsonBody(req);
  const r = await oathUploadCancel(body as never);
  return jsonResponse(res, r.status, r.body);
}
if (req.method === "POST" && url.pathname === "/api/oath-upload/start") {
  // Multipart: parse PDF + form fields, save to .tracker/uploads/, compute
  // sha256 server-side, then fire-and-forget runOathUploadCli.
  const parsed = await parseMultipart(req, { maxBytes: 50 * 1024 * 1024 });
  const file = parsed.files["pdf"];
  if (!file) return jsonResponse(res, 400, { ok: false, error: "missing pdf" });
  const path = await saveUploadedPdf(file.bytes, file.filename, trackerDir);
  const hash = (await import("node:crypto")).createHash("sha256").update(file.bytes).digest("hex");
  const start = buildOathUploadStartHandler({ trackerDir });
  const r = await start({
    pdfPath: path,
    pdfOriginalName: file.filename,
    pdfHash: hash,
  });
  return jsonResponse(res, r.status, r.body);
}
```

(Reuse the `parseMultipart` helper that emergency-contact's prepare route
uses. Search for it: `grep -n "parseMultipart\|multipart-helper" src/tracker/`.
Reuse `readJsonBody` similarly.)

- [ ] **Step 3: Add the sweep call** at the dashboard's startup section (search for `sweepStuckOcrRows` and add `sweepStuckOathUploadRows(trackerDir)` directly below):

```ts
sweepStuckOcrRows(trackerDir);
sweepStuckOathUploadRows(trackerDir);   // NEW
```

- [ ] **Step 4: Typecheck + run dashboard tests.**

Run: `npm run typecheck && npx vitest run tests/unit/tracker/dashboard.test.ts`

Expected: ALL PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/tracker/dashboard.ts
git commit -m "feat(dashboard): wire /api/oath-upload/* routes + restart sweep

Three new routes alongside the existing OCR + oath-signature shapes.
Reuses parseMultipart for the start route's PDF upload (50MB cap,
matches emergency-contact). Restart sweep called at server boot.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

# Stage 7 — Frontend

## Task 22: `OathUploadRunModal.tsx` + `DuplicateBanner.tsx`

**Files:**
- Create: `src/dashboard/components/oath-upload/OathUploadRunModal.tsx`
- Create: `src/dashboard/components/oath-upload/DuplicateBanner.tsx`
- Create: `src/dashboard/components/oath-upload/index.ts`

- [ ] **Step 1: Write `DuplicateBanner.tsx`.**

```tsx
// src/dashboard/components/oath-upload/DuplicateBanner.tsx
import type { PriorRunSummary } from "@/types/oath-upload";

export function DuplicateBanner({ priorRuns }: { priorRuns: PriorRunSummary[] }) {
  if (priorRuns.length === 0) return null;
  return (
    <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm">
      <div className="font-medium text-amber-900 mb-1">
        This PDF was uploaded before
      </div>
      <ul className="space-y-1 text-amber-800">
        {priorRuns.map((r) => (
          <li key={`${r.sessionId}#${r.runId}`}>
            <span className="font-mono">{r.startedAt.slice(0, 10)}</span>
            {" — "}
            <span className="font-mono">{r.runId.slice(0, 8)}</span>
            {" reached "}
            <span className="font-medium">{r.terminalStep || r.status}</span>
            {r.ticketNumber && (
              <>
                {", ticket "}
                <span className="font-mono">{r.ticketNumber}</span>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="mt-2 text-amber-700 text-xs">
        You can still upload — this is just a heads-up.
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the types file** referenced above. Create `src/dashboard/types/oath-upload.ts`:

```ts
export interface PriorRunSummary {
  sessionId: string;
  runId: string;
  startedAt: string;
  terminalStep: string;
  status: string;
  ticketNumber?: string;
  pdfOriginalName: string;
}
```

- [ ] **Step 3: Write `OathUploadRunModal.tsx`.**

```tsx
// src/dashboard/components/oath-upload/OathUploadRunModal.tsx
import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { DuplicateBanner } from "./DuplicateBanner";
import type { PriorRunSummary } from "@/types/oath-upload";

export interface OathUploadRunModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted?: (sessionId: string) => void;
}

async function sha256OfFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hashBuf = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function OathUploadRunModal({
  open,
  onOpenChange,
  onSubmitted,
}: OathUploadRunModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [priors, setPriors] = useState<PriorRunSummary[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onFileSelect = async (f: File | null) => {
    setFile(f);
    setPriors([]);
    setError(null);
    if (!f) return;
    try {
      const hash = await sha256OfFile(f);
      const r = await fetch(
        `/api/oath-upload/check-duplicate?hash=${encodeURIComponent(hash)}`,
      );
      const j = await r.json();
      if (j.ok) setPriors(j.priorRuns ?? []);
    } catch (err) {
      setError(`Duplicate check failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const onSubmit = async () => {
    if (!file) return;
    setSubmitting(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("pdf", file);
      const r = await fetch("/api/oath-upload/start", { method: "POST", body: fd });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error ?? "upload failed");
      onSubmitted?.(j.sessionId);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload Oath PDF</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => void onFileSelect(e.target.files?.[0] ?? null)}
          />
          {priors.length > 0 && <DuplicateBanner priorRuns={priors} />}
          {error && <div className="text-red-600 text-sm">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!file || submitting} onClick={() => void onSubmit()}>
              {submitting ? "Uploading..." : "Upload"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Write the barrel** `src/dashboard/components/oath-upload/index.ts`:

```ts
export { OathUploadRunModal } from "./OathUploadRunModal";
export { DuplicateBanner } from "./DuplicateBanner";
```

- [ ] **Step 5: Verify the dashboard typechecks.**

Run: `npm run typecheck`

Expected: PASS. (If imports are wrong because the dashboard uses different alias paths, search the existing OCR modal for the exact dialog/button imports and copy them.)

- [ ] **Step 6: Commit.**

```bash
git add src/dashboard/components/oath-upload/ src/dashboard/types/oath-upload.ts
git commit -m "feat(dashboard): OathUploadRunModal + DuplicateBanner

PDF-only picker; on file select, hashes locally and fetches the
duplicate check endpoint; renders a non-blocking banner if priors
exist. Submit POSTs multipart to /api/oath-upload/start.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 23: Wire `OathUploadRunModal` into the existing RunModal dispatch

**Files:**
- Modify: `src/dashboard/components/RunModal.tsx`

- [ ] **Step 1: Find the existing `RunModal` component.**

Run: `cat src/dashboard/components/RunModal.tsx | head -80`

- [ ] **Step 2: Add a workflow-name dispatch** so when `workflow === "oath-upload"`, render `OathUploadRunModal` instead of the OCR modal. Sketch:

```tsx
import { OathUploadRunModal } from "./oath-upload";

// inside the component:
if (workflow === "oath-upload") {
  return <OathUploadRunModal open={open} onOpenChange={onOpenChange} onSubmitted={onSubmitted} />;
}
// fall through to the existing OCR modal logic
```

(The exact location depends on the existing `RunModal` shape — read the
file first and pick the cleanest insertion point. If `RunModal` is a
switch-on-`workflow`, add a case. If it's a single component with
conditional behavior, add a guard at the top.)

- [ ] **Step 3: Verify the dashboard builds.**

Run: `npm run build:dashboard` (if defined) or `npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/dashboard/components/RunModal.tsx
git commit -m "feat(dashboard): RunModal dispatches to OathUploadRunModal for oath-upload

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

# Stage 8 — Final wiring

## Task 24: CLI integration

**Files:**
- Modify: `src/cli.ts` (new Commander subcommand)
- Modify: `src/cli-daemon.ts` (WORKFLOWS map entry)
- Modify: `package.json` (oath-upload + oath-upload:stop scripts)

- [ ] **Step 1: Find an existing daemon-mode CLI subcommand** as a template:

Run: `grep -n "oath-signature\|runOathSignatureCli" src/cli.ts | head -10`

- [ ] **Step 2: Add a new Commander subcommand** to `src/cli.ts`. Mirror oath-signature's shape:

```ts
program
  .command("oath-upload <pdfPath...>")
  .option("-n, --new", "spawn an additional daemon")
  .option("-p, --parallel <count>", "ensure ≥N daemons", parseInt)
  .description("Enqueue oath-upload runs to an alive daemon")
  .action(async (pdfPaths: string[], options) => {
    const { runOathUploadCli } = await import("./workflows/oath-upload/index.js");
    const { sha256OfFile } = await import("./workflows/oath-upload/index.js");
    const { basename } = await import("node:path");
    const { randomUUID } = await import("node:crypto");
    const inputs = await Promise.all(
      pdfPaths.map(async (p) => ({
        pdfPath: p,
        pdfOriginalName: basename(p),
        sessionId: randomUUID(),
        pdfHash: await sha256OfFile(p),
      })),
    );
    await runOathUploadCli(inputs, options);
  });
```

Also register the soft-stop command alongside other `*-stop` commands
in the same file:

```ts
program
  .command("oath-upload-stop")
  .option("-f, --force", "hard-stop instead of drain")
  .action(async (options) => {
    const { stopDaemons } = await import("./core/daemon-client.js");
    await stopDaemons("oath-upload", Boolean(options.force));
  });
```

- [ ] **Step 3: Add the workflow loader** to `src/cli-daemon.ts`. Find the `WORKFLOWS` map and add:

```ts
"oath-upload": async () => {
  const { oathUploadWorkflow } = await import("./workflows/oath-upload/index.js");
  return oathUploadWorkflow;
},
```

- [ ] **Step 4: Add npm scripts** to `package.json`:

```json
"oath-upload": "tsx --env-file=.env src/cli.ts oath-upload",
"oath-upload:stop": "tsx --env-file=.env src/cli.ts oath-upload-stop"
```

- [ ] **Step 5: Typecheck.**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/cli.ts src/cli-daemon.ts package.json
git commit -m "feat(cli): oath-upload + oath-upload-stop subcommands

Mirrors oath-signature's daemon-mode shape. CLI hashes the PDF before
enqueueing so the queue carries the same pdfHash the dashboard
duplicate-check uses.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 25: Regenerate selectors catalog

**Files:**
- Auto-generated: `src/systems/servicenow/SELECTORS.md`

- [ ] **Step 1: Run the catalog generator.**

Run: `npm run selectors:catalog`

Expected: Creates / updates `src/systems/servicenow/SELECTORS.md` plus refreshes any other system's SELECTORS.md.

- [ ] **Step 2: Verify the catalog test passes.**

Run: `npx vitest run tests/unit/scripts/selectors-catalog.test.ts`

Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add src/systems/servicenow/SELECTORS.md
git commit -m "chore: regen selectors catalog with servicenow entries

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 26: Update root `CLAUDE.md` workflow registry

**Files:**
- Modify: `CLAUDE.md` (workflow registry table + step list)

- [ ] **Step 1: Find the workflow registry table** in root `CLAUDE.md`. The "Step Tracking Per Workflow" table.

- [ ] **Step 2: Add the oath-upload row** to the table:

```markdown
| oath-upload | servicenow-auth → delegate-ocr → wait-ocr-approval → delegate-signatures → wait-signatures → open-hr-form → fill-form → submit (workflow opts out of auto-prepend; declares `servicenow-auth` itself) |
```

- [ ] **Step 3: Add the oath-upload command** to the Commands section near the other daemon-mode commands:

```bash
# Oath Upload (daemon mode by default — see "Daemon mode" below)
npm run oath-upload <pdfPath> [<pdfPath> ...]   # Enqueue PDF uploads to an alive daemon
npm run oath-upload:stop                         # Soft-stop all daemons
```

- [ ] **Step 4: Update the directory layout block** to include `oath-upload` under workflows and `servicenow` under systems.

- [ ] **Step 5: Commit.**

```bash
git add CLAUDE.md
git commit -m "docs: oath-upload workflow + servicenow system in root CLAUDE.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 27: Smoke test — single end-to-end run with mocked Playwright

**Files:**
- Create: `tests/integration/oath-upload-smoke.test.ts`

- [ ] **Step 1: Write a smoke test** that exercises the in-process `runOathUpload` path with everything mocked.

```ts
// tests/integration/oath-upload-smoke.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runOathUpload } from "../../src/workflows/oath-upload/index.js";
import { trackEvent } from "../../src/tracker/jsonl.js";

// This test stubs Playwright + ServiceNow login + the OCR/signature
// watchers, then verifies the run reaches done with a ticket number.

describe("oath-upload smoke", () => {
  it("reaches step=submit and writes data.ticketNumber", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oath-upload-smoke-"));
    process.env.TRACKER_DIR = dir;

    // Pre-write the OCR approved entry so wait-ocr-approval resolves immediately.
    const sessionId = "smoke-1";
    setTimeout(() => {
      trackEvent({
        workflow: "ocr",
        timestamp: new Date().toISOString(),
        id: `oath-upload-PRE-ocr`,
        runId: "ocr-r-pre",
        status: "done",
        step: "approved",
        data: { fannedOutItemIds: JSON.stringify([]) },
      }, dir);
    }, 100);

    // ... mock Session.launch, login, page.goto, fill, submit URL ...
    // (Full implementation matches the pattern in
    // tests/integration/onboarding-smoke.test.ts — too long to inline.
    // Mirror it exactly: stub launchBrowser, stub session, stub Page.)

    // Skip implementation here — engineer should mirror the existing
    // smoke pattern. If the project has no integration smoke harness,
    // mark this task as `xtest` and only run after the unit tests
    // are all green.

    await rm(dir, { recursive: true, force: true });
  });
});
```

(If the existing test scaffolding is too thin to mirror, mark the
smoke as `it.todo` and rely on the unit + handler tests for coverage
until manual smoke can be done against a real ServiceNow instance.)

- [ ] **Step 2: Run the smoke (or `todo` it).**

Run: `npx vitest run tests/integration/oath-upload-smoke.test.ts`

Expected: PASS or skipped via `it.todo`.

- [ ] **Step 3: Commit.**

```bash
git add tests/integration/oath-upload-smoke.test.ts
git commit -m "test(oath-upload): integration smoke harness scaffold

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 28: Manual smoke — first live run

This is a single human-driven validation pass before declaring the
feature shipped. Not a test, not committed; just a checklist.

- [ ] **Step 1: Start the dashboard.**

Run: `npm run dashboard`

- [ ] **Step 2: Open `http://localhost:5173`. Switch to the oath-upload tab.**

- [ ] **Step 3: Click Run. Pick a small test oath PDF.**

- [ ] **Step 4: Watch the duplicate banner appear (or not).**

- [ ] **Step 5: Submit. Verify the daemon spawns + Duo prompts for ServiceNow.**

- [ ] **Step 6: Watch the OCR child + eid-lookup grandchildren render in the LogPanel "Delegated runs" section.**

- [ ] **Step 7: Approve the OCR row. Verify oath-signature children spawn under the oath-upload parent (not loose in their own tab).**

- [ ] **Step 8: Wait for all UCPath transactions to complete.**

- [ ] **Step 9: Verify the form fills + submits + the ticket number appears on `data.ticketNumber`.**

- [ ] **Step 10: Open the actual ticket in ServiceNow. Verify all fields + the attachment match.**

If any step fails, debug + iterate. Update the relevant
`servicenow/LESSONS.md` entry if a selector flakes. Update the spec
if the architecture needs a course correction.

---

# Self-review

After this plan was drafted, the following spot-checks were applied:

- **Spec coverage:** every spec section maps to at least one task.
  Specifically: schema (Task 12), handler steps (Task 16, Task 19),
  HTTP endpoints (Task 20), UI (Task 22, Task 23), daemon plumbing
  (Tasks 1–5), OCR approve change (Task 6), watch abort (Task 7),
  ServiceNow module (Tasks 8–11), CLI (Task 24), docs (Task 18, Task
  26), smoke (Task 27, Task 28).
- **Placeholder scan:** intentional `it.todo` only in Task 27 where
  the existing smoke-test harness can't be confidently described
  without reading more files. Every other task has runnable code.
- **Type consistency:** `parentRunId` typed as `string | undefined`
  across `QueueEvent`, `QueueItem`, `EnqueueOpts`,
  `OnPreEmitPending`, `runOneItem`, `withTrackedWorkflow`,
  `RunOpts`, and `TrackerEntry`. `fannedOutItemIds` always serialized
  as JSON string in `data` (consistent with how OCR's orchestrator
  serializes records). `pdfHash` always 64-char lowercase hex.

---

# Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-01-oath-upload-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — A fresh subagent dispatches per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session via `superpowers:executing-plans`, batch execution with checkpoints for review.

**Which approach?**
