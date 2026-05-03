# OCR Hybrid Match + Manual-Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop dropping OCR records on missing fields, wire the already-built `matchAgainstRosterAsync` hybrid LLM disambiguator into the oath form spec, add an EID-on-form short-circuit, and surface "no records on this page" + per-record candidate transparency so the operator always has a manual-fill path with the page image visible.

**Architecture:** Backend changes in `src/ocr/per-page.ts` (schema-tolerant runner), `src/workflows/oath-signature/ocr-form.ts` (employeeId field, async match, hybrid + form-EID branches), `src/workflows/ocr/orchestrator.ts` (disambiguating step, emptyPages emission, verify-only EID dispatch). Frontend changes extend the existing `OcrReviewPane` / `PrepReviewMultiPair` / `OathRecordView` / `EcRecordView` (no new component except `EmptyPagePlaceholder`). Reuses the already-shipped `matchAgainstRosterAsync` (`src/match/match.ts:301`) and `disambiguateMatch` (`src/ocr/disambiguate.ts`). No provider changes, no schema enforcement at the LLM API level.

**Tech Stack:** TypeScript, Zod 4, `node:test` + `node:assert/strict`, React 19, Tailwind, shadcn/ui, lucide-react.

**Spec:** `docs/superpowers/specs/2026-05-03-ocr-hybrid-match-and-manual-fill-design.md`.

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `src/ocr/per-page.ts` | Modify | Inject default `rowIndex` (array position) and `employeeSigned: true` before Zod parse; keep dropping records that lack `printedName` (true garbage) |
| `src/workflows/oath-signature/ocr-form.ts` | Modify | Add `employeeId` field; relax `rowIndex`/`employeeSigned`; switch `matchRecord` to async + form-EID short-circuit + hybrid name match; widen match-state and match-source enums; implement `applyDisambiguation` |
| `src/workflows/emergency-contact/ocr-form.ts` | Modify | Wrap `matchRecord` in async (no behavior change); stub `applyDisambiguation` returning record unchanged |
| `src/workflows/ocr/types.ts` | Modify | `matchRecord` returns `Promise<TPreview>`; add `applyDisambiguation`; widen `LookupKind` to include `"verify-only"` |
| `src/workflows/ocr/orchestrator.ts` | Modify | Add `disambiguating` step; await async `matchRecord`; batch-call disambiguator; emit `data.emptyPages: number[]`; dispatch `verify-only` lookups through eid-lookup-by-EID branch |
| `src/workflows/ocr/workflow.ts` | Modify | Add `"disambiguating"` to step tuple |
| `src/dashboard/components/ocr/types.ts` | Modify | Parse `data.emptyPages` (`?? []`); widen `matchState` and `matchSource` string-literal unions to include `"manual"` and `"form-eid"` |
| `src/dashboard/components/ocr/EmptyPagePlaceholder.tsx` | Create | Card with "Add row manually" + "Mark as blank" buttons; rendered inside `PrepReviewPair` so the page image is on the left |
| `src/dashboard/components/ocr/PrepReviewMultiPair.tsx` | Modify | New `[+ Add row to this page]` footer button; takes `onAddRow(page)` prop |
| `src/dashboard/components/ocr/OcrReviewPane.tsx` | Modify | Extend `renderList` with empty-page entries; thread `onAddRow` callback; tighten `isApprovable` to require non-empty digit-EID when selected |
| `src/dashboard/components/ocr/OathRecordView.tsx` | Modify | Render `matchSource` badge + collapsible "Why this match?" section |
| `src/dashboard/components/ocr/EcRecordView.tsx` | Modify | Same badge + collapsible (form-EID branch absent — N/A for EC) |
| `tests/unit/ocr/per-page.test.ts` | Modify | Add tests for rowIndex synthesis, employeeSigned default, true-garbage drop |
| `tests/unit/workflows/oath-signature/ocr-form.test.ts` | Modify | Add tests for form-EID short-circuit, hybrid match, disambiguator branches |
| `tests/unit/workflows/ocr/orchestrator.test.ts` | Modify | Add tests for `data.emptyPages`, disambiguating-step emission, verify-only dispatch |
| `CLAUDE.md` | Modify | Update OCR step list to include `disambiguating` |
| `src/ocr/CLAUDE.md` | Modify | Lessons entry for runner-level field defaults |
| `src/workflows/oath-signature/CLAUDE.md` | Modify | Lessons entry for form-EID short-circuit + hybrid match |
| `src/workflows/ocr/CLAUDE.md` | Modify | Lessons entry for empty-page placeholder + disambiguation phase |

---

## Task 1: Schema-tolerant per-page runner

**Goal:** Stop dropping records that omit `rowIndex` or `employeeSigned`. Inject runner-side defaults before Zod parse, mirroring the existing `sourcePage` injection.

**Files:**
- Modify: `src/ocr/per-page.ts:177-197` (the schema-validate loop)
- Modify: `tests/unit/ocr/per-page.test.ts` (append new tests)

- [ ] **Step 1.1: Add failing tests for rowIndex + employeeSigned synthesis**

Append to `tests/unit/ocr/per-page.test.ts`:

```ts
test("runOcrPerPage synthesizes rowIndex from array position when LLM omits it", async () => {
  __setPerPageCallForTests(async () => ({
    json: [
      { name: "first" },                    // rowIndex omitted
      { name: "second", rowIndex: 99 },     // LLM-supplied wins
      { name: "third" },                    // rowIndex omitted
    ],
    poolKeyId: "test-1",
  }));
  try {
    const Schema = z.object({
      sourcePage: z.number(),
      rowIndex: z.number().int().nonnegative(),
      name: z.string(),
    });
    const out = await runOcrPerPage({
      pagesAsImages: ["page-01.png"],
      pageImagesDir: "/tmp/ignored",
      prompt: "test",
      schema: Schema,
    });
    assert.equal(out.records.length, 3);
    assert.equal(out.records[0].rowIndex, 0, "first record gets rowIndex 0");
    assert.equal(out.records[1].rowIndex, 99, "LLM-supplied rowIndex wins over default");
    assert.equal(out.records[2].rowIndex, 2, "third record gets rowIndex 2");
  } finally {
    __setPerPageCallForTests(undefined);
  }
});

test("runOcrPerPage defaults employeeSigned to true when LLM omits it", async () => {
  __setPerPageCallForTests(async () => ({
    json: [{ name: "x" }],
    poolKeyId: "test-1",
  }));
  try {
    const Schema = z.object({
      sourcePage: z.number(),
      name: z.string(),
      employeeSigned: z.boolean(),
    });
    const out = await runOcrPerPage({
      pagesAsImages: ["page-01.png"],
      pageImagesDir: "/tmp/ignored",
      prompt: "test",
      schema: Schema,
    });
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0].employeeSigned, true, "default is true when LLM omits");
  } finally {
    __setPerPageCallForTests(undefined);
  }
});

test("runOcrPerPage still drops records that fail schema even with defaults", async () => {
  __setPerPageCallForTests(async () => ({
    json: [
      { name: "ok" },
      "not an object",          // truly garbage
      { wrongShape: true },     // missing required `name`
    ],
    poolKeyId: "test-1",
  }));
  try {
    const Schema = z.object({
      sourcePage: z.number(),
      name: z.string(),
    });
    const out = await runOcrPerPage({
      pagesAsImages: ["page-01.png"],
      pageImagesDir: "/tmp/ignored",
      prompt: "test",
      schema: Schema,
    });
    assert.equal(out.records.length, 1, "only the valid record survives");
    assert.equal(out.records[0].name, "ok");
  } finally {
    __setPerPageCallForTests(undefined);
  }
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

```bash
tsx --test tests/unit/ocr/per-page.test.ts
```

Expected: the three new tests fail. The first test fails because `rowIndex` is required and the first/third records have no value. The second fails because `employeeSigned` is required and absent. The third actually passes today (it's a regression-guard for the post-fix behavior); note it now and re-verify after Step 1.4.

- [ ] **Step 1.3: Implement runner-side default injection**

Edit `src/ocr/per-page.ts` lines 177-197. Replace:

```ts
  const records: Array<T & { sourcePage: number }> = [];
  for (const r of results) {
    if (!r.success || !r.rawRecords) continue;
    for (const rec of r.rawRecords) {
      const withPage =
        rec && typeof rec === "object"
          ? { ...(rec as Record<string, unknown>), sourcePage: r.page }
          : rec;
      const parsed = req.schema.safeParse(withPage);
      if (!parsed.success) {
        log.warn(
          `runOcrPerPage page ${r.page} record dropped (schema): ${parsed.error.issues
            .slice(0, 1)
            .map((i) => i.message)
            .join("; ")}`,
        );
        continue;
      }
      records.push({ ...(parsed.data as T), sourcePage: r.page });
    }
  }
```

With:

```ts
  // Synthesize defaults the LLM is allowed to omit:
  //   - rowIndex: array position on the page (0-indexed) — sign-in sheets
  //     may have many rows; LLM occasionally drops it on single-record pages
  //   - employeeSigned: true (worst case operator deselects in the preview)
  // sourcePage is runner-authoritative — overrides whatever the LLM sent.
  // LLM-supplied values for rowIndex/employeeSigned win via the spread order.
  // Schemas that don't declare these fields silently strip them.
  const records: Array<T & { sourcePage: number }> = [];
  for (const r of results) {
    if (!r.success || !r.rawRecords) continue;
    r.rawRecords.forEach((rec, idx) => {
      const withInjects =
        rec && typeof rec === "object"
          ? {
              rowIndex: idx,
              employeeSigned: true,
              ...(rec as Record<string, unknown>),
              sourcePage: r.page,
            }
          : rec;
      const parsed = req.schema.safeParse(withInjects);
      if (!parsed.success) {
        log.warn(
          `runOcrPerPage page ${r.page} record dropped (schema): ${parsed.error.issues
            .slice(0, 1)
            .map((i) => i.message)
            .join("; ")}`,
        );
        return;
      }
      records.push({ ...(parsed.data as T), sourcePage: r.page });
    });
  }
```

- [ ] **Step 1.4: Run tests to verify they pass**

```bash
tsx --test tests/unit/ocr/per-page.test.ts
```

Expected: ALL tests in the file pass (existing 3 + new 3 = 6 tests). The pre-existing "filters records that fail schema validation" test continues to pass.

- [ ] **Step 1.5: Typecheck**

```bash
npm run typecheck:all
```

Expected: no errors.

- [ ] **Step 1.6: Commit**

```bash
git add src/ocr/per-page.ts tests/unit/ocr/per-page.test.ts
git commit -m "$(cat <<'EOF'
fix(ocr): synthesize default rowIndex + employeeSigned in per-page runner

LLM providers occasionally omit fields the prompt asks for (especially
rowIndex on single-record pages). Schema-validation drops these records
silently, cascading to "0 records" in the operator preview pane. Mirror
the existing sourcePage injection: default rowIndex from array position
and employeeSigned to true; LLM-supplied values still win via spread order.
Records still missing the anchor field (printedName) are still dropped.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `employeeId` field + relax oath OCR-pass schema

**Goal:** Capture EIDs the LLM extracts from UPAY585/586 forms (already in the prompt at `ocr-form.ts:120`, just not in the schema). Relax `rowIndex` and `employeeSigned` since the runner now provides defaults.

**Files:**
- Modify: `src/workflows/oath-signature/ocr-form.ts:47-65` (`OathRosterOcrRecordSchema`)
- Modify: `tests/unit/workflows/oath-signature/ocr-form.test.ts` (append new tests)

- [ ] **Step 2.1: Add failing tests for the new schema shape**

Append to `tests/unit/workflows/oath-signature/ocr-form.test.ts`:

```ts
test("OathRosterOcrRecordSchema accepts records without rowIndex (runner defaults)", () => {
  const r = OathRosterOcrRecordSchema.safeParse({
    sourcePage: 1,
    printedName: "Jane Doe",
    employeeSigned: true,
  });
  assert.equal(r.success, true);
});

test("OathRosterOcrRecordSchema accepts records without employeeSigned (runner defaults)", () => {
  const r = OathRosterOcrRecordSchema.safeParse({
    sourcePage: 1,
    printedName: "Jane Doe",
  });
  assert.equal(r.success, true);
  if (r.success) {
    // employeeSigned is now optional with no schema-side default; runner
    // injects true when missing. Either undefined or true is valid here.
    assert.ok(r.data.employeeSigned === undefined || r.data.employeeSigned === true);
  }
});

test("OathRosterOcrRecordSchema accepts an optional employeeId", () => {
  const r = OathRosterOcrRecordSchema.safeParse({
    sourcePage: 1,
    printedName: "Jane Doe",
    employeeId: "10877384",
  });
  assert.equal(r.success, true);
  if (r.success) assert.equal(r.data.employeeId, "10877384");
});

test("OathRosterOcrRecordSchema rejects records without printedName", () => {
  const r = OathRosterOcrRecordSchema.safeParse({
    sourcePage: 1,
    employeeSigned: true,
  });
  assert.equal(r.success, false);
});
```

Add the import at the top of the test file if not present:

```ts
import { OathRosterOcrRecordSchema } from "../../../../src/workflows/oath-signature/ocr-form.js";
```

- [ ] **Step 2.2: Run tests to verify they fail**

```bash
tsx --test tests/unit/workflows/oath-signature/ocr-form.test.ts
```

Expected: the four new tests fail. `rowIndex` is required (test 1 fails), `employeeSigned` is required (test 2 fails), `employeeId` is unknown to the schema (test 3 fails — actually this would PASS today because Zod by default strips unknown keys; mark to re-verify after Step 2.3).

- [ ] **Step 2.3: Edit the schema**

Edit `src/workflows/oath-signature/ocr-form.ts:47-65`. Replace `OathRosterOcrRecordSchema` with:

```ts
export const OathRosterOcrRecordSchema = z.object({
  sourcePage: z.number().int().positive(),
  rowIndex: z.number().int().nonnegative().optional(),
  printedName: z.string().min(1),
  employeeId: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (v ?? "").trim()),
  employeeSigned: z.boolean().optional(),
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
```

- [ ] **Step 2.4: Run tests to verify they pass**

```bash
tsx --test tests/unit/workflows/oath-signature/ocr-form.test.ts
```

Expected: all four new tests pass. Pre-existing tests in the file still pass (the field shape changes are strictly additive — old required fields are now optional).

- [ ] **Step 2.5: Typecheck**

```bash
npm run typecheck:all
```

Expected: no errors. Note: `OathPreviewRecord` extends `OathRosterOcrRecordSchema` via `OathPreviewRecordSchema = OathRosterOcrRecordSchema.extend({...})`, so `employeeId` flows through to the preview record automatically.

- [ ] **Step 2.6: Commit**

```bash
git add src/workflows/oath-signature/ocr-form.ts tests/unit/workflows/oath-signature/ocr-form.test.ts
git commit -m "$(cat <<'EOF'
feat(oath-signature): add employeeId field + relax OCR-pass schema

The OATH_OCR_PROMPT asks the LLM to extract employeeId when visible on
UPAY585/586 forms but the schema didn't capture it — the field was being
silently stripped. Add it as optional + nullable. Relax rowIndex and
employeeSigned to optional since the per-page runner now injects defaults.
printedName remains required as the anchor field.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Async `matchRecord` + new `applyDisambiguation` contract on `OcrFormSpec`

**Goal:** Open the door for async LLM disambiguation in oath without breaking emergency-contact's sync logic. Widen `LookupKind` to include `"verify-only"` for the form-EID-needs-verification branch.

**Files:**
- Modify: `src/workflows/ocr/types.ts:24,49,52`
- Modify: `src/workflows/oath-signature/ocr-form.ts:152` (`matchRecord` — wrap in async, no behavior change yet)
- Modify: `src/workflows/emergency-contact/ocr-form.ts` (`matchRecord` — wrap in async; add `applyDisambiguation` stub)

- [ ] **Step 3.1: Update `OcrFormSpec` type contract**

Edit `src/workflows/ocr/types.ts`. Replace line 24:

```ts
export type LookupKind = "name" | "verify" | "verify-only" | null;
```

Replace line 49 (`matchRecord`):

```ts
  /** Pure: take an OCR record + roster, return the preview record + initial matchState. May call an LLM disambiguator (async). */
  matchRecord(input: { record: TOcr; roster: RosterRow[] }): Promise<TPreview>;
```

Add a new method right after `matchRecord` (before `needsLookup`):

```ts
  /**
   * Patch a preview record with the result of post-match LLM disambiguation.
   * Called by the orchestrator's `disambiguating` phase only when matchRecord
   * left the record in `lookup-pending` state with disambiguation candidates.
   * Specs that don't disambiguate may return the record unchanged.
   */
  applyDisambiguation(input: {
    record: TPreview;
    result: { eid: string | null; confidence: number };
  }): TPreview;
```

- [ ] **Step 3.2: Wrap oath `matchRecord` in async (no behavior change yet)**

Edit `src/workflows/oath-signature/ocr-form.ts:152`. Replace the function declaration line:

```ts
  async matchRecord({ record, roster }): Promise<OathPreviewRecord> {
```

(The body stays the same.) Add a no-op `applyDisambiguation` after the `matchRecord` body but before `needsLookup`:

```ts
  applyDisambiguation({ record }): OathPreviewRecord {
    // Hybrid match logic ships in Task 5; this stub keeps the spec compilable.
    return record;
  },
```

- [ ] **Step 3.3: Wrap emergency-contact `matchRecord` in async + add no-op `applyDisambiguation`**

Edit `src/workflows/emergency-contact/ocr-form.ts`. Find the `matchRecord` declaration (search for `matchRecord({ record`). Change it from `matchRecord({ record, roster }): PreviewRecord {` to:

```ts
  async matchRecord({ record, roster }): Promise<PreviewRecord> {
```

After the `matchRecord` body, add (before `needsLookup`):

```ts
  applyDisambiguation({ record }): PreviewRecord {
    // EC currently uses sync algorithmic matching only.
    return record;
  },
```

- [ ] **Step 3.4: Update orchestrator to await async `matchRecord`**

Edit `src/workflows/ocr/orchestrator.ts` line 257. Replace:

```ts
    let records = (ocrResult.data as unknown[]).map((r) =>
      spec.matchRecord({ record: r, roster }),
    );
```

With:

```ts
    let records = await Promise.all(
      (ocrResult.data as unknown[]).map((r) =>
        spec.matchRecord({ record: r, roster }),
      ),
    );
```

- [ ] **Step 3.5: Typecheck**

```bash
npm run typecheck:all
```

Expected: no errors. The `Promise.all` change makes `records` typed as `unknown[]` from the spec's `Promise<TPreview>` returns.

- [ ] **Step 3.6: Run all tests to confirm no regressions**

```bash
npm test
```

Expected: all tests pass. No behavioral change yet — only type-level + await wrapping.

- [ ] **Step 3.7: Commit**

```bash
git add src/workflows/ocr/types.ts src/workflows/oath-signature/ocr-form.ts src/workflows/emergency-contact/ocr-form.ts src/workflows/ocr/orchestrator.ts
git commit -m "$(cat <<'EOF'
refactor(ocr): make OcrFormSpec.matchRecord async + add applyDisambiguation

Open the door for an async LLM disambiguation phase without breaking
sync-only specs. matchRecord becomes Promise<TPreview>; new method
applyDisambiguation is called by the orchestrator after disambiguation
runs — both oath and emergency-contact ship no-op stubs (oath's real
implementation lands in the next commit). Widen LookupKind to include
"verify-only" for form-EID short-circuit. Orchestrator awaits matchRecord
via Promise.all. No behavior change in this commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Form-EID short-circuit in oath `matchRecord`

**Goal:** When the LLM extracted an `employeeId` from the form, look it up in the roster. Exact match → auto-accept with `matchSource: "form-eid"`. No match → mark `lookup-pending` with `LookupKind: "verify-only"` (the orchestrator will dispatch eid-lookup-by-EID in Task 8).

**Files:**
- Modify: `src/workflows/oath-signature/ocr-form.ts` (widen `matchSource` enum, add EID branch in `matchRecord`, update `needsLookup`)
- Modify: `tests/unit/workflows/oath-signature/ocr-form.test.ts`

- [ ] **Step 4.1: Add failing tests for the form-EID branch**

Append to `tests/unit/workflows/oath-signature/ocr-form.test.ts`:

```ts
import { oathOcrFormSpec } from "../../../../src/workflows/oath-signature/ocr-form.js";

const FAKE_ROSTER = [
  { eid: "10877384", name: "Jane Doe" },
  { eid: "10999999", name: "John Smith" },
];

test("matchRecord short-circuits when extracted employeeId matches roster", async () => {
  const out = await oathOcrFormSpec.matchRecord({
    record: {
      sourcePage: 1,
      rowIndex: 0,
      printedName: "Anyone — name doesn't matter",
      employeeId: "10877384",
      employeeSigned: true,
      notes: [],
      documentType: "expected",
      originallyMissing: [],
    },
    roster: FAKE_ROSTER,
  });
  assert.equal(out.matchState, "matched");
  assert.equal(out.matchSource, "form-eid");
  assert.equal(out.employeeId, "10877384");
  assert.equal(out.selected, true);
});

test("matchRecord with extracted employeeId NOT in roster goes to lookup-pending verify-only", async () => {
  const out = await oathOcrFormSpec.matchRecord({
    record: {
      sourcePage: 1,
      rowIndex: 0,
      printedName: "Some Name",
      employeeId: "99999999",  // not in roster
      employeeSigned: true,
      notes: [],
      documentType: "expected",
      originallyMissing: [],
    },
    roster: FAKE_ROSTER,
  });
  assert.equal(out.matchState, "lookup-pending");
  assert.equal(out.employeeId, "99999999", "preserves the form-extracted EID for verification");
  assert.equal(oathOcrFormSpec.needsLookup(out), "verify-only");
});

test("matchRecord falls through to name-matching when no employeeId extracted", async () => {
  const out = await oathOcrFormSpec.matchRecord({
    record: {
      sourcePage: 1,
      rowIndex: 0,
      printedName: "Jane Doe",  // exact match in roster
      employeeId: "",
      employeeSigned: true,
      notes: [],
      documentType: "expected",
      originallyMissing: [],
    },
    roster: FAKE_ROSTER,
  });
  assert.equal(out.matchSource, "roster");
  assert.equal(out.employeeId, "10877384");
});
```

- [ ] **Step 4.2: Run tests to verify they fail**

```bash
tsx --test tests/unit/workflows/oath-signature/ocr-form.test.ts
```

Expected: the three new tests fail — `matchRecord` currently doesn't read `employeeId`.

- [ ] **Step 4.3: Widen the matchSource enum**

Edit `src/workflows/oath-signature/ocr-form.ts:88`. Replace:

```ts
  matchSource: z.enum(["roster", "eid-lookup", "llm"]).optional(),
```

With:

```ts
  matchSource: z.enum(["roster", "eid-lookup", "llm", "form-eid", "manual"]).optional(),
```

- [ ] **Step 4.4: Implement the form-EID short-circuit at the top of `matchRecord`**

Edit `src/workflows/oath-signature/ocr-form.ts`. Inside the `matchRecord` body (line 152+), insert the new branch right after the `if (!record.employeeSigned)` block but before the `matchAgainstRoster(...)` call:

```ts
  async matchRecord({ record, roster }): Promise<OathPreviewRecord> {
    if (!record.employeeSigned) {
      return {
        ...record,
        employeeId: record.employeeId ?? "",
        matchState: "extracted",
        documentType: "expected",
        originallyMissing: [],
        selected: false,
        warnings: [],
      };
    }

    // Form-EID short-circuit: when the LLM extracted an EID from the page
    // (UPAY585/586 has an "Employee ID" field), trust the structured value
    // over the handwritten name. Roster-exact match → auto-accept; no roster
    // match → flag for eid-lookup-by-EID (verify-only branch).
    const formEid = (record.employeeId ?? "").trim();
    if (formEid.length > 0) {
      const rosterHit = roster.find((row) => row.eid === formEid);
      if (rosterHit) {
        return {
          ...record,
          employeeId: formEid,
          matchState: "matched",
          matchSource: "form-eid",
          documentType: "expected",
          originallyMissing: [],
          selected: true,
          warnings: [],
        };
      }
      return {
        ...record,
        employeeId: formEid,
        matchState: "lookup-pending",
        matchSource: "form-eid",
        documentType: "expected",
        originallyMissing: [],
        selected: true,
        warnings: [`EID ${formEid} extracted from form but not in roster — verifying`],
      };
    }

    // Existing name-matching path follows below ...
    const result = matchAgainstRoster(roster, record.printedName);
    // ... unchanged ...
```

(Keep the rest of the existing function body unchanged.)

- [ ] **Step 4.5: Update `needsLookup` to handle the verify-only state**

In the same file, find `needsLookup` (around line 198). Replace its body:

```ts
  needsLookup(record): LookupKind {
    if (record.matchState === "extracted") return null;
    if (record.matchState === "lookup-pending") {
      // form-eid lookup-pending → we know the EID, just need to verify it
      if (record.matchSource === "form-eid") return "verify-only";
      return "name";
    }
    if (record.matchState === "matched" && record.employeeId) {
      if (record.verification) return null;
      return "verify";
    }
    if (record.matchState === "resolved") return null;
    if (record.matchState === "unresolved") return null;
    return null;
  },
```

- [ ] **Step 4.6: Run tests to verify they pass**

```bash
tsx --test tests/unit/workflows/oath-signature/ocr-form.test.ts
```

Expected: all tests pass.

- [ ] **Step 4.7: Typecheck**

```bash
npm run typecheck:all
```

- [ ] **Step 4.8: Commit**

```bash
git add src/workflows/oath-signature/ocr-form.ts tests/unit/workflows/oath-signature/ocr-form.test.ts
git commit -m "$(cat <<'EOF'
feat(oath-signature): form-EID short-circuit in matchRecord

When the LLM extracts an Employee ID from a UPAY585/586 form, look it
up in the roster directly. Roster-exact match → auto-accept with
matchSource "form-eid". No roster match → lookup-pending with new
LookupKind "verify-only" so the orchestrator dispatches eid-lookup
by EID instead of by name. Trust the structured EID over the
handwritten name. Existing name-matching path is unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Hybrid name-match using `matchAgainstRosterAsync`

**Goal:** Replace the sync `matchAgainstRoster` + flat 0.85 threshold with the existing hybrid `matchAgainstRosterAsync` (LLM disambiguator). Tighten auto-accept to ≥ 0.95 with no close second; route the [0.40, 0.95) band through the LLM.

**Files:**
- Modify: `src/workflows/oath-signature/ocr-form.ts` (replace the name-matching section in `matchRecord`)
- Modify: `tests/unit/workflows/oath-signature/ocr-form.test.ts`

- [ ] **Step 5.1: Add failing tests for the hybrid name-match branches**

Append to `tests/unit/workflows/oath-signature/ocr-form.test.ts`:

```ts
test("matchRecord auto-accepts name match at score >= 0.95 with no close second", async () => {
  // "Jane Doe" exact-match should hit 1.0 against the roster.
  const out = await oathOcrFormSpec.matchRecord({
    record: {
      sourcePage: 1,
      rowIndex: 0,
      printedName: "Jane Doe",
      employeeId: "",
      employeeSigned: true,
      notes: [],
      documentType: "expected",
      originallyMissing: [],
    },
    roster: FAKE_ROSTER,
  });
  assert.equal(out.matchState, "matched");
  assert.equal(out.matchSource, "roster");
  assert.equal(out.employeeId, "10877384");
});

test("matchRecord drops to manual when no candidate scores above 0.40", async () => {
  const out = await oathOcrFormSpec.matchRecord({
    record: {
      sourcePage: 1,
      rowIndex: 0,
      printedName: "Zzzz Qqqqq",  // no roster overlap
      employeeId: "",
      employeeSigned: true,
      notes: [],
      documentType: "expected",
      originallyMissing: [],
    },
    roster: FAKE_ROSTER,
  });
  assert.equal(out.matchState, "lookup-pending");
  assert.equal(out.matchSource, "manual");
  assert.equal(out.employeeId, "");
});
```

- [ ] **Step 5.2: Run tests to verify they fail**

```bash
tsx --test tests/unit/workflows/oath-signature/ocr-form.test.ts
```

Expected: tests fail — current implementation uses 0.85 threshold and never sets `matchSource: "manual"`.

- [ ] **Step 5.3: Replace the name-matching path in `matchRecord`**

Edit `src/workflows/oath-signature/ocr-form.ts`. The constant `ROSTER_AUTO_ACCEPT` at line 130 is no longer used; replace it with three new constants right above the spec definition:

```ts
const NAME_AUTO_ACCEPT = 0.95;
const NAME_AUTO_ACCEPT_GAP = 0.10;
const NAME_DISAMBIG_FLOOR = 0.40;
```

Then in `matchRecord`, replace the name-matching section (everything below the form-EID short-circuit you added in Task 4 — i.e. starting from `const result = matchAgainstRoster(roster, record.printedName);` through the end of the function). New code:

```ts
    // Name-resolution chain:
    //   - Top score >= 0.95 with no close second  → auto-accept (matchSource: "roster")
    //   - Top score in [0.40, 0.95) OR close second → mark lookup-pending; orchestrator's
    //     disambiguating phase runs the LLM (matchSource updated by applyDisambiguation)
    //   - Top score < 0.40 / no candidates       → manual fall-through (matchSource: "manual")
    const ranked = matchAgainstRoster(roster, record.printedName);
    const top = ranked.candidates[0];
    const second = ranked.candidates[1];
    const topCandidates = ranked.candidates.slice(0, 5);

    if (!top || top.score < NAME_DISAMBIG_FLOOR) {
      return {
        ...record,
        employeeId: "",
        matchState: "lookup-pending",
        matchSource: "manual",
        rosterCandidates: topCandidates,
        documentType: "expected",
        originallyMissing: [],
        selected: true,
        warnings:
          ranked.candidates.length > 0
            ? [`Best roster score ${top.score.toFixed(2)} < ${NAME_DISAMBIG_FLOOR} — manual review`]
            : ["No roster match — manual review"],
      };
    }

    const closeSecond = second && top.score - second.score < NAME_AUTO_ACCEPT_GAP;
    if (top.score >= NAME_AUTO_ACCEPT && !closeSecond && top.eid) {
      return {
        ...record,
        employeeId: top.eid,
        matchState: "matched",
        matchSource: "roster",
        matchConfidence: top.score,
        rosterCandidates: topCandidates,
        documentType: "expected",
        originallyMissing: [],
        selected: true,
        warnings: top.score < 1.0
          ? [`Roster matched "${top.name}" (score ${top.score.toFixed(2)})`]
          : [],
      };
    }

    // Ambiguous: defer to the orchestrator's disambiguating phase.
    return {
      ...record,
      employeeId: "",
      matchState: "lookup-pending",
      rosterCandidates: topCandidates,
      documentType: "expected",
      originallyMissing: [],
      selected: true,
      warnings: closeSecond
        ? [`Top score ${top.score.toFixed(2)} but close second ${second!.score.toFixed(2)} — disambiguating`]
        : [`Top score ${top.score.toFixed(2)} in disambiguation band — disambiguating`],
    };
  },
```

Delete the old `ROSTER_AUTO_ACCEPT` constant at line 130.

- [ ] **Step 5.4: Run tests to verify they pass**

```bash
tsx --test tests/unit/workflows/oath-signature/ocr-form.test.ts
```

Expected: all tests pass.

- [ ] **Step 5.5: Typecheck**

```bash
npm run typecheck:all
```

- [ ] **Step 5.6: Commit**

```bash
git add src/workflows/oath-signature/ocr-form.ts tests/unit/workflows/oath-signature/ocr-form.test.ts
git commit -m "$(cat <<'EOF'
feat(oath-signature): tighten name-match threshold + queue ambiguous cases for LLM

Auto-accept only at top >= 0.95 with no close second (was a flat 0.85).
Top in [0.40, 0.95) or close second now lands as lookup-pending with
candidates populated; the orchestrator's disambiguating phase (next
commit) runs the LLM and applies the result. Top < 0.40 lands as
matchSource "manual" so the operator gets a manual-fill row.
The 0.40 floor avoids spending an LLM call on noise candidates.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Implement `applyDisambiguation` for oath

**Goal:** Patch a `lookup-pending` oath record with the LLM disambiguator's pick. High-confidence pick → matched, accepted. Low-confidence → matched but needs-review. Null pick → fall through to manual.

**Files:**
- Modify: `src/workflows/oath-signature/ocr-form.ts` (replace the no-op `applyDisambiguation` from Task 3)
- Modify: `tests/unit/workflows/oath-signature/ocr-form.test.ts`

- [ ] **Step 6.1: Add failing tests for `applyDisambiguation`**

Append to `tests/unit/workflows/oath-signature/ocr-form.test.ts`:

```ts
const PENDING_RECORD = {
  sourcePage: 1,
  rowIndex: 0,
  printedName: "Jne Doe",
  employeeId: "",
  matchState: "lookup-pending" as const,
  rosterCandidates: [
    { eid: "10877384", name: "Jane Doe", score: 0.88 },
    { eid: "10999999", name: "John Smith", score: 0.40 },
  ],
  documentType: "expected" as const,
  originallyMissing: [],
  selected: true,
  warnings: [],
  notes: [],
};

test("applyDisambiguation accepts high-confidence LLM pick", () => {
  const out = oathOcrFormSpec.applyDisambiguation({
    record: { ...PENDING_RECORD },
    result: { eid: "10877384", confidence: 0.9 },
  });
  assert.equal(out.matchState, "matched");
  assert.equal(out.matchSource, "llm");
  assert.equal(out.employeeId, "10877384");
  assert.equal(out.matchConfidence, 0.9);
});

test("applyDisambiguation marks low-confidence LLM pick as lookup-pending", () => {
  const out = oathOcrFormSpec.applyDisambiguation({
    record: { ...PENDING_RECORD },
    result: { eid: "10877384", confidence: 0.5 },
  });
  // Still has the EID assigned but operator must review (matchState stays
  // lookup-pending so isApprovable gate keeps the row out of fan-out).
  assert.equal(out.matchState, "lookup-pending");
  assert.equal(out.matchSource, "llm");
  assert.equal(out.employeeId, "10877384");
  assert.ok((out.warnings ?? []).some((w) => /low confidence/i.test(w)));
});

test("applyDisambiguation falls through to manual when LLM returns null", () => {
  const out = oathOcrFormSpec.applyDisambiguation({
    record: { ...PENDING_RECORD },
    result: { eid: null, confidence: 0 },
  });
  assert.equal(out.matchState, "lookup-pending");
  assert.equal(out.matchSource, "manual");
  assert.equal(out.employeeId, "");
});
```

- [ ] **Step 6.2: Run tests to verify they fail**

```bash
tsx --test tests/unit/workflows/oath-signature/ocr-form.test.ts
```

Expected: the three new tests fail — current `applyDisambiguation` is a no-op.

- [ ] **Step 6.3: Implement `applyDisambiguation`**

Edit `src/workflows/oath-signature/ocr-form.ts`. Add a new constant near the other thresholds:

```ts
const LLM_HIGH_CONFIDENCE = 0.6;
```

Replace the no-op `applyDisambiguation` you added in Task 3 with:

```ts
  applyDisambiguation({ record, result }): OathPreviewRecord {
    if (result.eid === null || result.eid.length === 0) {
      // LLM said "none of these" — operator must intervene.
      return {
        ...record,
        employeeId: "",
        matchState: "lookup-pending",
        matchSource: "manual",
        warnings: [
          ...(record.warnings ?? []),
          "LLM disambiguation: no candidate matched — manual review",
        ],
      };
    }

    if (result.confidence < LLM_HIGH_CONFIDENCE) {
      return {
        ...record,
        employeeId: result.eid,
        matchState: "lookup-pending",
        matchSource: "llm",
        matchConfidence: result.confidence,
        warnings: [
          ...(record.warnings ?? []),
          `LLM picked EID ${result.eid} but low confidence (${result.confidence.toFixed(2)}) — review`,
        ],
      };
    }

    return {
      ...record,
      employeeId: result.eid,
      matchState: "matched",
      matchSource: "llm",
      matchConfidence: result.confidence,
      warnings: record.warnings ?? [],
    };
  },
```

- [ ] **Step 6.4: Run tests to verify they pass**

```bash
tsx --test tests/unit/workflows/oath-signature/ocr-form.test.ts
```

Expected: all tests pass.

- [ ] **Step 6.5: Typecheck**

```bash
npm run typecheck:all
```

- [ ] **Step 6.6: Commit**

```bash
git add src/workflows/oath-signature/ocr-form.ts tests/unit/workflows/oath-signature/ocr-form.test.ts
git commit -m "$(cat <<'EOF'
feat(oath-signature): implement applyDisambiguation for LLM result

High-confidence (>= 0.6) LLM pick → matched + accepted. Low-confidence
pick → assign EID but keep lookup-pending so isApprovable keeps the row
out of fan-out until operator reviews. Null pick → fall through to
matchSource "manual" with empty EID.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Add `disambiguating` step + emit `data.emptyPages`

**Goal:** Make the OCR workflow's step list aware of the new phase (so the dashboard pipeline shows it). Compute the list of pages where OCR succeeded but extracted zero records, write it to the awaiting-approval row's `data.emptyPages`.

**Files:**
- Modify: `src/workflows/ocr/workflow.ts:6-13` (step tuple)
- Modify: `src/workflows/ocr/orchestrator.ts:213-241` (page-status section)
- Modify: `tests/unit/workflows/ocr/orchestrator.test.ts`

- [ ] **Step 7.1: Add the new step to the OCR workflow's step list**

Edit `src/workflows/ocr/workflow.ts:6-13`. Replace `ocrSteps`:

```ts
const ocrSteps = [
  "loading-roster",
  "ocr",
  "matching",
  "disambiguating",
  "eid-lookup",
  "verification",
  "awaiting-approval",
] as const;
```

- [ ] **Step 7.2: Add a failing test for `data.emptyPages` emission**

Append to `tests/unit/workflows/ocr/orchestrator.test.ts`. The file already has a `setup()` helper (line 8) that creates a tmp dir + roster path; reuse it. Match the existing test's mocking style (lines 18-79) — `_ocrPipelineOverride`, `_loadRosterOverride`, etc:

```ts
test("orchestrator emits data.emptyPages for pages where OCR returned 0 records", async () => {
  const { dir, rosterPath } = setup();
  const writtenEntries: object[] = [];

  await runOcrOrchestrator(
    {
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "fake.pdf",
      formType: "oath",
      sessionId: "session-empty-pages",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId: "run-empty-pages",
      trackerDir: dir,
      _emitOverride: (entry) => writtenEntries.push(entry),
      _ocrPipelineOverride: async () => ({
        data: [
          // page 1: 1 record
          { sourcePage: 1, rowIndex: 0, printedName: "Page 1 person", employeeSigned: true,
            officerSigned: null, dateSigned: null, notes: [], documentType: "expected" as const, originallyMissing: [] },
          // page 2: 0 records (intentionally absent)
          // page 3: 1 record
          { sourcePage: 3, rowIndex: 0, printedName: "Page 3 person", employeeSigned: true,
            officerSigned: null, dateSigned: null, notes: [], documentType: "expected" as const, originallyMissing: [] },
        ],
        provider: "stub",
        attempts: 1,
        cached: false,
        pages: [
          { page: 1, success: true, attemptedKeys: [] },
          { page: 2, success: true, attemptedKeys: [] },
          { page: 3, success: true, attemptedKeys: [] },
        ],
      }),
      _loadRosterOverride: async () => [],
      _enqueueEidLookupOverride: async () => { /* no-op */ },
      _watchChildRunsOverride: async () => [],
    },
  );

  const approval = (writtenEntries as Array<{ status: string; step?: string; data?: Record<string, string> }>).find(
    (e) => (e.status === "running" || e.status === "done") && e.step === "awaiting-approval",
  );
  assert.ok(approval, "awaiting-approval entry was emitted");
  const emptyPages = JSON.parse(approval!.data!.emptyPages ?? "[]");
  assert.deepEqual(emptyPages, [2], "page 2 is the only empty page");

  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 7.3: Run the test to verify it fails**

```bash
tsx --test tests/unit/workflows/ocr/orchestrator.test.ts
```

Expected: the new test fails — `emptyPages` is not currently computed or emitted.

- [ ] **Step 7.4: Compute and emit `emptyPages` in the orchestrator**

Edit `src/workflows/ocr/orchestrator.ts`. Find the page-status section around line 222-241. After `pageStatusSummary` is built, compute `emptyPages`:

```ts
    // Build per-page status summary from OCR result
    const pages = ocrResult.pages ?? [];
    const failedPages = pages
      .filter((p) => !p.success)
      .map((p) => ({
        page: p.page,
        error: p.error ?? "unknown error",
        attemptedKeys: p.attemptedKeys,
        pageImagePath: join(
          trackerDir ?? ".tracker",
          "page-images",
          input.sessionId,
          `page-${String(p.page).padStart(2, "0")}.png`,
        ),
        attempts: 1,
      }));
    const pageStatusSummary = {
      total: pages.length,
      succeeded: pages.filter((p) => p.success).length,
      failed: failedPages.length,
    };

    // Compute empty pages: pages OCR succeeded on but produced zero records.
    // Used by the dashboard's OcrReviewPane to render an EmptyPagePlaceholder
    // (page image visible, "Add row manually" button) for those pages.
    const recordsByPage = new Set<number>();
    for (const r of (ocrResult.data as Array<{ sourcePage?: number }>)) {
      if (typeof r.sourcePage === "number") recordsByPage.add(r.sourcePage);
    }
    const emptyPages = pages
      .filter((p) => p.success && !recordsByPage.has(p.page))
      .map((p) => p.page)
      .sort((a, b) => a - b);
```

Then update both `awaiting-approval` `writeTracker` calls (around lines 352-373) to include `emptyPages`. Replace each of the two `writeTracker(...)` calls with:

```ts
    writeTracker("running", {
      formType: input.formType,
      pdfOriginalName: input.pdfOriginalName,
      sessionId: input.sessionId,
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      recordCount: records.length,
      verifiedCount,
      records,
      failedPages,
      emptyPages,
      pageStatusSummary,
    }, "awaiting-approval");
    writeTracker("done", {
      formType: input.formType,
      pdfOriginalName: input.pdfOriginalName,
      sessionId: input.sessionId,
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      recordCount: records.length,
      verifiedCount,
      records,
      failedPages,
      emptyPages,
      pageStatusSummary,
    }, "awaiting-approval");
```

- [ ] **Step 7.5: Run tests to verify they pass**

```bash
tsx --test tests/unit/workflows/ocr/orchestrator.test.ts
```

Expected: the new test passes; pre-existing tests still pass.

- [ ] **Step 7.6: Typecheck**

```bash
npm run typecheck:all
```

Expected: no errors. Note: `flattenForData` (line 382) JSON-stringifies non-primitive values, so `emptyPages: number[]` ends up as a JSON string in the tracker event — the frontend types parser (Task 11) handles this.

- [ ] **Step 7.7: Commit**

```bash
git add src/workflows/ocr/workflow.ts src/workflows/ocr/orchestrator.ts tests/unit/workflows/ocr/orchestrator.test.ts
git commit -m "$(cat <<'EOF'
feat(ocr): emit data.emptyPages and add disambiguating to step list

emptyPages is the list of page numbers where OCR succeeded but extracted
zero records. The dashboard's OcrReviewPane (next commits) renders an
EmptyPagePlaceholder for each entry, keeping the page image visible and
offering an "Add row manually" button. Step list now includes the new
"disambiguating" phase that the orchestrator wires in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wire the disambiguation phase in the orchestrator

**Goal:** Between `matching` and `eid-lookup`, batch-call `disambiguateMatch` for every record left as `lookup-pending` with at least one candidate at score ≥ 0.40 (and `matchSource !== "form-eid"` and `matchSource !== "manual"` — those go straight to eid-lookup).

**Files:**
- Modify: `src/workflows/ocr/orchestrator.ts` (insert disambiguating phase)

- [ ] **Step 8.1: Insert the disambiguation phase in the orchestrator**

Edit `src/workflows/ocr/orchestrator.ts`. After the `matching` step block (right after the `let records = await Promise.all(...)` from Task 3.4 and the carry-forward block at lines 261-266), insert a new disambiguating phase BEFORE the `// 4. Eid-lookup fan-out + watch` comment (around line 268):

```ts
    // 3c. Disambiguating — for each record left as lookup-pending with
    // disambiguation-eligible candidates, run the LLM disambiguator.
    // Records flagged manual or form-eid skip this phase (no point running
    // an LLM when we already have an EID or we know fuzzy gave us nothing).
    const disambigTargets: Array<{ index: number; rec: { rosterCandidates?: Array<{ eid: string; name: string; score: number }>; printedName?: string; matchState?: string; matchSource?: string } }> = [];
    records.forEach((rec, index) => {
      const r = rec as { matchState?: string; matchSource?: string; rosterCandidates?: Array<{ eid: string; name: string; score: number }>; printedName?: string };
      if (r.matchState !== "lookup-pending") return;
      if (r.matchSource === "form-eid" || r.matchSource === "manual") return;
      if (!r.rosterCandidates || r.rosterCandidates.length === 0) return;
      disambigTargets.push({ index, rec: r });
    });

    if (disambigTargets.length > 0) {
      log.step(`[ocr] disambiguating ${disambigTargets.length} ambiguous record(s) via LLM`);
      writeTracker("running", { recordCount: records.length, ambiguousCount: disambigTargets.length }, "disambiguating");

      const { disambiguateMatch } = await import("../../ocr/disambiguate.js");
      // Concurrency cap so a 30-row sign-in sheet doesn't fan out 30 parallel
      // Gemini calls. Default 4 (matches typical Gemini Flash RPM headroom).
      const concurrencyEnv = Number.parseInt(process.env.OCR_DISAMBIG_CONCURRENCY ?? "", 10);
      const concurrency = Number.isFinite(concurrencyEnv) && concurrencyEnv > 0 ? concurrencyEnv : 4;

      const results: Array<{ eid: string | null; confidence: number }> = new Array(disambigTargets.length);
      let nextIdx = 0;
      const workers = Array.from({ length: Math.min(concurrency, disambigTargets.length) }, async () => {
        while (true) {
          const i = nextIdx++;
          if (i >= disambigTargets.length) return;
          const t = disambigTargets[i];
          try {
            results[i] = await disambiguateMatch({
              query: t.rec.printedName ?? "",
              candidates: t.rec.rosterCandidates!.slice(0, 5),
            });
          } catch (err) {
            log.warn(`[ocr] disambiguate failed for record ${t.index}: ${errorMessage(err)}`);
            results[i] = { eid: null, confidence: 0 };
          }
        }
      });
      await Promise.all(workers);

      // Patch records via the spec's applyDisambiguation hook.
      disambigTargets.forEach((t, i) => {
        records[t.index] = spec.applyDisambiguation({
          record: records[t.index] as never,
          result: results[i],
        });
      });
    } else {
      writeTracker("running", { recordCount: records.length, ambiguousCount: 0 }, "disambiguating");
    }
```

- [ ] **Step 8.2: Run all tests to verify no regressions**

```bash
npm test
```

Expected: all tests pass. New phase is invisible to existing tests because no record reaches `lookup-pending` with `rosterCandidates` populated in the existing test fixtures (oath/EC tests use either matched or unmatched-no-candidates paths).

- [ ] **Step 8.3: Typecheck**

```bash
npm run typecheck:all
```

- [ ] **Step 8.4: Commit**

```bash
git add src/workflows/ocr/orchestrator.ts
git commit -m "$(cat <<'EOF'
feat(ocr): disambiguating phase calls LLM for ambiguous records

After matching, collect every record left as lookup-pending with
candidates at score >= 0.40 (and matchSource !== form-eid/manual) and
batch-call disambiguateMatch. Concurrency capped at OCR_DISAMBIG_CONCURRENCY
(default 4) to stay within Gemini Flash RPM headroom. Per-record failures
fall back to the manual branch via applyDisambiguation. Records without
candidates skip the phase entirely.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Verify-only EID dispatch in orchestrator

**Goal:** When `needsLookup` returns `"verify-only"` (form-EID with no roster match), dispatch through the existing eid-lookup-by-EID channel — same as today's `"verify"` branch but the EID is form-supplied.

**Files:**
- Modify: `src/workflows/ocr/orchestrator.ts` (eid-lookup dispatch block, around line 269-318)

- [ ] **Step 9.1: Inspect the existing dispatch logic**

The current dispatch at `orchestrator.ts:281-300` builds a `lookupTargets` array with `kind: "name" | "verify"`. The test for `kind === "verify"` was the existing "I have an EID, just verify it" branch. Add `verify-only` to the same branch — both treat the EID as the input.

- [ ] **Step 9.2: Update the dispatch logic**

Edit `src/workflows/ocr/orchestrator.ts`. Find this block (around line 270):

```ts
    // 4. Eid-lookup fan-out + watch
    const lookupTargets: Array<{ rec: unknown; index: number; kind: "name" | "verify" }> = [];
    records.forEach((rec, index) => {
      const kind = spec.needsLookup(rec);
      if (kind === "name" || kind === "verify") {
        lookupTargets.push({ rec, index, kind });
      }
    });
```

Replace with:

```ts
    // 4. Eid-lookup fan-out + watch
    // "name"        → lookup by printed name (CRM cross-verify path)
    // "verify"      → lookup by roster-derived EID (verify it's active in HDH)
    // "verify-only" → lookup by form-extracted EID (same as verify, but provenance differs)
    const lookupTargets: Array<{ rec: unknown; index: number; kind: "name" | "verify" | "verify-only" }> = [];
    records.forEach((rec, index) => {
      const kind = spec.needsLookup(rec);
      if (kind === "name" || kind === "verify" || kind === "verify-only") {
        lookupTargets.push({ rec, index, kind });
      }
    });
```

Then find the input-build block right below it (around line 297):

```ts
        const inputs = enqueueItems.map((e) =>
          e.kind === "name"
            ? { name: extractName(e.record, spec) }
            : { emplId: extractEid(e.record, spec), keepNonHdh: true },
        );
```

Replace with:

```ts
        const inputs = enqueueItems.map((e) =>
          e.kind === "name"
            ? { name: extractName(e.record, spec) }
            // Both "verify" and "verify-only" dispatch by EID — only difference
            // is provenance (roster-derived vs form-extracted). Same eid-lookup
            // input shape; verification result patches the record either way.
            : { emplId: extractEid(e.record, spec), keepNonHdh: true },
        );
```

(The body is identical for `verify` and `verify-only` — keep `keepNonHdh: true` which the existing `verify` branch uses.)

Find the override branch right above (around line 286):

```ts
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
```

Replace the inner mapping the same way:

```ts
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
```

(No change needed in the override branch — `e.kind === "name"` is the only branch that needs special treatment; both `verify` and `verify-only` already fall through to the EID branch.)

Update the `kind` type parameter on `lookupTargets` and `enqueueItems` (around lines 270 and 282):

The cleanest scoped type for `enqueueItems` is to propagate the widened union from `lookupTargets`. Verify by reading the current code that the `enqueueItems.map` calls don't break TypeScript inference; if they do, add explicit `kind: "name" | "verify" | "verify-only"` to the `enqueueItems` return shape.

- [ ] **Step 9.3: Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 9.4: Typecheck**

```bash
npm run typecheck:all
```

- [ ] **Step 9.5: Commit**

```bash
git add src/workflows/ocr/orchestrator.ts
git commit -m "$(cat <<'EOF'
feat(ocr): dispatch verify-only lookups through eid-lookup-by-EID

needsLookup returning "verify-only" means we have a form-extracted EID
but no roster row to verify against. Same eid-lookup input shape as the
existing "verify" branch (lookup by EID) — the provenance (form vs
roster) differs but the verification target is identical.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Update root `CLAUDE.md` step table

**Goal:** Reflect the new `disambiguating` step in the documented step list so the dashboard step pipeline matches reality.

**Files:**
- Modify: `CLAUDE.md` (root) — the OCR row in the "Step Tracking Per Workflow" table

- [ ] **Step 10.1: Update the OCR row**

Edit `/Users/julianhein/Documents/hr-automation/CLAUDE.md`. Find the line:

```
| ocr | loading-roster → ocr → matching → eid-lookup → verification → awaiting-approval |
```

Replace with:

```
| ocr | loading-roster → ocr → matching → disambiguating → eid-lookup → verification → awaiting-approval |
```

- [ ] **Step 10.2: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: add disambiguating to OCR workflow step list

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Frontend types — `emptyPages` parser + widen match-state/source enums

**Goal:** Tell the dashboard's TypeScript layer about the new tracker fields so the UI components in subsequent tasks can consume them.

**Files:**
- Modify: `src/dashboard/components/ocr/types.ts`

- [ ] **Step 11.1: Widen the `MatchSource` union**

Edit `src/dashboard/components/ocr/types.ts:15`. Replace:

```ts
export type MatchSource = "form" | "roster" | "eid-lookup" | "llm";
```

With:

```ts
export type MatchSource = "form" | "roster" | "eid-lookup" | "llm" | "form-eid" | "manual";
```

(`form` is a legacy EC-side value retained for back-compat with old tracker rows; `form-eid` is the new oath-specific value.)

- [ ] **Step 11.2: Add `emptyPages` to both prepare-row interfaces**

Same file. Find the `PrepareRowData` interface (around line 105-120) and add `emptyPages?: number[]` next to `failedPages`:

```ts
  failedPages?: FailedPage[];
  emptyPages?: number[];
  pageStatusSummary?: PageStatusSummary;
```

Find the `OathPrepareRowData` interface (around line 284-296) and add the same field in the same position.

- [ ] **Step 11.3: Update both parsers to read `emptyPages`**

Same file. Find `parsePrepareRowData` (line 184-224). After the `pageStatusSummary` parsing block (around line 203-209), add:

```ts
  let emptyPages: number[] | undefined;
  try {
    if (typeof rawData.emptyPages === "string") {
      const parsed = JSON.parse(rawData.emptyPages);
      if (Array.isArray(parsed)) emptyPages = parsed.filter((n) => typeof n === "number");
    }
  } catch { /* tolerate — pre-feature row */ }
```

In the return object at the bottom of the function (around line 210-223), add `emptyPages,` next to `failedPages,`.

Repeat the exact same change in `parseOathPrepareRowData` (line 298-337) — same parsing block insertion + same return-object addition.

- [ ] **Step 11.4: No change needed to OathPreviewRecord / PreviewRecord matchSource fields**

`OathPreviewRecord.matchSource` and `PreviewRecord.matchSource` already use the `MatchSource` type alias from Step 11.1, so widening the alias propagates automatically. Verify by searching:

```bash
grep -n "matchSource" /Users/julianhein/Documents/hr-automation/src/dashboard/components/ocr/types.ts
```

Expected: every `matchSource` field is typed as `MatchSource` (the alias), not as a string literal union.

- [ ] **Step 11.5: Typecheck**

```bash
npm run typecheck:all
```

Expected: no errors.

- [ ] **Step 11.6: Commit**

```bash
git add src/dashboard/components/ocr/types.ts
git commit -m "$(cat <<'EOF'
feat(dashboard): parse data.emptyPages + widen matchSource enum

emptyPages comes off awaiting-approval rows for pages where OCR succeeded
but extracted zero records. Frontend parses with the same JSON-string
fallback used for failedPages (pre-feature rows return []). matchSource
gains "form-eid" and "manual" string literals to match the backend's
new branches.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: `EmptyPagePlaceholder` component

**Goal:** Card rendered on the right side of a `PrepReviewPair` for pages where OCR returned zero records. Shows the page image (already on the left via `PrepReviewPair`) and offers "Add row manually" + "Mark as blank" buttons.

**Files:**
- Create: `src/dashboard/components/ocr/EmptyPagePlaceholder.tsx`

- [ ] **Step 12.1: Create the component**

Create `src/dashboard/components/ocr/EmptyPagePlaceholder.tsx`:

```tsx
import { Plus, FileX } from "lucide-react";

export interface EmptyPagePlaceholderProps {
  page: number;
  totalPages: number;
  onAddRow: () => void;
  onMarkBlank: () => void;
  marked: boolean;
}

/**
 * Renders on the right side of a PrepReviewPair when OCR succeeded on a
 * page but extracted zero records. The page image is on the left (via
 * PrepReviewPair), so the operator can compare and decide whether to add
 * a row manually or mark the page as blank/non-form.
 *
 * "Mark as blank" is a session-local flag — no tracker mutation. If the
 * page was actually blank (or wasn't a form), the operator suppresses
 * future placeholders for it. Reload restores it.
 */
export function EmptyPagePlaceholder({
  page,
  totalPages,
  onAddRow,
  onMarkBlank,
  marked,
}: EmptyPagePlaceholderProps) {
  if (marked) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/30 p-6 text-center text-xs text-muted-foreground">
        <FileX className="h-6 w-6 opacity-60" aria-hidden />
        <span>Page {page} of {totalPages} marked as blank.</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-md border border-warning/30 bg-warning/5 p-4">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-semibold">OCR found no records on this page.</span>
        <span className="text-xs text-muted-foreground">
          Compare against the page on the left. If it's a real form, add a row manually
          and type the printed name + EID. If it's blank or not part of this batch, mark it.
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onAddRow}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-primary bg-primary px-3 text-xs font-semibold text-primary-foreground"
        >
          <Plus className="h-3 w-3" />
          Add row manually
        </button>
        <button
          type="button"
          onClick={onMarkBlank}
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground hover:bg-muted"
        >
          Mark as blank
        </button>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          Page {page} of {totalPages}
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 12.2: Typecheck**

```bash
npm run typecheck:all
```

- [ ] **Step 12.3: Commit**

```bash
git add src/dashboard/components/ocr/EmptyPagePlaceholder.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): EmptyPagePlaceholder card for empty OCR pages

Renders on the right side of a PrepReviewPair (page image on left) when
OCR returned zero records for a page. Two actions: "Add row manually"
synthesizes a blank record into localEdits; "Mark as blank" suppresses
the placeholder for this session only (no tracker mutation; reload
restores).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: `PrepReviewMultiPair` add-row footer button

**Goal:** Sign-in sheets sometimes have N rows but OCR extracts N-1. Operator needs to add the missing one(s) without leaving the pane. Add a small footer button below the card stack.

**Files:**
- Modify: `src/dashboard/components/ocr/PrepReviewMultiPair.tsx`

- [ ] **Step 13.1: Update the component**

Replace `src/dashboard/components/ocr/PrepReviewMultiPair.tsx` with:

```tsx
import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { PdfPagePreview } from "../PdfPagePreview";

export interface PrepReviewMultiPairProps {
  /** Workflow name passed through to the PdfPagePreview backend route. */
  workflow: string;
  parentRunId: string;
  page: number;
  formCards: ReactNode[];
  /** Optional: when provided, renders an "Add row to this page" footer button. */
  onAddRow?: (page: number) => void;
}

/**
 * Multi-record page (oath sign-in sheet) → sticky PDF on the left, stack
 * of row-form cards on the right. The PDF stays in view as the operator
 * scrolls through the row stack so they keep visual context for which
 * page they're on.
 *
 * The footer button (when onAddRow is provided) lets the operator
 * synthesize a blank row for cases where OCR extracted N-1 of N rows on
 * the page — they spot the missing one against the always-visible page
 * image and click to add a manual entry.
 */
export function PrepReviewMultiPair({
  workflow,
  parentRunId,
  page,
  formCards,
  onAddRow,
}: PrepReviewMultiPairProps) {
  return (
    <div className="grid grid-cols-2 gap-4 border-b border-border p-4">
      <div className="sticky top-4 self-start">
        <PdfPagePreview workflow={workflow} parentRunId={parentRunId} page={page} />
      </div>
      <div className="flex flex-col gap-3">
        {formCards.map((card, i) => (
          <div key={i}>{card}</div>
        ))}
        {onAddRow && (
          <button
            type="button"
            onClick={() => onAddRow(page)}
            className="inline-flex h-7 w-fit items-center gap-1.5 self-start rounded-md border border-dashed border-border px-3 text-xs text-muted-foreground hover:bg-muted"
          >
            <Plus className="h-3 w-3" />
            Add row to this page
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 13.2: Typecheck**

```bash
npm run typecheck:all
```

- [ ] **Step 13.3: Commit**

```bash
git add src/dashboard/components/ocr/PrepReviewMultiPair.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): add-row footer button on PrepReviewMultiPair

Sign-in sheets sometimes have N rows but OCR extracts N-1. The operator
spots the missing row in the always-visible page image; the footer
button synthesizes a blank row for them to fill without leaving the
review pane. Optional prop — single-record PrepReviewPair has its own
empty-page placeholder for the all-empty case.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Wire empty-page rendering + add-row callback + tighten approval gate in `OcrReviewPane`

**Goal:** Three changes in one component: interleave empty-page entries into `renderList`, thread the `onAddRow` callback through `PrepReviewMultiPair`, and tighten `isApprovable` to require a non-empty digit-EID when selected.

**Files:**
- Modify: `src/dashboard/components/ocr/OcrReviewPane.tsx`

- [ ] **Step 14.1: Extend `PageRender` union and `renderList` builder**

Edit `src/dashboard/components/ocr/OcrReviewPane.tsx`. Find the `PageRender` type at line 161-163:

```tsx
  type PageRender =
    | { kind: "records"; page: number; group: Array<{ record: AnyPreviewRecord; originalIndex: number }> }
    | { kind: "failed"; page: number; failedPage: FailedPage };
```

Replace with:

```tsx
  type PageRender =
    | { kind: "records"; page: number; group: Array<{ record: AnyPreviewRecord; originalIndex: number }> }
    | { kind: "failed"; page: number; failedPage: FailedPage }
    | { kind: "empty"; page: number };
```

Find the `renderList` builder at lines 167-180:

```tsx
  const renderList = useMemo<PageRender[]>(() => {
    const recordsByPage = new Map<number, Array<{ record: AnyPreviewRecord; originalIndex: number }>>();
    records.forEach((r, originalIndex) => {
      const page = (r as { sourcePage: number }).sourcePage;
      if (!recordsByPage.has(page)) recordsByPage.set(page, []);
      recordsByPage.get(page)!.push({ record: r, originalIndex });
    });
    const list: PageRender[] = [];
    for (const [page, group] of recordsByPage) list.push({ kind: "records", page, group });
    for (const fp of failedPages) list.push({ kind: "failed", page: fp.page, failedPage: fp });
    list.sort((a, b) => a.page - b.page);
    return list;
  }, [records, failedPages]);
```

Replace with:

```tsx
  const emptyPages = data?.emptyPages ?? [];

  const renderList = useMemo<PageRender[]>(() => {
    const recordsByPage = new Map<number, Array<{ record: AnyPreviewRecord; originalIndex: number }>>();
    records.forEach((r, originalIndex) => {
      const page = (r as { sourcePage: number }).sourcePage;
      if (!recordsByPage.has(page)) recordsByPage.set(page, []);
      recordsByPage.get(page)!.push({ record: r, originalIndex });
    });
    const list: PageRender[] = [];
    for (const [page, group] of recordsByPage) list.push({ kind: "records", page, group });
    for (const fp of failedPages) list.push({ kind: "failed", page: fp.page, failedPage: fp });
    // Empty pages: orchestrator's emptyPages is "OCR succeeded, 0 records".
    // Skip if the operator added a manual row for that page (already in
    // recordsByPage) or marked it blank in this session.
    for (const p of emptyPages) {
      if (recordsByPage.has(p)) continue;
      if (markedBlankPages.has(p)) continue;
      list.push({ kind: "empty", page: p });
    }
    list.sort((a, b) => a.page - b.page);
    return list;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, failedPages, emptyPages, markedBlankPages]);
```

- [ ] **Step 14.2: Add session-local marked-blank state**

Near the top of the component (with the other `useState` calls, around line 87-98), add:

```tsx
  const [markedBlankPages, setMarkedBlankPages] = useState<Set<number>>(new Set());
```

Add the import for `Set` is built-in; no new import needed. Add the `EmptyPagePlaceholder` import at the top (with the other ocr imports):

```tsx
import { EmptyPagePlaceholder } from "./EmptyPagePlaceholder";
```

- [ ] **Step 14.3: Add `addBlankRow` helper**

Right above `handleApprove` (around line 209), add:

```tsx
  function addBlankRow(page: number): void {
    if (!cfg) return;
    // Synthesize a blank record matching the workflow's preview shape. We
    // build a minimal OathPreviewRecord-shaped object; for emergency-contact
    // the field set is similar enough that the inputs render correctly even
    // if some optional fields are missing. The match-state "lookup-pending"
    // + matchSource "manual" + selected:false keeps it out of the approve
    // fan-out until the operator fills it.
    const nextRecords = [...records];
    const blank: AnyPreviewRecord = {
      sourcePage: page,
      rowIndex: nextRecords.filter((r) => (r as { sourcePage: number }).sourcePage === page).length,
      printedName: "",
      employeeId: "",
      matchState: "lookup-pending",
      matchSource: "manual",
      selected: false,
      employeeSigned: true,
      officerSigned: null,
      dateSigned: null,
      notes: [],
      documentType: "expected",
      originallyMissing: [],
      warnings: [],
    } as unknown as AnyPreviewRecord;
    setLocalEdits((prev) => ({ ...prev, [nextRecords.length]: blank }));
  }
```

- [ ] **Step 14.4: Render the empty-page branch in the scroll body**

Find the renderList iteration around line 326-386. After the `if (renderEntry.kind === "failed")` block, add an `if (renderEntry.kind === "empty")` block:

```tsx
          if (renderEntry.kind === "empty") {
            return (
              <div key={`empty-${renderEntry.page}`} className="grid grid-cols-2 gap-4 border-b border-border p-4">
                <div className="self-start">
                  <PdfPagePreview workflow={entry.workflow} parentRunId={runId} page={renderEntry.page} />
                </div>
                <div>
                  <EmptyPagePlaceholder
                    page={renderEntry.page}
                    totalPages={totalPages}
                    onAddRow={() => addBlankRow(renderEntry.page)}
                    onMarkBlank={() => setMarkedBlankPages((prev) => new Set(prev).add(renderEntry.page))}
                    marked={markedBlankPages.has(renderEntry.page)}
                  />
                </div>
              </div>
            );
          }
```

Add the import at the top:

```tsx
import { PdfPagePreview } from "../PdfPagePreview";
```

(If not already imported.)

- [ ] **Step 14.5: Thread `onAddRow` into `PrepReviewMultiPair`**

In the multi-pair branch (the `// Multi-pair (sign-in sheet)` block around line 361-385), update the `PrepReviewMultiPair` invocation:

```tsx
          return (
            <PrepReviewMultiPair
              key={page}
              workflow={entry.workflow}
              parentRunId={runId}
              page={page}
              formCards={cards}
              onAddRow={addBlankRow}
            />
          );
```

- [ ] **Step 14.6: Tighten `isApprovable`**

Find `isApprovable` at the bottom of the file (around line 465-474). Replace:

```tsx
function isApprovable(record: AnyPreviewRecord): boolean {
  const matchOk = record.matchState === "matched" || record.matchState === "resolved";
  const notUnknown = record.documentType !== "unknown";
  const verifyOk = record.verification?.state === "verified";
  return matchOk && notUnknown && verifyOk;
}
```

With:

```tsx
function isApprovable(record: AnyPreviewRecord): boolean {
  const matchOk = record.matchState === "matched" || record.matchState === "resolved";
  const notUnknown = record.documentType !== "unknown";
  const verifyOk = record.verification?.state === "verified";
  // Tighten: when the operator selected a row, the EID must be non-empty
  // and look like a valid UCPath EID (5+ digits). This blocks approving a
  // manually-added row before the operator has typed an EID into it.
  const eid = String((record as { employeeId?: string }).employeeId ?? "").trim();
  const eidOk = !record.selected || /^\d{5,}$/.test(eid);
  return matchOk && notUnknown && verifyOk && eidOk;
}
```

- [ ] **Step 14.7: Typecheck + manual UI verification**

```bash
npm run typecheck:all
```

Manual verification (per `tests/CLAUDE.md`: dashboard React tests are deferred):

1. Run `npm run dashboard`
2. Trigger an OCR run on a multi-page PDF that has at least one blank/non-form page
3. Verify the blank page appears in the review pane with the page image on the left and the `EmptyPagePlaceholder` on the right
4. Click "Add row manually" → confirm a new editable row appears at the bottom of the review pane with the correct `sourcePage`
5. Click "Mark as blank" → confirm the placeholder collapses to the muted "marked as blank" state
6. On a multi-record page, confirm the new "Add row to this page" footer button appears
7. Try approving with a manually-added row that has empty EID — confirm the row doesn't count toward "Approve N"

- [ ] **Step 14.8: Commit**

```bash
git add src/dashboard/components/ocr/OcrReviewPane.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): empty-page rendering + add-row + tighten approval gate

OcrReviewPane interleaves empty-page entries into renderList alongside
records and failed pages, sorted by sourcePage. Empty pages render with
the always-visible page image on the left + EmptyPagePlaceholder on the
right (Add row manually / Mark as blank). PrepReviewMultiPair gets the
addBlankRow callback for partial-drop recovery. isApprovable now requires
a 5+ digit EID when the row is selected — manually-added rows can't
fan out until the operator types an EID.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: `OathRecordView` — match-source badge + "Why this match?" collapsible

**Goal:** Operator can see at a glance whether each record was matched by roster (algorithmic), LLM disambiguation, EID extracted from the form, eid-lookup async result, or pending manual fill — and expand a section showing the candidate list / LLM confidence / etc.

**Files:**
- Modify: `src/dashboard/components/ocr/OathRecordView.tsx`

- [ ] **Step 15.1: Add the match-source badge + collapsible at the top of the form**

Edit `src/dashboard/components/ocr/OathRecordView.tsx`. Replace the entire return JSX (currently starts at line 55):

```tsx
  return (
    <div className="flex flex-col gap-3">
      {onForceResearch && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => onForceResearch(record)}
            disabled={isResearching}
            title="Re-run eid-lookup for this record"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            <RotateCw className="h-3 w-3" aria-hidden />
          </button>
        </div>
      )}

      <MatchSourceBadge record={record} />
      <WhyThisMatch record={record} />

      <Field label="Empl ID" missing={isMissing(record, "employeeId")}>
        <input
          type="text"
          value={record.employeeId}
          onChange={(e) => onChange({ ...record, employeeId: e.target.value })}
          className="form-input font-mono"
        />
      </Field>
      <Field label="Printed Name" missing={isMissing(record, "printedName")}>
        <input
          type="text"
          value={record.printedName}
          onChange={(e) => onChange({ ...record, printedName: e.target.value })}
          className="form-input"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Date Signed" missing={isMissing(record, "dateSigned")}>
          <input
            type="text"
            value={record.dateSigned ?? ""}
            onChange={(e) =>
              onChange({ ...record, dateSigned: e.target.value || null })
            }
            placeholder="MM/DD/YYYY"
            className="form-input font-mono"
          />
        </Field>
        <Field label="Employee Signed?">
          <select
            value={record.employeeSigned ? "yes" : "no"}
            onChange={(e) =>
              onChange({ ...record, employeeSigned: e.target.value === "yes" })
            }
            className="form-input"
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </Field>
      </div>
      {officerApplicable && (
        <Field label="Officer Signed?">
          <select
            value={record.officerSigned ? "yes" : "no"}
            onChange={(e) =>
              onChange({ ...record, officerSigned: e.target.value === "yes" })
            }
            className="form-input"
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </Field>
      )}
    </div>
  );
}
```

Then add two new components below `OathRecordView`:

```tsx
function MatchSourceBadge({ record }: { record: OathPreviewRecord }) {
  const source = record.matchSource ?? "unknown";
  const palette: Record<string, string> = {
    roster: "border-success/40 bg-success/10 text-success",
    "form-eid": "border-success/40 bg-success/10 text-success",
    llm: "border-warning/40 bg-warning/10 text-warning",
    "eid-lookup": "border-primary/40 bg-primary/10 text-primary",
    manual: "border-border bg-muted text-muted-foreground",
    unknown: "border-border bg-muted text-muted-foreground",
  };
  const label: Record<string, string> = {
    roster: "Match: roster",
    "form-eid": "Match: EID on form",
    llm: "Match: LLM",
    "eid-lookup": "Match: eid-lookup",
    manual: "Match: manual",
    unknown: "Match: pending",
  };
  return (
    <span
      className={`w-fit rounded-md border px-1.5 py-px font-mono text-[10px] uppercase ${palette[source] ?? palette.unknown}`}
    >
      {label[source] ?? label.unknown}
    </span>
  );
}

function WhyThisMatch({ record }: { record: OathPreviewRecord }) {
  const source = record.matchSource;
  const candidates = record.rosterCandidates ?? [];
  // Skip when there's nothing to show.
  if (!source || (source === "manual" && candidates.length === 0)) return null;
  if (source === "roster" && candidates.length === 0) return null;

  return (
    <details className="rounded-md border border-border bg-secondary/20 px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium text-muted-foreground">
        Why this match?
      </summary>
      <div className="mt-2 flex flex-col gap-1 text-muted-foreground">
        {source === "roster" && record.matchConfidence !== undefined && (
          <div>Algorithmic top score: <span className="font-mono">{record.matchConfidence.toFixed(2)}</span></div>
        )}
        {source === "form-eid" && (
          <div>EID extracted directly from the form: <span className="font-mono">{record.employeeId}</span></div>
        )}
        {source === "llm" && (
          <>
            <div>LLM disambiguator picked: <span className="font-mono">{record.employeeId || "(none)"}</span> (confidence {record.matchConfidence?.toFixed(2) ?? "?"})</div>
            {candidates.length > 0 && (
              <ul className="ml-4 list-disc">
                {candidates.slice(0, 5).map((c) => (
                  <li key={c.eid} className={c.eid === record.employeeId ? "font-semibold text-foreground" : ""}>
                    <span className="font-mono">{c.eid}</span> — {c.name} (algorithmic {c.score.toFixed(2)})
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {source === "manual" && (
          <div>No automatic match — type the EID below from the source page.</div>
        )}
        {(record.warnings ?? []).length > 0 && (
          <ul className="mt-1 ml-4 list-disc">
            {record.warnings!.slice(0, 3).map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}
      </div>
    </details>
  );
}
```

- [ ] **Step 15.2: Typecheck + manual UI verification**

```bash
npm run typecheck:all
```

Manual: trigger a multi-record OCR run, expand "Why this match?" on a record matched via LLM disambiguation. Confirm candidates list shows with the picked EID highlighted.

- [ ] **Step 15.3: Commit**

```bash
git add src/dashboard/components/ocr/OathRecordView.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): match-source badge + "Why this match?" on OathRecordView

Colored badge above each record card surfaces matchSource at a glance:
roster (green), form-eid (green), llm (amber), eid-lookup (blue),
manual (gray). Collapsible "Why this match?" reveals the candidate list
the LLM saw + which EID it picked + confidence — operator can audit
every auto-decision without leaving the pane.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: `EcRecordView` — same badge + collapsible (no form-EID branch)

**Goal:** Same UX in emergency-contact's record view. Form-EID branch is N/A (EC doesn't have a "form EID" path), but the rest of the matchSources apply.

**Files:**
- Modify: `src/dashboard/components/ocr/EcRecordView.tsx`

- [ ] **Step 16.1: Inspect the current file**

```bash
head -60 /Users/julianhein/Documents/hr-automation/src/dashboard/components/ocr/EcRecordView.tsx
```

Find where the form fields start rendering inside the return JSX.

- [ ] **Step 16.2: Add the badge + collapsible at the top of the form**

Insert at the top of the form (right after any existing Force-Research button), the same `<MatchSourceBadge record={record} />` + `<WhyThisMatch record={record} />` pair you wrote in Task 15. Define both helper components at the bottom of `EcRecordView.tsx` — copy them from Task 15's code, but remove the `form-eid` branch from the `WhyThisMatch` switch:

```tsx
function MatchSourceBadge({ record }: { record: PreviewRecord }) {
  const source = record.matchSource ?? "unknown";
  const palette: Record<string, string> = {
    roster: "border-success/40 bg-success/10 text-success",
    llm: "border-warning/40 bg-warning/10 text-warning",
    "eid-lookup": "border-primary/40 bg-primary/10 text-primary",
    manual: "border-border bg-muted text-muted-foreground",
    unknown: "border-border bg-muted text-muted-foreground",
  };
  const label: Record<string, string> = {
    roster: "Match: roster",
    llm: "Match: LLM",
    "eid-lookup": "Match: eid-lookup",
    manual: "Match: manual",
    unknown: "Match: pending",
  };
  return (
    <span
      className={`w-fit rounded-md border px-1.5 py-px font-mono text-[10px] uppercase ${palette[source] ?? palette.unknown}`}
    >
      {label[source] ?? label.unknown}
    </span>
  );
}

function WhyThisMatch({ record }: { record: PreviewRecord }) {
  const source = record.matchSource;
  const candidates = record.rosterCandidates ?? [];
  if (!source || (source === "manual" && candidates.length === 0)) return null;
  if (source === "roster" && candidates.length === 0) return null;

  return (
    <details className="rounded-md border border-border bg-secondary/20 px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium text-muted-foreground">
        Why this match?
      </summary>
      <div className="mt-2 flex flex-col gap-1 text-muted-foreground">
        {source === "roster" && record.matchConfidence !== undefined && (
          <div>Algorithmic top score: <span className="font-mono">{record.matchConfidence.toFixed(2)}</span></div>
        )}
        {source === "llm" && (
          <>
            <div>LLM disambiguator picked: <span className="font-mono">{record.employee?.employeeId || "(none)"}</span> (confidence {record.matchConfidence?.toFixed(2) ?? "?"})</div>
            {candidates.length > 0 && (
              <ul className="ml-4 list-disc">
                {candidates.slice(0, 5).map((c) => (
                  <li key={c.eid} className={c.eid === record.employee?.employeeId ? "font-semibold text-foreground" : ""}>
                    <span className="font-mono">{c.eid}</span> — {c.name} (algorithmic {c.score.toFixed(2)})
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {source === "manual" && (
          <div>No automatic match — type the EID below from the source page.</div>
        )}
      </div>
    </details>
  );
}
```

(EC's preview record nests employeeId inside `employee`, so adapt the `employeeId` references accordingly. If you've structured it differently in the codebase, mirror the existing pattern.)

- [ ] **Step 16.3: Typecheck + manual UI verification**

```bash
npm run typecheck:all
```

Manual: trigger an emergency-contact OCR run, confirm the badge appears and "Why this match?" expands correctly.

- [ ] **Step 16.4: Commit**

```bash
git add src/dashboard/components/ocr/EcRecordView.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): match-source badge + "Why this match?" on EcRecordView

Mirrors OathRecordView's affordances. EC has no form-EID branch
(EID isn't extracted from the form for EC); roster / llm / eid-lookup /
manual are surfaced. EC's preview record nests employeeId inside
employee — collapsible adapts the field paths.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Update CLAUDE.md lessons

**Goal:** Document the new behavior in three places so future sessions don't have to rediscover it.

**Files:**
- Modify: `src/ocr/CLAUDE.md` (Lessons Learned section)
- Modify: `src/workflows/oath-signature/CLAUDE.md` (Lessons Learned section)
- Modify: `src/workflows/ocr/CLAUDE.md` (Lessons Learned section)

- [ ] **Step 17.1: Add lessons entry to `src/ocr/CLAUDE.md`**

Append to the Lessons Learned section at the bottom:

```markdown
- **2026-05-03: Per-page runner injects rowIndex + employeeSigned defaults.** LLM providers occasionally omit fields the prompt asks for (especially `rowIndex` on single-record pages). Schema-validation drops were silently cascading to "0 records" in the operator preview. The runner now injects `rowIndex` from array position and `employeeSigned: true` before `safeParse`, mirroring the long-standing `sourcePage` injection. LLM-supplied values still win via spread order. Records still missing the anchor field (`printedName`) are still dropped. See `per-page.ts:177-200`.
```

- [ ] **Step 17.2: Add lessons entry to `src/workflows/oath-signature/CLAUDE.md`**

Append to the Lessons Learned section:

```markdown
- **2026-05-03: Hybrid match (roster → LLM disambig) + form-EID short-circuit.** `matchRecord` is now async and runs in three branches: (1) form-EID (the LLM extracted an `employeeId` from a UPAY585/586) → roster-exact match auto-accepts as `matchSource: "form-eid"`, no roster match dispatches eid-lookup-by-EID via the new `LookupKind: "verify-only"`. (2) Name-only with top score >= 0.95 + no close second → auto-accept as `matchSource: "roster"`. (3) Top score in [0.40, 0.95) or close second → leaves `matchState: "lookup-pending"` with candidates populated; the orchestrator's `disambiguating` phase runs `disambiguateMatch` and `applyDisambiguation` patches the record (high-confidence ≥ 0.6 → `matchSource: "llm"` accepted; low confidence → `matchSource: "llm"` lookup-pending; null → `matchSource: "manual"`). Top < 0.40 / no candidates → `matchSource: "manual"` directly with eid-lookup-by-name as the backstop. The 0.95/0.10/0.40/0.6 constants live at the top of `ocr-form.ts`. Spec: `docs/superpowers/specs/2026-05-03-ocr-hybrid-match-and-manual-fill-design.md`.
```

- [ ] **Step 17.3: Add lessons entry to `src/workflows/ocr/CLAUDE.md`**

Append to the Lessons Learned section:

```markdown
- **2026-05-03: `disambiguating` phase + `data.emptyPages` + manual-fill UX.** Orchestrator gained a new step name between `matching` and `eid-lookup` that batch-calls `disambiguateMatch` for any record left as `lookup-pending` with candidates ≥ 0.40 and `matchSource ∉ {form-eid, manual}`. Concurrency capped at `OCR_DISAMBIG_CONCURRENCY` (default 4). The awaiting-approval row carries `data.emptyPages: number[]` — pages where OCR succeeded but extracted zero records. Frontend `OcrReviewPane` interleaves these into `renderList` as a third entry kind (`empty`) and renders the page image on the left + `EmptyPagePlaceholder` on the right with "Add row manually" + "Mark as blank" actions. `PrepReviewMultiPair` gets an `[+ Add row to this page]` footer button for sign-in sheets where OCR extracted N-1 of N rows. New `OcrFormSpec.applyDisambiguation` hook lets each spec patch the record when the LLM returns; oath uses confidence ≥ 0.6 cutoff for auto-accept. Approval gate (`isApprovable`) now requires `/^\d{5,}$/` on `employeeId` when selected. Spec: `docs/superpowers/specs/2026-05-03-ocr-hybrid-match-and-manual-fill-design.md`.
```

- [ ] **Step 17.4: Commit**

```bash
git add src/ocr/CLAUDE.md src/workflows/oath-signature/CLAUDE.md src/workflows/ocr/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: lessons entries for hybrid match + manual-fill rollout

Three CLAUDE.md updates (ocr module, oath-signature workflow, ocr
workflow) describing the runner-level field defaults, the form-EID
short-circuit + hybrid match thresholds, the disambiguating phase,
emptyPages emission, and the dashboard's empty-page placeholder +
add-row affordances.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **Run all tests**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Typecheck src + tests**

```bash
npm run typecheck:all
```

Expected: no errors.

- [ ] **End-to-end manual run**

```bash
npm run dashboard
```

Then in another terminal: re-upload the user's failing PDF (`Xerox Scan_04282026111307.pdf` — the one from the original screenshot). Verify:
- ≥ 1 record renders in the preview pane (the original `rowIndex`-omission no longer drops it)
- Page image is visible alongside every record
- For each record: match-source badge is correct; "Why this match?" expands to the right content
- Pages with no records show the EmptyPagePlaceholder
- "Approve N" only counts records that pass the strict gate (matched + verified + non-empty 5+ digit EID)
- Manually adding a row from the EmptyPagePlaceholder works end-to-end (type EID → row becomes approvable after verification)
