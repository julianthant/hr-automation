# OCR Per-Page Retry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the OCR workflow from whole-PDF Gemini calls to the existing per-page pipeline, surface page-level failures on the row, and add manual per-page retry plus a manual whole-PDF escape hatch.

**Architecture:** `src/workflows/ocr/orchestrator.ts` stops calling `realOcrDocument` directly and calls `runOcrPipeline` (which already does per-page splitting + multi-provider fan-out). Per-page status is plumbed up to the tracker row as `failedPages[]` + `pageStatusSummary`. Two new HTTP endpoints (`/api/ocr/retry-page`, `/api/ocr/reocr-whole-pdf`) drive operator-initiated recovery, behind a per-row mutex. The dashboard's `OcrReviewPane` renders `FailedPageCard` inline by `sourcePage`.

**Tech Stack:** TypeScript, `node:test` + `node:assert/strict`, Zod v4, React 19, shadcn/ui (Radix Dialog), Tailwind, Lucide icons.

**Spec:** `docs/superpowers/specs/2026-05-01-ocr-per-page-retry-design.md`

---

## Task 1: Extend `OcrPipelineResult` with per-page status; remove auto whole-PDF fallback

**Files:**
- Modify: `src/ocr/pipeline.ts`
- Test: `tests/unit/ocr/pipeline.test.ts` (new)
- Reference: `src/ocr/per-page.ts` (already exposes `PerPageOcrResult.pages`)

The pipeline currently returns a 5-field result and auto-falls-back to whole-PDF when per-page success ratio is <50%. We're adding a `pages[]` field and removing the fallback. Whole-PDF will live behind a separate exported helper for the manual escape-hatch endpoint.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/ocr/pipeline.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod/v4";
import { runOcrPipeline } from "../../../src/ocr/pipeline.js";
import { __setPerPageCallForTests } from "../../../src/ocr/per-page.js";

const RecordSchema = z.object({ name: z.string() });
const ArraySchema = z.array(RecordSchema);

function makeTmpPdfDir(): { pdfPath: string; pageImagesDir: string; cleanup: () => void } {
  const dir = join(tmpdir(), `ocr-pipeline-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const pdfPath = join(dir, "scan.pdf");
  writeFileSync(pdfPath, "%PDF-1.4 stub", "utf-8");
  const pageImagesDir = join(dir, "page-images");
  mkdirSync(pageImagesDir, { recursive: true });
  // Render at least one PNG so render-pages has something to find — but the
  // per-page driver is faked, so the bytes don't need to be a real PNG.
  writeFileSync(join(pageImagesDir, "page-01.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(pageImagesDir, "page-02.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(pageImagesDir, "page-03.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return {
    pdfPath,
    pageImagesDir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("runOcrPipeline returns per-page status with success and failure flags", async () => {
  const { pdfPath, pageImagesDir, cleanup } = makeTmpPdfDir();
  __setPerPageCallForTests(async ({ pageNum }) => {
    if (pageNum === 2) throw new Error("simulated 429 rate limit");
    return { json: [{ name: `page-${pageNum}` }], poolKeyId: "test-1" };
  });
  try {
    const result = await runOcrPipeline({
      pdfPath,
      pageImagesDir,
      recordSchema: RecordSchema,
      arraySchema: ArraySchema,
      prompt: "test",
      schemaName: "Test",
      _renderOverride: async () => ["page-01.png", "page-02.png", "page-03.png"],
      _poolOverride: [
        // Single fake pool key — `__setPerPageCallForTests` intercepts before the
        // pool key's callOcr is hit, so the contents don't matter, but the
        // pipeline checks `pool.length > 0`.
        { id: "test-1", providerId: "gemini", keyIndex: 1, callOcr: async () => ({}) },
      ],
    });
    assert.equal(result.pages.length, 3, "all 3 pages reported");
    assert.equal(result.pages[0].success, true);
    assert.equal(result.pages[1].success, false);
    assert.equal(result.pages[1].error, "simulated 429 rate limit");
    assert.equal(result.pages[2].success, true);
    assert.equal(result.data.length, 2, "only successful pages contribute records");
  } finally {
    __setPerPageCallForTests(undefined);
    cleanup();
  }
});

test("runOcrPipeline does NOT auto-fall-back to whole-PDF on partial failure", async () => {
  const { pdfPath, pageImagesDir, cleanup } = makeTmpPdfDir();
  let wholePdfCalled = false;
  __setPerPageCallForTests(async () => {
    throw new Error("everything throttled");
  });
  try {
    const result = await runOcrPipeline({
      pdfPath,
      pageImagesDir,
      recordSchema: RecordSchema,
      arraySchema: ArraySchema,
      prompt: "test",
      schemaName: "Test",
      _renderOverride: async () => ["page-01.png", "page-02.png"],
      _poolOverride: [
        { id: "test-1", providerId: "gemini", keyIndex: 1, callOcr: async () => ({}) },
      ],
      _wholePdfOverride: async () => {
        wholePdfCalled = true;
        return { data: [], provider: "whole-pdf-stub", attempts: 1, cached: false };
      },
    });
    assert.equal(wholePdfCalled, false, "whole-PDF fallback must not be invoked");
    assert.equal(result.data.length, 0);
    assert.equal(result.pages.every((p) => !p.success), true);
  } finally {
    __setPerPageCallForTests(undefined);
    cleanup();
  }
});

test("runOcrPipeline fails the row when zero pages render", async () => {
  const { pdfPath, pageImagesDir, cleanup } = makeTmpPdfDir();
  try {
    await assert.rejects(
      runOcrPipeline({
        pdfPath,
        pageImagesDir,
        recordSchema: RecordSchema,
        arraySchema: ArraySchema,
        prompt: "test",
        schemaName: "Test",
        _renderOverride: async () => [],
        _poolOverride: [
          { id: "test-1", providerId: "gemini", keyIndex: 1, callOcr: async () => ({}) },
        ],
      }),
      /PDF page render failed/,
    );
  } finally {
    cleanup();
  }
});

test("runOcrPipeline fails the row when pool is empty", async () => {
  const { pdfPath, pageImagesDir, cleanup } = makeTmpPdfDir();
  try {
    await assert.rejects(
      runOcrPipeline({
        pdfPath,
        pageImagesDir,
        recordSchema: RecordSchema,
        arraySchema: ArraySchema,
        prompt: "test",
        schemaName: "Test",
        _renderOverride: async () => ["page-01.png"],
        _poolOverride: [],
      }),
      /no vision API keys configured/i,
    );
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/unit/ocr/pipeline.test.ts`
Expected: FAIL — `runOcrPipeline` doesn't accept `_renderOverride` / `_poolOverride` / `_wholePdfOverride`, doesn't return `pages[]`, still has the auto-fallback branch.

- [ ] **Step 3: Modify `src/ocr/pipeline.ts`**

Replace the entire file contents with:

```ts
/**
 * Schema-bound OCR pipeline. Splits the PDF into per-page PNGs and fans
 * pages across the multi-provider key pool. Returns per-page status so
 * callers can surface failed pages to operators for manual retry.
 *
 * No auto-fallback to whole-PDF — that path lives in `runOcrWholePdf`
 * and is only reachable via the operator-initiated escape-hatch
 * endpoint.
 */
import type { ZodType } from "zod/v4";
import { log } from "../utils/log.js";
import { ocrDocument, type OcrRequest, type OcrResult } from "./index.js";
import { renderPdfPagesToPngs } from "./render-pages.js";
import { runOcrPerPage } from "./per-page.js";
import { buildVisionPool, summarizePool, type PoolKey } from "./per-page-pool.js";

export interface OcrPipelineInput<T> {
  pdfPath: string;
  pageImagesDir: string;
  recordSchema: ZodType<T>;
  arraySchema: ZodType<T[]>;
  prompt: string;
  schemaName: string;
  /** Test escape: skip the actual pdf-to-img render. */
  _renderOverride?: (pdfPath: string, pageImagesDir: string) => Promise<string[]>;
  /** Test escape: inject a fake pool. */
  _poolOverride?: PoolKey[];
  /** Test escape: replace the whole-PDF helper (used by `runOcrWholePdf`). */
  _wholePdfOverride?: <U>(req: OcrRequest<U>) => Promise<OcrResult<U>>;
}

export interface OcrPipelineResult<T> {
  data: T[];
  provider: string;
  attempts: number;
  cached: boolean;
  pageImagesDir: string;
  pages: Array<{
    page: number;
    success: boolean;
    error?: string;
    attemptedKeys: string[];
    poolKeyId?: string;
  }>;
}

export async function runOcrPipeline<T>(
  input: OcrPipelineInput<T>,
): Promise<OcrPipelineResult<T>> {
  const render = input._renderOverride ?? renderPdfPagesToPngs;
  const pool = input._poolOverride ?? buildVisionPool();

  const pageFilenames = await render(input.pdfPath, input.pageImagesDir);
  if (pageFilenames.length === 0) {
    throw new Error(
      "PDF page render failed — re-upload or use Re-OCR whole PDF",
    );
  }
  if (pool.length === 0) {
    throw new Error(
      "no vision API keys configured (set GEMINI_API_KEY*, MISTRAL_API_KEY*, GROQ_API_KEY*, or SAMBANOVA_API_KEY*)",
    );
  }

  log.step(
    `[ocr] per-page: ${pageFilenames.length} page(s) across pool ${summarizePool(pool)}`,
  );
  const perPage = await runOcrPerPage({
    pageImagesDir: input.pageImagesDir,
    pagesAsImages: pageFilenames,
    prompt: input.prompt,
    schema: input.recordSchema,
    pool,
  });

  return {
    data: perPage.records,
    provider: `per-page (${perPage.poolSummary})`,
    attempts: perPage.pages.length,
    cached: false,
    pageImagesDir: input.pageImagesDir,
    pages: perPage.pages.map((p) => ({
      page: p.page,
      success: p.success,
      error: p.error,
      attemptedKeys: p.poolKeyId ? [p.poolKeyId] : [],
      poolKeyId: p.success ? p.poolKeyId : undefined,
    })),
  };
}

/**
 * Operator-initiated whole-PDF escape hatch. Bypasses per-page entirely;
 * one cached Gemini call on the full PDF. Replaces records on the row.
 */
export async function runOcrWholePdf<T>(input: {
  pdfPath: string;
  arraySchema: ZodType<T[]>;
  prompt: string;
  schemaName: string;
  _override?: <U>(req: OcrRequest<U>) => Promise<OcrResult<U>>;
}): Promise<{ data: T[]; provider: string; attempts: number; cached: boolean }> {
  const fn = input._override ?? ocrDocument;
  const result = await fn({
    pdfPath: input.pdfPath,
    schema: input.arraySchema,
    prompt: input.prompt,
    schemaName: input.schemaName,
  });
  return {
    data: result.data,
    provider: result.provider,
    attempts: result.attempts,
    cached: result.cached,
  };
}
```

Note: per-page driver only exposes a single `poolKeyId` per page (the succeeded key, or last-tried on failure). Surfacing the full retry chain would require a small change to `per-page.ts`'s outcome shape — out of scope for this task. The frontend just shows the one chip we have, with a tooltip or label "(last tried)" if needed (handled in Task 9).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/unit/ocr/pipeline.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: no errors. Other call sites of `runOcrPipeline` (the orchestrator hasn't been wired yet, but emergency-contact's prep code may have been deleted per recent commits — verify there are no remaining callers expecting the old shape).

If a caller still expects the old shape, leave a `@ts-expect-error` with a `// fixed in Task 3` comment rather than blocking — Task 3 is the orchestrator wiring.

- [ ] **Step 6: Commit**

```bash
git add src/ocr/pipeline.ts tests/unit/ocr/pipeline.test.ts
git commit -m "$(cat <<'EOF'
feat(ocr): expose per-page status in pipeline + drop auto whole-PDF fallback

Pipeline now returns pages[] (page number, success, error, poolKeyId) so
callers can surface failed pages to operators. Removes the <50%-success
auto-fallback to whole-PDF; whole-PDF is now reachable only via the new
exported runOcrWholePdf helper for the operator-initiated escape hatch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Wire orchestrator to `runOcrPipeline`; emit `failedPages` + `pageStatusSummary`

**Files:**
- Modify: `src/workflows/ocr/orchestrator.ts:82-95, 280-301`
- Test: `tests/unit/workflows/ocr/orchestrator.test.ts` (extend existing file)

The orchestrator currently calls `realOcrDocument` directly. Switch to `runOcrPipeline` and propagate per-page status onto the `awaiting-approval` row.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/workflows/ocr/orchestrator.test.ts`:

```ts
test("orchestrator surfaces failedPages and pageStatusSummary on awaiting-approval", async () => {
  const { dir, rosterPath } = setup();
  const writtenEntries: object[] = [];

  await runOcrOrchestrator(
    {
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "fake.pdf",
      formType: "oath",
      sessionId: "session-fp-1",
      rosterPath,
      rosterMode: "existing",
    },
    {
      runId: "run-fp-1",
      trackerDir: dir,
      _emitOverride: (entry) => writtenEntries.push(entry),
      _ocrPipelineOverride: async () => ({
        data: [{
          sourcePage: 1, rowIndex: 0,
          printedName: "Liam Kustenbauder",
          employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
          notes: [], documentType: "expected", originallyMissing: [],
        }],
        provider: "stub",
        attempts: 3,
        cached: false,
        pages: [
          { page: 1, success: true, attemptedKeys: ["gemini-1"], poolKeyId: "gemini-1" },
          { page: 2, success: false, error: "rate limit", attemptedKeys: ["gemini-1", "mistral-1"] },
          { page: 3, success: true, attemptedKeys: ["groq-1"], poolKeyId: "groq-1" },
        ],
      }),
      _loadRosterOverride: async () => [
        { eid: "10000001", name: "Liam Kustenbauder" },
      ],
      _enqueueEidLookupOverride: async () => { /* no-op */ },
      _watchChildRunsOverride: async () => [
        {
          workflow: "eid-lookup",
          itemId: "ocr-oath-run-fp-1-r0",
          runId: "verify-1",
          status: "done" as const,
          data: { hrStatus: "Active", department: "HDH", personOrgScreenshot: "x.png", emplId: "10000001" },
        },
      ],
    },
  );

  const approval = (writtenEntries as Array<{ status: string; step?: string; data?: Record<string, string> }>).find(
    (e) => (e.status === "running" || e.status === "done") && e.step === "awaiting-approval",
  );
  assert.ok(approval, "awaiting-approval entry written");
  const failedPages = JSON.parse(approval!.data!.failedPages ?? "[]") as Array<{ page: number }>;
  assert.equal(failedPages.length, 1, "one failed page");
  assert.equal(failedPages[0].page, 2);
  const summary = JSON.parse(approval!.data!.pageStatusSummary ?? "{}") as {
    total: number; succeeded: number; failed: number;
  };
  assert.deepEqual(summary, { total: 3, succeeded: 2, failed: 1 });

  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/unit/workflows/ocr/orchestrator.test.ts`
Expected: the new test fails — orchestrator doesn't write `failedPages` / `pageStatusSummary`.

- [ ] **Step 3: Modify orchestrator's `runOcr` default + the awaiting-approval write**

In `src/workflows/ocr/orchestrator.ts`, change the default `runOcr` (around lines 82-95) to use `runOcrPipeline` and pass `pages` through. Replace:

```ts
const runOcr = opts._ocrPipelineOverride ?? (async ({ pdfPath, spec: s }: { pdfPath: string; formType: string; spec: AnyOcrFormSpec }) => {
  const result = await realOcrDocument({
    pdfPath,
    schema: s.ocrArraySchema as ZodType<unknown[]>,
    schemaName: s.schemaName,
    prompt: s.prompt,
  });
  return {
    data: result.data as unknown[],
    provider: result.provider,
    attempts: result.attempts,
    cached: result.cached,
  };
});
```

with:

```ts
const runOcr = opts._ocrPipelineOverride ?? (async ({ pdfPath, spec: s, sessionId }: { pdfPath: string; formType: string; spec: AnyOcrFormSpec; sessionId: string }) => {
  const { runOcrPipeline } = await import("../../ocr/pipeline.js");
  const pageImagesDir = join(trackerDir ?? ".tracker", "page-images", sessionId);
  const result = await runOcrPipeline({
    pdfPath,
    pageImagesDir,
    recordSchema: s.ocrRecordSchema as ZodType<unknown>,
    arraySchema: s.ocrArraySchema as ZodType<unknown[]>,
    schemaName: s.schemaName,
    prompt: s.prompt,
  });
  return {
    data: result.data as unknown[],
    provider: result.provider,
    attempts: result.attempts,
    cached: result.cached,
    pages: result.pages,
  };
});
```

Update the `OcrPipelineResult` local interface (around line 31-36) to include `pages`:

```ts
interface OcrPipelineResult {
  data: unknown[];
  provider: string;
  attempts: number;
  cached: boolean;
  pages?: Array<{
    page: number;
    success: boolean;
    error?: string;
    attemptedKeys: string[];
    poolKeyId?: string;
  }>;
}
```

Update the `runOcr` call (around line 173) to pass `sessionId`:

```ts
const ocrResult = await runOcr({
  pdfPath: input.pdfPath,
  formType: input.formType,
  spec,
  sessionId: input.sessionId,
});
```

Build `failedPages` + `pageStatusSummary` from `ocrResult.pages` after OCR completes. Insert this block right after the `runOcr` call:

```ts
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
    attempts: p.attemptedKeys.length || 1,
  }));
const pageStatusSummary = {
  total: pages.length,
  succeeded: pages.filter((p) => p.success).length,
  failed: failedPages.length,
};
```

Extend the awaiting-approval writes (lines 284-301) to include the new fields:

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
  pageStatusSummary,
}, "awaiting-approval");
```

Make sure `join` is imported (`import { join } from "node:path";` — likely already imported).

Remove the now-unused `import { ocrDocument as realOcrDocument } from "../../ocr/index.js";` line. Update tests that reference `realOcrDocument` in orchestrator-internal logic (none should — only `_ocrPipelineOverride` is used in tests).

- [ ] **Step 4: Run tests**

Run: `npx tsx --test tests/unit/workflows/ocr/orchestrator.test.ts`
Expected: all tests pass, including the new `failedPages` test.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/workflows/ocr/orchestrator.ts tests/unit/workflows/ocr/orchestrator.test.ts
git commit -m "$(cat <<'EOF'
feat(ocr): orchestrator uses per-page pipeline, surfaces failedPages

The OCR orchestrator now calls runOcrPipeline (per-page) instead of
ocrDocument (whole-PDF). Per-page status is plumbed onto the
awaiting-approval tracker row as data.failedPages[] and
data.pageStatusSummary, ready for the dashboard to render
FailedPageCard inline.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Extract `runOcrRetryPage` helper for single-page retry

**Files:**
- Create: `src/workflows/ocr/retry-page.ts`
- Test: `tests/unit/workflows/ocr/retry-page.test.ts` (new)
- Reference: `src/workflows/ocr/orchestrator.ts` (match phase + eid-lookup phase + verification phase share the same shape)

The retry-page operation is a mini-orchestrator scoped to one page: load prior records, OCR just that page, match, eid-lookup the new records that need it, splice into records[], emit a fresh awaiting-approval entry.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/workflows/ocr/retry-page.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runOcrRetryPage } from "../../../../src/workflows/ocr/retry-page.js";

function setup(): { dir: string } {
  const dir = join(tmpdir(), `ocr-retry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return { dir };
}

test("runOcrRetryPage replaces records for the retried page and clears it from failedPages", async () => {
  const { dir } = setup();
  const ocrFile = join(dir, "ocr-2026-05-01.jsonl");
  writeFileSync(ocrFile, JSON.stringify({
    workflow: "ocr",
    id: "session-r1",
    runId: "run-r1",
    status: "done",
    step: "awaiting-approval",
    timestamp: "2026-05-01T00:00:00Z",
    data: {
      formType: "oath",
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "fake.pdf",
      sessionId: "session-r1",
      recordCount: 2,
      verifiedCount: 1,
      records: JSON.stringify([
        { sourcePage: 1, rowIndex: 0, printedName: "Alice",
          employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
          notes: [], documentType: "expected", originallyMissing: [],
          employeeId: "10000001", matchState: "resolved", selected: true, warnings: [],
          verification: { state: "verified", hrStatus: "Active", department: "HDH", screenshotFilename: "a.png", checkedAt: "2026-05-01T00:00:00Z" },
        },
      ]),
      failedPages: JSON.stringify([
        { page: 2, error: "rate limit", attemptedKeys: ["gemini-1"], pageImagePath: join(dir, "page-images", "session-r1", "page-02.png"), attempts: 1 },
      ]),
      pageStatusSummary: JSON.stringify({ total: 2, succeeded: 1, failed: 1 }),
    },
  }) + "\n", "utf-8");

  const writtenEntries: object[] = [];
  await runOcrRetryPage(
    { sessionId: "session-r1", runId: "run-r1", pageNum: 2 },
    {
      trackerDir: dir,
      date: "2026-05-01",
      _emitOverride: (e) => writtenEntries.push(e),
      _ocrPageOverride: async ({ pageNum }) => {
        assert.equal(pageNum, 2);
        return {
          records: [{
            sourcePage: 2, rowIndex: 0,
            printedName: "Bob",
            employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
            notes: [], documentType: "expected", originallyMissing: [],
          }],
          stillFailed: false,
        };
      },
      _loadRosterOverride: async () => [{ eid: "10000002", name: "Bob" }],
      _enqueueEidLookupOverride: async () => { /* none — Bob matches roster directly */ },
      _watchChildRunsOverride: async () => [],
    },
  );

  const approval = (writtenEntries as Array<{ status: string; step?: string; data?: Record<string, string> }>).find(
    (e) => (e.status === "running" || e.status === "done") && e.step === "awaiting-approval",
  );
  assert.ok(approval, "fresh awaiting-approval entry written");
  const records = JSON.parse(approval!.data!.records!) as Array<{ sourcePage: number; printedName: string }>;
  const sortedRecords = [...records].sort((a, b) => a.sourcePage - b.sourcePage);
  assert.equal(sortedRecords.length, 2, "alice (page 1) + bob (page 2)");
  assert.equal(sortedRecords[0].printedName, "Alice");
  assert.equal(sortedRecords[1].printedName, "Bob");
  const failedPages = JSON.parse(approval!.data!.failedPages ?? "[]") as Array<{ page: number }>;
  assert.equal(failedPages.length, 0, "page 2 cleared from failedPages");

  rmSync(dir, { recursive: true, force: true });
});

test("runOcrRetryPage keeps page in failedPages with bumped attempts when retry still fails", async () => {
  const { dir } = setup();
  const ocrFile = join(dir, "ocr-2026-05-01.jsonl");
  writeFileSync(ocrFile, JSON.stringify({
    workflow: "ocr",
    id: "session-r2",
    runId: "run-r2",
    status: "done",
    step: "awaiting-approval",
    timestamp: "2026-05-01T00:00:00Z",
    data: {
      formType: "oath",
      pdfPath: "/tmp/fake.pdf",
      pdfOriginalName: "fake.pdf",
      sessionId: "session-r2",
      recordCount: 0,
      verifiedCount: 0,
      records: JSON.stringify([]),
      failedPages: JSON.stringify([
        { page: 1, error: "rate limit", attemptedKeys: ["gemini-1"], pageImagePath: join(dir, "page-images", "session-r2", "page-01.png"), attempts: 1 },
      ]),
      pageStatusSummary: JSON.stringify({ total: 1, succeeded: 0, failed: 1 }),
    },
  }) + "\n", "utf-8");

  const writtenEntries: object[] = [];
  await runOcrRetryPage(
    { sessionId: "session-r2", runId: "run-r2", pageNum: 1 },
    {
      trackerDir: dir,
      date: "2026-05-01",
      _emitOverride: (e) => writtenEntries.push(e),
      _ocrPageOverride: async () => ({
        records: [],
        stillFailed: true,
        error: "still throttled",
        attemptedKeys: ["gemini-2", "mistral-1"],
      }),
      _loadRosterOverride: async () => [],
      _enqueueEidLookupOverride: async () => {},
      _watchChildRunsOverride: async () => [],
    },
  );

  const approval = (writtenEntries as Array<{ status: string; step?: string; data?: Record<string, string> }>).find(
    (e) => (e.status === "running" || e.status === "done") && e.step === "awaiting-approval",
  );
  const failedPages = JSON.parse(approval!.data!.failedPages!) as Array<{ page: number; attempts: number; error: string }>;
  assert.equal(failedPages.length, 1);
  assert.equal(failedPages[0].page, 1);
  assert.equal(failedPages[0].attempts, 2, "attempts bumped from 1 to 2");
  assert.equal(failedPages[0].error, "still throttled");

  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/unit/workflows/ocr/retry-page.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Create `src/workflows/ocr/retry-page.ts`**

```ts
/**
 * Single-page retry for the OCR workflow. Scoped mini-orchestrator:
 * load the row's prior state from JSONL, re-OCR just one page through
 * the multi-provider pool, match new records against the roster, fan
 * out eid-lookup for any that need it, and emit a fresh
 * awaiting-approval row with patched records + failedPages.
 *
 * Reuses the same primitives as the main orchestrator (matchRecord,
 * watchChildRuns, eid-lookup daemon dispatch). Test escape hatches
 * mirror those on `runOcrOrchestrator`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ZodType } from "zod/v4";
import { runOcrPerPage } from "../../ocr/per-page.js";
import { buildVisionPool } from "../../ocr/per-page-pool.js";
import { loadRoster as realLoadRoster } from "../../match/index.js";
import type { RosterRow as MatchRosterRow } from "../../match/match.js";
import { watchChildRuns as realWatchChildRuns, type ChildOutcome, type WatchChildRunsOpts } from "../../tracker/watch-child-runs.js";
import { trackEvent, dateLocal, type TrackerEntry } from "../../tracker/jsonl.js";
import { errorMessage } from "../../utils/errors.js";
import { isAcceptedDept } from "../eid-lookup/search.js";
import { getFormSpec } from "./form-registry.js";
import type { AnyOcrFormSpec, RosterRow as OcrRosterRow } from "./types.js";

const WORKFLOW = "ocr";

export interface RetryPageInput {
  sessionId: string;
  runId: string;
  pageNum: number;
}

export interface RetryPageOpts {
  trackerDir?: string;
  date?: string;
  eidLookupTimeoutMs?: number;

  _emitOverride?: (entry: TrackerEntry) => void;
  _ocrPageOverride?: (args: { pageNum: number; pageImagePath: string; spec: AnyOcrFormSpec }) => Promise<{
    records: unknown[];
    stillFailed: boolean;
    error?: string;
    attemptedKeys?: string[];
  }>;
  _loadRosterOverride?: (path: string) => Promise<MatchRosterRow[]>;
  _watchChildRunsOverride?: (opts: WatchChildRunsOpts) => Promise<ChildOutcome[]>;
  _enqueueEidLookupOverride?: (
    items: Array<{ name?: string; emplId?: string; itemId: string }>,
  ) => Promise<void>;
}

export interface RetryPageResult {
  ok: true;
  page: number;
  recordsAdded: number;
  stillFailed: boolean;
}

export class RetryPageError extends Error {
  constructor(public readonly code: "row-not-found" | "row-not-mutable" | "image-missing" | "spec-missing", message: string) {
    super(message);
    this.name = "RetryPageError";
  }
}

export async function runOcrRetryPage(
  input: RetryPageInput,
  opts: RetryPageOpts = {},
): Promise<RetryPageResult> {
  const trackerDir = opts.trackerDir;
  const date = opts.date ?? dateLocal();
  const emit = opts._emitOverride ?? ((e: TrackerEntry) => trackEvent(e, trackerDir));
  const loadRosterFn = opts._loadRosterOverride ?? realLoadRoster;
  const watchChildren = opts._watchChildRunsOverride ?? realWatchChildRuns;

  // 1. Load the latest row state.
  const row = readLatestRow(input.sessionId, input.runId, trackerDir, date);
  if (!row) throw new RetryPageError("row-not-found", `No OCR row for sessionId=${input.sessionId} runId=${input.runId}`);
  if (row.status === "failed") throw new RetryPageError("row-not-mutable", "Row is in failed state");
  const formType = row.data?.formType as unknown as string | undefined;
  if (!formType) throw new RetryPageError("spec-missing", "Row missing formType");
  const spec = getFormSpec(formType);
  if (!spec) throw new RetryPageError("spec-missing", `Unknown formType "${formType}"`);

  const records = parseRecords(row.data);
  const failedPages = parseFailedPages(row.data);
  const summary = parsePageSummary(row.data) ?? { total: 0, succeeded: 0, failed: 0 };

  const failedEntry = failedPages.find((fp) => fp.page === input.pageNum);
  const pageImagePath = failedEntry?.pageImagePath ?? join(
    trackerDir ?? ".tracker",
    "page-images",
    input.sessionId,
    `page-${String(input.pageNum).padStart(2, "0")}.png`,
  );

  if (!opts._ocrPageOverride && !existsSync(pageImagePath)) {
    throw new RetryPageError("image-missing", `Page image expired at ${pageImagePath}`);
  }

  // 2. OCR the single page.
  const ocr = opts._ocrPageOverride
    ? await opts._ocrPageOverride({ pageNum: input.pageNum, pageImagePath, spec })
    : await runSinglePageThroughPool({ pageNum: input.pageNum, pageImagePath, spec });

  if (ocr.stillFailed) {
    // Patch failedPages: bump attempts, update error.
    const newFailedPages = failedPages.map((fp) =>
      fp.page === input.pageNum
        ? {
            ...fp,
            attempts: fp.attempts + 1,
            error: ocr.error ?? fp.error,
            attemptedKeys: ocr.attemptedKeys ?? fp.attemptedKeys,
          }
        : fp,
    );
    if (!newFailedPages.some((fp) => fp.page === input.pageNum)) {
      // Wasn't in failedPages before — operator retried a successful page.
      newFailedPages.push({
        page: input.pageNum,
        error: ocr.error ?? "retry failed",
        attemptedKeys: ocr.attemptedKeys ?? [],
        pageImagePath,
        attempts: 1,
      });
    }
    emitRow({ row, records, failedPages: newFailedPages, summary, emit, parentRunId: row.parentRunId, sessionId: input.sessionId, runId: input.runId, formType, pdfOriginalName: row.data?.pdfOriginalName as unknown as string ?? "" });
    return { ok: true, page: input.pageNum, recordsAdded: 0, stillFailed: true };
  }

  // 3. Match new records against the roster.
  const rosterPath = (row.data?.rosterPath as unknown as string | undefined) ?? "";
  const roster = rosterPath ? ((await loadRosterFn(rosterPath)) as OcrRosterRow[]) : [];
  let newRecords = ocr.records.map((r) => spec.matchRecord({ record: r, roster }));

  // 4. Eid-lookup for new records that need it.
  const lookupTargets: Array<{ rec: unknown; localIndex: number; kind: "name" | "verify" }> = [];
  newRecords.forEach((rec, localIndex) => {
    const kind = spec.needsLookup(rec);
    if (kind === "name" || kind === "verify") {
      lookupTargets.push({ rec, localIndex, kind });
    }
  });

  if (lookupTargets.length > 0) {
    const enqueueItems = lookupTargets.map((t, i) => ({
      record: t.rec,
      localIndex: t.localIndex,
      kind: t.kind,
      itemId: `ocr-retry-${input.runId}-p${input.pageNum}-r${i}`,
    }));
    if (opts._enqueueEidLookupOverride) {
      await opts._enqueueEidLookupOverride(
        enqueueItems.map((e) => ({
          ...(e.kind === "name"
            ? { name: extractName(e.record, spec) }
            : { emplId: extractEid(e.record) }),
          itemId: e.itemId,
        })),
      );
    } else {
      const { ensureDaemonsAndEnqueue } = await import("../../core/daemon-client.js");
      const { eidLookupCrmWorkflow } = await import("../eid-lookup/index.js");
      const inputs = enqueueItems.map((e) =>
        e.kind === "name"
          ? { name: extractName(e.record, spec) }
          : { emplId: extractEid(e.record), keepNonHdh: true },
      );
      await ensureDaemonsAndEnqueue(eidLookupCrmWorkflow, inputs as never, {}, {
        deriveItemId: (inp: { name?: string; emplId?: string }) => {
          const matched = enqueueItems.find((e) => {
            if ("name" in inp && inp.name) return extractName(e.record, spec) === inp.name;
            if ("emplId" in inp && inp.emplId) return extractEid(e.record) === inp.emplId;
            return false;
          });
          return matched?.itemId ?? `ocr-retry-fallback-${input.runId}-p${input.pageNum}`;
        },
      });
    }

    const outcomes = await watchChildren({
      workflow: "eid-lookup",
      expectedItemIds: enqueueItems.map((e) => e.itemId),
      trackerDir,
      date,
      timeoutMs: opts.eidLookupTimeoutMs ?? 60 * 60_000,
    }).catch(() => [] as ChildOutcome[]);

    const outcomesByItemId = new Map(outcomes.map((o) => [o.itemId, o]));
    for (const enq of enqueueItems) {
      const outcome = outcomesByItemId.get(enq.itemId);
      const idx = enq.localIndex;
      if (!outcome) {
        patchUnresolved(newRecords, idx);
        continue;
      }
      patchFromOutcome(newRecords, idx, outcome, enq.kind);
    }
  }

  // 5. Splice into records[]: drop existing records with sourcePage === pageNum, append new ones.
  const survivingRecords = records.filter((r) => (r as { sourcePage: number }).sourcePage !== input.pageNum);
  const updatedRecords = [...survivingRecords, ...newRecords];

  // 6. Clear page from failedPages.
  const updatedFailedPages = failedPages.filter((fp) => fp.page !== input.pageNum);

  // 7. Recompute summary.
  const updatedSummary = {
    total: summary.total,
    succeeded: summary.total - updatedFailedPages.length,
    failed: updatedFailedPages.length,
  };

  emitRow({
    row,
    records: updatedRecords,
    failedPages: updatedFailedPages,
    summary: updatedSummary,
    emit,
    parentRunId: row.parentRunId,
    sessionId: input.sessionId,
    runId: input.runId,
    formType,
    pdfOriginalName: row.data?.pdfOriginalName as unknown as string ?? "",
  });

  return { ok: true, page: input.pageNum, recordsAdded: newRecords.length, stillFailed: false };
}

// ─── Helpers ─────────────────────────────────────────────────

interface FailedPageEntry {
  page: number;
  error: string;
  attemptedKeys: string[];
  pageImagePath: string;
  attempts: number;
}

function readLatestRow(
  sessionId: string,
  runId: string,
  trackerDir: string | undefined,
  date: string,
): TrackerEntry | null {
  const file = join(trackerDir ?? ".tracker", `ocr-${date}.jsonl`);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf-8");
  const lines = raw.split("\n").filter(Boolean);
  let latest: TrackerEntry | null = null;
  for (const line of lines) {
    try {
      const e: TrackerEntry = JSON.parse(line);
      if (e.id === sessionId && e.runId === runId) latest = e;
    } catch { /* tolerate */ }
  }
  return latest;
}

function parseRecords(data: Record<string, string> | undefined): unknown[] {
  if (!data?.records) return [];
  try {
    const parsed = JSON.parse(data.records);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function parseFailedPages(data: Record<string, string> | undefined): FailedPageEntry[] {
  if (!data?.failedPages) return [];
  try {
    const parsed = JSON.parse(data.failedPages);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function parsePageSummary(data: Record<string, string> | undefined): { total: number; succeeded: number; failed: number } | null {
  if (!data?.pageStatusSummary) return null;
  try {
    const p = JSON.parse(data.pageStatusSummary);
    if (typeof p?.total === "number") return p;
    return null;
  } catch { return null; }
}

async function runSinglePageThroughPool(args: {
  pageNum: number;
  pageImagePath: string;
  spec: AnyOcrFormSpec;
}): Promise<{ records: unknown[]; stillFailed: boolean; error?: string; attemptedKeys?: string[] }> {
  const pool = buildVisionPool();
  if (pool.length === 0) {
    return { records: [], stillFailed: true, error: "No vision API keys configured", attemptedKeys: [] };
  }
  // runOcrPerPage operates on filenames within pageImagesDir — split path/filename.
  const lastSlash = args.pageImagePath.lastIndexOf("/");
  const dir = lastSlash >= 0 ? args.pageImagePath.slice(0, lastSlash) : ".";
  const filename = lastSlash >= 0 ? args.pageImagePath.slice(lastSlash + 1) : args.pageImagePath;
  const result = await runOcrPerPage({
    pagesAsImages: [filename],
    pageImagesDir: dir,
    prompt: args.spec.prompt,
    schema: args.spec.ocrRecordSchema as ZodType<unknown>,
    pool,
  });
  const status = result.pages[0];
  if (!status?.success) {
    return {
      records: [],
      stillFailed: true,
      error: status?.error ?? "unknown failure",
      attemptedKeys: status?.poolKeyId ? [status.poolKeyId] : [],
    };
  }
  const newRecords = result.records
    .filter((r) => (r as { sourcePage: number }).sourcePage === 1)
    .map((r) => ({ ...(r as object), sourcePage: args.pageNum }));
  return { records: newRecords, stillFailed: false };
}

function emitRow(args: {
  row: TrackerEntry;
  records: unknown[];
  failedPages: FailedPageEntry[];
  summary: { total: number; succeeded: number; failed: number };
  emit: (e: TrackerEntry) => void;
  parentRunId: string | undefined;
  sessionId: string;
  runId: string;
  formType: string;
  pdfOriginalName: string;
}): void {
  const verifiedCount = countVerified(args.records);
  const data = flattenForData({
    formType: args.formType,
    pdfOriginalName: args.pdfOriginalName,
    sessionId: args.sessionId,
    ...(args.parentRunId ? { parentRunId: args.parentRunId } : {}),
    recordCount: args.records.length,
    verifiedCount,
    records: args.records,
    failedPages: args.failedPages,
    pageStatusSummary: args.summary,
  });
  args.emit({
    workflow: WORKFLOW,
    timestamp: new Date().toISOString(),
    id: args.sessionId,
    runId: args.runId,
    ...(args.parentRunId ? { parentRunId: args.parentRunId } : {}),
    status: "running",
    step: "awaiting-approval",
    data,
  });
  args.emit({
    workflow: WORKFLOW,
    timestamp: new Date().toISOString(),
    id: args.sessionId,
    runId: args.runId,
    ...(args.parentRunId ? { parentRunId: args.parentRunId } : {}),
    status: "done",
    step: "awaiting-approval",
    data,
  });
}

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

function extractName(record: unknown, spec: AnyOcrFormSpec): string {
  return spec.carryForwardKey(record as never);
}

function extractEid(record: unknown): string {
  const r = record as Record<string, unknown>;
  if (typeof r.employeeId === "string") return r.employeeId;
  const employee = r.employee as Record<string, unknown> | undefined;
  if (employee && typeof employee.employeeId === "string") return employee.employeeId;
  return "";
}

function patchUnresolved(records: unknown[], idx: number): void {
  const rec = records[idx] as Record<string, unknown>;
  if (rec.matchState === "lookup-pending" || rec.matchState === "lookup-running") {
    rec.matchState = "unresolved";
    const warnings = (rec.warnings as string[]) ?? [];
    warnings.push("eid-lookup did not return within timeout");
    rec.warnings = warnings;
  }
}

function patchFromOutcome(records: unknown[], idx: number, outcome: ChildOutcome, kind: "name" | "verify"): void {
  const rec = records[idx] as Record<string, unknown>;
  const eid = (outcome.data?.emplId ?? "").trim();
  const looksLikeEid = /^\d{5,}$/.test(eid);

  if (kind === "name") {
    if (outcome.status === "done" && looksLikeEid) {
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

  const v = computeVerification({
    hrStatus: outcome.data?.hrStatus,
    department: outcome.data?.department,
    personOrgScreenshot: outcome.data?.personOrgScreenshot,
  });
  rec.verification = v;
  if (v.state !== "verified") rec.selected = false;
}

function countVerified(records: unknown[]): number {
  let n = 0;
  for (const r of records) {
    const v = (r as Record<string, unknown>).verification as { state?: string } | undefined;
    if (v?.state === "verified") n++;
  }
  return n;
}

function computeVerification(d: { hrStatus?: string; department?: string; personOrgScreenshot?: string }): {
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

void errorMessage;
```

(The `void errorMessage;` is a no-op import keep — leave it if your linter doesn't strip unused; otherwise remove the import. The `errorMessage` import is for symmetry with the orchestrator and may be useful for future inline error wrapping.)

- [ ] **Step 4: Run tests**

Run: `npx tsx --test tests/unit/workflows/ocr/retry-page.test.ts`
Expected: both tests PASS.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/workflows/ocr/retry-page.ts tests/unit/workflows/ocr/retry-page.test.ts
git commit -m "$(cat <<'EOF'
feat(ocr): runOcrRetryPage — single-page mini-orchestrator

Retry-page operation: load the row's prior state, OCR just one page,
match new records against the roster, fan out eid-lookup for any that
need it, splice into records[] (replacing same-sourcePage entries),
remove the page from failedPages or bump attempts on still-failure.
Reuses the existing orchestrator's verification + lookup helpers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: HTTP handlers — `retry-page` + `reocr-whole-pdf`

**Files:**
- Modify: `src/tracker/ocr-http.ts`
- Test: `tests/unit/tracker/ocr-http.test.ts` (extend existing file)

Two new factories. Both acquire a per-row mutex keyed `${sessionId}:${runId}`. The retry-page handler delegates to `runOcrRetryPage`; the reocr-whole-pdf handler runs `runOcrWholePdf` + the orchestrator's match → eid-lookup → verification path (it's invasive enough to write inline rather than refactor a fifth time).

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/tracker/ocr-http.test.ts`:

```ts
test("buildOcrRetryPageHandler rejects concurrent retries on the same row", async () => {
  const dir = join(tmpdir(), `ocr-http-mutex-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const { buildOcrRetryPageHandler, _resetSessionLockForTests } = await import("../../../src/tracker/ocr-http.js");
    _resetSessionLockForTests();

    let inFlightResolve: () => void;
    const inFlight = new Promise<void>((r) => { inFlightResolve = r; });
    const handler = buildOcrRetryPageHandler({
      trackerDir: dir,
      runRetryPageOverride: async () => {
        await inFlight;
        return { ok: true, page: 1, recordsAdded: 0, stillFailed: false };
      },
    });

    const first = handler({ sessionId: "s1", runId: "r1", pageNum: 1 });
    const second = await handler({ sessionId: "s1", runId: "r1", pageNum: 1 });
    assert.equal(second.status, 409);
    assert.match(JSON.stringify(second.body), /already in progress/i);

    inFlightResolve!();
    const firstResolved = await first;
    assert.equal(firstResolved.status, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildOcrRetryPageHandler maps RetryPageError codes to HTTP statuses", async () => {
  const dir = join(tmpdir(), `ocr-http-err-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const { buildOcrRetryPageHandler, _resetSessionLockForTests } = await import("../../../src/tracker/ocr-http.js");
    const { RetryPageError } = await import("../../../src/workflows/ocr/retry-page.js");
    _resetSessionLockForTests();

    const handler = buildOcrRetryPageHandler({
      trackerDir: dir,
      runRetryPageOverride: async () => {
        throw new RetryPageError("image-missing", "page image expired");
      },
    });
    const r = await handler({ sessionId: "s2", runId: "r2", pageNum: 1 });
    assert.equal(r.status, 410);
    assert.match(JSON.stringify(r.body), /expired/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildOcrReocrWholePdfHandler replaces records and clears failedPages", async () => {
  const dir = join(tmpdir(), `ocr-http-whole-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const ocrFile = join(dir, `ocr-${dateLocalForTest()}.jsonl`);
    writeFileSync(ocrFile, JSON.stringify({
      workflow: "ocr",
      id: "s3",
      runId: "r3",
      status: "done",
      step: "awaiting-approval",
      timestamp: "2026-05-01T00:00:00Z",
      data: {
        formType: "oath",
        pdfPath: "/tmp/fake.pdf",
        pdfOriginalName: "fake.pdf",
        sessionId: "s3",
        records: JSON.stringify([]),
        failedPages: JSON.stringify([{ page: 1, error: "x", attemptedKeys: [], pageImagePath: "/tmp/p1.png", attempts: 1 }]),
        pageStatusSummary: JSON.stringify({ total: 1, succeeded: 0, failed: 1 }),
      },
    }) + "\n", "utf-8");

    const { buildOcrReocrWholePdfHandler, _resetSessionLockForTests } = await import("../../../src/tracker/ocr-http.js");
    _resetSessionLockForTests();

    const writtenEntries: object[] = [];
    const handler = buildOcrReocrWholePdfHandler({
      trackerDir: dir,
      _emitOverride: (e) => writtenEntries.push(e),
      _wholePdfOverride: async () => ({
        data: [{
          sourcePage: 1, rowIndex: 0,
          printedName: "Carla", employeeSigned: true, officerSigned: true, dateSigned: "05/01/2026",
          notes: [], documentType: "expected", originallyMissing: [],
        }],
        provider: "whole-pdf-stub",
        attempts: 1,
        cached: false,
      }),
      _loadRosterOverride: async () => [{ eid: "10000003", name: "Carla" }],
      _watchChildRunsOverride: async () => [],
      _enqueueEidLookupOverride: async () => {},
    });
    const r = await handler({ sessionId: "s3", runId: "r3" });
    assert.equal(r.status, 200);
    const approval = (writtenEntries as Array<{ status: string; step?: string; data?: Record<string, string> }>)
      .find((e) => (e.status === "running" || e.status === "done") && e.step === "awaiting-approval");
    assert.ok(approval);
    const failedPages = JSON.parse(approval!.data!.failedPages ?? "[]") as unknown[];
    assert.equal(failedPages.length, 0, "failedPages cleared");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function dateLocalForTest(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
```

(Add the imports `mkdirSync`, `rmSync`, `writeFileSync`, `tmpdir`, `join` at the top of the test file if not already imported.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/unit/tracker/ocr-http.test.ts`
Expected: FAIL — `buildOcrRetryPageHandler` and `buildOcrReocrWholePdfHandler` don't exist.

- [ ] **Step 3: Append handlers to `src/tracker/ocr-http.ts`**

Add at the bottom of the file (above the helpers):

```ts
// ─── POST /api/ocr/retry-page ─────────────────────────────────

const activeRowKeys = new Set<string>();

function rowKey(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}`;
}

export interface RetryPageBody {
  sessionId: string;
  runId: string;
  pageNum: number;
}
export interface RetryPageHttpResponse {
  status: 200 | 400 | 404 | 409 | 410;
  body: { ok: true; page: number; recordsAdded: number; stillFailed: boolean } | { ok: false; error: string };
}
export interface RetryPageHandlerOpts {
  trackerDir?: string;
  runRetryPageOverride?: (input: RetryPageBody, opts: { trackerDir?: string }) => Promise<{
    ok: true; page: number; recordsAdded: number; stillFailed: boolean;
  }>;
}

export function buildOcrRetryPageHandler(opts: RetryPageHandlerOpts = {}) {
  const trackerDir = opts.trackerDir;
  return async (input: RetryPageBody): Promise<RetryPageHttpResponse> => {
    if (!input.sessionId || !input.runId || typeof input.pageNum !== "number" || input.pageNum < 1) {
      return { status: 400, body: { ok: false, error: "Missing or invalid sessionId/runId/pageNum" } };
    }
    const key = rowKey(input.sessionId, input.runId);
    if (activeRowKeys.has(key)) {
      return { status: 409, body: { ok: false, error: "Retry already in progress for this row" } };
    }
    activeRowKeys.add(key);
    try {
      const fn = opts.runRetryPageOverride ?? (async (i, o) => {
        const { runOcrRetryPage } = await import("../workflows/ocr/retry-page.js");
        return runOcrRetryPage(i, { trackerDir: o.trackerDir });
      });
      const result = await fn(input, { trackerDir });
      return { status: 200, body: { ok: true, page: result.page, recordsAdded: result.recordsAdded, stillFailed: result.stillFailed } };
    } catch (err) {
      const { RetryPageError } = await import("../workflows/ocr/retry-page.js");
      if (err instanceof RetryPageError) {
        const statusByCode: Record<RetryPageError["code"], 404 | 409 | 410> = {
          "row-not-found": 404,
          "row-not-mutable": 409,
          "image-missing": 410,
          "spec-missing": 400 as 404,  // 400 — but type expects narrowed union; use 404 for "spec missing" too
        };
        const status = err.code === "spec-missing" ? 400 : statusByCode[err.code];
        return { status: status as 400 | 404 | 409 | 410, body: { ok: false, error: err.message } };
      }
      log.error(`[ocr-http] retry-page threw: ${errorMessage(err)}`);
      return { status: 400, body: { ok: false, error: errorMessage(err) } };
    } finally {
      activeRowKeys.delete(key);
    }
  };
}

// ─── POST /api/ocr/reocr-whole-pdf ────────────────────────────

import { isAcceptedDept } from "../workflows/eid-lookup/search.js";
import type { ChildOutcome, WatchChildRunsOpts } from "./watch-child-runs.js";
import type { OcrRequest, OcrResult } from "../ocr/index.js";

export interface ReocrWholePdfBody {
  sessionId: string;
  runId: string;
}
export interface ReocrWholePdfHttpResponse {
  status: 200 | 400 | 404 | 409;
  body: { ok: true; recordCount: number; verifiedCount: number } | { ok: false; error: string };
}
export interface ReocrWholePdfHandlerOpts {
  trackerDir?: string;
  date?: string;
  _emitOverride?: (entry: TrackerEntry) => void;
  _wholePdfOverride?: <U>(req: OcrRequest<U>) => Promise<OcrResult<U>>;
  _loadRosterOverride?: (path: string) => Promise<unknown>;
  _watchChildRunsOverride?: (opts: WatchChildRunsOpts) => Promise<ChildOutcome[]>;
  _enqueueEidLookupOverride?: (
    items: Array<{ name?: string; emplId?: string; itemId: string }>,
  ) => Promise<void>;
}

export function buildOcrReocrWholePdfHandler(opts: ReocrWholePdfHandlerOpts = {}) {
  const trackerDir = opts.trackerDir;
  return async (input: ReocrWholePdfBody): Promise<ReocrWholePdfHttpResponse> => {
    if (!input.sessionId || !input.runId) {
      return { status: 400, body: { ok: false, error: "Missing sessionId/runId" } };
    }
    const key = rowKey(input.sessionId, input.runId);
    if (activeRowKeys.has(key)) {
      return { status: 409, body: { ok: false, error: "Operation already in progress for this row" } };
    }
    activeRowKeys.add(key);
    try {
      const date = opts.date ?? dateLocal();
      const file = join(trackerDir ?? ".tracker", `ocr-${date}.jsonl`);
      if (!existsSync(file)) return { status: 404, body: { ok: false, error: "OCR row not found" } };
      const lines = readFileSync(file, "utf-8").split("\n").filter(Boolean);
      let row: TrackerEntry | null = null;
      for (const line of lines) {
        try {
          const e: TrackerEntry = JSON.parse(line);
          if (e.id === input.sessionId && e.runId === input.runId) row = e;
        } catch { /* tolerate */ }
      }
      if (!row) return { status: 404, body: { ok: false, error: "OCR row not found" } };
      const formType = row.data?.formType as unknown as string | undefined;
      if (!formType) return { status: 400, body: { ok: false, error: "Row missing formType" } };
      const spec = getFormSpec(formType);
      if (!spec) return { status: 400, body: { ok: false, error: `Unknown formType "${formType}"` } };

      const pdfPath = row.data?.pdfPath as unknown as string | undefined;
      if (!pdfPath) return { status: 400, body: { ok: false, error: "Row missing pdfPath" } };
      const rosterPath = (row.data?.rosterPath as unknown as string | undefined) ?? "";

      const { runOcrWholePdf } = await import("../ocr/pipeline.js");
      const ocrResult = await runOcrWholePdf({
        pdfPath,
        arraySchema: spec.ocrArraySchema as never,
        prompt: spec.prompt,
        schemaName: spec.schemaName,
        _override: opts._wholePdfOverride,
      });

      const { loadRoster: realLoadRoster } = await import("../match/index.js");
      const loadRosterFn = opts._loadRosterOverride ?? realLoadRoster;
      const roster = rosterPath ? (await loadRosterFn(rosterPath) as unknown[]) : [];

      let records = (ocrResult.data as unknown[]).map((r) => spec.matchRecord({ record: r, roster: roster as never }));

      // Eid-lookup fan-out (mirror the orchestrator's lookup phase)
      const lookupTargets: Array<{ rec: unknown; index: number; kind: "name" | "verify" }> = [];
      records.forEach((rec, index) => {
        const kind = spec.needsLookup(rec);
        if (kind === "name" || kind === "verify") lookupTargets.push({ rec, index, kind });
      });

      if (lookupTargets.length > 0) {
        const enqueueItems = lookupTargets.map((t) => ({
          record: t.rec,
          index: t.index,
          kind: t.kind,
          itemId: `ocr-whole-${input.runId}-r${t.index}`,
        }));
        if (opts._enqueueEidLookupOverride) {
          await opts._enqueueEidLookupOverride(
            enqueueItems.map((e) => ({
              ...(e.kind === "name"
                ? { name: spec.carryForwardKey(e.record as never) }
                : { emplId: extractEidLocal(e.record) }),
              itemId: e.itemId,
            })),
          );
        } else {
          const { ensureDaemonsAndEnqueue } = await import("../core/daemon-client.js");
          const { eidLookupCrmWorkflow } = await import("../workflows/eid-lookup/index.js");
          const inputs = enqueueItems.map((e) =>
            e.kind === "name"
              ? { name: spec.carryForwardKey(e.record as never) }
              : { emplId: extractEidLocal(e.record), keepNonHdh: true },
          );
          await ensureDaemonsAndEnqueue(eidLookupCrmWorkflow, inputs as never, {}, {
            deriveItemId: () => enqueueItems[0]?.itemId ?? `ocr-whole-fallback-${input.runId}`,
          });
        }

        const { watchChildRuns: realWatchChildRuns } = await import("./watch-child-runs.js");
        const watchChildren = opts._watchChildRunsOverride ?? realWatchChildRuns;
        const outcomes = await watchChildren({
          workflow: "eid-lookup",
          expectedItemIds: enqueueItems.map((e) => e.itemId),
          trackerDir,
          date,
          timeoutMs: 60 * 60_000,
        }).catch(() => [] as ChildOutcome[]);

        const outcomesByItemId = new Map(outcomes.map((o) => [o.itemId, o]));
        for (const enq of enqueueItems) {
          const outcome = outcomesByItemId.get(enq.itemId);
          const idx = enq.index;
          const rec = records[idx] as Record<string, unknown>;
          if (!outcome) {
            if (rec.matchState === "lookup-pending" || rec.matchState === "lookup-running") rec.matchState = "unresolved";
            continue;
          }
          if (enq.kind === "name") {
            const eid = (outcome.data?.emplId ?? "").trim();
            if (outcome.status === "done" && /^\d{5,}$/.test(eid)) {
              if ("employee" in rec) (rec.employee as Record<string, unknown>).employeeId = eid;
              else rec.employeeId = eid;
              rec.matchState = "resolved";
              rec.matchSource = "eid-lookup";
            } else {
              rec.matchState = "unresolved";
            }
          }
          const v = computeVerificationLocal({
            hrStatus: outcome.data?.hrStatus,
            department: outcome.data?.department,
            personOrgScreenshot: outcome.data?.personOrgScreenshot,
          });
          rec.verification = v;
          if (v.state !== "verified") rec.selected = false;
        }
      }

      const verifiedCount = records.filter((r) => {
        const v = (r as Record<string, unknown>).verification as { state?: string } | undefined;
        return v?.state === "verified";
      }).length;

      const emit = opts._emitOverride ?? ((e: TrackerEntry) => trackEvent(e, trackerDir));
      const data = {
        formType,
        pdfOriginalName: (row.data?.pdfOriginalName as unknown as string) ?? "",
        sessionId: input.sessionId,
        ...(row.parentRunId ? { parentRunId: row.parentRunId } : {}),
        recordCount: String(records.length),
        verifiedCount: String(verifiedCount),
        records: JSON.stringify(records),
        failedPages: JSON.stringify([]),
        pageStatusSummary: JSON.stringify({ total: 0, succeeded: 0, failed: 0 }),
      };
      emit({
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id: input.sessionId,
        runId: input.runId,
        ...(row.parentRunId ? { parentRunId: row.parentRunId } : {}),
        status: "running",
        step: "awaiting-approval",
        data,
      });
      emit({
        workflow: WORKFLOW,
        timestamp: new Date().toISOString(),
        id: input.sessionId,
        runId: input.runId,
        ...(row.parentRunId ? { parentRunId: row.parentRunId } : {}),
        status: "done",
        step: "awaiting-approval",
        data,
      });

      return { status: 200, body: { ok: true, recordCount: records.length, verifiedCount } };
    } catch (err) {
      log.error(`[ocr-http] reocr-whole-pdf threw: ${errorMessage(err)}`);
      return { status: 400, body: { ok: false, error: errorMessage(err) } };
    } finally {
      activeRowKeys.delete(key);
    }
  };
}

function extractEidLocal(record: unknown): string {
  const r = record as Record<string, unknown>;
  if (typeof r.employeeId === "string") return r.employeeId;
  const employee = r.employee as Record<string, unknown> | undefined;
  if (employee && typeof employee.employeeId === "string") return employee.employeeId;
  return "";
}

function computeVerificationLocal(d: { hrStatus?: string; department?: string; personOrgScreenshot?: string }): {
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

Update `_resetSessionLockForTests` to also clear `activeRowKeys`:

```ts
export function _resetSessionLockForTests(): void {
  activeSessionIds.clear();
  activeRowKeys.clear();
}
```

- [ ] **Step 4: Run tests**

Run: `npx tsx --test tests/unit/tracker/ocr-http.test.ts`
Expected: all tests pass.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/tracker/ocr-http.ts tests/unit/tracker/ocr-http.test.ts
git commit -m "$(cat <<'EOF'
feat(ocr): retry-page + reocr-whole-pdf HTTP handlers

Two new factories with a per-row mutex (sessionId:runId). Retry-page
delegates to runOcrRetryPage; reocr-whole-pdf runs runOcrWholePdf +
the orchestrator's match/eid-lookup/verification phases inline. Both
emit fresh awaiting-approval tracker entries so the dashboard SSE
picks them up.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Wire endpoints into the dashboard SSE server

**Files:**
- Modify: `src/tracker/dashboard.ts`

Wire the two new factories into the route table next to the existing `/api/ocr/*` routes.

- [ ] **Step 1: Locate the existing OCR route bindings**

Run: `grep -n "/api/ocr/" /Users/julianhein/Documents/hr-automation/src/tracker/dashboard.ts | head -10`

Note the line numbers where the existing OCR handlers are wired. They typically follow a pattern like:

```ts
const ocrPrepareHandler = buildOcrPrepareHandler({ trackerDir });
const ocrApproveHandler = buildOcrApproveHandler({ trackerDir });
// ... in the request router ...
if (req.method === "POST" && url.pathname === "/api/ocr/approve-batch") { ... }
```

- [ ] **Step 2: Add factory instantiations**

In the same setup block as the other OCR handlers, add:

```ts
const ocrRetryPageHandler = buildOcrRetryPageHandler({ trackerDir });
const ocrReocrWholePdfHandler = buildOcrReocrWholePdfHandler({ trackerDir });
```

- [ ] **Step 3: Add route handlers**

In the request router, alongside the existing `/api/ocr/*` POST handlers (`approve-batch`, `discard-prepare`, `force-research`), add:

```ts
if (req.method === "POST" && url.pathname === "/api/ocr/retry-page") {
  const body = await readJsonBody(req);
  const result = await ocrRetryPageHandler(body as never);
  res.writeHead(result.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result.body));
  return;
}
if (req.method === "POST" && url.pathname === "/api/ocr/reocr-whole-pdf") {
  const body = await readJsonBody(req);
  const result = await ocrReocrWholePdfHandler(body as never);
  res.writeHead(result.status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result.body));
  return;
}
```

(`readJsonBody` is the existing helper used by the other POST handlers. Match the local convention exactly — your editor's line-context will show whether it's `await parseJsonBody(req)` or similar.)

Add the imports at the top of `dashboard.ts`:

```ts
import {
  // ... existing imports ...
  buildOcrRetryPageHandler,
  buildOcrReocrWholePdfHandler,
} from "./ocr-http.js";
```

- [ ] **Step 4: Typecheck + manual smoke**

Run: `npm run typecheck`
Expected: clean.

Run: `npm run dashboard` and in another terminal:

```bash
curl -X POST http://localhost:3838/api/ocr/retry-page \
  -H "Content-Type: application/json" \
  -d '{"sessionId":"nonexistent","runId":"abc","pageNum":1}'
```

Expected: a 404 JSON body `{"ok":false,"error":"No OCR row for sessionId=..."}` (the handler tries to load the row and fails). 200 wouldn't make sense without prior state. Stop the dashboard.

- [ ] **Step 5: Commit**

```bash
git add src/tracker/dashboard.ts
git commit -m "$(cat <<'EOF'
feat(ocr): wire retry-page + reocr-whole-pdf endpoints into dashboard

Two new POST routes alongside the existing /api/ocr/* handlers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Frontend `FailedPage` type + parser extension

**Files:**
- Modify: `src/dashboard/components/ocr/types.ts`

Add the type and update the parsers so failed-page data round-trips.

- [ ] **Step 1: Read the existing types file**

Open `src/dashboard/components/ocr/types.ts`. Note the existing exports — likely `parsePrepareRowData`, `parseOathPrepareRowData`, `PreviewRecord`, `OathPreviewRecord`, `Verification`. Match their JSON-parsing pattern (each one calls `JSON.parse(data.records)` with a try/catch).

- [ ] **Step 2: Add the `FailedPage` interface**

At the top of the exports section, add:

```ts
export interface FailedPage {
  page: number;
  error: string;
  attemptedKeys: string[];
  pageImagePath: string;
  attempts: number;
}

export interface PageStatusSummary {
  total: number;
  succeeded: number;
  failed: number;
}
```

- [ ] **Step 3: Extend the parsed-row interfaces and parsers**

Find the interfaces returned by `parsePrepareRowData` and `parseOathPrepareRowData` (likely named `PrepareRowData` and `OathPrepareRowData`). Add optional fields:

```ts
export interface PrepareRowData {
  // ... existing fields ...
  failedPages?: FailedPage[];
  pageStatusSummary?: PageStatusSummary;
}

export interface OathPrepareRowData {
  // ... existing fields ...
  failedPages?: FailedPage[];
  pageStatusSummary?: PageStatusSummary;
}
```

In each parser body (mirror the existing `records` parsing pattern), add:

```ts
let failedPages: FailedPage[] | undefined;
try {
  if (typeof data.failedPages === "string") {
    const parsed = JSON.parse(data.failedPages);
    if (Array.isArray(parsed)) failedPages = parsed as FailedPage[];
  }
} catch { /* tolerate */ }

let pageStatusSummary: PageStatusSummary | undefined;
try {
  if (typeof data.pageStatusSummary === "string") {
    const parsed = JSON.parse(data.pageStatusSummary);
    if (parsed && typeof parsed.total === "number") pageStatusSummary = parsed as PageStatusSummary;
  }
} catch { /* tolerate */ }
```

Include them in the returned object:

```ts
return {
  // ... existing fields ...
  failedPages,
  pageStatusSummary,
};
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/components/ocr/types.ts
git commit -m "$(cat <<'EOF'
feat(ocr-ui): FailedPage type + parser extension

Tracker rows now carry data.failedPages (JSON-stringified) and
data.pageStatusSummary. Frontend parses them into typed shapes for
OcrReviewPane to consume.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `FailedPageCard.tsx` component

**Files:**
- Create: `src/dashboard/components/ocr/FailedPageCard.tsx`
- Reference: `src/dashboard/components/ocr/PrepReviewFormCard.tsx` for the card framing pattern

Renders one failed page with the retry button.

- [ ] **Step 1: Create the component**

```tsx
import { useState } from "react";
import { Loader2, AlertCircle, RefreshCw, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { FailedPage } from "./types";

export interface FailedPageCardProps {
  failedPage: FailedPage;
  totalPages: number;
  sessionId: string;
  runId: string;
  onRetryComplete?: () => void;
}

const PROVIDER_LABELS: Record<string, string> = {
  gemini: "Gemini",
  mistral: "Mistral",
  groq: "Groq",
  sambanova: "Sambanova",
};

function providerFamily(keyId: string): string {
  const dash = keyId.indexOf("-");
  return dash >= 0 ? keyId.slice(0, dash) : keyId;
}

export function FailedPageCard({ failedPage, totalPages, sessionId, runId, onRetryComplete }: FailedPageCardProps) {
  const [retrying, setRetrying] = useState(false);
  const [skipped, setSkipped] = useState(false);

  async function handleRetry() {
    if (retrying) return;
    setRetrying(true);
    try {
      const r = await fetch("/api/ocr/retry-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, runId, pageNum: failedPage.page }),
      });
      const body = await r.json() as { ok: boolean; recordsAdded?: number; stillFailed?: boolean; error?: string };
      if (!r.ok || !body.ok) {
        toast.error(`Page ${failedPage.page} retry failed`, { description: body.error ?? `HTTP ${r.status}` });
      } else if (body.stillFailed) {
        toast.warning(`Page ${failedPage.page} retry still failed`, { description: body.error ?? "All providers exhausted" });
      } else {
        toast.success(`Page ${failedPage.page} OCR succeeded`, {
          description: `${body.recordsAdded} record${body.recordsAdded === 1 ? "" : "s"} added`,
        });
        onRetryComplete?.();
      }
    } catch (err) {
      toast.error(`Page ${failedPage.page} retry failed`, {
        description: err instanceof Error ? err.message : "Network error",
      });
    } finally {
      setRetrying(false);
    }
  }

  const triedFamilies = Array.from(new Set(failedPage.attemptedKeys.map(providerFamily)));

  return (
    <div className={cn(
      "mx-4 my-3 rounded-md border bg-card p-4",
      skipped ? "border-border/40 opacity-50" : "border-destructive/40",
    )}>
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold">
              Page {failedPage.page} of {totalPages} in pile · OCR failed
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              Tried {failedPage.attempts}×
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{failedPage.error}</p>
          {triedFamilies.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {triedFamilies.map((family) => (
                <span
                  key={family}
                  className="rounded-md border border-border bg-secondary px-1.5 py-px font-mono text-[10px] uppercase text-muted-foreground"
                >
                  {PROVIDER_LABELS[family] ?? family}
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleRetry}
              disabled={retrying || skipped}
              className={cn(
                "inline-flex h-7 items-center gap-1.5 rounded-md border border-primary bg-primary px-3 text-xs font-semibold text-primary-foreground",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              {retrying ? "Retrying…" : "Retry page"}
            </button>
            <button
              type="button"
              onClick={() => setSkipped((s) => !s)}
              disabled={retrying}
              className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <EyeOff className="h-3 w-3" />
              {skipped ? "Unskip" : "Skip page"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/components/ocr/FailedPageCard.tsx
git commit -m "$(cat <<'EOF'
feat(ocr-ui): FailedPageCard component

Inline card for a failed OCR page — error message, attempt count,
attempted-providers chips, Retry button (POSTs to
/api/ocr/retry-page), Skip button (local visual ack only).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Integrate failed-page cards + Re-OCR button into `OcrReviewPane`

**Files:**
- Modify: `src/dashboard/components/ocr/OcrReviewPane.tsx`

Inline failed pages by `sourcePage`, add the Re-OCR-whole-PDF header button + confirm dialog, update the summary string.

- [ ] **Step 1: Extend the grouped-render to interleave failed pages**

Locate the `grouped` `useMemo` (currently around lines 126-134):

```ts
const grouped = useMemo(() => {
  const map = new Map<number, Array<{ record: AnyPreviewRecord; originalIndex: number }>>();
  records.forEach((r, originalIndex) => {
    const page = (r as { sourcePage: number }).sourcePage;
    if (!map.has(page)) map.set(page, []);
    map.get(page)!.push({ record: r, originalIndex });
  });
  return Array.from(map.entries()).sort(([a], [b]) => a - b);
}, [records]);
```

Replace with a unified render-list that includes both successful page groups and failed-page entries, sorted by page number:

```ts
type PageRender =
  | { kind: "records"; page: number; group: Array<{ record: AnyPreviewRecord; originalIndex: number }> }
  | { kind: "failed"; page: number; failedPage: FailedPage };

const failedPages = data?.failedPages ?? [];

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

const totalPages = data?.pageStatusSummary?.total ?? renderList.length;
```

Add the import at the top:

```ts
import { FailedPageCard } from "./FailedPageCard";
import type { FailedPage } from "./types";
```

In the scroll-body JSX (currently iterating `grouped.map(([page, group]) => ...)`), replace with:

```tsx
{renderList.map((entry) => {
  if (entry.kind === "failed") {
    return (
      <FailedPageCard
        key={`failed-${entry.page}`}
        failedPage={entry.failedPage}
        totalPages={totalPages}
        sessionId={entry.id /* see note below */}
        runId={runId}
      />
    );
  }
  // ... existing records-rendering logic from `grouped.map`, using entry.page + entry.group ...
})}
```

The `sessionId` for `FailedPageCard` comes from the parent's `entry.id` (`OcrReviewPane`'s `entry: TrackerEntry` prop). Capture that once at the top:

```ts
const sessionId = entry.id;
```

- [ ] **Step 2: Add the Re-OCR-whole-PDF header button + confirm dialog**

Where the header currently renders the Cancel + Approve buttons (around lines 225-244), inject a Re-OCR button when there are failed pages. Use the existing Radix `Dialog` primitive in `components/ui/dialog.tsx`.

Add imports:

```ts
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { FileScan } from "lucide-react";
```

In the header `<div className="flex items-center gap-3">`, *before* the Cancel button, add:

```tsx
{failedPages.length > 0 && (
  <ReocrWholePdfButton
    sessionId={sessionId}
    runId={runId}
    storageKey={storageKey}
  />
)}
```

Add the component at the bottom of the file (above `isApprovable` etc.):

```tsx
function ReocrWholePdfButton({ sessionId, runId, storageKey }: { sessionId: string; runId: string; storageKey: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    setBusy(true);
    try {
      const r = await fetch("/api/ocr/reocr-whole-pdf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, runId }),
      });
      const body = await r.json() as { ok: boolean; recordCount?: number; error?: string };
      if (!r.ok || !body.ok) {
        toast.error("Re-OCR failed", { description: body.error ?? `HTTP ${r.status}` });
      } else {
        toast.success("Re-OCR complete", { description: `${body.recordCount} record${body.recordCount === 1 ? "" : "s"} extracted` });
        window.localStorage.removeItem(storageKey);
        setOpen(false);
      }
    } catch (err) {
      toast.error("Re-OCR failed", { description: err instanceof Error ? err.message : "Network error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-muted-foreground hover:bg-muted"
        >
          <FileScan className="h-3 w-3" />
          Re-OCR whole PDF
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Re-OCR the whole PDF?</DialogTitle>
          <DialogDescription>
            This sends the full PDF to Gemini in one call and replaces the records on this row.
            All per-record edits will be discarded. Use only when many pages have failed and per-page retry isn't recovering.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            type="button"
            onClick={() => setOpen(false)}
            disabled={busy}
            className="h-8 rounded-md border border-border px-3 text-xs text-muted-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-primary bg-primary px-3 text-xs font-semibold text-primary-foreground disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3 w-3 animate-spin" />}
            {busy ? "Re-running…" : "Re-OCR whole PDF"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Update the summary string**

In `describeSummary` (the existing function around line 332-355), accept failed pages as an optional second arg and append them to the parts list. Find the function definition and replace with:

```ts
function describeSummary(records: AnyPreviewRecord[], failedPageCount = 0): string {
  let verified = 0;
  let needsReview = 0;
  let toRemove = 0;
  for (const r of records) {
    if (r.documentType === "unknown") { toRemove += 1; continue; }
    if (r.verification && r.verification.state !== "verified") { needsReview += 1; continue; }
    if (r.matchState !== "matched" && r.matchState !== "resolved") { needsReview += 1; continue; }
    verified += 1;
  }
  const parts: string[] = [`${verified} verified`];
  if (needsReview > 0) parts.push(`${needsReview} needs review`);
  if (toRemove > 0) parts.push(`${toRemove} to remove`);
  if (failedPageCount > 0) parts.push(`${failedPageCount} page${failedPageCount === 1 ? "" : "s"} failed`);
  return parts.join(" · ");
}
```

Update the `summary` line where it's called:

```ts
const summary = describeSummary(records, failedPages.length);
```

- [ ] **Step 4: Manual smoke test**

Run: `npm run dashboard`. Open http://localhost:5173.

Then in another terminal, simulate a failed-pages row by appending a stub entry to today's OCR JSONL:

```bash
DATE=$(date +%Y-%m-%d)
cat <<EOF >> .tracker/ocr-${DATE}.jsonl
{"workflow":"ocr","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","id":"smoke-test","runId":"smoke-1","status":"done","step":"awaiting-approval","data":{"formType":"oath","pdfPath":"/tmp/fake.pdf","pdfOriginalName":"smoke.pdf","sessionId":"smoke-test","recordCount":"1","verifiedCount":"0","records":"[{\"sourcePage\":1,\"rowIndex\":0,\"printedName\":\"Test User\",\"employeeSigned\":true,\"officerSigned\":true,\"dateSigned\":\"05/01/2026\",\"notes\":[],\"documentType\":\"expected\",\"originallyMissing\":[],\"matchState\":\"unresolved\",\"selected\":false,\"warnings\":[]}]","failedPages":"[{\"page\":2,\"error\":\"All providers throttled\",\"attemptedKeys\":[\"gemini-1\",\"mistral-1\"],\"pageImagePath\":\"/tmp/missing.png\",\"attempts\":3}]","pageStatusSummary":"{\"total\":2,\"succeeded\":1,\"failed\":1}"}}
EOF
```

In the dashboard:
1. Click the OCR workflow tab
2. Find the `smoke.pdf` row → click into Review
3. Verify the failed page card appears between page 1 (or wherever) and page 2's expected position
4. Verify "1 page failed" appears in the summary
5. Verify the `Re-OCR whole PDF` button appears in the header
6. Click `Retry page` — it'll fail with a network error (the stub PNG path doesn't exist), but the loading + toast UX should work

Cleanup:

```bash
sed -i '' '/smoke-test/d' .tracker/ocr-${DATE}.jsonl
```

Stop the dashboard.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/components/ocr/OcrReviewPane.tsx
git commit -m "$(cat <<'EOF'
feat(ocr-ui): inline failed-page cards + Re-OCR-whole-PDF escape hatch

OcrReviewPane now interleaves FailedPageCard with successful page
groups (sorted by page number), shows a 'Re-OCR whole PDF' confirm
dialog when failedPages.length > 0, and includes the failed-page count
in the header summary.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: End-to-end manual smoke test

**Files:** none (operator-driven verification)

- [ ] **Step 1: Force a real per-page failure**

Set up the env so per-page is forced to fail on at least one page. Easiest: in `.env`, temporarily reduce the pool to one provider with a soon-to-be-revoked key:

```bash
# In .env, comment out all but one provider, e.g. keep only GEMINI_API_KEY
# Then in the dashboard run, set OCR_PER_PAGE_MAX_RETRIES=0 so a single
# failure marks the page failed without retry across alternates.
echo "OCR_PER_PAGE_MAX_RETRIES=0" >> .env
```

Add a temporary throw inside `src/ocr/per-page-pool.ts` at the top of `callGemini` to fail page 2 deterministically:

```ts
async function callGemini(apiKey: string, imagePath: string, prompt: string): Promise<unknown> {
  if (imagePath.endsWith("page-02.png")) throw new Error("simulated provider failure");
  // ... existing body ...
}
```

- [ ] **Step 2: Run the workflow**

Start the dashboard: `npm run dashboard`. Upload a multi-page PDF (oath or emergency-contact form) via the OCR run modal. Wait for it to reach `awaiting-approval`.

- [ ] **Step 3: Verify**

In the OCR review pane:
- The failed page card for page 2 appears inline between pages 1 and 3.
- The header shows `... · 1 page failed`.
- The `Re-OCR whole PDF` button is visible next to Cancel.

Click `Retry page`:
- Spinner appears in the button.
- Remove the temporary throw in `per-page-pool.ts` between clicks (or reduce the throw probability) so the second attempt succeeds.
- Toast `Page 2 OCR succeeded` appears.
- Failed page card disappears; new records for page 2 render in their position.
- Summary updates to remove the `· 1 page failed` part.

- [ ] **Step 4: Revert the temporary changes**

Remove the throw from `per-page-pool.ts`. Remove `OCR_PER_PAGE_MAX_RETRIES=0` from `.env`. Re-enable the other provider keys.

- [ ] **Step 5: Run the full test suite**

Run: `npm run test`
Expected: all tests pass.

Run: `npm run typecheck:all`
Expected: clean.

- [ ] **Step 6: Update OCR module CLAUDE.md**

Add a Lessons Learned entry to `src/ocr/CLAUDE.md` documenting the change:

```markdown
- **2026-05-01: Per-page is the only auto path.** `runOcrPipeline` no longer falls back to whole-PDF on partial failure (`<50%` ratio branch removed). Failed pages propagate up via `pages[]` in the result; the orchestrator surfaces them as `data.failedPages` on the awaiting-approval row. Whole-PDF lives in `runOcrWholePdf` and is only reached via the operator-initiated `/api/ocr/reocr-whole-pdf` endpoint. Retry-page is a single-page mini-orchestrator at `src/workflows/ocr/retry-page.ts`.
```

- [ ] **Step 7: Commit**

```bash
git add src/ocr/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(ocr): record the per-page-only + retry-page architecture

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review checklist (skip if all items ✓)

- ✓ **Spec coverage:** All four spec goals (per-page default, surfaced failures, manual retry, manual whole-PDF) have at least one task.
- ✓ **Placeholders:** No TBDs; every code step contains executable code.
- ✓ **Type consistency:** `FailedPage`, `PageStatusSummary`, `runOcrRetryPage`, `RetryPageError`, `buildOcrRetryPageHandler`, `buildOcrReocrWholePdfHandler`, and `runOcrWholePdf` are spelled identically across tasks.
- ✓ **Test coverage:** Pipeline (Task 1), orchestrator (Task 2), retry-page primitive (Task 3), HTTP handlers + mutex (Task 4) each get unit tests.
- ✓ **Frontend:** No automated frontend tests (project lacks the harness — see dashboard CLAUDE.md). Task 8 includes a manual smoke step; Task 9 is a full e2e smoke.
