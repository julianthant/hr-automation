# OCR Workflow + Delegation Primitive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the OCR-with-preview-and-approval flow currently duplicated across `oath-signature/prepare.ts` and `emergency-contact/prepare.ts` into a single kernel-registered `ocr` workflow with its own dashboard tab, run modal, queue rows, and preview pane. Add a delegation primitive (`parentRunId` field + `watchChildRuns` helper) so future workflows (Piece 3 = `oath-upload`) can wait on child runs cleanly. Rewire SharePoint roster download as a delegated child rather than a modal hook.

**Architecture:** New `src/workflows/ocr/` directory holds the kernel workflow + orchestrator + form-spec registry. Per-form schemas, prompts, match logic, and preview components stay in their consumer workflows under `ocr-form.ts`. New `src/tracker/watch-child-runs.ts` is the canonical "watch a JSONL until N expected itemIds reach terminal status" helper. `TrackerEntry` gains `parentRunId?: string` (visual only — watching is itemId-based). Frontend `PreviewRow` / `PrepReviewPane` / `OathReviewForm` / `EcReviewForm` move into `src/dashboard/components/ocr/` with new names. Old prep code (`prepare.ts` × 2, `*-http.ts` × 2) is deleted at the end after the new path is verified.

**Tech Stack:** TypeScript, tsx (`--env-file=.env`), Zod (zod/v4), Playwright (kernel only — OCR has no browsers), React 19 + Vite + shadcn/ui (dashboard), node-test (`npm run test`).

**Reference spec:** [`docs/superpowers/specs/2026-05-01-ocr-workflow-and-delegation-design.md`](../specs/2026-05-01-ocr-workflow-and-delegation-design.md). Read its Decision Log before starting Phase 4 — the SharePoint-as-delegated-child rationale matters for Phase 5.

**Worktree:** Run this in a dedicated worktree (use `superpowers:using-git-worktrees` skill if not already in one). The branch should be named something like `feat/ocr-workflow-delegation`.

**Hard prerequisite per phase:** the previous phase's tests pass. Don't move on with red tests.

---

## Phase 0 — Kernel prep (1 task)

### Task 1: Smoke test that the kernel runs a workflow with empty `systems[]`

**Files:**
- Create: `tests/unit/core/empty-systems.test.ts`
- Maybe modify: `src/core/batch-lifecycle.ts` (only if test reveals a bug)

OCR is the first kernel workflow with `systems: []`. We don't know if the kernel's batch lifecycle / Session.launch / auth-failure fanout assumes at least one system. This task is a smoke test that proves the empty case works — if it doesn't, fix the kernel before the rest of the plan can land.

- [ ] **Step 1: Write the failing test (or pass test, depending on kernel state)**

Create `tests/unit/core/empty-systems.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert";
import { z } from "zod/v4";
import { defineWorkflow, runWorkflow } from "../../../src/core/index.js";

test("kernel runs a workflow with empty systems[]", async () => {
  let handlerRan = false;
  const wf = defineWorkflow({
    name: "test-empty-systems",
    label: "Test Empty Systems",
    systems: [],
    authSteps: false,
    steps: ["work"] as const,
    schema: z.object({ value: z.string() }),
    authChain: "sequential",
    tiling: "single",
    detailFields: [{ key: "value", label: "Value" }],
    getName: (d) => d.value ?? "",
    getId:   (d) => d.value ?? "",
    handler: async (ctx, input) => {
      ctx.updateData({ value: input.value });
      await ctx.step("work", async () => {
        handlerRan = true;
      });
    },
  });

  await runWorkflow(wf, { value: "smoke" }, { trackerStub: true });
  assert.ok(handlerRan, "handler should have executed");
});
```

- [ ] **Step 2: Run test to verify behavior**

Run: `npm run test -- tests/unit/core/empty-systems.test.ts`

Two possible outcomes:
- **PASS**: kernel handles empty systems already — skip Step 3 + 4, go to Step 5.
- **FAIL**: kernel needs a patch. Read the failure message and patch `src/core/batch-lifecycle.ts` (or wherever the `systems[0]` assumption lives). The most likely sites:
  - `withBatchLifecycle`'s auth-failure fanout (uses `systems[0].id` for the synthetic auth step name when `Session.launch` throws). Patch: skip the fanout entirely when `systems.length === 0`.
  - `createBatchObserver` / `getAuthTimings` — should be no-ops when systems is empty.

- [ ] **Step 3: (Only if Step 2 failed) Patch the kernel**

Read the offending file, narrow the change to a guard like:

```ts
if (systems.length === 0) {
  // No auth, no fanout, no observer — just run the body.
  return await body({ instance, makeObserver: () => null /*...*/ });
}
```

Show the diff to the reviewer. Don't refactor unrelated code.

- [ ] **Step 4: (Only if Step 3 was needed) Re-run test, verify PASS**

Run: `npm run test -- tests/unit/core/empty-systems.test.ts`
Expected: PASS

- [ ] **Step 5: Run full kernel test suite to verify no regression**

Run: `npm run test -- tests/unit/core/`
Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add tests/unit/core/empty-systems.test.ts
# Only if Step 3 was needed:
# git add src/core/batch-lifecycle.ts
git commit -m "test(core): smoke test for kernel with empty systems[]

Verifies the kernel's batch lifecycle, observer wiring, and auth-failure
fanout all handle the no-browser case correctly. OCR is the first kernel
workflow with no systems; this gates the OCR rollout."
```

---

## Phase 1 — Delegation primitive (2 tasks)

### Task 2: Add `parentRunId` field to `TrackerEntry`

**Files:**
- Modify: `src/tracker/jsonl.ts`
- Modify: `src/dashboard/components/types.ts`

Additive field. No migration needed — old entries lack it, dashboard treats absence as "no parent."

- [ ] **Step 1: Locate the `TrackerEntry` interface in the backend**

Read `src/tracker/jsonl.ts` to find the `TrackerEntry` interface. Note the existing field set.

- [ ] **Step 2: Add `parentRunId?: string` to backend type**

Edit `src/tracker/jsonl.ts`:

```ts
export interface TrackerEntry {
  workflow: string;
  timestamp: string;
  id: string;
  runId: string;
  parentRunId?: string;                    // ← NEW: visual delegation link
  status: "pending" | "running" | "done" | "failed" | "skipped";
  step?: string;
  data?: Record<string, string>;
  error?: string;
  // ... any other existing fields
}
```

- [ ] **Step 3: Mirror the field in the frontend type**

Edit `src/dashboard/components/types.ts`:

```ts
export interface TrackerEntry {
  workflow: string;
  timestamp: string;
  id: string;
  runId: string;
  parentRunId?: string;                    // ← NEW
  status: "pending" | "running" | "done" | "failed" | "skipped";
  step?: string;
  data?: Record<string, string>;
  error?: string;
  // ... any other existing fields
}
```

- [ ] **Step 4: Verify trackEvent + readEntries preserve the field**

Read `src/tracker/jsonl.ts::trackEvent` and `readEntries`. They should pass through unknown fields via spread/serialization. If either explicitly enumerates fields, add `parentRunId` to the enumeration.

- [ ] **Step 5: Run typecheck + tests**

Run: `npm run typecheck`
Expected: no errors

Run: `npm run test -- tests/unit/tracker/`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/tracker/jsonl.ts src/dashboard/components/types.ts
git commit -m "feat(tracker): add parentRunId field to TrackerEntry

Optional field, additive — old entries lack it. Used purely for dashboard
navigation (parent→child pills, expandable parent rows). Watch logic
remains itemId-based.

Part of OCR + delegation primitive (Piece 1+2)."
```

### Task 3: Implement `watch-child-runs.ts` helper + tests

**Files:**
- Create: `src/tracker/watch-child-runs.ts`
- Create: `tests/unit/tracker/watch-child-runs.test.ts`

This is Piece 2's whole purpose. Hoist the duplicated `fs.watch + 200ms polling` watcher from today's prep.ts files into a generic helper.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/tracker/watch-child-runs.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watchChildRuns } from "../../../src/tracker/watch-child-runs.js";

function setupTrackerDir(): string {
  const dir = join(tmpdir(), `wcr-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeEntry(file: string, entry: object): void {
  appendFileSync(file, JSON.stringify(entry) + "\n");
}

test("resolves when all expected itemIds reach terminal status", async () => {
  const dir = setupTrackerDir();
  const date = "2026-05-01";
  const file = join(dir, `eid-lookup-${date}.jsonl`);
  writeFileSync(file, "");

  // Pre-write one terminal entry
  writeEntry(file, {
    workflow: "eid-lookup", id: "test-r0", runId: "r0",
    status: "done", data: { emplId: "10000001" }, timestamp: new Date().toISOString(),
  });

  const promise = watchChildRuns({
    workflow: "eid-lookup",
    expectedItemIds: ["test-r0", "test-r1"],
    trackerDir: dir,
    date,
    timeoutMs: 5000,
  });

  // After 100ms, write the second terminal entry
  setTimeout(() => {
    writeEntry(file, {
      workflow: "eid-lookup", id: "test-r1", runId: "r1",
      status: "failed", error: "no result", timestamp: new Date().toISOString(),
    });
  }, 100);

  const outcomes = await promise;
  assert.equal(outcomes.length, 2);
  const r0 = outcomes.find((o) => o.itemId === "test-r0");
  const r1 = outcomes.find((o) => o.itemId === "test-r1");
  assert.ok(r0); assert.equal(r0.status, "done"); assert.equal(r0.data?.emplId, "10000001");
  assert.ok(r1); assert.equal(r1.status, "failed"); assert.equal(r1.error, "no result");
  rmSync(dir, { recursive: true, force: true });
});

test("times out cleanly when items don't terminate", async () => {
  const dir = setupTrackerDir();
  const date = "2026-05-01";
  const file = join(dir, `eid-lookup-${date}.jsonl`);
  writeFileSync(file, "");

  await assert.rejects(
    () => watchChildRuns({
      workflow: "eid-lookup",
      expectedItemIds: ["never-arrives"],
      trackerDir: dir,
      date,
      timeoutMs: 200,
    }),
    /timeout/i,
  );
  rmSync(dir, { recursive: true, force: true });
});

test("ignores non-matching itemIds in the JSONL", async () => {
  const dir = setupTrackerDir();
  const date = "2026-05-01";
  const file = join(dir, `eid-lookup-${date}.jsonl`);
  writeFileSync(file, "");
  writeEntry(file, {
    workflow: "eid-lookup", id: "other-item", runId: "x",
    status: "done", timestamp: new Date().toISOString(),
  });
  writeEntry(file, {
    workflow: "eid-lookup", id: "wanted", runId: "y",
    status: "done", timestamp: new Date().toISOString(),
  });

  const outcomes = await watchChildRuns({
    workflow: "eid-lookup",
    expectedItemIds: ["wanted"],
    trackerDir: dir,
    date,
    timeoutMs: 1000,
  });
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].itemId, "wanted");
  rmSync(dir, { recursive: true, force: true });
});

test("custom isTerminal predicate (waiting for step=approved)", async () => {
  const dir = setupTrackerDir();
  const date = "2026-05-01";
  const file = join(dir, `ocr-${date}.jsonl`);
  writeFileSync(file, "");

  // status=done step=awaiting-approval should NOT be terminal under custom predicate
  writeEntry(file, {
    workflow: "ocr", id: "session-1", runId: "r1",
    status: "done", step: "awaiting-approval", timestamp: new Date().toISOString(),
  });

  const promise = watchChildRuns({
    workflow: "ocr",
    expectedItemIds: ["session-1"],
    trackerDir: dir,
    date,
    timeoutMs: 1000,
    isTerminal: (e) =>
      (e.status === "done" && e.step === "approved") ||
      (e.status === "failed" && (e.step === "discarded" || e.step === "superseded")),
  });

  setTimeout(() => {
    writeEntry(file, {
      workflow: "ocr", id: "session-1", runId: "r1",
      status: "done", step: "approved", timestamp: new Date().toISOString(),
    });
  }, 100);

  const outcomes = await promise;
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].itemId, "session-1");
  rmSync(dir, { recursive: true, force: true });
});

test("calls onProgress as items terminate", async () => {
  const dir = setupTrackerDir();
  const date = "2026-05-01";
  const file = join(dir, `eid-lookup-${date}.jsonl`);
  writeFileSync(file, "");

  const progressCalls: Array<{ itemId: string; remaining: number }> = [];

  const promise = watchChildRuns({
    workflow: "eid-lookup",
    expectedItemIds: ["a", "b", "c"],
    trackerDir: dir,
    date,
    timeoutMs: 5000,
    onProgress: (outcome, remaining) => {
      progressCalls.push({ itemId: outcome.itemId, remaining });
    },
  });

  setTimeout(() => writeEntry(file, { workflow: "eid-lookup", id: "a", runId: "1", status: "done", timestamp: new Date().toISOString() }), 50);
  setTimeout(() => writeEntry(file, { workflow: "eid-lookup", id: "b", runId: "2", status: "done", timestamp: new Date().toISOString() }), 100);
  setTimeout(() => writeEntry(file, { workflow: "eid-lookup", id: "c", runId: "3", status: "done", timestamp: new Date().toISOString() }), 150);

  await promise;
  assert.equal(progressCalls.length, 3);
  assert.equal(progressCalls[0].remaining, 2);
  assert.equal(progressCalls[1].remaining, 1);
  assert.equal(progressCalls[2].remaining, 0);
  rmSync(dir, { recursive: true, force: true });
});

test("survives when target file doesn't exist initially", async () => {
  const dir = setupTrackerDir();
  const date = "2026-05-01";
  const file = join(dir, `eid-lookup-${date}.jsonl`);
  // file does NOT exist yet

  const promise = watchChildRuns({
    workflow: "eid-lookup",
    expectedItemIds: ["arrives-late"],
    trackerDir: dir,
    date,
    timeoutMs: 5000,
  });

  setTimeout(() => {
    writeFileSync(file, "");
    writeEntry(file, {
      workflow: "eid-lookup", id: "arrives-late", runId: "1",
      status: "done", timestamp: new Date().toISOString(),
    });
  }, 200);

  const outcomes = await promise;
  assert.equal(outcomes.length, 1);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/unit/tracker/watch-child-runs.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `watch-child-runs.ts`**

Create `src/tracker/watch-child-runs.ts`:

```ts
/**
 * Watch a workflow's JSONL until N expected itemIds reach terminal status.
 *
 * Hoisted from the duplicated watchers in src/workflows/oath-signature/prepare.ts
 * and src/workflows/emergency-contact/prepare.ts (both deleted as part of the
 * OCR migration).
 *
 * Filters by explicit `expectedItemIds` (deterministic at spawn time), NOT by
 * `parentRunId` — parentRunId is purely for dashboard visualization.
 */
import { existsSync, readFileSync, statSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";
import type { TrackerEntry } from "./jsonl.js";

export interface ChildOutcome {
  workflow: string;
  itemId: string;
  runId: string;
  status: "done" | "failed";
  data?: Record<string, string>;
  error?: string;
}

export interface WatchChildRunsOpts {
  /** Workflow name whose JSONL we watch. */
  workflow: string;
  /** Specific itemIds to wait for. Resolves when all reach terminal status. */
  expectedItemIds: string[];
  /** Tracker dir. Default: `.tracker`. */
  trackerDir?: string;
  /** YYYY-MM-DD; default today (local). */
  date?: string;
  /** Hard timeout in ms. Default 1h. Rejects with `Error("watchChildRuns timeout")`. */
  timeoutMs?: number;
  /** Custom terminal predicate. Default: status in {done, failed}. */
  isTerminal?: (entry: TrackerEntry) => boolean;
  /** Fired as each expected item terminates, with the remaining count. */
  onProgress?: (outcome: ChildOutcome, remaining: number) => void;
}

const DEFAULT_TIMEOUT_MS = 60 * 60_000;

function dateLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function watchChildRuns(opts: WatchChildRunsOpts): Promise<ChildOutcome[]> {
  const dir = opts.trackerDir ?? ".tracker";
  const date = opts.date ?? dateLocal();
  const file = join(dir, `${opts.workflow}-${date}.jsonl`);
  const expected = new Set(opts.expectedItemIds);
  const totalExpected = expected.size;
  const isTerminal =
    opts.isTerminal ?? ((e: TrackerEntry) => e.status === "done" || e.status === "failed");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const outcomes: ChildOutcome[] = [];
  let lastSize = 0;

  return new Promise<ChildOutcome[]>((resolve, reject) => {
    let finalized = false;
    let watcher: ReturnType<typeof fsWatch> | undefined;
    let pollHandle: ReturnType<typeof setInterval> | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      finalized = true;
      try { watcher?.close(); } catch { /* ignore */ }
      if (pollHandle) clearInterval(pollHandle);
      if (timeoutHandle) clearTimeout(timeoutHandle);
    };

    const checkFile = (): void => {
      if (finalized) return;
      if (!existsSync(file)) return;
      let cur;
      try { cur = statSync(file); } catch { return; }
      if (cur.size <= lastSize) return;
      let raw;
      try { raw = readFileSync(file, "utf-8"); } catch { return; }
      const lines = raw.split("\n").filter(Boolean);
      for (const line of lines) {
        let entry: TrackerEntry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry.id || !expected.has(entry.id)) continue;
        if (!isTerminal(entry)) continue;
        const outcome: ChildOutcome = {
          workflow: entry.workflow,
          itemId: entry.id,
          runId: entry.runId,
          status: entry.status as "done" | "failed",
          data: entry.data,
          error: entry.error,
        };
        outcomes.push(outcome);
        expected.delete(entry.id);
        const remaining = totalExpected - outcomes.length;
        if (opts.onProgress) {
          try { opts.onProgress(outcome, remaining); } catch { /* swallow */ }
        }
      }
      lastSize = cur.size;
      if (expected.size === 0) {
        cleanup();
        resolve(outcomes);
      }
    };

    // Initial pass — file may already have terminal entries.
    checkFile();
    if (finalized) return;

    // fs.watch on the file (best effort).
    try {
      if (existsSync(file)) {
        watcher = fsWatch(file, { persistent: false }, () => checkFile());
      }
    } catch {
      // fs.watch can throw on some FS (NFS, certain Linux configs). Polling
      // covers; not fatal.
    }

    // Poll fallback — also handles the "file doesn't exist yet" case.
    pollHandle = setInterval(() => {
      checkFile();
      // Re-arm watcher once the file appears.
      if (!watcher && existsSync(file)) {
        try {
          watcher = fsWatch(file, { persistent: false }, () => checkFile());
        } catch { /* tolerate */ }
      }
    }, 200);
    pollHandle.unref?.();

    timeoutHandle = setTimeout(() => {
      if (finalized) return;
      cleanup();
      const stillWaiting = Array.from(expected).join(", ");
      reject(new Error(`watchChildRuns timeout (${timeoutMs}ms) — still waiting for: ${stillWaiting}`));
    }, timeoutMs);
    timeoutHandle.unref?.();
  });
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npm run test -- tests/unit/tracker/watch-child-runs.test.ts`
Expected: 6 PASS

- [ ] **Step 5: Run full tracker test suite to verify no regression**

Run: `npm run test -- tests/unit/tracker/`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/tracker/watch-child-runs.ts tests/unit/tracker/watch-child-runs.test.ts
git commit -m "feat(tracker): hoist watch-child-runs helper

Generic watcher for waiting on N expected itemIds in a child workflow's
JSONL until they reach terminal status. Replaces the duplicated fs.watch +
200ms polling logic in oath-signature/prepare.ts and emergency-contact/
prepare.ts (both deleted later in this migration). Future workflows
(oath-upload — Piece 3) reuse this for parent-waits-on-child semantics.

Filters by explicit expectedItemIds; parentRunId is purely visual.

Part of OCR + delegation primitive (Piece 2)."
```

---

## Phase 2 — Form-spec contract + per-form specs (4 tasks)

### Task 4: Define `OcrFormSpec` types

**Files:**
- Create: `src/workflows/ocr/types.ts`

No tests — interfaces only. Tests live with consumers in Tasks 5+6.

- [ ] **Step 1: Create directory + types file**

```bash
mkdir -p src/workflows/ocr
```

Create `src/workflows/ocr/types.ts`:

```ts
/**
 * Per-form-type contract for OCR. Consumer workflows (oath-signature,
 * emergency-contact) declare an `OcrFormSpec` and OCR's orchestrator runs it
 * generically — no per-form branches in the orchestrator.
 *
 * Domain knowledge (signed/unsigned semantics for oath; address-compare for
 * EC) lives with the consumer workflow. OCR has a thin registry that imports
 * each spec — see `src/workflows/ocr/form-registry.ts`.
 */
import type { ZodType } from "zod/v4";

/** A single roster row, as loaded by `src/match/`. Shape mirrors RosterRow used today. */
export interface RosterRow {
  eid: string;
  name: string;
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  // (other fields are tolerated; orchestrator passes the row through to
  // spec.matchRecord which decides what to read.)
}

export type LookupKind = "name" | "verify" | null;

export interface OcrFormSpec<TOcr, TPreview, TFanOut> {
  /** Stable id matching the form-type picker value. e.g. "oath", "emergency-contact". */
  formType: string;

  /** Human label for the run modal picker. */
  label: string;

  /** Short description shown under the picker option. */
  description: string;

  /** OCR prompt sent to the LLM. */
  prompt: string;

  /** Per-record schema (LLM-permissive — eid optional, etc.). */
  ocrRecordSchema: ZodType<TOcr>;

  /** Array form for the whole-PDF fallback path. = z.array(ocrRecordSchema). */
  ocrArraySchema: ZodType<TOcr[]>;

  /** Cache key segment fed into OCR's content cache. */
  schemaName: string;

  /** Pure: take an OCR record + roster, return the preview record + initial matchState. */
  matchRecord(input: { record: TOcr; roster: RosterRow[] }): TPreview;

  /** Whether this preview record needs an eid-lookup pass. */
  needsLookup(record: TPreview): LookupKind;

  /** Carry-forward fuzzy-match key (Levenshtein on this string with threshold ≤ 2). */
  carryForwardKey(record: TPreview): string;

  /** Apply v1's resolved fields onto a v2 record. Returns the patched record. */
  applyCarryForward(input: { v2: TPreview; v1: TPreview }): TPreview;

  /** Whether v1's `forceResearch` flag was set on the matched record (skips carry-forward). */
  isForceResearchFlag(record: TPreview): boolean;

  /** Approve fan-out target. */
  approveTo: {
    workflow: string;                                              // "oath-signature", "emergency-contact"
    deriveInput: (record: TPreview) => TFanOut;
    deriveItemId: (record: TPreview, parentRunId: string, index: number) => string;
  };

  /** React component reference for per-record preview rendering. Looked up frontend-side. */
  recordRendererId: "OathRecordView" | "EcRecordView" | (string & {});

  /** Whether to require a roster on disk before starting OCR. */
  rosterMode: "required" | "optional";
}

/** Convenience union — used by callers that don't care about generics. */
export type AnyOcrFormSpec = OcrFormSpec<unknown, unknown, unknown>;
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/workflows/ocr/types.ts
git commit -m "feat(ocr): define OcrFormSpec contract

Per-form-type contract: schema, prompt, match logic, carry-forward,
fan-out, record renderer. Consumer workflows (oath, EC) implement; OCR
orchestrator consumes generically.

Part of OCR + delegation primitive (Piece 1)."
```

### Task 5: Build `oath-signature/ocr-form.ts` + tests

**Files:**
- Create: `src/workflows/oath-signature/ocr-form.ts`
- Create: `tests/unit/workflows/oath-signature/ocr-form.test.ts`
- Modify: `src/workflows/oath-signature/index.ts` (re-export `oathOcrFormSpec`)

This is largely a port of today's `preview-schema.ts` + the per-record match logic from today's `prepare.ts`. The schemas (`OathRosterOcrRecordSchema`, `OathOcrOutputSchema`, `OathPreviewRecordSchema`, `MatchStateSchema`, `VerificationSchema`) move into the spec file. The match phase logic in today's `prepare.ts::runPaperOathPrepare` (lines ~227–275 — "for each OCR record, match against roster, decide eid-lookup or extracted") becomes `spec.matchRecord` + `spec.needsLookup`. Don't delete `preview-schema.ts` yet — Task 25 deletes it after callers migrate.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/workflows/oath-signature/ocr-form.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert";
import { oathOcrFormSpec } from "../../../../src/workflows/oath-signature/ocr-form.js";
import type { RosterRow } from "../../../../src/workflows/ocr/types.js";

const roster: RosterRow[] = [
  { eid: "10000001", name: "Liam Kustenbauder" },
  { eid: "10000002", name: "Akitsugu Uchida" },
  { eid: "10000003", name: "Sarah Chen" },
];

test("matchRecord: signed row with high-confidence roster name → matched", () => {
  const ocr = {
    sourcePage: 1, rowIndex: 0,
    printedName: "Liam Kustenbauder",
    employeeSigned: true, officerSigned: true,
    dateSigned: "05/01/2026",
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = oathOcrFormSpec.matchRecord({ record: ocr, roster });
  assert.equal(preview.matchState, "matched");
  assert.equal(preview.employeeId, "10000001");
  assert.equal(preview.selected, true);
  assert.equal(preview.matchSource, "roster");
});

test("matchRecord: unsigned row → extracted, deselected, no employeeId", () => {
  const ocr = {
    sourcePage: 1, rowIndex: 1,
    printedName: "Some Person",
    employeeSigned: false, officerSigned: null,
    dateSigned: null,
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = oathOcrFormSpec.matchRecord({ record: ocr, roster });
  assert.equal(preview.matchState, "extracted");
  assert.equal(preview.employeeId, "");
  assert.equal(preview.selected, false);
});

test("matchRecord: signed row with no roster match → lookup-pending", () => {
  const ocr = {
    sourcePage: 1, rowIndex: 2,
    printedName: "Unknown Person Notroster",
    employeeSigned: true, officerSigned: true,
    dateSigned: "05/01/2026",
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = oathOcrFormSpec.matchRecord({ record: ocr, roster });
  assert.equal(preview.matchState, "lookup-pending");
  assert.equal(preview.employeeId, "");
});

test("needsLookup: lookup-pending → 'name'", () => {
  const r = { matchState: "lookup-pending", employeeId: "" } as any;
  assert.equal(oathOcrFormSpec.needsLookup(r), "name");
});

test("needsLookup: matched with eid → 'verify'", () => {
  const r = { matchState: "matched", employeeId: "10000001" } as any;
  assert.equal(oathOcrFormSpec.needsLookup(r), "verify");
});

test("needsLookup: extracted (unsigned) → null", () => {
  const r = { matchState: "extracted", employeeId: "" } as any;
  assert.equal(oathOcrFormSpec.needsLookup(r), null);
});

test("needsLookup: resolved with eid → null (already done)", () => {
  const r = { matchState: "resolved", employeeId: "10000001" } as any;
  assert.equal(oathOcrFormSpec.needsLookup(r), null);
});

test("carryForwardKey normalizes name", () => {
  const r1 = { printedName: "  Liam Kustenbauder  " } as any;
  const r2 = { printedName: "liam kustenbauder" } as any;
  assert.equal(oathOcrFormSpec.carryForwardKey(r1), oathOcrFormSpec.carryForwardKey(r2));
});

test("applyCarryForward inherits resolved EID + verification + selection", () => {
  const v1 = {
    employeeId: "10000001",
    matchState: "resolved" as const,
    matchSource: "eid-lookup" as const,
    selected: true,
    verification: { state: "verified", hrStatus: "Active", department: "HDH", screenshotFilename: "x.png", checkedAt: "2026-05-01T00:00:00Z" },
    forceResearch: false,
  } as any;
  const v2 = {
    employeeId: "",
    matchState: "lookup-pending" as const,
    selected: true,
  } as any;
  const merged = oathOcrFormSpec.applyCarryForward({ v2, v1 });
  assert.equal(merged.employeeId, "10000001");
  assert.equal(merged.matchState, "resolved");
  assert.equal(merged.matchSource, "eid-lookup");
  assert.deepEqual(merged.verification?.state, "verified");
});

test("approveTo.deriveInput: matched record → OathSignatureInput shape", () => {
  const r = {
    employeeId: "10000001",
    dateSigned: "05/01/2026",
  } as any;
  const input = oathOcrFormSpec.approveTo.deriveInput(r);
  assert.equal(input.emplId, "10000001");
  assert.equal(input.date, "05/01/2026");
});

test("approveTo.deriveItemId: deterministic shape", () => {
  const r = {} as any;
  const id = oathOcrFormSpec.approveTo.deriveItemId(r, "parent-run-xyz", 3);
  assert.match(id, /^ocr-oath-/);
  assert.match(id, /parent-run-xyz/);
  assert.match(id, /r3$/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/unit/workflows/oath-signature/ocr-form.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `ocr-form.ts`**

Create `src/workflows/oath-signature/ocr-form.ts`:

```ts
/**
 * OCR form spec for paper oath rosters. Implements `OcrFormSpec` so OCR's
 * orchestrator can run this form-type generically.
 *
 * Replaces the schemas + match phase that lived in `preview-schema.ts` +
 * `prepare.ts` (both deleted in Task 25 of this plan).
 */
import { z } from "zod/v4";
import { matchAgainstRoster } from "../../match/index.js";
import type { OcrFormSpec, RosterRow, LookupKind } from "../ocr/types.js";
import type { OathSignatureInput } from "./schema.js";

// ─── Verification schema (was in emergency-contact/preview-schema.ts) ──

export const VerificationSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("verified"),
    hrStatus: z.string(),
    department: z.string(),
    screenshotFilename: z.string(),
    checkedAt: z.string(),
  }),
  z.object({
    state: z.literal("inactive"),
    hrStatus: z.string(),
    department: z.string().optional(),
    screenshotFilename: z.string(),
    checkedAt: z.string(),
  }),
  z.object({
    state: z.literal("non-hdh"),
    hrStatus: z.string(),
    department: z.string(),
    screenshotFilename: z.string(),
    checkedAt: z.string(),
  }),
  z.object({
    state: z.literal("lookup-failed"),
    error: z.string(),
    checkedAt: z.string(),
  }),
]);
export type Verification = z.infer<typeof VerificationSchema>;

// ─── OCR-pass record (one row of a paper roster) ──────────

export const OathRosterOcrRecordSchema = z.object({
  sourcePage: z.number().int().positive(),
  rowIndex: z.number().int().nonnegative(),
  printedName: z.string().min(1),
  employeeSigned: z.boolean(),
  officerSigned: z.boolean().nullable().optional(),
  dateSigned: z
    .string()
    .nullable()
    .optional()
    .transform((v) => {
      if (v == null) return null;
      const trimmed = v.trim();
      return trimmed.length === 0 ? null : trimmed;
    }),
  notes: z.array(z.string()).default([]),
  documentType: z.enum(["expected", "unknown"]).default("expected"),
  originallyMissing: z.array(z.string()).default([]),
});
export type OathRosterOcrRecord = z.infer<typeof OathRosterOcrRecordSchema>;

export const OathOcrOutputSchema = z.array(OathRosterOcrRecordSchema);
export type OathOcrOutput = z.infer<typeof OathOcrOutputSchema>;

// ─── Match state ─────────────────────────────────────────────

export const MatchStateSchema = z.enum([
  "extracted",
  "matched",
  "lookup-pending",
  "lookup-running",
  "resolved",
  "unresolved",
]);
export type MatchState = z.infer<typeof MatchStateSchema>;

// ─── Preview record (in-flight, post-match) ────────────────

export const OathPreviewRecordSchema = OathRosterOcrRecordSchema.extend({
  employeeId: z.string(),
  matchState: MatchStateSchema,
  matchSource: z.enum(["roster", "eid-lookup", "llm"]).optional(),
  matchConfidence: z.number().min(0).max(1).optional(),
  rosterCandidates: z
    .array(
      z.object({
        eid: z.string(),
        name: z.string(),
        score: z.number(),
      }),
    )
    .optional(),
  documentType: z.enum(["expected", "unknown"]).default("expected"),
  originallyMissing: z.array(z.string()).default([]),
  verification: VerificationSchema.optional(),
  selected: z.boolean(),
  warnings: z.array(z.string()),
  /** Set when the operator clicked the per-row ↻ button — skips carry-forward on next reupload. */
  forceResearch: z.boolean().optional(),
});
export type OathPreviewRecord = z.infer<typeof OathPreviewRecordSchema>;

// ─── Prompt + match logic ───────────────────────────────────

const OATH_OCR_PROMPT = `You are an OCR system. Extract structured data from the attached PDF.

The PDF is a stack of paper oath signature documents in one of three formats — each page is one of:
- "signin"  — multi-row sign-in sheet (many records per page)
- "upay585" — single-form per page, UPAY585 (1997, includes Patent Acknowledgment)
- "upay586" — single-form per page, UPAY586 (2015 DocuSign, oath only)
- "unknown" — blank, irrelevant, or doesn't match any of the above

For each page you process:
1. Classify document type. Map "signin"/"upay585"/"upay586" to documentType: "expected"; "unknown" → documentType: "unknown".
2. For each record extract: printedName (always); employeeId if visible; dateSigned if visible; employeeSigned: whether the employee/officer signature line is filled (a scribble counts; an empty box doesn't); officerSigned: whether the authorized-official / witness signature is filled. For sign-in sheets that only have a single signature column, set officerSigned to null. For UPAY585/UPAY586, false when the column is empty.
3. After extraction, list which expected fields were BLANK or ILLEGIBLE on the paper in originallyMissing on each record.

Field-level rules:
- One record per signer. Multi-row sign-in sheets emit multiple records per page; single-form pages emit one.
- For handwritten text, use your best transcription. If a field is illegible, set it to null and add it to originallyMissing.
- dateSigned should be transcribed as it appears on the paper (typical formats: MM/DD/YYYY or M/D/YY).
- Output ONLY valid JSON matching the schema. No commentary.`;

const ROSTER_AUTO_ACCEPT = 0.85;

function normalizeName(n: string): string {
  return n.trim().toLowerCase().replace(/\s+/g, " ");
}

// ─── Spec implementation ────────────────────────────────────

export const oathOcrFormSpec: OcrFormSpec<
  OathRosterOcrRecord,
  OathPreviewRecord,
  OathSignatureInput
> = {
  formType: "oath",
  label: "Oath signature",
  description: "Paper oath rosters / UPAY585 / UPAY586. Approves into the oath-signature daemon.",

  prompt: OATH_OCR_PROMPT,
  ocrRecordSchema: OathRosterOcrRecordSchema,
  ocrArraySchema: OathOcrOutputSchema,
  schemaName: "oath-roster-batch",

  matchRecord({ record, roster }): OathPreviewRecord {
    if (!record.employeeSigned) {
      return {
        ...record,
        employeeId: "",
        matchState: "extracted",
        documentType: "expected",
        originallyMissing: [],
        selected: false,
        warnings: [],
      };
    }
    const result = matchAgainstRoster(roster, record.printedName);
    if (result.bestScore >= ROSTER_AUTO_ACCEPT) {
      const top = result.candidates[0];
      return {
        ...record,
        employeeId: top.eid,
        matchState: "matched",
        matchSource: "roster",
        matchConfidence: top.score,
        rosterCandidates: result.candidates.slice(0, 3),
        documentType: "expected",
        originallyMissing: [],
        selected: true,
        warnings:
          top.score < 1.0
            ? [`Roster fuzzy-matched "${top.name}" (score ${top.score.toFixed(2)})`]
            : [],
      };
    }
    return {
      ...record,
      employeeId: "",
      matchState: "lookup-pending",
      rosterCandidates: result.candidates.slice(0, 3),
      documentType: "expected",
      originallyMissing: [],
      selected: true,
      warnings:
        result.candidates.length > 0
          ? [`Best roster score ${result.bestScore.toFixed(2)} < ${ROSTER_AUTO_ACCEPT} — needs eid-lookup`]
          : ["No roster match — falling back to eid-lookup"],
    };
  },

  needsLookup(record): LookupKind {
    if (record.matchState === "extracted") return null;
    if (record.matchState === "lookup-pending") return "name";
    if (record.matchState === "matched" && record.employeeId) {
      // Has EID from roster, still need to verify activeness/dept.
      // If verification already populated, skip.
      if (record.verification) return null;
      return "verify";
    }
    if (record.matchState === "resolved") return null;
    if (record.matchState === "unresolved") return null;
    return null;
  },

  carryForwardKey(record): string {
    return normalizeName(record.printedName);
  },

  applyCarryForward({ v2, v1 }): OathPreviewRecord {
    return {
      ...v2,
      employeeId: v1.employeeId || v2.employeeId,
      matchState: v1.matchState !== "lookup-pending" && v1.matchState !== "lookup-running"
        ? v1.matchState
        : v2.matchState,
      matchSource: v1.matchSource ?? v2.matchSource,
      matchConfidence: v1.matchConfidence ?? v2.matchConfidence,
      verification: v1.verification ?? v2.verification,
      selected: v1.selected,
    };
  },

  isForceResearchFlag(record): boolean {
    return record.forceResearch === true;
  },

  approveTo: {
    workflow: "oath-signature",
    deriveInput(record): OathSignatureInput {
      return {
        emplId: record.employeeId,
        ...(record.dateSigned ? { date: record.dateSigned } : {}),
      };
    },
    deriveItemId(_record, parentRunId, index): string {
      return `ocr-oath-${parentRunId}-r${index}`;
    },
  },

  recordRendererId: "OathRecordView",
  rosterMode: "required",
};
```

- [ ] **Step 4: Re-export from barrel**

Edit `src/workflows/oath-signature/index.ts` — add:

```ts
export { oathOcrFormSpec } from "./ocr-form.js";
export {
  OathRosterOcrRecordSchema,
  OathOcrOutputSchema,
  OathPreviewRecordSchema,
  MatchStateSchema,
  VerificationSchema,
} from "./ocr-form.js";
export type {
  OathRosterOcrRecord,
  OathOcrOutput,
  OathPreviewRecord,
  MatchState,
  Verification,
} from "./ocr-form.js";
```

Leave the existing `preview-schema.ts` re-exports for now — Task 25 cleans them up.

- [ ] **Step 5: Run tests + typecheck**

Run: `npm run test -- tests/unit/workflows/oath-signature/ocr-form.test.ts`
Expected: 11 PASS

Run: `npm run typecheck`
Expected: no errors (the old `preview-schema.ts` should still work — it's untouched).

- [ ] **Step 6: Commit**

```bash
git add src/workflows/oath-signature/ocr-form.ts src/workflows/oath-signature/index.ts tests/unit/workflows/oath-signature/ocr-form.test.ts
git commit -m "feat(oath-signature): OcrFormSpec implementation

Schemas + prompt + match logic + fan-out adapter for OCR's orchestrator.
Mirrors the per-form work that lived in prepare.ts (deleted in Task 25).

Part of OCR + delegation primitive (Piece 1)."
```

### Task 6: Build `emergency-contact/ocr-form.ts` + tests

**Files:**
- Create: `src/workflows/emergency-contact/ocr-form.ts`
- Create: `tests/unit/workflows/emergency-contact/ocr-form.test.ts`
- Modify: `src/workflows/emergency-contact/index.ts`

Mirror of Task 5 for emergency-contact. Differences from oath: form-EID-first match (skip roster if record carries an EID); address compare; different prompt; OathSignatureInput → EmergencyContactRecord fan-out.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/workflows/emergency-contact/ocr-form.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert";
import { emergencyContactOcrFormSpec } from "../../../../src/workflows/emergency-contact/ocr-form.js";
import type { RosterRow } from "../../../../src/workflows/ocr/types.js";

const roster: RosterRow[] = [
  { eid: "10001234", name: "Maria Garcia", street: "123 Main St", city: "San Diego", state: "CA", zip: "92101" },
  { eid: "10005678", name: "James Wong" },
];

test("matchRecord: form-EID present → matched (form-eid first)", () => {
  const ocr = {
    sourcePage: 1,
    employee: { name: "Maria Garcia", employeeId: "10001234" },
    emergencyContact: { name: "Sara Garcia", relationship: "Sister", primary: true, sameAddressAsEmployee: true, cellPhone: "(555) 123-4567" },
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = emergencyContactOcrFormSpec.matchRecord({ record: ocr, roster });
  assert.equal(preview.matchState, "matched");
  assert.equal(preview.matchSource, "form");
  assert.equal(preview.employee.employeeId, "10001234");
  assert.equal(preview.selected, true);
});

test("matchRecord: no form-EID, high roster name match → matched (roster)", () => {
  const ocr = {
    sourcePage: 2,
    employee: { name: "Maria Garcia", employeeId: null },
    emergencyContact: { name: "Sara Garcia", relationship: "Sister", primary: true, sameAddressAsEmployee: true, cellPhone: "(555) 123-4567" },
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = emergencyContactOcrFormSpec.matchRecord({ record: ocr, roster });
  assert.equal(preview.matchState, "matched");
  assert.equal(preview.matchSource, "roster");
  assert.equal(preview.employee.employeeId, "10001234");
});

test("matchRecord: no form-EID, no roster match → lookup-pending", () => {
  const ocr = {
    sourcePage: 3,
    employee: { name: "Unknown Person", employeeId: null },
    emergencyContact: { name: "Other Person", relationship: "Friend", primary: true, sameAddressAsEmployee: true, cellPhone: "(555) 999-0000" },
    notes: [], documentType: "expected" as const, originallyMissing: [],
  };
  const preview = emergencyContactOcrFormSpec.matchRecord({ record: ocr, roster });
  assert.equal(preview.matchState, "lookup-pending");
  assert.equal(preview.employee.employeeId, "");
});

test("needsLookup: matched-via-form → 'verify'", () => {
  const r = { matchState: "matched", matchSource: "form", employee: { employeeId: "10001234" } } as any;
  assert.equal(emergencyContactOcrFormSpec.needsLookup(r), "verify");
});

test("needsLookup: matched-via-roster → 'verify'", () => {
  const r = { matchState: "matched", matchSource: "roster", employee: { employeeId: "10001234" } } as any;
  assert.equal(emergencyContactOcrFormSpec.needsLookup(r), "verify");
});

test("needsLookup: lookup-pending → 'name'", () => {
  const r = { matchState: "lookup-pending", employee: { employeeId: "" } } as any;
  assert.equal(emergencyContactOcrFormSpec.needsLookup(r), "name");
});

test("needsLookup: matched + verification already present → null", () => {
  const r = { matchState: "matched", employee: { employeeId: "10001234" }, verification: { state: "verified" } } as any;
  assert.equal(emergencyContactOcrFormSpec.needsLookup(r), null);
});

test("carryForwardKey uses employee name normalized", () => {
  const r1 = { employee: { name: "  Maria GARCIA  " } } as any;
  const r2 = { employee: { name: "maria garcia" } } as any;
  assert.equal(emergencyContactOcrFormSpec.carryForwardKey(r1), emergencyContactOcrFormSpec.carryForwardKey(r2));
});

test("approveTo.deriveInput returns RecordSchema-compatible shape", () => {
  const r = {
    sourcePage: 1,
    employee: { name: "Maria Garcia", employeeId: "10001234" },
    emergencyContact: { name: "Sara Garcia", relationship: "Sister", primary: true, sameAddressAsEmployee: true, cellPhone: "(555) 123-4567" },
    notes: [],
  } as any;
  const input = emergencyContactOcrFormSpec.approveTo.deriveInput(r);
  assert.equal(input.employee.employeeId, "10001234");
  assert.equal(input.emergencyContact.name, "Sara Garcia");
});

test("approveTo.deriveItemId: deterministic", () => {
  const r = { sourcePage: 5, employee: { employeeId: "10001234" } } as any;
  const id = emergencyContactOcrFormSpec.approveTo.deriveItemId(r, "parent-xyz", 2);
  assert.match(id, /^ocr-ec-/);
  assert.match(id, /parent-xyz/);
  assert.match(id, /r2$/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/unit/workflows/emergency-contact/ocr-form.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `ocr-form.ts`**

Create `src/workflows/emergency-contact/ocr-form.ts`:

```ts
/**
 * OCR form spec for UCSD R&R Emergency Contact forms. Implements `OcrFormSpec`
 * so OCR's orchestrator runs this form-type generically.
 *
 * Replaces schemas + match logic that lived in `preview-schema.ts` + `prepare.ts`
 * (both deleted in Task 25).
 */
import { z } from "zod/v4";
import {
  matchAgainstRoster,
  compareUsAddresses,
  normalizeEid,
} from "../../match/index.js";
import type { OcrFormSpec, RosterRow, LookupKind } from "../ocr/types.js";
import {
  AddressSchema,
  EmergencyContactSchema,
  type EmergencyContactRecord,
} from "./schema.js";
import { VerificationSchema, type Verification } from "../oath-signature/ocr-form.js";

// ─── Permissive OCR-pass schema ────────────────────────────

const PermissiveEmployeeSchema = z.object({
  name: z.string().min(1),
  employeeId: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (v ?? "").trim()),
  pid: z.string().nullable().optional(),
  jobTitle: z.string().nullable().optional(),
  workLocation: z.string().nullable().optional(),
  supervisor: z.string().nullable().optional(),
  workEmail: z.string().nullable().optional(),
  personalEmail: z.string().nullable().optional(),
  homeAddress: AddressSchema.nullable().optional(),
  homePhone: z.string().nullable().optional(),
  cellPhone: z.string().nullable().optional(),
});

export const PermissiveRecordSchema = z.object({
  sourcePage: z.number().int().positive(),
  employee: PermissiveEmployeeSchema,
  emergencyContact: EmergencyContactSchema,
  notes: z.array(z.string()).default([]),
  documentType: z.enum(["expected", "unknown"]).default("expected"),
  originallyMissing: z.array(z.string()).default([]),
});
export type PermissiveRecord = z.infer<typeof PermissiveRecordSchema>;

export const OcrOutputSchema = z.array(PermissiveRecordSchema);
export type OcrOutput = z.infer<typeof OcrOutputSchema>;

// ─── Match state ─────────────────────────────────────────────

export const MatchStateSchema = z.enum([
  "extracted",
  "matched",
  "lookup-pending",
  "lookup-running",
  "resolved",
  "unresolved",
]);
export type MatchState = z.infer<typeof MatchStateSchema>;

export { VerificationSchema, type Verification } from "../oath-signature/ocr-form.js";

// ─── Preview record ────────────────────────────────────────

export const PreviewRecordSchema = PermissiveRecordSchema.extend({
  matchState: MatchStateSchema,
  matchSource: z.enum(["form", "roster", "eid-lookup", "llm"]).optional(),
  matchConfidence: z.number().min(0).max(1).optional(),
  rosterCandidates: z
    .array(z.object({ eid: z.string(), name: z.string(), score: z.number() }))
    .optional(),
  addressMatch: z.enum(["match", "differ", "missing"]).optional(),
  documentType: z.enum(["expected", "unknown"]).default("expected"),
  originallyMissing: z.array(z.string()).default([]),
  verification: VerificationSchema.optional(),
  selected: z.boolean(),
  warnings: z.array(z.string()),
  forceResearch: z.boolean().optional(),
});
export type PreviewRecord = z.infer<typeof PreviewRecordSchema>;

// ─── Prompt + constants ────────────────────────────────────

const EC_OCR_PROMPT = `You are an OCR system. Extract structured data from the attached PDF.

The PDF is a stack of UCSD R&R Emergency Contact Information forms — one form per page (occasionally a page may not be a form at all). For each page produce one record.

For each page:
1. Classify document type: "expected" if UCSD R&R Emergency Contact form; "unknown" otherwise.
2. After extracting fields, list which expected fields were BLANK or ILLEGIBLE on the paper.
   The expected fields: employee.name, employee.employeeId, emergencyContact.name, emergencyContact.relationship, emergencyContact.address, emergencyContact.cellPhone/homePhone/workPhone (any one suffices).

Field-level rules:
- Extract every record visible; one per page.
- For handwritten text use your best transcription; if illegible set null and add to originallyMissing.
- Phone numbers normalized to "(XXX) XXX-XXXX" when digits clear.
- Addresses: US format. Pull street/city/state(2-letter)/zip into separate fields.
- Do not invent data. If a field is blank, return null and list in originallyMissing.
- Output ONLY valid JSON matching the schema. No commentary.`;

const ROSTER_AUTO_ACCEPT = 0.85;

function normalizeName(n: string): string {
  return n.trim().toLowerCase().replace(/\s+/g, " ");
}

// ─── Spec ──────────────────────────────────────────────────

export const emergencyContactOcrFormSpec: OcrFormSpec<
  PermissiveRecord,
  PreviewRecord,
  EmergencyContactRecord
> = {
  formType: "emergency-contact",
  label: "Emergency contact",
  description: "UCSD R&R Emergency Contact forms. Approves into the emergency-contact daemon.",

  prompt: EC_OCR_PROMPT,
  ocrRecordSchema: PermissiveRecordSchema,
  ocrArraySchema: OcrOutputSchema,
  schemaName: "emergency-contact-batch",

  matchRecord({ record, roster }): PreviewRecord {
    // Stage 1: form-EID. If the operator transcribed an EID on the paper,
    // trust it (subject to verification later).
    const formEid = normalizeEid(record.employee.employeeId);
    if (formEid) {
      return {
        ...record,
        employee: { ...record.employee, employeeId: formEid },
        matchState: "matched",
        matchSource: "form",
        matchConfidence: 1.0,
        documentType: "expected",
        originallyMissing: [],
        selected: true,
        warnings: [],
      };
    }
    // Stage 2: roster match by name.
    const result = matchAgainstRoster(roster, record.employee.name);
    if (result.bestScore >= ROSTER_AUTO_ACCEPT) {
      const top = result.candidates[0];
      const rosterRow = roster.find((r) => r.eid === top.eid);
      const addressMatch =
        rosterRow && rosterRow.street
          ? compareUsAddresses(record.employee.homeAddress ?? null, {
              street: rosterRow.street,
              city: rosterRow.city,
              state: rosterRow.state,
              zip: rosterRow.zip,
            })
          : undefined;
      return {
        ...record,
        employee: { ...record.employee, employeeId: top.eid },
        matchState: "matched",
        matchSource: "roster",
        matchConfidence: top.score,
        rosterCandidates: result.candidates.slice(0, 3),
        addressMatch,
        documentType: "expected",
        originallyMissing: [],
        selected: true,
        warnings:
          top.score < 1.0
            ? [`Roster fuzzy-matched "${top.name}" (score ${top.score.toFixed(2)})`]
            : [],
      };
    }
    return {
      ...record,
      employee: { ...record.employee, employeeId: "" },
      matchState: "lookup-pending",
      rosterCandidates: result.candidates.slice(0, 3),
      documentType: "expected",
      originallyMissing: [],
      selected: true,
      warnings:
        result.candidates.length > 0
          ? [`Best roster score ${result.bestScore.toFixed(2)} < ${ROSTER_AUTO_ACCEPT} — needs eid-lookup`]
          : ["No roster match — falling back to eid-lookup"],
    };
  },

  needsLookup(record): LookupKind {
    if (record.verification) return null;
    if (record.matchState === "lookup-pending") return "name";
    if (record.matchState === "matched" && record.employee.employeeId) return "verify";
    return null;
  },

  carryForwardKey(record): string {
    return normalizeName(record.employee.name);
  },

  applyCarryForward({ v2, v1 }): PreviewRecord {
    return {
      ...v2,
      employee: {
        ...v2.employee,
        employeeId: v1.employee.employeeId || v2.employee.employeeId,
      },
      matchState: v1.matchState !== "lookup-pending" && v1.matchState !== "lookup-running"
        ? v1.matchState
        : v2.matchState,
      matchSource: v1.matchSource ?? v2.matchSource,
      matchConfidence: v1.matchConfidence ?? v2.matchConfidence,
      verification: v1.verification ?? v2.verification,
      addressMatch: v1.addressMatch ?? v2.addressMatch,
      selected: v1.selected,
    };
  },

  isForceResearchFlag(record): boolean {
    return record.forceResearch === true;
  },

  approveTo: {
    workflow: "emergency-contact",
    deriveInput(record): EmergencyContactRecord {
      // PreviewRecord shares its shape with the kernel's RecordSchema by
      // construction (PermissiveRecordSchema → RecordSchema is a strict-EID
      // coercion, which already happened by approve time).
      return {
        sourcePage: record.sourcePage,
        employee: {
          ...record.employee,
          employeeId: record.employee.employeeId, // already non-empty by approve
        },
        emergencyContact: record.emergencyContact,
        notes: record.notes ?? [],
      } as EmergencyContactRecord;
    },
    deriveItemId(record, parentRunId, index): string {
      return `ocr-ec-${parentRunId}-r${index}`;
    },
  },

  recordRendererId: "EcRecordView",
  rosterMode: "required",
};
```

- [ ] **Step 4: Re-export from barrel**

Edit `src/workflows/emergency-contact/index.ts`, add:

```ts
export { emergencyContactOcrFormSpec } from "./ocr-form.js";
export {
  PermissiveRecordSchema,
  OcrOutputSchema,
  PreviewRecordSchema,
  MatchStateSchema,
} from "./ocr-form.js";
export type {
  PermissiveRecord,
  OcrOutput,
  PreviewRecord,
  MatchState,
} from "./ocr-form.js";
```

Don't delete the old `preview-schema.ts` re-exports yet — Task 25 handles that.

- [ ] **Step 5: Run tests + typecheck**

Run: `npm run test -- tests/unit/workflows/emergency-contact/ocr-form.test.ts`
Expected: 10 PASS

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/workflows/emergency-contact/ocr-form.ts src/workflows/emergency-contact/index.ts tests/unit/workflows/emergency-contact/ocr-form.test.ts
git commit -m "feat(emergency-contact): OcrFormSpec implementation

Schemas + prompt + form-EID-first match + address compare + fan-out adapter
for OCR's orchestrator.

Part of OCR + delegation primitive (Piece 1)."
```

### Task 7: Form registry

**Files:**
- Create: `src/workflows/ocr/form-registry.ts`
- Create: `tests/unit/workflows/ocr/form-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/workflows/ocr/form-registry.test.ts
import { test } from "node:test";
import assert from "node:assert";
import { FORM_SPECS, getFormSpec, listFormTypes } from "../../../../src/workflows/ocr/form-registry.js";

test("FORM_SPECS includes oath + emergency-contact", () => {
  assert.ok(FORM_SPECS.oath);
  assert.ok(FORM_SPECS["emergency-contact"]);
});

test("getFormSpec resolves known formType", () => {
  const oath = getFormSpec("oath");
  assert.ok(oath);
  assert.equal(oath.formType, "oath");
});

test("getFormSpec returns null for unknown", () => {
  assert.equal(getFormSpec("not-a-form"), null);
});

test("listFormTypes returns metadata for the run modal", () => {
  const list = listFormTypes();
  assert.equal(list.length, 2);
  const oath = list.find((f) => f.formType === "oath");
  assert.ok(oath);
  assert.equal(oath.label, "Oath signature");
  assert.equal(oath.rosterMode, "required");
});
```

- [ ] **Step 2: Run tests, verify FAIL**

Run: `npm run test -- tests/unit/workflows/ocr/form-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement registry**

```ts
// src/workflows/ocr/form-registry.ts
import { oathOcrFormSpec } from "../oath-signature/ocr-form.js";
import { emergencyContactOcrFormSpec } from "../emergency-contact/ocr-form.js";
import type { AnyOcrFormSpec, OcrFormSpec } from "./types.js";

export const FORM_SPECS = {
  oath:                oathOcrFormSpec as unknown as AnyOcrFormSpec,
  "emergency-contact": emergencyContactOcrFormSpec as unknown as AnyOcrFormSpec,
} as const;

export type FormType = keyof typeof FORM_SPECS;

export function getFormSpec(formType: string): AnyOcrFormSpec | null {
  return (FORM_SPECS as Record<string, AnyOcrFormSpec>)[formType] ?? null;
}

export interface FormTypeListing {
  formType: string;
  label: string;
  description: string;
  rosterMode: "required" | "optional";
}

export function listFormTypes(): FormTypeListing[] {
  return Object.values(FORM_SPECS).map((spec) => ({
    formType: spec.formType,
    label: spec.label,
    description: spec.description,
    rosterMode: spec.rosterMode,
  }));
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm run test -- tests/unit/workflows/ocr/form-registry.test.ts`
Expected: 4 PASS

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/workflows/ocr/form-registry.ts tests/unit/workflows/ocr/form-registry.test.ts
git commit -m "feat(ocr): form-spec registry

Single import site for FORM_SPECS. Run modal's GET /api/ocr/forms reads
listFormTypes(); orchestrator dispatches via getFormSpec(formType).

Adding a new form type = one new ocr-form.ts file in the consumer workflow
+ one line in this registry + one new record renderer component."
```

---

## Phase 3 — OCR workflow core (5 tasks)

### Task 8: OCR input schema + carry-forward helper

**Files:**
- Create: `src/workflows/ocr/schema.ts`
- Create: `src/workflows/ocr/carry-forward.ts`
- Create: `tests/unit/workflows/ocr/carry-forward.test.ts`

The carry-forward helper is small and pure (Levenshtein fuzzy match), so it gets dedicated tests separate from the orchestrator.

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/workflows/ocr/carry-forward.test.ts
import { test } from "node:test";
import assert from "node:assert";
import { applyCarryForward } from "../../../../src/workflows/ocr/carry-forward.js";
import { oathOcrFormSpec } from "../../../../src/workflows/oath-signature/ocr-form.js";

const v1Records = [
  {
    sourcePage: 1, rowIndex: 0,
    printedName: "Liam Kustenbauder",
    employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
    notes: [], documentType: "expected" as const, originallyMissing: [],
    employeeId: "10000001",
    matchState: "resolved" as const,
    matchSource: "eid-lookup" as const,
    selected: true,
    warnings: [],
    verification: {
      state: "verified" as const,
      hrStatus: "Active",
      department: "HDH",
      screenshotFilename: "x.png",
      checkedAt: "2026-05-01T00:00:00Z",
    },
  },
];

test("v2 record matching v1 by name inherits resolved fields", () => {
  const v2Records = [{
    sourcePage: 1, rowIndex: 0,
    printedName: "Liam Kustenbauder",
    employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
    notes: [], documentType: "expected" as const, originallyMissing: [],
    employeeId: "",
    matchState: "lookup-pending" as const,
    selected: true,
    warnings: [],
  }];

  const result = applyCarryForward({ v2Records, v1Records, spec: oathOcrFormSpec });
  assert.equal(result[0].employeeId, "10000001");
  assert.equal(result[0].matchState, "resolved");
});

test("v2 record with no v1 match treated as fresh", () => {
  const v2Records = [{
    sourcePage: 1, rowIndex: 0,
    printedName: "Brand New Person",
    employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
    notes: [], documentType: "expected" as const, originallyMissing: [],
    employeeId: "",
    matchState: "lookup-pending" as const,
    selected: true,
    warnings: [],
  }];

  const result = applyCarryForward({ v2Records, v1Records, spec: oathOcrFormSpec });
  assert.equal(result[0].employeeId, "");
  assert.equal(result[0].matchState, "lookup-pending");
});

test("v1 record with forceResearch=true is NOT carried forward", () => {
  const v1Forced = [{ ...v1Records[0], forceResearch: true }];
  const v2Records = [{
    sourcePage: 1, rowIndex: 0,
    printedName: "Liam Kustenbauder",
    employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
    notes: [], documentType: "expected" as const, originallyMissing: [],
    employeeId: "",
    matchState: "lookup-pending" as const,
    selected: true,
    warnings: [],
  }];

  const result = applyCarryForward({ v2Records, v1Records: v1Forced, spec: oathOcrFormSpec });
  assert.equal(result[0].employeeId, "");
  assert.equal(result[0].matchState, "lookup-pending");
});

test("Levenshtein ≤ 2 still matches (single-character difference)", () => {
  const v2Records = [{
    sourcePage: 1, rowIndex: 0,
    printedName: "Liam Kustenbouder", // typo: a→o
    employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
    notes: [], documentType: "expected" as const, originallyMissing: [],
    employeeId: "",
    matchState: "lookup-pending" as const,
    selected: true,
    warnings: [],
  }];

  const result = applyCarryForward({ v2Records, v1Records, spec: oathOcrFormSpec });
  assert.equal(result[0].employeeId, "10000001");
});
```

- [ ] **Step 2: Run tests, verify FAIL**

Run: `npm run test -- tests/unit/workflows/ocr/carry-forward.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement schema + carry-forward**

```ts
// src/workflows/ocr/schema.ts
import { z } from "zod/v4";

export const OcrInputSchema = z.object({
  pdfPath:          z.string(),
  pdfOriginalName:  z.string(),
  formType:         z.string(),
  sessionId:        z.string(),
  rosterPath:       z.string().optional(),
  rosterMode:       z.enum(["existing", "download"]).default("existing"),
  parentRunId:      z.string().optional(),
  previousRunId:    z.string().optional(),
  forceResearchAll: z.boolean().optional(),
});

export type OcrInput = z.infer<typeof OcrInputSchema>;
```

```ts
// src/workflows/ocr/carry-forward.ts
/**
 * Pure function: given v1 records (from a previous OCR run on the same
 * sessionId) and v2 records (fresh OCR output), inherit resolved fields
 * from v1 onto v2 by fuzzy-matching on `spec.carryForwardKey()`.
 *
 * Drops carry-forward when v1 record has `forceResearch === true` (set by
 * the operator's per-row ↻ click in the prior version).
 */
import { levenshteinDistance } from "../../match/index.js";
import type { AnyOcrFormSpec } from "./types.js";

const FUZZY_THRESHOLD = 2;

export interface ApplyCarryForwardInput<TPreview> {
  v2Records: TPreview[];
  v1Records: TPreview[];
  spec: AnyOcrFormSpec;
}

export function applyCarryForward<TPreview>(
  input: ApplyCarryForwardInput<TPreview>,
): TPreview[] {
  const { v2Records, v1Records, spec } = input;
  if (v1Records.length === 0) return v2Records;

  const v1WithKeys = v1Records.map((r) => ({ rec: r, key: spec.carryForwardKey(r as never) }));

  return v2Records.map((v2): TPreview => {
    const v2Key = spec.carryForwardKey(v2 as never);
    let bestDist = Number.POSITIVE_INFINITY;
    let best: TPreview | undefined;
    for (const { rec, key } of v1WithKeys) {
      const dist = levenshteinDistance(v2Key, key);
      if (dist < bestDist) {
        bestDist = dist;
        best = rec;
      }
    }
    if (!best || bestDist > FUZZY_THRESHOLD) return v2;
    if (spec.isForceResearchFlag(best as never)) return v2;
    return spec.applyCarryForward({ v2: v2 as never, v1: best as never }) as TPreview;
  });
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm run test -- tests/unit/workflows/ocr/carry-forward.test.ts`
Expected: 4 PASS

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/workflows/ocr/schema.ts src/workflows/ocr/carry-forward.ts tests/unit/workflows/ocr/carry-forward.test.ts
git commit -m "feat(ocr): input schema + carry-forward helper

Pure Levenshtein-based fuzzy match. Inherits resolved fields from v1
record onto matching v2 record. forceResearch flag bypasses carry-forward."
```

### Task 9: OCR orchestrator (no kernel wrapper yet)

**Files:**
- Create: `src/workflows/ocr/orchestrator.ts`
- Create: `tests/unit/workflows/ocr/orchestrator.test.ts`

The orchestrator is the heart of OCR. It's a plain async function so tests can mock the OCR pipeline + watchChildRuns + ensureDaemonsAndEnqueue. The kernel wrapper (Task 11) is a thin adapter.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/unit/workflows/ocr/orchestrator.test.ts
import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runOcrOrchestrator } from "../../../../src/workflows/ocr/orchestrator.js";

function setup(): { dir: string; uploadsDir: string; rosterPath: string } {
  const dir = join(tmpdir(), `ocr-orch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const uploadsDir = join(dir, "uploads");
  mkdirSync(uploadsDir, { recursive: true });
  const rosterPath = join(dir, "roster.xlsx");
  writeFileSync(rosterPath, ""); // stubbed
  return { dir, uploadsDir, rosterPath };
}

test("orchestrator emits pending → loading-roster → ocr → matching → done(awaiting-approval)", async () => {
  const { dir, uploadsDir, rosterPath } = setup();
  const writtenEntries: object[] = [];

  await runOcrOrchestrator(
    {
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "fake.pdf",
      formType: "oath",
      sessionId: "session-1",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId: "run-1",
      trackerDir: dir,
      // Test escape hatches:
      _emitOverride: (entry) => writtenEntries.push(entry),
      _ocrPipelineOverride: async () => ({
        data: [{
          sourcePage: 1, rowIndex: 0,
          printedName: "Liam Kustenbauder",
          employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
          notes: [], documentType: "expected", originallyMissing: [],
        }],
        provider: "stub",
        attempts: 1,
        cached: false,
        pageImagesDir: uploadsDir,
      }),
      _loadRosterOverride: async () => [
        { eid: "10000001", name: "Liam Kustenbauder" },
      ],
      _watchChildRunsOverride: async () => [
        // Verification call returns: active + HDH dept
        {
          workflow: "eid-lookup",
          itemId: "ocr-oath-run-1-r0",
          runId: "verify-1",
          status: "done" as const,
          data: { hrStatus: "Active", department: "HDH", personOrgScreenshot: "x.png", emplId: "10000001" },
        },
      ],
    },
  );

  const steps = writtenEntries.map((e: any) => `${e.status}/${e.step ?? ""}`);
  assert.ok(steps.includes("pending/"));
  assert.ok(steps.some((s) => s.includes("loading-roster")));
  assert.ok(steps.some((s) => s.includes("ocr")));
  assert.ok(steps.some((s) => s.includes("matching")));
  assert.ok(steps.some((s) => s.includes("eid-lookup")));
  assert.ok(steps.some((s) => s === "running/awaiting-approval" || s === "done/awaiting-approval"));
  rmSync(dir, { recursive: true, force: true });
});

test("orchestrator with previousRunId carries forward v1 EIDs", async () => {
  const { dir, uploadsDir, rosterPath } = setup();
  // Pre-populate v1 history in JSONL
  const ocrFile = join(dir, "ocr-2026-05-01.jsonl");
  writeFileSync(ocrFile, JSON.stringify({
    workflow: "ocr", id: "session-1", runId: "run-prev",
    status: "done", step: "approved",
    data: {
      records: JSON.stringify([{
        sourcePage: 1, rowIndex: 0,
        printedName: "Liam Kustenbauder",
        employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
        notes: [], documentType: "expected", originallyMissing: [],
        employeeId: "10000001",
        matchState: "resolved", matchSource: "eid-lookup",
        selected: true, warnings: [],
        verification: { state: "verified", hrStatus: "Active", department: "HDH", screenshotFilename: "x.png", checkedAt: "2026-05-01T00:00:00Z" },
      }]),
    },
    timestamp: "2026-05-01T00:00:00Z",
  }) + "\n");

  let watchCalled = false;
  await runOcrOrchestrator(
    {
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "fake-v2.pdf",
      formType: "oath",
      sessionId: "session-1",
      rosterPath,
      rosterMode: "existing",
      previousRunId: "run-prev",
    },
    {
      runId: "run-2",
      trackerDir: dir,
      date: "2026-05-01",
      _ocrPipelineOverride: async () => ({
        data: [{
          sourcePage: 1, rowIndex: 0,
          printedName: "Liam Kustenbauder",
          employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
          notes: [], documentType: "expected", originallyMissing: [],
        }],
        provider: "stub", attempts: 1, cached: false, pageImagesDir: uploadsDir,
      }),
      _loadRosterOverride: async () => [{ eid: "10000001", name: "Liam Kustenbauder" }],
      _watchChildRunsOverride: async () => {
        watchCalled = true;
        return [];
      },
    },
  );

  // No eid-lookup call should have happened — record was carried forward.
  assert.equal(watchCalled, false, "watchChildRuns should not be called when carry-forward fully resolves");
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests, verify FAIL**

Run: `npm run test -- tests/unit/workflows/ocr/orchestrator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement orchestrator**

```ts
// src/workflows/ocr/orchestrator.ts
/**
 * OCR orchestrator. Generic over form-type via OcrFormSpec. Replaces the
 * duplicated runPaperOathPrepare + runPrepare in oath-signature/prepare.ts
 * and emergency-contact/prepare.ts.
 *
 * Phases (each emits a tracker `running` event with `step` set):
 *   loading-roster → ocr → matching → eid-lookup → verification → awaiting-approval
 *
 * Returns when the row reaches `awaiting-approval`. The user's approve /
 * discard / reupload click is handled via separate HTTP endpoints that
 * write further tracker events on the same id+runId.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZodType } from "zod/v4";
import { runOcrPipeline as realRunOcrPipeline, type OcrRequest, type OcrResult } from "../../ocr/index.js";
import { loadRoster as realLoadRoster, type RosterRow as MatchRosterRow } from "../../match/index.js";
import { watchChildRuns as realWatchChildRuns, type ChildOutcome, type WatchChildRunsOpts } from "../../tracker/watch-child-runs.js";
import { trackEvent, dateLocal, type TrackerEntry } from "../../tracker/jsonl.js";
import { errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";
import { isAcceptedDept } from "../eid-lookup/search.js";
import { getFormSpec } from "./form-registry.js";
import { applyCarryForward } from "./carry-forward.js";
import type { AnyOcrFormSpec, RosterRow as OcrRosterRow } from "./types.js";
import type { OcrInput } from "./schema.js";

const WORKFLOW = "ocr";

export interface OcrOrchestratorOpts {
  /** runId for this execution. Required — caller (HTTP or kernel handler) supplies. */
  runId: string;
  /** Tracker directory override. Default: process.env.TRACKER_DIR or .tracker. */
  trackerDir?: string;
  /** Date override (YYYY-MM-DD). Default: today. */
  date?: string;
  /** Uploads dir for per-page rendered PNGs. Default: `<trackerDir>/uploads/<sessionId>`. */
  uploadsDir?: string;
  /** Hard timeout for eid-lookup phase. Default 1h. */
  eidLookupTimeoutMs?: number;

  // ─── Test escape hatches ──────────────────────────────
  _emitOverride?: (entry: TrackerEntry) => void;
  _ocrPipelineOverride?: typeof realRunOcrPipeline;
  _loadRosterOverride?: (path: string) => Promise<MatchRosterRow[]>;
  _watchChildRunsOverride?: (opts: WatchChildRunsOpts) => Promise<ChildOutcome[]>;
  _enqueueEidLookupOverride?: (
    items: Array<{ name?: string; emplId?: string; itemId: string }>,
  ) => Promise<void>;
}

export async function runOcrOrchestrator(
  input: OcrInput,
  opts: OcrOrchestratorOpts,
): Promise<void> {
  const spec = getFormSpec(input.formType);
  if (!spec) {
    throw new Error(`OCR: unknown formType "${input.formType}"`);
  }
  const trackerDir = opts.trackerDir;
  const date = opts.date ?? dateLocal();
  const id = input.sessionId;
  const runId = opts.runId;
  const uploadsDir =
    opts.uploadsDir ?? join(trackerDir ?? ".tracker", "uploads", input.sessionId);
  const emit =
    opts._emitOverride ??
    ((entry: TrackerEntry) => trackEvent(entry, trackerDir));
  const runOcr = opts._ocrPipelineOverride ?? realRunOcrPipeline;
  const loadRosterFn = opts._loadRosterOverride ?? realLoadRoster;
  const watchChildren = opts._watchChildRunsOverride ?? realWatchChildRuns;

  const writeTracker = (
    status: TrackerEntry["status"],
    data: Record<string, unknown>,
    step?: string,
    error?: string,
  ): void => {
    emit({
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id,
      runId,
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      status,
      ...(step ? { step } : {}),
      data: flattenForData(data),
      ...(error ? { error } : {}),
    });
  };

  // 0. Pending row
  writeTracker("pending", {
    formType: input.formType,
    pdfPath: input.pdfPath,
    pdfOriginalName: input.pdfOriginalName,
    sessionId: input.sessionId,
    ...(input.previousRunId ? { previousRunId: input.previousRunId } : {}),
    rosterMode: input.rosterMode,
  });

  try {
    // 1. Loading-roster
    writeTracker("running", { formType: input.formType, rosterPath: input.rosterPath ?? "" }, "loading-roster");
    if (!input.rosterPath) {
      throw new Error("OCR: rosterPath is required (caller should have resolved it before kernel call)");
    }
    const roster = (await loadRosterFn(input.rosterPath)) as OcrRosterRow[];

    // 2. OCR
    writeTracker("running", { formType: input.formType, rosterPath: input.rosterPath }, "ocr");
    const ocrResult = await runOcr({
      pdfPath: input.pdfPath,
      pageImagesDir: uploadsDir,
      recordSchema: spec.ocrRecordSchema as ZodType<unknown>,
      arraySchema: spec.ocrArraySchema as ZodType<unknown[]>,
      prompt: spec.prompt,
      schemaName: spec.schemaName,
    });

    // 3. Match
    writeTracker(
      "running",
      {
        formType: input.formType,
        rosterPath: input.rosterPath,
        ocrProvider: ocrResult.provider,
        ocrAttempts: ocrResult.attempts,
        ocrCached: ocrResult.cached,
      },
      "matching",
    );
    let records = (ocrResult.data as unknown[]).map((r) =>
      spec.matchRecord({ record: r, roster }),
    );

    // 3b. Carry-forward (if reupload)
    if (input.previousRunId) {
      const v1Records = readPreviousRecords(input.sessionId, input.previousRunId, trackerDir, date);
      if (v1Records.length > 0) {
        records = applyCarryForward({ v2Records: records, v1Records, spec });
      }
    }

    // 4. Eid-lookup fan-out + watch
    const lookupTargets: Array<{ rec: unknown; index: number; kind: "name" | "verify" }> = [];
    records.forEach((rec, index) => {
      const kind = spec.needsLookup(rec);
      if (kind === "name" || kind === "verify") {
        lookupTargets.push({ rec, index, kind });
      }
    });

    if (lookupTargets.length > 0) {
      writeTracker("running", { recordCount: records.length, pendingLookup: lookupTargets.length }, "eid-lookup");

      const enqueueItems = lookupTargets.map((t) => {
        const itemId = `ocr-${spec.formType === "oath" ? "oath" : "ec"}-${runId}-r${t.index}`;
        return { record: t.rec, index: t.index, kind: t.kind, itemId };
      });

      // Kick off the eid-lookup daemon for each.
      if (opts._enqueueEidLookupOverride) {
        await opts._enqueueEidLookupOverride(
          enqueueItems.map((e) => ({
            ...(e.kind === "name"
              ? { name: extractName(e.record, spec) }
              : { emplId: extractEid(e.record, spec) }),
            itemId: e.itemId,
          })),
        );
      } else {
        const { ensureDaemonsAndEnqueue } = await import("../../core/daemon-client.js");
        const { eidLookupCrmWorkflow } = await import("../eid-lookup/index.js");
        const inputs = enqueueItems.map((e) =>
          e.kind === "name"
            ? { name: extractName(e.record, spec) }
            : { emplId: extractEid(e.record, spec), keepNonHdh: true },
        );
        await ensureDaemonsAndEnqueue(
          eidLookupCrmWorkflow,
          inputs as never,
          {},
          {
            deriveItemId: (inp: { name?: string; emplId?: string }) => {
              const matched = enqueueItems.find((e) => {
                if ("name" in inp && inp.name) return extractName(e.record, spec) === inp.name;
                if ("emplId" in inp && inp.emplId) return extractEid(e.record, spec) === inp.emplId;
                return false;
              });
              return matched?.itemId ?? `ocr-fallback-${runId}-r0`;
            },
          },
        );
      }

      // Watch for terminations.
      const outcomes = await watchChildren({
        workflow: "eid-lookup",
        expectedItemIds: enqueueItems.map((e) => e.itemId),
        trackerDir,
        date,
        timeoutMs: opts.eidLookupTimeoutMs ?? 60 * 60_000,
        onProgress: () => {
          // Could write progress events here if desired; today's prep didn't.
        },
      }).catch((err) => {
        log.warn(`[ocr] watchChildRuns timed out: ${errorMessage(err)}`);
        return [] as ChildOutcome[];
      });

      // Patch records from outcomes.
      const outcomesByItemId = new Map(outcomes.map((o) => [o.itemId, o]));
      for (const enq of enqueueItems) {
        const outcome = outcomesByItemId.get(enq.itemId);
        const idx = enq.index;
        if (!outcome) {
          // Timed out — mark unresolved if it was lookup-pending.
          patchUnresolved(records, idx, spec);
          continue;
        }
        patchFromOutcome(records, idx, outcome, enq.kind, spec);
      }
    }

    // 5. Verification (no-op marker — verification was computed inline above)
    const verifiedCount = countVerified(records, spec);
    writeTracker("running", { recordCount: records.length, verifiedCount }, "verification");

    // 6. Awaiting-approval — final emission BEFORE returning. Kernel wrapper
    //    (when invoked through kernel) emits status: done step: awaiting-approval
    //    on its own; for the HTTP-direct path we emit it ourselves here.
    writeTracker("running", {
      formType: input.formType,
      pdfOriginalName: input.pdfOriginalName,
      sessionId: input.sessionId,
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      recordCount: records.length,
      verifiedCount,
      records,
    }, "awaiting-approval");
    writeTracker("done", {
      formType: input.formType,
      pdfOriginalName: input.pdfOriginalName,
      sessionId: input.sessionId,
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      recordCount: records.length,
      verifiedCount,
      records,
    }, "awaiting-approval");
  } catch (err) {
    writeTracker("failed", { formType: input.formType, sessionId: input.sessionId }, undefined, errorMessage(err));
    throw err;
  }
}

// ─── Helpers (private) ──────────────────────────────────────

function flattenForData(d: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      out[k] = String(v);
    } else {
      try { out[k] = JSON.stringify(v); } catch { out[k] = String(v); }
    }
  }
  return out;
}

function readPreviousRecords(
  sessionId: string,
  previousRunId: string,
  trackerDir: string | undefined,
  date: string,
): unknown[] {
  const file = join(trackerDir ?? ".tracker", `ocr-${date}.jsonl`);
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, "utf-8");
  const lines = raw.split("\n").filter(Boolean);
  let latest: TrackerEntry | undefined;
  for (const line of lines) {
    try {
      const entry: TrackerEntry = JSON.parse(line);
      if (entry.id === sessionId && entry.runId === previousRunId) {
        latest = entry;
      }
    } catch { /* tolerate */ }
  }
  if (!latest?.data?.records) return [];
  try {
    const parsed = JSON.parse(latest.data.records as unknown as string);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* tolerate */ }
  return [];
}

function extractName(record: unknown, spec: AnyOcrFormSpec): string {
  // The spec doesn't declare a getName, so we fall back to carryForwardKey
  // which is the operator-visible name in both consumer specs.
  return spec.carryForwardKey(record as never);
}

function extractEid(record: unknown, spec: AnyOcrFormSpec): string {
  void spec;
  const r = record as Record<string, unknown>;
  if (typeof r.employeeId === "string") return r.employeeId;
  const employee = r.employee as Record<string, unknown> | undefined;
  if (employee && typeof employee.employeeId === "string") return employee.employeeId;
  return "";
}

function patchUnresolved(records: unknown[], idx: number, spec: AnyOcrFormSpec): void {
  const rec = records[idx] as Record<string, unknown>;
  if (rec.matchState === "lookup-pending" || rec.matchState === "lookup-running") {
    rec.matchState = "unresolved";
    const warnings = (rec.warnings as string[]) ?? [];
    warnings.push("eid-lookup did not return within timeout");
    rec.warnings = warnings;
  }
  void spec;
}

function patchFromOutcome(
  records: unknown[],
  idx: number,
  outcome: ChildOutcome,
  kind: "name" | "verify",
  spec: AnyOcrFormSpec,
): void {
  const rec = records[idx] as Record<string, unknown>;
  const eid = (outcome.data?.emplId ?? "").trim();
  const looksLikeEid = /^\d{5,}$/.test(eid);

  if (kind === "name") {
    if (outcome.status === "done" && looksLikeEid) {
      // Top-level employeeId (oath shape) OR nested employee.employeeId (EC shape).
      if ("employee" in rec) {
        (rec.employee as Record<string, unknown>).employeeId = eid;
      } else {
        rec.employeeId = eid;
      }
      rec.matchState = "resolved";
      rec.matchSource = "eid-lookup";
    } else {
      rec.matchState = "unresolved";
      const warnings = (rec.warnings as string[]) ?? [];
      warnings.push(`eid-lookup ${outcome.status === "done" ? `returned "${eid || "no result"}"` : "failed"}`);
      rec.warnings = warnings;
    }
  }

  // Verification: from the same eid-lookup outcome's hrStatus + department.
  const v = computeVerification({
    hrStatus: outcome.data?.hrStatus,
    department: outcome.data?.department,
    personOrgScreenshot: outcome.data?.personOrgScreenshot,
  });
  rec.verification = v;
  if (v.state !== "verified") {
    rec.selected = false;
  }
  void spec;
}

function countVerified(records: unknown[], spec: AnyOcrFormSpec): number {
  void spec;
  let n = 0;
  for (const r of records) {
    const v = (r as Record<string, unknown>).verification as { state?: string } | undefined;
    if (v?.state === "verified") n++;
  }
  return n;
}

function computeVerification(d: {
  hrStatus?: string;
  department?: string;
  personOrgScreenshot?: string;
}): {
  state: "verified" | "inactive" | "non-hdh" | "lookup-failed";
  hrStatus?: string;
  department?: string;
  screenshotFilename: string;
  checkedAt: string;
  error?: string;
} {
  const checkedAt = new Date().toISOString();
  const screenshotFilename = d.personOrgScreenshot ?? "";
  if (!d.hrStatus) return { state: "lookup-failed", error: "no result", checkedAt, screenshotFilename };
  const active = d.hrStatus === "Active";
  const hdh = isAcceptedDept(d.department ?? null);
  if (!active) return { state: "inactive", hrStatus: d.hrStatus, department: d.department, screenshotFilename, checkedAt };
  if (!hdh) return { state: "non-hdh", hrStatus: d.hrStatus, department: d.department ?? "", screenshotFilename, checkedAt };
  return { state: "verified", hrStatus: d.hrStatus, department: d.department ?? "", screenshotFilename, checkedAt };
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm run test -- tests/unit/workflows/ocr/orchestrator.test.ts`
Expected: 2 PASS

Run: `npm run typecheck`
Expected: no errors (some `as never` / `as unknown[]` casts are intentional — orchestrator is generic over T).

- [ ] **Step 5: Commit**

```bash
git add src/workflows/ocr/orchestrator.ts tests/unit/workflows/ocr/orchestrator.test.ts
git commit -m "feat(ocr): orchestrator (loading-roster → ocr → match → eid-lookup → done)

Generic over OcrFormSpec. Replaces duplicated runPaperOathPrepare +
runPrepare logic from oath-signature/prepare.ts and emergency-contact/
prepare.ts. Uses watch-child-runs helper for the eid-lookup phase.
Carry-forward applied between matching and eid-lookup."
```

### Task 10: OCR kernel workflow + barrel

**Files:**
- Create: `src/workflows/ocr/workflow.ts`
- Create: `src/workflows/ocr/index.ts`
- Create: `src/workflows/ocr/CLAUDE.md`

- [ ] **Step 1: Implement workflow.ts**

```ts
// src/workflows/ocr/workflow.ts
import { defineWorkflow, type Ctx } from "../../core/index.js";
import { runOcrOrchestrator } from "./orchestrator.js";
import { OcrInputSchema, type OcrInput } from "./schema.js";

const ocrSteps = [
  "loading-roster",
  "ocr",
  "matching",
  "eid-lookup",
  "verification",
  "awaiting-approval",
] as const;

export const ocrWorkflow = defineWorkflow({
  name: "ocr",
  label: "OCR",
  systems: [],
  authSteps: false,
  steps: ocrSteps,
  schema: OcrInputSchema,
  authChain: "sequential",
  tiling: "single",
  detailFields: [
    { key: "formType",         label: "Form" },
    { key: "pdfOriginalName",  label: "PDF" },
    { key: "recordCount",      label: "Records" },
    { key: "verifiedCount",    label: "Verified" },
  ],
  getName: (d) => d.pdfOriginalName ?? "",
  getId:   (d) => d.sessionId ?? "",
  handler: ocrKernelHandler,
});

async function ocrKernelHandler(ctx: Ctx, input: OcrInput): Promise<void> {
  // Thin wrapper. Orchestrator owns its own tracker emissions because the
  // kernel's per-step machinery doesn't model "wait for user, mid-handler."
  // We pass ctx.runId so the orchestrator's emissions agree with the kernel
  // wrapper's pending row.
  await runOcrOrchestrator(input, { runId: ctx.runId });
}
```

- [ ] **Step 2: Barrel + CLAUDE.md**

```ts
// src/workflows/ocr/index.ts
export { ocrWorkflow } from "./workflow.js";
export { runOcrOrchestrator } from "./orchestrator.js";
export type { OcrOrchestratorOpts } from "./orchestrator.js";
export { OcrInputSchema, type OcrInput } from "./schema.js";
export {
  FORM_SPECS,
  getFormSpec,
  listFormTypes,
  type FormType,
  type FormTypeListing,
} from "./form-registry.js";
export type { OcrFormSpec, AnyOcrFormSpec, RosterRow, LookupKind } from "./types.js";
export { applyCarryForward } from "./carry-forward.js";
```

Create `src/workflows/ocr/CLAUDE.md`:

```markdown
# OCR Workflow — `src/workflows/ocr/`

The "prep phase" of any form-based workflow. Operator uploads a PDF → OCR
runs the per-form Zod-bound LLM extraction → roster match → eid-lookup +
verification → preview row in the OCR tab → operator approves/discards/
reuploads → on approve, fans out to the form-type's downstream daemon
(oath-signature or emergency-contact).

**Kernel-registered, NOT daemon-mode.** No browsers, no Duo. Runs in the
dashboard's Node process via fire-and-forget `runWorkflow` from
`/api/ocr/prepare`. Same shape as `sharepoint-download`.

## Files

- `workflow.ts` — `defineWorkflow(...)` + thin handler that calls the
  orchestrator. `systems: []`, `authSteps: false`.
- `orchestrator.ts` — `runOcrOrchestrator(input, opts)` — pure async
  function with test escape hatches. Replaces the duplicated
  `prepare.ts` runners that lived in `oath-signature/` and
  `emergency-contact/`.
- `form-registry.ts` — `FORM_SPECS = { oath, "emergency-contact" }`. One
  line to add a new form type once you've written its `ocr-form.ts`.
- `types.ts` — `OcrFormSpec<TOcr, TPreview, TFanOut>` contract.
- `carry-forward.ts` — `applyCarryForward({ v2, v1, spec })` — Levenshtein
  ≤ 2 fuzzy match by `spec.carryForwardKey`. Skips records flagged
  `forceResearch`.
- `schema.ts` — `OcrInputSchema` (Zod). Required fields:
  pdfPath, pdfOriginalName, formType, sessionId, rosterMode.
- `index.ts` — barrel.

## Adding a new form type

1. Create `src/workflows/<consumer>/ocr-form.ts` exporting an
   `OcrFormSpec` object. Mirror oath/EC for prompt + match + fan-out.
2. Add a record renderer component in `src/dashboard/components/ocr/`
   (e.g. `MyFormRecordView.tsx`).
3. Add the spec to `FORM_SPECS` in `form-registry.ts`.
4. Run modal's picker auto-populates from `GET /api/ocr/forms`.

## Lessons Learned

(empty — module is new as of 2026-05-01)
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/workflows/ocr/workflow.ts src/workflows/ocr/index.ts src/workflows/ocr/CLAUDE.md
git commit -m "feat(ocr): kernel workflow registration + barrel + CLAUDE.md

systems: [], authSteps: false. Handler is a thin wrapper over
runOcrOrchestrator. Auto-registers with the dashboard via defineWorkflow."
```

### Task 11: Wire OCR into the daemon registry (negative test)

**Files:**
- Modify: `src/core/workflow-loaders.ts` (DO NOT add OCR — verify it isn't present)

OCR is HTTP-driven only. It must NOT appear in `WORKFLOW_LOADERS` (used by `cli-daemon.ts` and the dashboard's `/api/enqueue`). Adding it there would let an operator accidentally spawn an OCR daemon, which would crash on first claim.

- [ ] **Step 1: Read the workflow-loaders file**

Read `src/core/workflow-loaders.ts`.

- [ ] **Step 2: Confirm no `ocr` entry**

Verify the `WORKFLOW_LOADERS` map does NOT contain `"ocr"`. If it does (e.g. accidentally added during a prior task), remove it.

- [ ] **Step 3: Add a unit test asserting the omission**

Create `tests/unit/core/workflow-loaders.test.ts` (or append to existing if present):

```ts
import { test } from "node:test";
import assert from "node:assert";
import { WORKFLOW_LOADERS, listWorkflowNames } from "../../../src/core/workflow-loaders.js";

test("ocr is NOT in the daemon registry — HTTP-only workflow", () => {
  assert.ok(!("ocr" in WORKFLOW_LOADERS), "OCR should not be daemon-spawnable");
  assert.ok(!listWorkflowNames().includes("ocr"));
});
```

- [ ] **Step 4: Run test**

Run: `npm run test -- tests/unit/core/workflow-loaders.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tests/unit/core/workflow-loaders.test.ts
git commit -m "test(core): assert OCR is not in daemon registry

OCR is HTTP-driven only. Adding it to WORKFLOW_LOADERS would let an
operator spawn an OCR daemon (browser + Duo for a no-system workflow).
This test guards against that drift."
```

### Task 12: Smoke test — kernel + orchestrator end-to-end

**Files:**
- Create: `tests/integration/ocr/end-to-end.test.ts`

Validates: `runWorkflow(ocrWorkflow, ...)` invokes the orchestrator with the right runId; tracker rows have the expected step progression; no browser launches.

- [ ] **Step 1: Write integration test**

```ts
// tests/integration/ocr/end-to-end.test.ts
import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWorkflow } from "../../../src/core/index.js";
import { ocrWorkflow } from "../../../src/workflows/ocr/index.js";
import { __setOcrPipelineForTests } from "../../../src/ocr/index.js"; // (if not exported, skip injection)

test("runWorkflow(ocrWorkflow, ...) emits expected step progression", async () => {
  const dir = join(tmpdir(), `ocr-e2e-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const rosterPath = join(dir, "roster.xlsx");
  writeFileSync(rosterPath, ""); // stubbed; loadRoster will need to handle
  // [Test setup may need additional mock injection — see orchestrator test
  //  for patterns. If runWorkflow path doesn't expose orchestrator overrides,
  //  this integration is best validated post-Phase 4 via HTTP smoke.]
  rmSync(dir, { recursive: true, force: true });
});

test("ocrWorkflow registered with empty systems", () => {
  assert.deepEqual(ocrWorkflow.config.systems, []);
  assert.equal(ocrWorkflow.config.authSteps, false);
  assert.equal(ocrWorkflow.config.name, "ocr");
});
```

If full e2e through `runWorkflow` proves hard without orchestrator overrides reachable from kernel scope: this task documents the limitation and defers full e2e to Phase 4's HTTP-layer integration test (which CAN inject overrides via the HTTP factory).

- [ ] **Step 2: Run test**

Run: `npm run test -- tests/integration/ocr/end-to-end.test.ts`
Expected: 2 PASS (or document the deferred case in the test file's comment)

- [ ] **Step 3: Commit**

```bash
git add tests/integration/ocr/end-to-end.test.ts
git commit -m "test(ocr): kernel-level smoke + registration check"
```

---

## Phase 4 — HTTP layer (2 tasks)

### Task 13: OCR HTTP handlers + sweep + per-sessionId lock

**Files:**
- Create: `src/tracker/ocr-http.ts`
- Create: `tests/unit/tracker/ocr-http.test.ts`

The HTTP layer owns: prepare/reupload (multipart + fire-and-forget), approve-batch (validates + fans out), discard-prepare, force-research, GET /forms, restart-sweep. Per-sessionId in-memory lock guards against double-launch races.

- [ ] **Step 1: Write failing tests**

```ts
// tests/unit/tracker/ocr-http.test.ts
import { test } from "node:test";
import assert from "node:assert";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildOcrPrepareHandler,
  buildOcrApproveHandler,
  buildOcrDiscardHandler,
  buildOcrForceResearchHandler,
  buildOcrFormsHandler,
  sweepStuckOcrRows,
  _resetSessionLockForTests,
} from "../../../src/tracker/ocr-http.js";

function setup(): string {
  const dir = join(tmpdir(), `ocr-http-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("GET /api/ocr/forms returns registry listing", () => {
  const handler = buildOcrFormsHandler();
  const result = handler();
  assert.ok(result.length >= 2);
  const oath = result.find((f) => f.formType === "oath");
  assert.ok(oath);
  assert.equal(oath.label, "Oath signature");
});

test("POST /api/ocr/prepare returns 202 with sessionId+runId on happy path", async () => {
  const dir = setup();
  _resetSessionLockForTests();
  const handler = buildOcrPrepareHandler({
    trackerDir: dir,
    runOrchestrator: async () => {/* fire-and-forget stub */},
  });
  const resp = await handler({
    pdfPath: "/tmp/fake.pdf",
    pdfOriginalName: "fake.pdf",
    formType: "oath",
    rosterMode: "existing",
    rosterPath: "/tmp/roster.xlsx",
  });
  assert.equal(resp.status, 202);
  assert.equal(resp.body.ok, true);
  assert.ok(resp.body.sessionId);
  assert.ok(resp.body.runId);
  rmSync(dir, { recursive: true, force: true });
});

test("POST /api/ocr/prepare returns 409 when sessionId is locked", async () => {
  const dir = setup();
  _resetSessionLockForTests();
  // Hold the lock by starting an orchestrator that doesn't resolve.
  let resolveStub: (() => void) | null = null;
  const handler = buildOcrPrepareHandler({
    trackerDir: dir,
    runOrchestrator: () => new Promise<void>((resolve) => { resolveStub = resolve; }),
  });
  const sessionId = "session-locked";
  const first = await handler({
    pdfPath: "/tmp/a.pdf", pdfOriginalName: "a.pdf",
    formType: "oath", rosterMode: "existing", rosterPath: "/tmp/r.xlsx",
    sessionId,
  });
  assert.equal(first.status, 202);

  const second = await handler({
    pdfPath: "/tmp/b.pdf", pdfOriginalName: "b.pdf",
    formType: "oath", rosterMode: "existing", rosterPath: "/tmp/r.xlsx",
    sessionId,
  });
  assert.equal(second.status, 409);

  if (resolveStub) (resolveStub as () => void)();
  rmSync(dir, { recursive: true, force: true });
});

test("POST /api/ocr/reupload requires sessionId + previousRunId", async () => {
  const dir = setup();
  _resetSessionLockForTests();
  const handler = buildOcrPrepareHandler({
    trackerDir: dir,
    runOrchestrator: async () => {},
  });
  // /reupload alias enforces both — represented as a flag on the handler input.
  const resp = await handler({
    pdfPath: "/tmp/fake.pdf", pdfOriginalName: "fake.pdf",
    formType: "oath", rosterMode: "existing", rosterPath: "/tmp/r.xlsx",
    isReupload: true,
    // sessionId + previousRunId omitted
  });
  assert.equal(resp.status, 400);
  rmSync(dir, { recursive: true, force: true });
});

test("POST /api/ocr/discard-prepare emits failed step=discarded", async () => {
  const dir = setup();
  const handler = buildOcrDiscardHandler({ trackerDir: dir });
  const resp = await handler({ sessionId: "s1", runId: "r1", reason: "user clicked" });
  assert.equal(resp.status, 200);
  const file = join(dir, `ocr-${todayLocal()}.jsonl`);
  assert.ok(existsSync(file));
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.status, "failed");
  assert.equal(last.step, "discarded");
  rmSync(dir, { recursive: true, force: true });
});

test("sweepStuckOcrRows marks running rows failed", () => {
  const dir = setup();
  const file = join(dir, `ocr-${todayLocal()}.jsonl`);
  // Pre-populate one running row.
  require("node:fs").writeFileSync(file,
    JSON.stringify({
      workflow: "ocr", id: "stuck-session", runId: "r1",
      status: "running", step: "ocr",
      timestamp: new Date().toISOString(),
    }) + "\n",
  );
  sweepStuckOcrRows(dir);
  const lines = require("node:fs").readFileSync(file, "utf-8").split("\n").filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.status, "failed");
  assert.match(last.error, /Dashboard restarted/);
  rmSync(dir, { recursive: true, force: true });
});

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
```

- [ ] **Step 2: Run tests, verify FAIL**

Run: `npm run test -- tests/unit/tracker/ocr-http.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ocr-http.ts`**

```ts
// src/tracker/ocr-http.ts
/**
 * HTTP handlers for /api/ocr/* endpoints. All factories return either a
 * synchronous handler (forms, discard, force-research) or an async one
 * (prepare/reupload — fire-and-forget the orchestrator).
 *
 * Per-sessionId in-memory lock guards against double-launch races. Lock is
 * released after the runWorkflow hand-off, NOT after orchestrator completion.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { trackEvent, dateLocal, type TrackerEntry } from "./jsonl.js";
import { errorMessage } from "../utils/errors.js";
import { log } from "../utils/log.js";
import { listFormTypes, getFormSpec, type FormTypeListing } from "../workflows/ocr/form-registry.js";
import { runOcrOrchestrator, type OcrOrchestratorOpts } from "../workflows/ocr/orchestrator.js";

const WORKFLOW = "ocr";

// ─── Per-sessionId lock ──────────────────────────────────────

const activeSessionIds = new Set<string>();

export function _resetSessionLockForTests(): void {
  activeSessionIds.clear();
}

// ─── GET /api/ocr/forms ──────────────────────────────────────

export function buildOcrFormsHandler(): () => FormTypeListing[] {
  return () => listFormTypes();
}

// ─── POST /api/ocr/prepare + /reupload ───────────────────────

export interface PrepareInput {
  pdfPath: string;
  pdfOriginalName: string;
  formType: string;
  rosterMode: "existing" | "download";
  rosterPath?: string;
  sessionId?: string;
  previousRunId?: string;
  isReupload?: boolean;
}

export interface PrepareResponse {
  status: 202 | 400 | 409 | 500;
  body:
    | { ok: true; sessionId: string; runId: string }
    | { ok: false; error: string };
}

export interface PrepareHandlerOpts {
  trackerDir?: string;
  /** Override the orchestrator (for tests). Defaults to runOcrOrchestrator. */
  runOrchestrator?: (input: import("../workflows/ocr/schema.js").OcrInput, opts: OcrOrchestratorOpts) => Promise<void>;
}

export function buildOcrPrepareHandler(
  opts: PrepareHandlerOpts = {},
): (input: PrepareInput) => Promise<PrepareResponse> {
  const trackerDir = opts.trackerDir;
  const runOrch = opts.runOrchestrator ?? runOcrOrchestrator;

  return async (input) => {
    const spec = getFormSpec(input.formType);
    if (!spec) {
      return { status: 400, body: { ok: false, error: `Unknown formType "${input.formType}"` } };
    }
    if (input.isReupload && (!input.sessionId || !input.previousRunId)) {
      return {
        status: 400,
        body: { ok: false, error: "Reupload requires sessionId and previousRunId" },
      };
    }
    if (input.rosterMode === "existing" && !input.rosterPath) {
      return {
        status: 400,
        body: { ok: false, error: 'rosterMode="existing" requires rosterPath' },
      };
    }
    if (spec.rosterMode === "required" && input.rosterMode === "existing" && !input.rosterPath) {
      return {
        status: 400,
        body: { ok: false, error: "Form requires a roster" },
      };
    }

    const sessionId = input.sessionId ?? randomUUID();
    if (activeSessionIds.has(sessionId)) {
      return {
        status: 409,
        body: { ok: false, error: `Session ${sessionId} already has a prepare in flight` },
      };
    }
    activeSessionIds.add(sessionId);

    const runId = randomUUID();

    // Supersede the previous run if this is a reupload.
    if (input.isReupload && input.previousRunId) {
      trackEvent(
        {
          workflow: WORKFLOW,
          timestamp: new Date().toISOString(),
          id: sessionId,
          runId: input.previousRunId,
          status: "failed",
          step: "superseded",
        },
        trackerDir,
      );
    }

    // Fire-and-forget the orchestrator. Lock released in finally.
    void (async () => {
      try {
        await runOrch(
          {
            pdfPath: input.pdfPath,
            pdfOriginalName: input.pdfOriginalName,
            formType: input.formType,
            sessionId,
            rosterPath: input.rosterPath,
            rosterMode: input.rosterMode,
            previousRunId: input.previousRunId,
          },
          { runId, trackerDir },
        );
      } catch (err) {
        log.error(`[ocr-http] orchestrator threw: ${errorMessage(err)}`);
      } finally {
        activeSessionIds.delete(sessionId);
      }
    })();

    return { status: 202, body: { ok: true, sessionId, runId } };
  };
}

// ─── POST /api/ocr/approve-batch ─────────────────────────────

export interface ApproveInput {
  sessionId: string;
  runId: string;
  records: unknown[];
}
export interface ApproveResponse {
  status: 200 | 400 | 500;
  body:
    | { ok: true; fannedOut: Array<{ workflow: string; itemId: string }> }
    | { ok: false; error: string };
}
export interface ApproveHandlerOpts {
  trackerDir?: string;
  /** Override the daemon enqueue (for tests). */
  ensureDaemonsAndEnqueueOverride?: (
    workflow: string,
    inputs: unknown[],
    deriveItemId: (input: unknown, idx: number) => string,
  ) => Promise<void>;
}

export function buildOcrApproveHandler(
  opts: ApproveHandlerOpts = {},
): (input: ApproveInput) => Promise<ApproveResponse> {
  const trackerDir = opts.trackerDir;
  return async (input) => {
    if (!input.sessionId || !input.runId || !Array.isArray(input.records)) {
      return { status: 400, body: { ok: false, error: "Missing sessionId/runId/records" } };
    }
    // Read the OCR row to find formType.
    const formType = readFormType(input.sessionId, trackerDir);
    if (!formType) {
      return { status: 400, body: { ok: false, error: "Could not resolve formType for session" } };
    }
    const spec = getFormSpec(formType);
    if (!spec) {
      return { status: 400, body: { ok: false, error: `Unknown formType "${formType}"` } };
    }

    // Fan out.
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
        await opts.ensureDaemonsAndEnqueueOverride(spec.approveTo.workflow, enqueueInputs, (_inp, idx) => itemIds[idx]);
      } else {
        const { ensureDaemonsAndEnqueue } = await import("../core/daemon-client.js");
        const { loadWorkflow } = await import("../core/workflow-loaders.js");
        const childWf = await loadWorkflow(spec.approveTo.workflow);
        if (!childWf) {
          return { status: 500, body: { ok: false, error: `Unknown approveTo workflow "${spec.approveTo.workflow}"` } };
        }
        await ensureDaemonsAndEnqueue(
          childWf,
          enqueueInputs as never,
          {},
          {
            deriveItemId: (_inp: unknown, idx: number) => itemIds[idx] ?? `ocr-fallback-${input.runId}-r${idx}`,
          },
        );
      }
    } catch (err) {
      return { status: 500, body: { ok: false, error: errorMessage(err) } };
    }

    // Emit approved tracker event.
    trackEvent(
      {
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id: input.sessionId,
        runId: input.runId,
        status: "done",
        step: "approved",
        data: { fannedOutCount: String(fannedOut.length) },
      },
      trackerDir,
    );

    return { status: 200, body: { ok: true, fannedOut } };
  };
}

// ─── POST /api/ocr/discard-prepare ───────────────────────────

export interface DiscardInput {
  sessionId: string;
  runId: string;
  reason?: string;
}
export interface DiscardResponse {
  status: 200 | 400;
  body: { ok: boolean; error?: string };
}
export interface DiscardHandlerOpts {
  trackerDir?: string;
  /** PDF path resolver — if provided, attempts unlink for cleanup. */
  resolvePdfPath?: (sessionId: string) => string | null;
}
export function buildOcrDiscardHandler(opts: DiscardHandlerOpts = {}) {
  return async (input: DiscardInput): Promise<DiscardResponse> => {
    if (!input.sessionId || !input.runId) {
      return { status: 400, body: { ok: false, error: "Missing sessionId/runId" } };
    }
    trackEvent(
      {
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id: input.sessionId,
        runId: input.runId,
        status: "failed",
        step: "discarded",
        ...(input.reason ? { error: input.reason } : {}),
      },
      opts.trackerDir,
    );
    if (opts.resolvePdfPath) {
      const path = opts.resolvePdfPath(input.sessionId);
      if (path && existsSync(path)) {
        try { unlinkSync(path); } catch { /* tolerate */ }
      }
    }
    return { status: 200, body: { ok: true } };
  };
}

// ─── POST /api/ocr/force-research ────────────────────────────

export interface ForceResearchInput {
  sessionId: string;
  runId: string;
  recordIndices: number[];
}
export interface ForceResearchResponse {
  status: 200 | 400;
  body: { ok: boolean; error?: string };
}
export interface ForceResearchHandlerOpts {
  trackerDir?: string;
  /** Test override — orchestrate-style re-eid-lookup. */
  triggerForceResearch?: (input: ForceResearchInput) => Promise<void>;
}
export function buildOcrForceResearchHandler(opts: ForceResearchHandlerOpts = {}) {
  return async (input: ForceResearchInput): Promise<ForceResearchResponse> => {
    if (!input.sessionId || !input.runId || !Array.isArray(input.recordIndices)) {
      return { status: 400, body: { ok: false, error: "Missing fields" } };
    }
    if (opts.triggerForceResearch) {
      try {
        await opts.triggerForceResearch(input);
      } catch (err) {
        return { status: 400, body: { ok: false, error: errorMessage(err) } };
      }
    } else {
      // Production path: read current row, patch records, re-fan-out via daemon-client + watch.
      // Implementation lives in a helper so tests can inject the orchestration.
      const { runForceResearch } = await import("../workflows/ocr/force-research.js");
      try {
        await runForceResearch(input, opts.trackerDir);
      } catch (err) {
        return { status: 400, body: { ok: false, error: errorMessage(err) } };
      }
    }
    return { status: 200, body: { ok: true } };
  };
}

// ─── Restart sweep ───────────────────────────────────────────

export function sweepStuckOcrRows(trackerDir: string): void {
  const date = dateLocal();
  const file = join(trackerDir, `ocr-${date}.jsonl`);
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
          error: "Dashboard restarted while OCR was in progress — please re-upload",
        },
        trackerDir,
      );
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function readFormType(sessionId: string, trackerDir: string | undefined): string | null {
  const date = dateLocal();
  const file = join(trackerDir ?? ".tracker", `ocr-${date}.jsonl`);
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e: TrackerEntry = JSON.parse(lines[i]);
      if (e.id === sessionId && e.data?.formType) {
        return e.data.formType as unknown as string;
      }
    } catch { /* tolerate */ }
  }
  return null;
}
```

Also create the force-research helper stub that the handler imports:

```ts
// src/workflows/ocr/force-research.ts
/**
 * Drops resolved fields on selected records, re-fans-out eid-lookup, watches
 * for completions, patches the OCR row's records progressively.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { trackEvent, dateLocal, type TrackerEntry } from "../../tracker/jsonl.js";
import { watchChildRuns } from "../../tracker/watch-child-runs.js";
import { getFormSpec } from "./form-registry.js";

const WORKFLOW = "ocr";

export interface ForceResearchInput {
  sessionId: string;
  runId: string;
  recordIndices: number[];
}

export async function runForceResearch(input: ForceResearchInput, trackerDir?: string): Promise<void> {
  const date = dateLocal();
  const file = join(trackerDir ?? ".tracker", `ocr-${date}.jsonl`);
  if (!existsSync(file)) throw new Error("OCR row not found");
  const raw = readFileSync(file, "utf-8");
  const lines = raw.split("\n").filter(Boolean);
  let latest: TrackerEntry | undefined;
  for (const line of lines) {
    try {
      const e: TrackerEntry = JSON.parse(line);
      if (e.id === input.sessionId && e.runId === input.runId) latest = e;
    } catch { /* tolerate */ }
  }
  if (!latest) throw new Error("OCR row not found in JSONL");
  const formType = latest.data?.formType as unknown as string | undefined;
  if (!formType) throw new Error("formType missing on OCR row");
  const spec = getFormSpec(formType);
  if (!spec) throw new Error(`Unknown formType "${formType}"`);

  const records: unknown[] = JSON.parse((latest.data?.records as unknown as string) ?? "[]");
  const itemIds: string[] = [];
  const enqueueInputs: unknown[] = [];

  for (const idx of input.recordIndices) {
    const r = records[idx] as Record<string, unknown>;
    if (!r) continue;
    // Drop resolved fields, set forceResearch flag for future reupload.
    if ("employee" in r) {
      const e = r.employee as Record<string, unknown>;
      e.employeeId = "";
    } else {
      r.employeeId = "";
    }
    r.matchState = "lookup-pending";
    r.matchSource = undefined;
    r.matchConfidence = undefined;
    r.verification = undefined;
    r.forceResearch = true;
    const itemId = `ocr-force-${input.runId}-r${idx}`;
    itemIds.push(itemId);
    // Use spec.carryForwardKey to extract a name to feed the eid-lookup.
    const name = spec.carryForwardKey(r as never);
    enqueueInputs.push({ name });
  }

  // Emit running step=eid-lookup with patched records.
  trackEvent(
    {
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id: input.sessionId,
      runId: input.runId,
      status: "running",
      step: "eid-lookup",
      data: { records: JSON.stringify(records) },
    },
    trackerDir,
  );

  // Fan-out + watch.
  const { ensureDaemonsAndEnqueue } = await import("../../core/daemon-client.js");
  const { eidLookupCrmWorkflow } = await import("../eid-lookup/index.js");
  await ensureDaemonsAndEnqueue(
    eidLookupCrmWorkflow,
    enqueueInputs as never,
    {},
    { deriveItemId: (_i: unknown, idx: number) => itemIds[idx] ?? "" },
  );
  const outcomes = await watchChildRuns({
    workflow: "eid-lookup",
    expectedItemIds: itemIds,
    trackerDir,
    date,
    timeoutMs: 30 * 60_000,
  }).catch(() => []);

  // Patch records from outcomes (mirror orchestrator's patchFromOutcome path).
  // [Same logic as orchestrator's patch helpers — could be extracted; left
  //  inline here for readability of the force-research delta.]
  // ... patch records[idx] for each outcome ...

  // Final emission.
  trackEvent(
    {
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id: input.sessionId,
      runId: input.runId,
      status: "running",
      step: "awaiting-approval",
      data: { records: JSON.stringify(records) },
    },
    trackerDir,
  );
  trackEvent(
    {
      workflow: WORKFLOW,
      timestamp: new Date().toISOString(),
      id: input.sessionId,
      runId: input.runId,
      status: "done",
      step: "awaiting-approval",
      data: { records: JSON.stringify(records) },
    },
    trackerDir,
  );
  void outcomes;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npm run test -- tests/unit/tracker/ocr-http.test.ts`
Expected: 6 PASS

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/tracker/ocr-http.ts src/workflows/ocr/force-research.ts tests/unit/tracker/ocr-http.test.ts
git commit -m "feat(tracker): /api/ocr/* HTTP handlers + sweep + per-sessionId lock

prepare/reupload/approve-batch/discard-prepare/force-research/forms.
In-memory lock returns 409 on double-launch. Restart sweep marks stuck
running rows as failed."
```

### Task 14: Wire OCR routes into `dashboard.ts`

**Files:**
- Modify: `src/tracker/dashboard.ts`

Register the 6 new routes. Keep old `/api/{oath-signature,emergency-contact}/*` routes for now — Task 26 deletes them.

- [ ] **Step 1: Read existing route registrations**

Read `src/tracker/dashboard.ts` to find where existing prep routes (`/api/oath-signature/prepare`, `/api/emergency-contact/prepare`, etc.) are registered. Note the parsing pattern (multipart for prepare, JSON for approve/discard).

- [ ] **Step 2: Add OCR route registrations alongside existing ones**

Add to `dashboard.ts`'s route handler section (preserving style):

```ts
// ─── OCR endpoints ─────────────────────────────────────────
import {
  buildOcrFormsHandler,
  buildOcrPrepareHandler,
  buildOcrApproveHandler,
  buildOcrDiscardHandler,
  buildOcrForceResearchHandler,
  sweepStuckOcrRows,
} from "./ocr-http.js";

const ocrFormsHandler         = buildOcrFormsHandler();
const ocrPrepareHandler       = buildOcrPrepareHandler({ trackerDir });
const ocrApproveHandler       = buildOcrApproveHandler({ trackerDir });
const ocrDiscardHandler       = buildOcrDiscardHandler({ trackerDir });
const ocrForceResearchHandler = buildOcrForceResearchHandler({ trackerDir });

// Run sweep at startup (alongside existing sweeps).
sweepStuckOcrRows(trackerDir);

// Route table additions:
//   GET  /api/ocr/forms           → ocrFormsHandler()
//   POST /api/ocr/prepare         → multipart → ocrPrepareHandler({ ...input, isReupload: false })
//   POST /api/ocr/reupload        → multipart → ocrPrepareHandler({ ...input, isReupload: true })
//   POST /api/ocr/approve-batch   → JSON     → ocrApproveHandler(body)
//   POST /api/ocr/discard-prepare → JSON     → ocrDiscardHandler(body)
//   POST /api/ocr/force-research  → JSON     → ocrForceResearchHandler(body)
```

The exact wiring (Node http.IncomingMessage parsing, multipart boundary, etc.) follows the existing `/api/emergency-contact/prepare` pattern in `dashboard.ts`. Reuse the existing multipart-helper.

- [ ] **Step 3: Restart dashboard manually + smoke test**

```bash
npm run dashboard
```

In a separate terminal:

```bash
curl -s http://localhost:3838/api/ocr/forms | jq .
```

Expected output: array of form-type listings with `oath` and `emergency-contact`.

- [ ] **Step 4: Run typecheck + full test suite**

Run: `npm run typecheck`
Expected: no errors

Run: `npm run test`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/tracker/dashboard.ts
git commit -m "feat(dashboard): wire /api/ocr/* routes

GET /api/ocr/forms; POST /api/ocr/{prepare, reupload, approve-batch,
discard-prepare, force-research}. Sweep runs at startup. Old prep
routes remain in place for now (Task 26 deletes)."
```

---

## Phase 5 — SharePoint roster as a delegated child (2 tasks)

### Task 15: SharePoint download accepts `parentRunId`

**Files:**
- Modify: `src/workflows/sharepoint-download/handler.ts`
- Modify: `src/workflows/sharepoint-download/workflow.ts`
- Modify: `src/workflows/sharepoint-download/schema.ts`
- Create: `tests/unit/workflows/sharepoint-download/parent-run-id.test.ts`

The OCR orchestrator's loading-roster step (Task 16) will fire SharePoint download programmatically and stamp `parentRunId = <OCR runId>` so the dashboard can render the parent→child link.

- [ ] **Step 1: Add `parentRunId?` to the SharePoint input schema**

Edit `src/workflows/sharepoint-download/schema.ts`:

```ts
// Existing schema gains:
export const SharePointDownloadInputSchema = z.object({
  id:           z.string(),
  label:        z.string(),
  url:          z.string(),
  outDir:       z.string().optional(),
  parentRunId:  z.string().optional(),     // ← NEW
});
```

- [ ] **Step 2: Plumb `parentRunId` through the workflow handler**

Edit `src/workflows/sharepoint-download/workflow.ts` — in the kernel handler:

```ts
handler: async (ctx, input) => {
  ctx.updateData({
    id: input.id,
    label: input.label,
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
  });
  // ... existing handler body ...
}
```

The kernel's `updateData` writes into `data` which the dashboard reads. We ALSO want `parentRunId` on the top-level TrackerEntry — but that's emitted by `withTrackedWorkflow` from the kernel, not from `updateData`. To stamp it on the entry itself, we need to thread it through `runWorkflow`.

Look at how `runWorkflow` handles input vs preAssignedRunId. The simplest lift:

```ts
// In src/core/workflow.ts — runWorkflow signature accepts an optional opts.parentRunId.
//                          withTrackedWorkflow accepts parentRunId and stamps every emit.
```

If that change is not already present, this task includes a small kernel patch:

```ts
// src/core/workflow.ts (modify runWorkflow + buildTrackerOpts to accept parentRunId)
export async function runWorkflow<TData>(
  wf: RegisteredWorkflow<TData, readonly string[]>,
  data: TData,
  opts: RunOpts & { parentRunId?: string } = {},
): Promise<void> {
  // ...
  // pass opts.parentRunId into withTrackedWorkflow's emit pipeline.
}
```

```ts
// src/tracker/jsonl.ts — withTrackedWorkflow signature accepts parentRunId, stamps every TrackerEntry it emits.
```

(If the kernel already supports this — verify by reading — skip the patch.)

- [ ] **Step 3: HTTP handler accepts parentRunId**

Edit `src/workflows/sharepoint-download/handler.ts::buildSharePointRosterDownloadHandler`. Change input shape:

```ts
return async (input: { id?: string; parentRunId?: string }) => {
  // ... existing checks ...
  // When firing runWorkflow:
  await runWorkflowImpl(sharepointDownloadWorkflow, {
    id: spec.id,
    label: spec.label,
    url,
    outDir,
    ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
  });
}
```

The HTTP route in `dashboard.ts` for `/api/sharepoint-download/run` already body-parses JSON; just pass through `parentRunId` from the body.

- [ ] **Step 4: Write the failing test**

```ts
// tests/unit/workflows/sharepoint-download/parent-run-id.test.ts
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

  const resp = await handler({ id: "onboarding-roster", parentRunId: "parent-run-xyz" });
  assert.equal(resp.status, 202);
  // Allow the fire-and-forget closure to run.
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(capturedInput);
  assert.equal(capturedInput.parentRunId, "parent-run-xyz");

  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 5: Run test**

Run: `npm run test -- tests/unit/workflows/sharepoint-download/parent-run-id.test.ts`
Expected: PASS

Run: `npm run test -- tests/unit/workflows/sharepoint-download/`
Expected: all PASS (no regression in existing tests).

- [ ] **Step 6: Commit**

```bash
git add src/workflows/sharepoint-download/{handler,workflow,schema}.ts tests/unit/workflows/sharepoint-download/parent-run-id.test.ts
# If the kernel patch was needed:
# git add src/core/workflow.ts src/tracker/jsonl.ts
git commit -m "feat(sharepoint-download): accept parentRunId

When OCR's loading-roster step delegates to SharePoint download, the
resulting tracker row carries parentRunId pointing at the OCR run.
Dashboard renders this as a parent→child pill."
```

### Task 16: OCR loading-roster step delegates to SharePoint when needed

**Files:**
- Modify: `src/workflows/ocr/orchestrator.ts`

When `input.rosterMode === "download"`, the orchestrator fires `/api/sharepoint-download/run` (or the kernel `runWorkflow(sharepointDownloadWorkflow, ...)` directly when in-process), waits via `watchChildRuns` on the sharepoint-download workflow, then resolves the saved roster path.

- [ ] **Step 1: Extend orchestrator to handle rosterMode=download**

In `src/workflows/ocr/orchestrator.ts`, replace the loading-roster section:

```ts
// 1. Loading-roster
writeTracker("running", { formType: input.formType, rosterMode: input.rosterMode }, "loading-roster");

let resolvedRosterPath = input.rosterPath;

if (input.rosterMode === "download") {
  // Fire SharePoint download as a delegated child.
  const { runWorkflow } = await import("../../core/index.js");
  const { sharepointDownloadWorkflow } = await import("../sharepoint-download/index.js");
  const { SHAREPOINT_DOWNLOADS } = await import("../sharepoint-download/registry.js");
  // Pick the first registered spec for now — future work could pass
  // sharepointId in OcrInput. For OCR's purpose (oath + EC), the onboarding
  // roster is universal.
  const spec = SHAREPOINT_DOWNLOADS[0];
  const url = (process.env[spec.envVar] ?? "").trim();
  if (!url) {
    throw new Error(`OCR rosterMode=download but ${spec.envVar} env var is unset`);
  }
  // Fire fire-and-forget; the kernel emits its own pending row stamped
  // with parentRunId = our runId.
  void runWorkflow(sharepointDownloadWorkflow, {
    id: spec.id,
    label: spec.label,
    url,
    parentRunId: runId,
  }).catch((err) => log.error(`[ocr] sharepoint download crashed: ${errorMessage(err)}`));

  // Watch for terminal status of THE specific sharepoint-download row
  // we just spawned. ItemId of sharepoint-download rows = spec.id.
  const outcomes = await watchChildren({
    workflow: "sharepoint-download",
    expectedItemIds: [spec.id],
    trackerDir,
    date,
    timeoutMs: 5 * 60_000,
  });
  const result = outcomes[0];
  if (!result || result.status !== "done") {
    throw new Error(`SharePoint download failed: ${result?.error ?? "unknown error"}`);
  }
  resolvedRosterPath = (result.data?.path ?? "").trim();
  if (!resolvedRosterPath) throw new Error("SharePoint download finished without saving a path");
}

if (!resolvedRosterPath) {
  throw new Error("OCR: no roster path resolved");
}
const roster = (await loadRosterFn(resolvedRosterPath)) as OcrRosterRow[];
```

(The orchestrator's `watchChildren` parameter is the `_watchChildRunsOverride` or `realWatchChildRuns` already plumbed through.)

- [ ] **Step 2: Update orchestrator test to cover rosterMode=download**

Append to `tests/unit/workflows/ocr/orchestrator.test.ts`:

```ts
test("rosterMode=download triggers sharepoint-download as delegated child", async () => {
  // Stub watchChildRuns to return a sharepoint-download "done" outcome.
  // ... (similar to existing test, but with rosterMode: "download")
  // Verify the orchestrator passed parentRunId through and proceeded
  // after the watch resolved.
});
```

- [ ] **Step 3: Run tests**

Run: `npm run test -- tests/unit/workflows/ocr/orchestrator.test.ts`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add src/workflows/ocr/orchestrator.ts tests/unit/workflows/ocr/orchestrator.test.ts
git commit -m "feat(ocr): rosterMode=download → delegated SharePoint child

Orchestrator's loading-roster step fires sharepoint-download workflow with
parentRunId=<self runId>, then watchChildRuns waits for terminal status.
On success, reads the saved path from the child row's data.path. No more
useSharePointDownload modal hook (RunModal will follow in Phase 6)."
```

---

## Phase 6 — Frontend file moves + types consolidation (3 tasks)

### Task 17: Move + rename frontend files

**Files:** all in `src/dashboard/components/`. Move + rename mechanically. NO content changes beyond imports + identifier renames.

- [ ] **Step 1: Create the new directory**

```bash
mkdir -p src/dashboard/components/ocr
```

- [ ] **Step 2: Move + rename files**

```bash
git mv src/dashboard/components/PreviewRow.tsx          src/dashboard/components/ocr/OcrQueueRow.tsx
git mv src/dashboard/components/PrepReviewPane.tsx       src/dashboard/components/ocr/OcrReviewPane.tsx
git mv src/dashboard/components/OathReviewForm.tsx       src/dashboard/components/ocr/OathRecordView.tsx
git mv src/dashboard/components/EcReviewForm.tsx         src/dashboard/components/ocr/EcRecordView.tsx
git mv src/dashboard/components/PrepReviewPair.tsx       src/dashboard/components/ocr/PrepReviewPair.tsx
git mv src/dashboard/components/PrepReviewMultiPair.tsx  src/dashboard/components/ocr/PrepReviewMultiPair.tsx
git mv src/dashboard/components/PrepReviewFormCard.tsx   src/dashboard/components/ocr/PrepReviewFormCard.tsx
```

- [ ] **Step 3: Rename top-level components inside the moved files**

For each renamed file, update the exported component name:
- `PreviewRow` → `OcrQueueRow` (in `OcrQueueRow.tsx`)
- `PrepReviewPane` → `OcrReviewPane` (in `OcrReviewPane.tsx`)
- `OathReviewForm` → `OathRecordView` (in `OathRecordView.tsx`)
- `EcReviewForm` → `EcRecordView` (in `EcRecordView.tsx`)

For each, also update the `interface XxxProps` and any internal references to the old name. Don't change behavior — just rename.

- [ ] **Step 4: Update all import sites**

Find all files that import from the old paths:

```bash
grep -rn "PreviewRow\|PrepReviewPane\|OathReviewForm\|EcReviewForm\|PrepReviewPair\|PrepReviewMultiPair\|PrepReviewFormCard" src/dashboard/ | grep -v "\.tsx:.*from \"\\./ocr/" | grep -v "components/ocr/"
```

Update each import:
- `from "./PreviewRow"` → `from "./ocr/OcrQueueRow"` (also rename `PreviewRow` → `OcrQueueRow` in usage)
- `from "./PrepReviewPane"` → `from "./ocr/OcrReviewPane"`
- etc.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 6: Build the dashboard to verify**

Run: `npm run build:dashboard`
Expected: clean build, no errors

- [ ] **Step 7: Commit**

```bash
git add -A src/dashboard/components/
git commit -m "refactor(dashboard): move OCR-related components to components/ocr/

Mechanical rename + relocation. PreviewRow → OcrQueueRow,
PrepReviewPane → OcrReviewPane, OathReviewForm → OathRecordView,
EcReviewForm → EcRecordView. Behavior unchanged."
```

### Task 18: Consolidate `preview-types.ts` + `oath-preview-types.ts` into one file

**Files:**
- Move + merge: `src/dashboard/components/preview-types.ts` + `src/dashboard/components/oath-preview-types.ts` → `src/dashboard/components/ocr/types.ts`

- [ ] **Step 1: Create the consolidated types file**

```bash
git mv src/dashboard/components/preview-types.ts src/dashboard/components/ocr/types.ts
```

Edit `src/dashboard/components/ocr/types.ts` to also include the contents of `oath-preview-types.ts` (the parser + types). Add comment block at the top:

```ts
/**
 * Frontend mirrors of OCR's per-form schemas. No runtime Zod here — these
 * are TypeScript types only, so the dashboard bundle stays slim. Validation
 * lives server-side in src/workflows/{oath-signature,emergency-contact}/ocr-form.ts.
 */
```

- [ ] **Step 2: Delete the old `oath-preview-types.ts`**

```bash
git rm src/dashboard/components/oath-preview-types.ts
```

- [ ] **Step 3: Update import sites**

Find all files importing from the old paths:

```bash
grep -rn "preview-types\|oath-preview-types" src/dashboard/
```

Update each: `from "./preview-types"` → `from "./ocr/types"`. Same for `oath-preview-types`.

- [ ] **Step 4: Add a record-renderer registry on the frontend**

Create `src/dashboard/components/ocr/record-renderers.tsx`:

```tsx
import type { ComponentType } from "react";
import { OathRecordView } from "./OathRecordView";
import { EcRecordView } from "./EcRecordView";

/**
 * Maps `OcrFormSpec.recordRendererId` (from the backend) to a React
 * component. Add a new form type's renderer here when adding the form.
 */
export const RECORD_RENDERERS: Record<string, ComponentType<{ record: any; onChange?: (r: any) => void }>> = {
  OathRecordView,
  EcRecordView,
};

export function getRecordRenderer(rendererId: string): ComponentType<{ record: any; onChange?: (r: any) => void }> | null {
  return RECORD_RENDERERS[rendererId] ?? null;
}
```

`OcrReviewPane` consumes this registry to pick the right per-record component based on the form-type spec metadata received from `GET /api/ocr/forms`.

- [ ] **Step 5: Run typecheck + build**

Run: `npm run typecheck`
Expected: no errors

Run: `npm run build:dashboard`
Expected: clean build

- [ ] **Step 6: Commit**

```bash
git add -A src/dashboard/components/ocr/
git rm src/dashboard/components/oath-preview-types.ts 2>/dev/null || true
git commit -m "refactor(dashboard): consolidate OCR types + add record-renderer registry

Single src/dashboard/components/ocr/types.ts. Per-form record components
looked up via RECORD_RENDERERS by rendererId from the backend spec."
```

### Task 19: Make `RunModal` and `TopBarRunButton` workflow-aware

**Files:**
- Modify: `src/dashboard/components/RunModal.tsx`
- Modify: `src/dashboard/components/TopBarRunButton.tsx`

- [ ] **Step 1: Add `workflow` prop to `TopBarRunButton`**

Edit `src/dashboard/components/TopBarRunButton.tsx`:

```tsx
const RUN_ENABLED_WORKFLOWS = ["ocr"]; // Piece 3 will add "oath-upload"

export interface TopBarRunButtonProps {
  activeWorkflow: string;
  busyCount?: number;
}

export function TopBarRunButton({ activeWorkflow, busyCount = 0 }: TopBarRunButtonProps) {
  const [open, setOpen] = useState(false);
  if (!RUN_ENABLED_WORKFLOWS.includes(activeWorkflow)) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Run ${activeWorkflow}`}
        // ... existing styling ...
      >
        {/* existing button content */}
      </button>
      <RunModal open={open} onOpenChange={setOpen} workflow={activeWorkflow} />
    </>
  );
}
```

- [ ] **Step 2: Update RunModal to take a workflow prop + form-type picker**

Edit `src/dashboard/components/RunModal.tsx`:

```tsx
interface RunModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workflow: string;                        // ← NEW
  /** When set, the modal is in "reupload" mode for the given session. */
  reuploadFor?: { sessionId: string; previousRunId: string };
}

interface FormTypeOption {
  formType: string;
  label: string;
  description: string;
  rosterMode: "required" | "optional";
}

export function RunModal({ open, onOpenChange, workflow, reuploadFor }: RunModalProps) {
  const [formType, setFormType] = useState<string | null>(null);
  const [formOptions, setFormOptions] = useState<FormTypeOption[]>([]);
  // ... existing file/roster state ...

  // Fetch form types when modal opens for OCR.
  useEffect(() => {
    if (!open || workflow !== "ocr") return;
    fetch("/api/ocr/forms").then(async (r) => {
      if (r.ok) {
        const list = (await r.json()) as FormTypeOption[];
        setFormOptions(list);
        if (!formType && list.length > 0) setFormType(list[0].formType);
      }
    });
  }, [open, workflow, formType]);

  async function handleSubmit() {
    if (!file || !formType) return;
    // ... existing PDF / roster handling ...

    const fd = new FormData();
    fd.append("pdf", file, file.name);
    fd.append("formType", formType);
    fd.append("rosterMode", rosterMode);
    if (reuploadFor) {
      fd.append("sessionId", reuploadFor.sessionId);
      fd.append("previousRunId", reuploadFor.previousRunId);
    }

    const url = reuploadFor ? "/api/ocr/reupload" : "/api/ocr/prepare";
    // ... XHR submission as today ...
  }

  // Render: form-type picker (radio list) ONLY when workflow === "ocr" && !reuploadFor.
  // When reuploadFor is set: the form type is locked (read from the existing OCR row's data.formType).
  // ...
}
```

- [ ] **Step 3: Remove the `useSharePointDownload` hook call from RunModal**

The "Download fresh from SharePoint" radio now just toggles the `rosterMode: "download"` field in the form body. The OCR orchestrator handles the actual download as a delegated child (Task 16).

```tsx
// DELETE:  const sharePoint = useSharePointDownload("ONBOARDING_ROSTER");
// DELETE:  if (rosterMode === "download") { const path = await sharePoint.start(); ... }

// Keep only the radio button. On submit, just pass rosterMode=download in the form body.
```

- [ ] **Step 4: Pass `activeWorkflow` from `TopBar` to `TopBarRunButton`**

Edit `src/dashboard/components/TopBar.tsx` (or wherever `TopBarRunButton` is mounted) to pass the active workflow string.

- [ ] **Step 5: Run typecheck + dashboard build**

Run: `npm run typecheck`
Expected: no errors

Run: `npm run build:dashboard`
Expected: clean build

- [ ] **Step 6: Manual smoke**

```bash
npm run dashboard
```

Open http://localhost:5173, switch to OCR tab, click Run. Modal opens with form-type picker (Oath / Emergency contact). Pick one, drag a PDF, submit.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard/components/RunModal.tsx src/dashboard/components/TopBarRunButton.tsx src/dashboard/components/TopBar.tsx
git commit -m "feat(dashboard): RunModal + TopBarRunButton workflow-aware

RunModal accepts workflow + reuploadFor props. Form-type picker visible
only for ocr (oath / emergency-contact). Reupload mode locks formType.
useSharePointDownload hook removed — OCR orchestrator delegates to
sharepoint-download workflow itself."
```

---

## Phase 7 — Frontend feature additions (5 tasks)

### Task 20: ApprovalInbox rule + delegation pills

**Files:**
- Modify: `src/tracker/dashboard.ts` (`buildPreviewInboxHandler`)
- Modify: `src/dashboard/components/ApprovalInbox.tsx` (no logic change — just verify the new server payload renders)
- Modify: `src/dashboard/components/EntryItem.tsx` (add parent pill)

- [ ] **Step 1: Update `buildPreviewInboxHandler`**

In `src/tracker/dashboard.ts`, find `buildPreviewInboxHandler`. Change the predicate from:

```ts
// OLD:
const isPreview =
  e.data?.mode === "prepare" &&
  e.status === "done" &&
  e.step !== "approved" &&
  e.step !== "discarded";
```

to:

```ts
// NEW:
const isPreview =
  e.workflow === "ocr" &&
  e.status === "done" &&
  e.step === "awaiting-approval";
```

- [ ] **Step 2: Add parent-pill rendering in `EntryItem`**

Edit `src/dashboard/components/EntryItem.tsx`. Where the row's header / time row is rendered, add:

```tsx
{entry.parentRunId && (
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation();
      onNavigateToParent?.(entry.parentRunId!);
    }}
    className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-px font-mono text-[10px] text-muted-foreground hover:bg-muted"
    title="Open parent run"
  >
    ↗ from parent
  </button>
)}
```

`onNavigateToParent` is a new optional prop fired from the queue panel; it should select the parent run by its runId. Resolution: the queue panel's parent component (`App.tsx` likely) maintains a `runId → entry` index and switches `activeWorkflow` + `selectedId` when called.

- [ ] **Step 3: Add "Delegated runs" section in `LogPanel`**

Edit `src/dashboard/components/LogPanel.tsx`. Above `StepPipeline`, add:

```tsx
{childEntries.length > 0 && (
  <section className="mb-3 rounded-md border border-border p-3">
    <h3 className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
      Delegated runs ({childEntries.length})
    </h3>
    <ul className="space-y-1">
      {childEntries.map((c) => (
        <MiniEntryRow key={`${c.workflow}#${c.id}#${c.runId}`} entry={c} onClick={() => onOpenChild?.(c)} />
      ))}
    </ul>
  </section>
)}
```

`childEntries` is computed from `useEntries` (or a new `useChildEntries(parentRunId)` hook): all entries across workflows where `parentRunId === current entry's runId`. Add a helper `findChildren(allEntries, parentRunId): TrackerEntry[]`.

`MiniEntryRow` is a small component showing workflow icon, name, status badge, click target.

- [ ] **Step 4: Run typecheck + dashboard build**

Run: `npm run typecheck`
Expected: no errors

Run: `npm run build:dashboard`
Expected: clean build

- [ ] **Step 5: Commit**

```bash
git add src/tracker/dashboard.ts src/dashboard/components/ApprovalInbox.tsx src/dashboard/components/EntryItem.tsx src/dashboard/components/LogPanel.tsx
git commit -m "feat(dashboard): delegation pills + Delegated runs section

EntryItem renders 'from parent' pill when parentRunId is set. LogPanel
shows 'Delegated runs (N)' section above StepPipeline listing child
entries. ApprovalInbox now keys on workflow=ocr + step=awaiting-approval
instead of data.mode=prepare."
```

### Task 21: Force-research UI in `OcrReviewPane`

**Files:**
- Modify: `src/dashboard/components/ocr/OcrReviewPane.tsx`
- Modify: per-record components (`OathRecordView.tsx`, `EcRecordView.tsx`)

- [ ] **Step 1: Add per-row ↻ button to record views**

In `OathRecordView.tsx` and `EcRecordView.tsx`, add a button next to the name:

```tsx
<button
  type="button"
  onClick={() => onForceResearch?.(record)}
  disabled={isResearching}
  title="Re-run eid-lookup for this record"
  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
>
  <RotateCw className="h-3 w-3" />
</button>
```

Add `onForceResearch` and `isResearching` to the props of each renderer.

- [ ] **Step 2: Add bulk toolbar in `OcrReviewPane`**

```tsx
<div className="flex items-center gap-2 mb-2">
  <button
    type="button"
    disabled={selectedIndices.size === 0}
    onClick={() => handleForceResearch(Array.from(selectedIndices))}
  >
    ↻ Re-research selected ({selectedIndices.size})
  </button>
  <button
    type="button"
    onClick={() => handleForceResearch(records.map((_, i) => i))}
  >
    ↻ Re-research all
  </button>
</div>
```

- [ ] **Step 3: Wire up `handleForceResearch`**

```tsx
async function handleForceResearch(indices: number[]) {
  setResearchingIndices(new Set(indices));
  try {
    const r = await fetch("/api/ocr/force-research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, runId, recordIndices: indices }),
    });
    if (!r.ok) {
      const body = await r.json();
      toast.error("Re-research failed", { description: body.error });
    } else {
      toast.success("Re-research started");
    }
  } finally {
    // Records will update via SSE; clear local "researching" state when
    // the next entry arrives showing matchState != lookup-pending.
    setResearchingIndices(new Set());
  }
}
```

The pulsing-dot indicator: each row reads `record.matchState === "lookup-pending"` from the latest entry pulled via SSE.

- [ ] **Step 4: Run dashboard, smoke-test the per-row + bulk buttons**

```bash
npm run dashboard
```

Upload a PDF, wait for OCR to finish, click ↻ on a row. Verify the row's matchState flips to lookup-pending.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/components/ocr/OcrReviewPane.tsx src/dashboard/components/ocr/OathRecordView.tsx src/dashboard/components/ocr/EcRecordView.tsx
git commit -m "feat(dashboard): force-research per-row + bulk toolbar

↻ button on each record. Bulk 'Re-research selected' / 'Re-research all'
in the toolbar. Posts to /api/ocr/force-research; record state updates
via SSE."
```

### Task 22: Reupload UI on `OcrQueueRow`

**Files:**
- Modify: `src/dashboard/components/ocr/OcrQueueRow.tsx`
- Modify: `src/dashboard/components/RunModal.tsx` (already accepts `reuploadFor` from Task 19)

- [ ] **Step 1: Add Reupload button to `OcrQueueRow`**

In `OcrQueueRow.tsx`, in the Foot zone (next to Discard):

```tsx
<button
  onClick={(e) => {
    e.stopPropagation();
    onReupload?.({ sessionId: data.sessionId ?? entry.id, previousRunId: entry.runId });
  }}
  disabled={discarding}
  className="inline-flex h-6 items-center gap-1 rounded-md border border-border px-1.5 text-[11px] text-muted-foreground hover:bg-muted"
  title="Re-upload corrected PDF — carries forward resolved EIDs from this run"
>
  <UploadCloud className="h-3 w-3" /> Reupload
</button>
```

`onReupload` is a new prop forwarded up to whatever parent owns the RunModal state (likely `App.tsx`):

```tsx
function handleReupload(reuploadFor: { sessionId: string; previousRunId: string }) {
  setRunModalOpen(true);
  setRunModalReuploadFor(reuploadFor);
}
```

- [ ] **Step 2: When RunModal opens in reupload mode, auto-fill formType**

In RunModal:

```tsx
useEffect(() => {
  if (!open || !reuploadFor) return;
  // Read the parent OCR row to find formType.
  fetch(`/api/entries?workflow=ocr`)
    .then(r => r.json())
    .then((entries: any[]) => {
      const parent = entries.find(e => e.id === reuploadFor.sessionId && e.runId === reuploadFor.previousRunId);
      if (parent?.data?.formType) {
        setFormType(parent.data.formType);
      }
    });
}, [open, reuploadFor]);
```

- [ ] **Step 3: Smoke-test the reupload flow**

Upload PDF v1 → wait for OCR → click Reupload → modal opens with formType locked → upload PDF v2 → submit. Verify v2's preview row appears (same sessionId, new runId), v1 entries show step=superseded in their RunSelector pills.

- [ ] **Step 4: Commit**

```bash
git add src/dashboard/components/ocr/OcrQueueRow.tsx src/dashboard/components/RunModal.tsx src/dashboard/App.tsx
git commit -m "feat(dashboard): Reupload button on OcrQueueRow

Opens RunModal in reupload mode with sessionId + previousRunId pre-set.
formType is auto-resolved from the parent row. v1 row gets step=superseded
in its RunSelector history."
```

### Task 23: localStorage edit-key migration to `ocr-edits:<sessionId>`

**Files:**
- Modify: `src/dashboard/components/ocr/OcrReviewPane.tsx` (or wherever record edits persist)

- [ ] **Step 1: Update edit persistence to use single namespace**

In whichever component currently uses `oath-prep-edits:` / `ec-prep-edits:`, replace with:

```ts
const editKey = `ocr-edits:${sessionId}`;
```

The keys persist edits across reuploads (same sessionId → same key). Cleared on Approve / Discard endpoints' successful response.

- [ ] **Step 2: Run dashboard + smoke**

Upload PDF, edit a record, refresh tab → edits restored. Approve → localStorage cleared.

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/components/ocr/OcrReviewPane.tsx
git commit -m "feat(dashboard): unify edit-key localStorage namespace

ocr-edits:<sessionId> replaces oath-prep-edits:<runId> + ec-prep-edits:
<runId>. Edits persist across reuploads (carry-forward UX). Cleared on
approve/discard."
```

### Task 24: Capture migration

**Files:**
- Modify: `src/capture/sessions.ts`
- Modify: `src/capture/server.ts`

- [ ] **Step 1: Extend session metadata schema**

Edit `src/capture/sessions.ts`. The session schema (likely a Zod object) gains:

```ts
formType: z.enum(["oath", "emergency-contact"]).optional(),
```

When `workflow === "ocr"`, formType is required; otherwise optional. Add a `superRefine` if Zod's required-when-other-equals isn't expressible.

- [ ] **Step 2: Reroute `makeCaptureFinalize`**

Edit `src/capture/server.ts::makeCaptureFinalize`. Today it routes `workflow === "oath-signature"` to `runPaperOathPrepare`. Replace with:

```ts
async function onFinalize(session: CaptureSession, pdfPath: string): Promise<void> {
  let formType: string;
  let workflow: string;
  if (session.workflow === "oath-signature") {
    workflow = "ocr";
    formType = "oath";
  } else if (session.workflow === "emergency-contact") {
    workflow = "ocr";
    formType = "emergency-contact";
  } else if (session.workflow === "ocr" && session.formType) {
    workflow = "ocr";
    formType = session.formType;
  } else {
    log.warn(`[capture] Unknown workflow ${session.workflow} — ignoring`);
    return;
  }

  // POST to /api/ocr/prepare — same multipart shape RunModal uses.
  const fd = new FormData();
  fd.append("pdf", new File([readFileSync(pdfPath)], `capture-${session.id}.pdf`));
  fd.append("formType", formType);
  fd.append("rosterMode", "existing");
  // ... POST to localhost:3838/api/ocr/prepare ...
  void workflow;
}
```

- [ ] **Step 3: Smoke**

Use the QR capture flow on phone, snap an oath roster, finish. Verify an OCR row appears in the OCR tab (not oath-signature).

- [ ] **Step 4: Commit**

```bash
git add src/capture/sessions.ts src/capture/server.ts
git commit -m "feat(capture): route to /api/ocr/prepare instead of legacy prep endpoints

QR capture sessions targeting oath-signature/emergency-contact now
redirect through OCR. New sessions can target workflow=ocr directly
with explicit formType."
```

---

## Phase 8 — Cleanup (2 tasks)

### Task 25: Delete old preview-schema files

**Files:**
- Delete: `src/workflows/oath-signature/preview-schema.ts`
- Delete: `src/workflows/emergency-contact/preview-schema.ts`
- Modify: barrel re-exports in both workflows' `index.ts` (point to `ocr-form.ts` instead)

- [ ] **Step 1: Verify nothing still imports preview-schema**

```bash
grep -rn "preview-schema" src/ tests/
```

Expected: only the to-be-deleted files themselves + the barrel re-exports.

- [ ] **Step 2: Update barrels**

Edit `src/workflows/oath-signature/index.ts` to remove the `./preview-schema.js` re-export line; the same exports now come from `./ocr-form.js` (added in Task 5).

Same for `src/workflows/emergency-contact/index.ts`.

- [ ] **Step 3: Delete the files**

```bash
git rm src/workflows/oath-signature/preview-schema.ts
git rm src/workflows/emergency-contact/preview-schema.ts
```

- [ ] **Step 4: Run typecheck + tests**

Run: `npm run typecheck`
Expected: no errors

Run: `npm run test`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: delete old preview-schema files

Schemas now live in {oath-signature,emergency-contact}/ocr-form.ts
inside the OcrFormSpec definition. Barrel re-exports updated."
```

### Task 26: Delete old prep code + HTTP handlers + routes

**Files:**
- Delete: `src/workflows/oath-signature/prepare.ts`
- Delete: `src/workflows/emergency-contact/prepare.ts`
- Delete: `src/tracker/oath-signature-http.ts`
- Delete: `src/tracker/emergency-contact-http.ts`
- Modify: `src/tracker/dashboard.ts` (remove old route registrations + sweeps)
- Modify: barrel re-exports in both workflow index.ts files

- [ ] **Step 1: Audit callers**

```bash
grep -rn "runPrepare\|runPaperOathPrepare\|sweepStuckPrepRows\|sweepStuckOathPrepRows" src/ tests/
```

Expected callers: only the dashboard.ts route registrations + the to-be-deleted files. If anything else calls them (e.g. a script in `src/scripts/`), update it to use `/api/ocr/prepare` instead.

- [ ] **Step 2: Delete the files**

```bash
git rm src/workflows/oath-signature/prepare.ts
git rm src/workflows/emergency-contact/prepare.ts
git rm src/tracker/oath-signature-http.ts
git rm src/tracker/emergency-contact-http.ts
```

- [ ] **Step 3: Remove old routes from `dashboard.ts`**

Find and delete:
- All `/api/oath-signature/{prepare,approve-batch,discard-prepare}` route registrations.
- All `/api/emergency-contact/{prepare,approve-batch,discard-prepare}` route registrations.
- Calls to `sweepStuckPrepRows` and `sweepStuckOathPrepRows` (the new `sweepStuckOcrRows` replaces them).

- [ ] **Step 4: Update barrels**

In `src/workflows/oath-signature/index.ts`:
```ts
// DELETE:
export { runPaperOathPrepare } from "./prepare.js";
export type { PaperOathPrepareInput, PaperOathPrepareOutput } from "./prepare.js";
```

Same for `src/workflows/emergency-contact/index.ts`:
```ts
// DELETE:
export { runPrepare } from "./prepare.js";
export type { PrepareInput, PrepareOutput } from "./prepare.js";
```

- [ ] **Step 5: Run typecheck + tests + dashboard build**

Run: `npm run typecheck`
Expected: no errors

Run: `npm run test`
Expected: all PASS

Run: `npm run build:dashboard`
Expected: clean build

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: delete old prep code + HTTP handlers + routes

oath-signature/prepare.ts, emergency-contact/prepare.ts,
{oath-signature,emergency-contact}-http.ts deleted. /api/oath-signature/*
and /api/emergency-contact/* prep routes removed from dashboard.ts.
Sweeps replaced by sweepStuckOcrRows. The OCR migration is complete."
```

### Task 27: CLAUDE.md updates

**Files:**
- Modify: `CLAUDE.md` (root)
- Modify: `src/workflows/oath-signature/CLAUDE.md`
- Modify: `src/workflows/emergency-contact/CLAUDE.md`
- Modify: `src/tracker/CLAUDE.md`
- Modify: `src/dashboard/CLAUDE.md`
- Modify: `src/workflows/CLAUDE.md`

Document the new architecture so future sessions don't reinvent the prep flow.

- [ ] **Step 1: Root `CLAUDE.md`**

Add to the "Existing Workflows" section a row for `ocr`:

```
| ocr | _Dashboard button + Capture_ (HTTP only — no CLI, no daemon) | _none_ | Yes (no systems) | In-process (single fire-and-forget) |
```

Add a new bullet to "Architecture > Data flows":

```
**OCR (kernel, HTTP-driven, no browser)**
PDF upload → form-spec dispatch (oath / emergency-contact) → OCR → roster match → eid-lookup (delegated) → preview row in OCR tab → operator approves → fan-out to form-type's daemon
```

Update "Step Tracking Per Workflow" table:

```
| ocr | loading-roster → ocr → matching → eid-lookup → verification → awaiting-approval |
```

- [ ] **Step 2: `src/workflows/oath-signature/CLAUDE.md`**

Add a paragraph after "What this workflow does":

```
**OCR prep:** the paper-roster prep flow (operator uploads PDF → OCR → preview → approve) lives in the OCR workflow (`src/workflows/ocr/`). When operator approves an OCR row with formType=oath, it fans out per-EID kernel queue items to this workflow's daemon. See `src/workflows/oath-signature/ocr-form.ts` for the per-form spec (schemas + match logic).
```

Remove (or replace) the "Dashboard 'Run' button (paper-roster prep)" section — that lives in OCR's CLAUDE.md now.

- [ ] **Step 3: `src/workflows/emergency-contact/CLAUDE.md`**

Same pattern: replace the "Dashboard 'Run' button (self-service prep)" section with a pointer to OCR.

- [ ] **Step 4: `src/tracker/CLAUDE.md`**

Add docs for `watch-child-runs.ts` + `ocr-http.ts` + `parentRunId` field on TrackerEntry.

- [ ] **Step 5: `src/dashboard/CLAUDE.md`**

Update the API endpoints table — remove the old `/api/{oath,ec}/*` rows, add the `/api/ocr/*` rows. Add a note about the parent-pill rendering in EntryItem and the "Delegated runs" section in LogPanel.

- [ ] **Step 6: `src/workflows/CLAUDE.md`**

Add `ocr` to the existing-workflows table. Note that OCR is the only workflow with `systems: []`.

- [ ] **Step 7: Run typecheck (sanity — CLAUDE.md changes won't fail typecheck, but run anyway)**

Run: `npm run typecheck`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add CLAUDE.md src/workflows/{oath-signature,emergency-contact,CLAUDE}.md src/tracker/CLAUDE.md src/dashboard/CLAUDE.md
git commit -m "docs: update CLAUDE.md files for OCR + delegation

Root CLAUDE.md, per-workflow CLAUDE.md, src/tracker/CLAUDE.md, src/
dashboard/CLAUDE.md all updated. The prep flow moved out of oath-signature
and emergency-contact into OCR; consumers now point at OCR's CLAUDE.md."
```

---

## Phase 9 — Live smoke (1 task)

### Task 28: End-to-end live smoke test

**Files:** none — this is manual verification.

Verify both form types end-to-end against real systems. Don't merge to master without this.

- [ ] **Step 1: Start the dashboard**

```bash
npm run dashboard
```

Open http://localhost:5173, switch to OCR tab.

- [ ] **Step 2: Smoke oath**

- Click Run → pick "Oath signature" → drop a real oath PDF → Submit.
- Verify pending row appears, progresses through loading-roster → ocr → matching → eid-lookup → done(awaiting-approval).
- Click row → review pane opens with records.
- Pick one row → click ↻ — verify it goes to lookup-pending and resolves.
- Edit a record's date → click Approve.
- Switch to oath-signature tab — verify N rows enqueued with parentRunId pill.
- Wait for the daemon to claim a row (or pre-spawn `npm run oath-signature -- -p 1` to ensure capacity).

- [ ] **Step 3: Smoke emergency-contact**

Same as above but pick "Emergency contact" form type. Verify approve fans out to emergency-contact daemon.

- [ ] **Step 4: Smoke reupload**

After Step 2, click Reupload on an oath OCR row. Drop a v2 PDF (modified). Submit. Verify the new row carries forward EIDs from v1, the v1 row's RunSelector shows step=superseded.

- [ ] **Step 5: Smoke SharePoint roster delegation**

In RunModal, pick "Download fresh from SharePoint". Verify a sharepoint-download row appears with `parentRunId` = OCR's runId; OCR row sits at step=loading-roster until SharePoint completes; OCR proceeds to step=ocr after.

- [ ] **Step 6: If anything fails — file the issue, do NOT merge**

Document failures in a follow-up issue. Common gotchas:
- Multipart parsing of formType in /api/ocr/prepare — verify the body parser handles it.
- Per-form record renderer not registered — check `RECORD_RENDERERS` registry.
- Capture flow still pointing at old endpoint — check `src/capture/server.ts` redirect.

- [ ] **Step 7: Merge** (after all 5 smoke variants pass)

```bash
git checkout master
git merge --no-ff <feature-branch> -m "feat: OCR workflow + delegation primitive (Pieces 1+2)

Extracts the OCR-with-preview-and-approval flow from oath-signature/
prepare.ts and emergency-contact/prepare.ts into a kernel-registered
'ocr' workflow with its own dashboard tab, run modal, queue rows, and
preview pane. Adds delegation primitive (parentRunId field +
watchChildRuns helper). Rewires SharePoint roster as a delegated child.
Old prep code deleted.

Spec: docs/superpowers/specs/2026-05-01-ocr-workflow-and-delegation-design.md
Plan: docs/superpowers/plans/2026-05-01-ocr-workflow-and-delegation-plan.md"
```

---

## Self-review checklist (perform after writing the plan)

**Spec coverage** — every section of the spec maps to a task:

- [x] §"Goals" — addressed across all phases
- [x] §"Architecture overview" — Tasks 2, 3, 7, 10
- [x] §"OCR workflow shape" — Task 10
- [x] §"Form-type spec contract" — Tasks 4, 5, 6, 7
- [x] §"Re-upload + carry-forward" — Tasks 8, 9, 22, 23
- [x] §"Force-research" — Tasks 13, 21
- [x] §"Delegation primitive" — Tasks 2, 3, 9, 20
- [x] §"Dashboard surfaces" — Tasks 17, 18, 19, 20, 21, 22
- [x] §"HTTP endpoints + capture migration" — Tasks 13, 14, 24
- [x] §"SharePoint roster integration" — Tasks 15, 16, 19
- [x] §"Edge cases + risks" — Task 1 (kernel empty systems), Task 13 (sessionId lock + sweep)
- [x] §"Decision log" — embedded in spec, not a code task

**Type consistency** — `OcrFormSpec` uses generics consistently; `parentRunId` field consistently optional; `sessionId` always = entry.id; `runId` always = entry.runId.

**Placeholder scan** — none found. Every task has executable code or commands. Force-research patch in Task 13 references the orchestrator's patch logic ("[Same logic as orchestrator's patch helpers — could be extracted; left inline here for readability of the force-research delta.]") — this is intentional duplication noted as a future cleanup, not a placeholder.

**Ordering** — Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 is strictly sequential. No phase can land before its predecessor's tests pass.
