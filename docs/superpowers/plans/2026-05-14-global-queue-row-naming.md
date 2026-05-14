# Global Queue Row Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one global queue-title naming scheme so single rows use the person title, batch rows use `Oath · #1234` / `Emergency Contact · #1234` style titles, and delegated rows inherit the root parent title.

**Architecture:** Introduce a shared domain primitive for queue titles, stamp it in the kernel / enqueue paths, and make dashboard display resolution prefer that primitive over legacy `__name` / `parentSubject` heuristics. Keep compatibility fields during migration so older tracker rows and existing delegation code continue to render. This plan changes titles only; no row grouping or queue-control semantics should change.

**Tech Stack:** TypeScript, Node 26, `node:test`, tsx, React dashboard, JSONL tracker rows.

---

## Naming Rules

- **Single:** rows tied to one person/name/EID/email display that person-linked title. Examples: EID lookup by name, active check by name/EID, oath-signature by EID after name resolution if standalone.
- **Batch:** rows that represent a PDF / prepare parent display `<Batch Type Label> · #<last4(runId)>`. For OCR/prep flows use form-specific labels:
  - oath form: `Oath · #1234`
  - emergency contact form: `Emergency Contact · #1234`
- **Delegation:** any child or grandchild with a parent run displays the root parent's queue title. The parent row and all delegated rows share the same visible title.

## File Structure

- Create `src/domain/queue-title.ts`
  - Owns the queue title kind enum, title data fields, batch label formatting, and inheritance helpers.
- Modify `src/core/kernel/types.ts`
  - Adds optional `queueTitle` metadata to `WorkflowConfig`.
- Modify `src/core/kernel/workflow.ts`
  - Stamps single/batch queue title data in `buildInitialTrackerData`.
- Modify `src/core/daemon/enqueue-dispatch.ts`
  - Uses the same queue-title helper for HTTP/quick-run pending rows.
- Modify workflow definitions:
  - `src/workflows/eid-lookup/workflow.ts`
  - `src/workflows/active-check/workflow.ts`
  - `src/workflows/ocr/workflow.ts`
  - `src/workflows/oath-signature/workflow.ts`
  - `src/workflows/emergency-contact/workflow.ts`
  - Any prep HTTP helpers in `src/tracker/dashboard/ocr/prepare.ts` and `src/tracker/dashboard/ocr/approve.ts`
- Modify `src/dashboard/components/shared/entry-display.ts`
  - Makes queue title fields the first display source and makes delegation inheritance unconditional.
- Update docs:
  - `src/dashboard/CLAUDE.md`
  - `src/tracker/CLAUDE.md`
  - nearest workflow `CLAUDE.md` files touched by non-obvious naming behavior.

## Task 1: Add Shared Queue Title Domain Primitive

**Files:**
- Create: `src/domain/queue-title.ts`
- Test: `tests/unit/domain/queue-title.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/domain/queue-title.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  batchQueueTitle,
  queueTitleData,
  readQueueTitle,
  rootQueueTitleData,
} from "../../../src/domain/queue-title.js";

test("batchQueueTitle formats label plus last 4 run id characters", () => {
  assert.equal(batchQueueTitle("Oath", "1234567890ab"), "Oath · #90ab");
  assert.equal(batchQueueTitle("Emergency Contact", "run-3456"), "Emergency Contact · #3456");
});

test("queueTitleData stamps title and kind", () => {
  assert.deepEqual(queueTitleData({ kind: "single", title: "Doe, Jane" }), {
    __queueTitle: "Doe, Jane",
    __queueTitleKind: "single",
  });
});

test("rootQueueTitleData preserves the inherited root title", () => {
  assert.deepEqual(rootQueueTitleData("Oath · #90ab"), {
    __queueTitle: "Oath · #90ab",
    __queueTitleKind: "delegation",
    __queueRootTitle: "Oath · #90ab",
    parentSubject: "Oath · #90ab",
  });
});

test("readQueueTitle prefers root title over local title", () => {
  assert.equal(readQueueTitle({ __queueRootTitle: "Oath · #90ab", __queueTitle: "Doe, Jane" }), "Oath · #90ab");
  assert.equal(readQueueTitle({ __queueTitle: "Doe, Jane" }), "Doe, Jane");
  assert.equal(readQueueTitle({}), undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/tsx --test tests/unit/domain/queue-title.test.ts`

Expected: FAIL because `src/domain/queue-title.ts` does not exist.

- [ ] **Step 3: Implement the primitive**

Create `src/domain/queue-title.ts`:

```ts
export type QueueTitleKind = "single" | "batch" | "delegation";

export interface QueueTitle {
  kind: QueueTitleKind;
  title: string;
}

export function batchQueueTitle(label: string, runId: string): string {
  return `${label} · #${runId.slice(-4)}`;
}

export function queueTitleData(title: QueueTitle | null | undefined): Record<string, string> {
  if (!title?.title.trim()) return {};
  return {
    __queueTitle: title.title.trim(),
    __queueTitleKind: title.kind,
  };
}

export function rootQueueTitleData(title: string | undefined): Record<string, string> {
  const trimmed = title?.trim();
  if (!trimmed) return {};
  return {
    __queueTitle: trimmed,
    __queueTitleKind: "delegation",
    __queueRootTitle: trimmed,
    parentSubject: trimmed,
  };
}

export function readQueueTitle(data: Record<string, unknown> | null | undefined): string | undefined {
  const root = data?.__queueRootTitle;
  if (typeof root === "string" && root.trim()) return root.trim();
  const local = data?.__queueTitle;
  if (typeof local === "string" && local.trim()) return local.trim();
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/tsx --test tests/unit/domain/queue-title.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/queue-title.ts tests/unit/domain/queue-title.test.ts
git commit -m "feat(domain): add queue title primitive"
```

## Task 2: Stamp Queue Titles in Kernel and HTTP Enqueue Paths

**Files:**
- Modify: `src/core/kernel/types.ts`
- Modify: `src/core/kernel/workflow.ts`
- Modify: `src/core/daemon/enqueue-dispatch.ts`
- Test: `tests/unit/core/initial-data.test.ts`
- Test: `tests/unit/core/enqueue-dispatch.test.ts`

- [ ] **Step 1: Add failing kernel tests**

In `tests/unit/core/initial-data.test.ts`, add:

```ts
test("buildInitialTrackerData stamps single queue titles from operator subject", () => {
  const wf = defineWorkflow({
    name: "queue-title-test",
    systems: [],
    steps: ["done"] as const,
    schema: z.object({ name: z.string() }),
    queueTitle: { kind: "single" },
    operatorSubject: (input) => ({ kind: "person", label: input.name }),
    handler: async () => {},
  });

  const data = buildInitialTrackerData(wf, { name: "Doe, Jane" });

  assert.equal(data.__queueTitle, "Doe, Jane");
  assert.equal(data.__queueTitleKind, "single");
});
```

In `tests/unit/core/enqueue-dispatch.test.ts`, add a case for a workflow with `queueTitle: { kind: "single" }` and assert `buildHttpPendingData(...)` includes `__queueTitle` and `__queueTitleKind`.

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/core/initial-data.test.ts tests/unit/core/enqueue-dispatch.test.ts
```

Expected: FAIL because `queueTitle` is not part of `WorkflowConfig` and no title fields are stamped.

- [ ] **Step 3: Add workflow metadata type**

In `src/core/kernel/types.ts`, add:

```ts
export type WorkflowQueueTitleConfig<TData> =
  | { kind: "single" }
  | { kind: "batch"; label?: string; labelFromInput?: (input: TData) => string | undefined };
```

Then add to `WorkflowConfig`:

```ts
  /**
   * Global queue-row title policy. This only controls display titles today,
   * but it is intentionally metadata so future queue naming surfaces can
   * reuse the same classification.
   */
  queueTitle?: WorkflowQueueTitleConfig<TData>
```

- [ ] **Step 4: Stamp title data in `buildInitialTrackerData`**

In `src/core/kernel/workflow.ts`, import `queueTitleData` and add a helper:

```ts
import { queueTitleData } from "../../domain/queue-title.js";

function buildQueueTitleForInput<TData, TSteps extends readonly string[]>(
  wf: RegisteredWorkflow<TData, TSteps>,
  input: TData,
  seed: Record<string, string>,
): Record<string, string> {
  const config = wf.config.queueTitle;
  if (!config) return {};
  if (config.kind === "single") {
    const title = seed.__subject || seed.__name || wf.config.getName?.(seed) || "";
    return queueTitleData({ kind: "single", title });
  }
  if (config.kind === "batch") {
    const title = config.labelFromInput?.(input) ?? config.label ?? wf.config.label ?? wf.config.name;
    return queueTitleData({ kind: "batch", title });
  }
  return {};
}
```

Then update `buildInitialTrackerData`:

```ts
  const initial = wf.config.initialData ? stringifyMap(wf.config.initialData(input)) : {};
  const subject = wf.config.operatorSubject ? operatorSubjectData(wf.config.operatorSubject(input)) : {};
  const seed = { ...initial, ...subject };
  return { ...seed, ...buildQueueTitleForInput(wf, input, seed) };
```

Do not add run-id suffixing here; the kernel helper does not know the final run id. Batch rows that need `#1234` are prepared by the tracker HTTP prep path in Task 3.

- [ ] **Step 5: Ensure HTTP pending rows use the same seed path**

`src/core/daemon/enqueue-dispatch.ts` already calls `buildInitialTrackerData`. Make no separate title logic there unless tests reveal a missing merge. If a failing test shows `buildHttpPendingData` overwrites the fields, preserve `__queueTitle` and `__queueTitleKind` after `getName` / `getId`.

- [ ] **Step 6: Run tests**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/core/initial-data.test.ts tests/unit/core/enqueue-dispatch.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/kernel/types.ts src/core/kernel/workflow.ts src/core/daemon/enqueue-dispatch.ts tests/unit/core/initial-data.test.ts tests/unit/core/enqueue-dispatch.test.ts
git commit -m "feat(core): stamp global queue title metadata"
```

## Task 3: Apply Queue Title Policies to Workflows and Prep Parents

**Files:**
- Modify: `src/workflows/eid-lookup/workflow.ts`
- Modify: `src/workflows/active-check/workflow.ts`
- Modify: `src/workflows/ocr/workflow.ts`
- Modify: `src/workflows/oath-signature/workflow.ts`
- Modify: `src/workflows/emergency-contact/workflow.ts`
- Modify: `src/tracker/dashboard/ocr/prepare.ts`
- Modify: `src/tracker/dashboard/ocr/approve.ts`
- Test: `tests/unit/tracker/dashboard/ocr-prepare-parent-naming.test.ts`
- Test: `tests/unit/workflows/eid-lookup/pre-emit-parent-subject.test.ts`
- Test: `tests/unit/workflows/oath-signature/pre-emit-parent-subject.test.ts`

- [ ] **Step 1: Add failing prep parent naming tests**

In `tests/unit/tracker/dashboard/ocr-prepare-parent-naming.test.ts`, assert:

```ts
assert.equal(pending.data.__queueTitle, "Oath · #90ab");
assert.equal(pending.data.__queueTitleKind, "batch");
assert.equal(pending.data.__queueRootTitle, "Oath · #90ab");
```

For emergency contact, assert:

```ts
assert.equal(pending.data.__queueTitle, "Emergency Contact · #3456");
assert.equal(pending.data.__queueTitleKind, "batch");
assert.equal(pending.data.__queueRootTitle, "Emergency Contact · #3456");
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/tracker/dashboard/ocr-prepare-parent-naming.test.ts
```

Expected: FAIL because prep rows do not stamp global queue title fields yet.

- [ ] **Step 3: Add queue title metadata to single-person workflows**

In `eidLookupCrmWorkflow`, `activeCheckWorkflow`, and standalone person workflows that should display person-linked rows, add:

```ts
queueTitle: { kind: "single" },
```

Keep existing `operatorSubject`, `initialData`, `getName`, and `getId`.

- [ ] **Step 4: Add form-specific batch title helper in prep code**

In `src/tracker/dashboard/ocr/prepare.ts`, import:

```ts
import { batchQueueTitle, rootQueueTitleData, queueTitleData } from "../../../domain/queue-title.js";
```

Add:

```ts
function batchTypeLabelForForm(formType: string | undefined): string {
  if (formType === "oath") return "Oath";
  if (formType === "emergency-contact") return "Emergency Contact";
  return "OCR";
}

function prepBatchQueueTitle(formType: string | undefined, runId: string): string {
  return batchQueueTitle(batchTypeLabelForForm(formType), runId);
}
```

Where the origin parent pending row is emitted, compute:

```ts
const queueTitle = prepBatchQueueTitle(formType, parentRunId);
```

Then include in `data`:

```ts
__name: queueTitle,
...queueTitleData({ kind: "batch", title: queueTitle }),
__queueRootTitle: queueTitle,
parentSubject: queueTitle,
```

This intentionally changes previous `Oath Signature · #1234` labels to `Oath · #1234` for oath PDFs and `Emergency Contact · #1234` for emergency-contact PDFs.

- [ ] **Step 5: Preserve root title on approval**

In `src/tracker/dashboard/ocr/approve.ts`, when writing the approved parent row and downstream child pending rows, preserve:

```ts
const inheritedTitle = latestParentData.__queueRootTitle || latestParentData.__queueTitle || latestParentData.__name;
```

Then include:

```ts
...rootQueueTitleData(inheritedTitle),
```

in each delegated child input/pending row that currently receives `parentSubject`.

- [ ] **Step 6: Update workflow pre-emit hooks for delegated children**

Where `eidLookupPreEmitPending` and `oathSignaturePreEmitPending` currently copy `parentSubject` into `__name`, also copy global fields:

```ts
const inherited = item.parentSubject;
const queueFields = inherited ? rootQueueTitleData(inherited) : {};
```

Include `queueFields` in the emitted `data`. Keep `__name: inherited` for compatibility until every dashboard consumer has migrated.

- [ ] **Step 7: Run targeted tests**

Run:

```bash
./node_modules/.bin/tsx --test \
  tests/unit/tracker/dashboard/ocr-prepare-parent-naming.test.ts \
  tests/unit/workflows/eid-lookup/pre-emit-parent-subject.test.ts \
  tests/unit/workflows/oath-signature/pre-emit-parent-subject.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/workflows/eid-lookup/workflow.ts src/workflows/active-check/workflow.ts src/workflows/ocr/workflow.ts src/workflows/oath-signature/workflow.ts src/workflows/emergency-contact/workflow.ts src/tracker/dashboard/ocr/prepare.ts src/tracker/dashboard/ocr/approve.ts tests/unit/tracker/dashboard/ocr-prepare-parent-naming.test.ts tests/unit/workflows/eid-lookup/pre-emit-parent-subject.test.ts tests/unit/workflows/oath-signature/pre-emit-parent-subject.test.ts
git commit -m "feat(workflows): apply global queue title naming"
```

## Task 4: Make Dashboard Display Prefer Global Queue Titles

**Files:**
- Modify: `src/dashboard/components/shared/entry-display.ts`
- Test: `tests/unit/dashboard/entry-display.test.ts`

- [ ] **Step 1: Add failing display tests**

In `tests/unit/dashboard/entry-display.test.ts`, add:

```ts
test("batch rows display the global queue title", () => {
  const row = entry("ocr-session-1", {
    __queueTitle: "Oath · #90ab",
    __queueTitleKind: "batch",
    __queueRootTitle: "Oath · #90ab",
    __name: "Legacy Name",
  });
  row.workflow = "ocr";

  const displayNames = buildDisplayNameMap([row], "OCR");

  assert.equal(resolveEntryName(row, displayNames), "Oath · #90ab");
});

test("delegated rows inherit root queue title even with employee name", () => {
  const parent = entry("ocr-session-1", {
    __queueTitle: "Emergency Contact · #3456",
    __queueTitleKind: "batch",
    __queueRootTitle: "Emergency Contact · #3456",
  });
  parent.workflow = "ocr";
  parent.runId = "parent-run-1";

  const child = entry("10000001", {
    name: "Doe, Jane",
    __queueTitle: "Doe, Jane",
    __queueTitleKind: "delegation",
    __queueRootTitle: "Emergency Contact · #3456",
  });
  child.workflow = "active-check";
  child.parentRunId = "parent-run-1";

  const displayNames = buildDisplayNameMap([child, parent], "OCR");

  assert.equal(resolveEntryName(parent, displayNames), "Emergency Contact · #3456");
  assert.equal(resolveEntryName(child, displayNames), "Emergency Contact · #3456");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/tsx --test tests/unit/dashboard/entry-display.test.ts`

Expected: FAIL because current precedence may prefer employee names or legacy `__name`.

- [ ] **Step 3: Update `resolveEntryName` precedence**

In `src/dashboard/components/shared/entry-display.ts`, import `readQueueTitle`:

```ts
import { readQueueTitle } from "../../../domain/queue-title.js";
```

Update `resolveEntryName` so `displayNames` still wins, then queue title fields win before employee-name fallback:

```ts
  const fromMap = displayNames?.get(entry.id);
  if (fromMap) return fromMap;
  const d = entry.data ?? {};
  const queueTitle = readQueueTitle(d);
  if (queueTitle) return queueTitle;
  return resolveEmployeeLabel(d) || d.__name || d.__subject || "";
```

- [ ] **Step 4: Update `buildDisplayNameMap` display base**

At the start of `displayFor`, add:

```ts
const queueTitle = readQueueTitle(d);
if (queueTitle) {
  return {
    base: queueTitle,
    ordinal: false,
    explicitWorkflowName: d.__queueTitleKind === "batch" || d.__queueTitleKind === "delegation",
  };
}
```

In the final delegated-row pass, remove the special case that prefers `personName` for delegated rows. Delegated rows must inherit the root parent label even when they later resolve a person name.

- [ ] **Step 5: Run display tests**

Run:

```bash
./node_modules/.bin/tsx --test tests/unit/dashboard/entry-display.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/components/shared/entry-display.ts tests/unit/dashboard/entry-display.test.ts
git commit -m "feat(dashboard): prefer global queue titles"
```

## Task 5: Update Lessons and Run Final Verification

**Files:**
- Modify: `src/dashboard/CLAUDE.md`
- Modify: `src/tracker/CLAUDE.md`
- Modify: touched workflow `CLAUDE.md` files if behavior-specific notes belong there.

- [ ] **Step 1: Update dashboard lesson**

Add to `src/dashboard/CLAUDE.md` Lessons Learned:

```md
- **2026-05-14: Queue row titles use the global queue-title primitive.** Dashboard title resolution now prefers `data.__queueRootTitle` / `data.__queueTitle` before legacy `__name` and person-name fallbacks. Single rows use person-linked titles, batch prep rows use form-specific titles like `Oath · #1234` or `Emergency Contact · #1234`, and delegated descendants inherit the root parent title even after they resolve their own employee data.
```

- [ ] **Step 2: Update tracker/core lesson**

Add to `src/tracker/CLAUDE.md` or `src/core/CLAUDE.md`:

```md
- **2026-05-14: Queue title metadata is the canonical row-title contract.** New queue title behavior should stamp `data.__queueTitle`, `data.__queueTitleKind`, and, for delegated work, `data.__queueRootTitle`. Keep `__name` only as compatibility/display fallback; do not add new workflow-specific title hacks in pre-emit hooks.
```

- [ ] **Step 3: Run final verification**

Run:

```bash
./node_modules/.bin/tsx --test \
  tests/unit/domain/queue-title.test.ts \
  tests/unit/core/initial-data.test.ts \
  tests/unit/core/enqueue-dispatch.test.ts \
  tests/unit/tracker/dashboard/ocr-prepare-parent-naming.test.ts \
  tests/unit/workflows/eid-lookup/pre-emit-parent-subject.test.ts \
  tests/unit/workflows/oath-signature/pre-emit-parent-subject.test.ts \
  tests/unit/dashboard/entry-display.test.ts
npm run typecheck
npm run test
npm run lint
```

Expected: all commands pass. Because `npm run test` is included, `npm run lint` must also pass before declaring done.

- [ ] **Step 4: Commit docs and final fixes**

```bash
git add src/dashboard/CLAUDE.md src/tracker/CLAUDE.md src/core/CLAUDE.md src/workflows/*/CLAUDE.md
git commit -m "docs(queue): document global queue title contract"
```

If there are final code fixes from verification, commit them separately with the narrowest matching scope.

## Handoff

Use this `/handoff` prompt in the next execution session:

```text
/handoff Execute docs/superpowers/plans/2026-05-14-global-queue-row-naming.md.

Context:
- The goal is a global queue-row title contract.
- Single rows display the person-linked title.
- Batch rows display form-specific titles: `Oath · #<last4(runId)>` or `Emergency Contact · #<last4(runId)>`.
- Delegated rows inherit the root parent title, even if the child later resolves its own employee name.
- This is a title-only change for now; do not redesign queue grouping or controls.
- Preserve legacy `__name` / `parentSubject` compatibility while adding `__queueTitle`, `__queueTitleKind`, and `__queueRootTitle`.
- Follow AGENTS.md: use subagent-driven development by default, commit per task, and when running `npm run test`, also run `npm run lint`.
```
