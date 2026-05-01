# OCR Workflow + Delegation Primitive — Design Spec

**Date:** 2026-05-01
**Status:** Draft (pending user review)
**Scope:** Piece 1+2 of the larger OCR/oath-upload arc. Piece 3 (`oath-upload` workflow) is a separate spec.

## Background

Today, `src/workflows/oath-signature/prepare.ts` and `src/workflows/emergency-contact/prepare.ts` each contain ~600 lines of near-duplicate orchestration: load roster → run OCR → match records → fan out to eid-lookup daemon → watch eid-lookup JSONL for completions → emit progressive tracker updates → terminate when all records resolved. The two files differ in form-specific bits (oath has signed/unsigned column semantics; emergency-contact does form-EID-first then roster-name match plus address comparison) but share their orchestration skeleton verbatim, including the `fs.watch` + 200ms polling JSONL watcher.

The dashboard's "Run" button + run modal + preview pane currently belongs to emergency-contact (`TopBarRunButton.tsx` is hardcoded to that workflow). Per-record edit form components (`OathReviewForm`, `EcReviewForm`) and the prep row container (`PreviewRow`) live at the top level of `src/dashboard/components/`, with conditional logic switching on `entry.workflow === "oath-signature"` vs `"emergency-contact"`.

A new `oath-upload` workflow (Piece 3, separate spec) will need this same OCR-with-preview-and-approval flow as a *delegated step* inside its own handler — it cannot just duplicate the prep code a third time.

## Goals

1. **Eliminate duplication.** Consolidate orchestration into a single home so adding a third or fourth consumer is one new file, not 600 new lines.
2. **First-class delegation.** Workflows that depend on another workflow's completion get a documented primitive (`watchChildRuns`) and dashboard visualization (`parentRunId` pills + expandable parent rows showing children).
3. **OCR as a real surface.** OCR gets its own dashboard tab, run modal, queue rows, preview pane, and HTTP endpoints — the operator interacts with it as a peer of oath-signature / emergency-contact, not a hidden phase inside them.
4. **Re-upload that remembers.** Operators who hand-correct paper and rescan get carry-forward of resolved EIDs + verifications + edits from the prior run, so v2 only does fresh work for genuinely new content.
5. **Per-row force-research.** Operators who notice an OCR misread on one row can fix the name and re-run that row's eid-lookup without rerunning anything else.

## Non-goals

- Changing `oath-signature` or `emergency-contact` *kernel* behavior (the per-EID UCPath transactions stay byte-identical).
- Replacing the OCR content-addressed cache (`.ocr-cache/`). The carry-forward layer sits above it.
- Adding daemon mode to OCR. OCR has no browser, no Duo; it runs in the dashboard's Node process via a fire-and-forget `runWorkflow` call (same shape as `sharepoint-download`).
- Migrating in-flight edits in operators' browsers across the deploy. We deploy at end-of-day; operators with a preview row open will lose unsaved edits and must re-upload.
- Building Piece 3 (`oath-upload`). This spec only ensures Piece 3's primitives exist and are demonstrably correct.

## Architecture overview

A new directory `src/workflows/ocr/` declares a kernel-registered workflow `ocr` with empty `systems[]`. The orchestrator lives at `src/workflows/ocr/orchestrator.ts` and consolidates today's two `prepare.ts` files. Form-specific knowledge (Zod schemas, OCR prompts, per-record preview component, fan-out adapters) stays in the consumer workflows under new files `src/workflows/{oath-signature,emergency-contact}/ocr-form.ts`. OCR imports both via a single registry at `src/workflows/ocr/form-registry.ts`.

The duplicate JSONL-watch code in today's two `prepare.ts` files is hoisted into `src/tracker/watch-child-runs.ts`. OCR's eid-lookup watch + force-research watch + Piece 3's wait-on-oath-signature all use this single helper.

Tracker entries gain an optional `parentRunId` field (top-level, alongside `runId`) used purely for dashboard navigation. Watching is itemId-based, not parentRunId-based — the spawner stamps deterministic itemIds and the watcher waits for those exact ids to terminate. parentRunId enables the dashboard to render "↗ from <workflow> #N" pills on child rows and "↗ N children" expandable sections on parent rows.

OCR is *not* daemon-mode. `POST /api/ocr/prepare` calls `runWorkflow(ocrWorkflow, input)` fire-and-forget from the dashboard's Node process, returns 202 with `{sessionId, runId}`. The orchestrator emits its own progressive tracker events; the kernel wrapper emits the final `done` when the handler returns at `step: "awaiting-approval"`. Approve/discard/reupload are HTTP endpoints that emit subsequent tracker events on the same `id` (sessionId).

## OCR workflow shape

```ts
// src/workflows/ocr/workflow.ts
defineWorkflow({
  name: "ocr",
  label: "OCR",
  systems: [],                              // first kernel workflow with no systems
  authSteps: false,
  steps: [
    "loading-roster",
    "ocr",
    "matching",
    "eid-lookup",
    "verification",
    "awaiting-approval",
  ] as const,
  schema: OcrInputSchema,
  authChain: "sequential",
  tiling: "single",
  detailFields: [
    { key: "formType",         label: "Form" },
    { key: "pdfOriginalName",  label: "PDF" },
    { key: "recordCount",      label: "Records" },
    { key: "verifiedCount",    label: "Verified" },
  ],
  getName: (d) => d.pdfOriginalName ?? "(unnamed)",
  getId:   (d) => d.sessionId ?? "",
  handler: ocrKernelHandler,                // thin wrapper over runOcrOrchestrator
});

// Thin wrapper so the kernel's `ctx` plumbing (markStep, updateData,
// screenshotOnFail, etc.) is in scope for the orchestrator. The orchestrator
// itself is exported separately as a plain async function for testability.
async function ocrKernelHandler(ctx: Ctx, input: OcrInput): Promise<void> {
  await runOcrOrchestrator(input, { ctx });
}
```

```ts
// src/workflows/ocr/schema.ts
export const OcrInputSchema = z.object({
  pdfPath:          z.string(),
  pdfOriginalName:  z.string(),
  formType:         z.string(),                 // matches a key in FORM_SPECS
  sessionId:        z.string(),                 // = the row's id
  rosterPath:       z.string().optional(),      // resolved before kernel handler runs
  parentRunId:      z.string().optional(),      // who delegated to me (for visual)
  previousRunId:    z.string().optional(),      // reupload chain
  forceResearchAll: z.boolean().optional(),     // initial-run flag, rare
});
```

**Key shape decisions:**
- `systems: []` + `authSteps: false`: OCR is the first kernel workflow with no browsers. Kernel must handle empty systems (smoke test in implementation; small patch if needed — see "Risks" below).
- `id = sessionId`: stable across reuploads. Each Run/Reupload is a new `runId` under the same `id`. Dashboard's RunSelector pills surface the v1/v2/v3 chain.
- `awaiting-approval` is a step name, not a status. Handler ends at `markStep("awaiting-approval")`; kernel wrapper writes `status: done, step: "awaiting-approval"`. The dashboard's preview row interprets step to know whether the row needs operator action.
- `forceResearchAll`: rarely used initial-run flag for the case where the operator wants to bypass any cache and force fresh OCR + eid-lookup on the first upload. Most invocations omit it.

**Orchestrator pseudo:**

```ts
// src/workflows/ocr/orchestrator.ts
export async function runOcrOrchestrator(
  input: OcrInput,
  opts: OcrOrchestratorOpts,                    // tracker dir override, OCR fn override for tests
): Promise<void> {
  const spec = getFormSpec(input.formType);
  if (!spec) throw new Error(`Unknown formType: ${input.formType}`);

  emit("running", { step: "loading-roster" });
  const roster = await loadRoster(input.rosterPath);

  emit("running", { step: "ocr" });
  const ocrResult = await runOcrPipeline({
    pdfPath:        input.pdfPath,
    pageImagesDir:  resolvePageImagesDir(input.sessionId, input.runId),
    recordSchema:   spec.ocrRecordSchema,
    arraySchema:    spec.ocrArraySchema,
    prompt:         spec.prompt,
    schemaName:     spec.schemaName,
  });

  emit("running", { step: "matching" });
  const records = ocrResult.data.map((r) => spec.matchRecord({ record: r, roster }));

  // Carry-forward (if reupload)
  if (input.previousRunId) {
    applyCarryForward(records, input.previousRunId, spec);
  }

  emit("running", { step: "eid-lookup", recordCount: records.length });
  const lookupTargets = records
    .map((r, i) => ({ record: r, index: i, kind: spec.needsLookup(r) }))
    .filter((t) => t.kind !== null);
  if (lookupTargets.length > 0) {
    await fanOutAndWatchEidLookup(lookupTargets, records);
  }

  emit("running", { step: "verification", verifiedCount: countVerified(records) });
  // verification is computed from eid-lookup data already; this step is a no-op marker

  emit("running", { step: "awaiting-approval", records });
  // handler returns; kernel wrapper writes status: done, step: awaiting-approval
}
```

The orchestrator is a plain async function for testability. The kernel handler `ocrKernelHandler` is a thin wrapper that calls it inside the existing `ctx` plumbing (so `ctx.markStep`, `ctx.updateData`, screenshot-on-fail, etc. all work). HTTP handlers can call `runOcrOrchestrator` directly when they don't want the kernel wrapping (e.g. reupload that's just an in-process new run).

## Form-type spec contract

```ts
// src/workflows/ocr/types.ts

export interface OcrFormSpec<TOcr, TPreview, TFanOut> {
  formType:    string;                                    // "oath", "emergency-contact"
  label:       string;                                    // shown in run modal picker
  description: string;                                    // shown under picker option

  prompt:           string;                               // OCR prompt
  ocrRecordSchema:  ZodType<TOcr>;                        // single-record (LLM-permissive)
  ocrArraySchema:   ZodType<TOcr[]>;                      // = z.array(ocrRecordSchema)
  schemaName:       string;                               // OCR cache key segment

  /** Pure: take an OCR record + roster, return the preview record + initial matchState. */
  matchRecord(input: { record: TOcr; roster: RosterRow[] }): TPreview;

  /** Whether this preview record needs an eid-lookup pass. */
  needsLookup(record: TPreview): "name" | "verify" | null;

  /** Carry-forward fuzzy-match key (default impl uses Levenshtein over this string). */
  carryForwardKey(record: TPreview): string;

  /** Approve fan-out target. */
  approveTo: {
    workflow:        string;                              // "oath-signature", "emergency-contact"
    deriveInput:     (record: TPreview) => TFanOut;
    deriveItemId:    (record: TPreview, parentRunId: string, index: number) => string;
  };

  /** React component reference for per-record preview rendering. */
  recordRendererId: "OathRecordView" | "EcRecordView" | (string & {});

  /** Whether to require a roster on disk before starting OCR. */
  rosterMode: "required" | "optional";
}
```

**Per-form spec files:**
- `src/workflows/oath-signature/ocr-form.ts` exports `oathOcrFormSpec`. Inlines the schemas previously in `preview-schema.ts`. Replaces today's `preview-schema.ts`; that file is deleted.
- `src/workflows/emergency-contact/ocr-form.ts` exports `emergencyContactOcrFormSpec`. Same — replaces today's `preview-schema.ts`.

**Registry:**
```ts
// src/workflows/ocr/form-registry.ts
import { oathOcrFormSpec } from "../oath-signature/ocr-form.js";
import { emergencyContactOcrFormSpec } from "../emergency-contact/ocr-form.js";

export const FORM_SPECS = {
  oath:                oathOcrFormSpec,
  "emergency-contact": emergencyContactOcrFormSpec,
} as const;

export type FormType = keyof typeof FORM_SPECS;
export function getFormSpec(formType: string): OcrFormSpec<any, any, any> | null {
  return (FORM_SPECS as Record<string, OcrFormSpec<any, any, any>>)[formType] ?? null;
}
```

The orchestrator, the run modal's `GET /api/ocr/forms` endpoint, and the approve-batch fan-out logic all consume the registry. Adding a new form type is one new `ocr-form.ts` file in the consumer workflow + one line in the registry + one new record renderer component in `src/dashboard/components/ocr/`.

## Re-upload + carry-forward

**Identity.** OCR row's `id` = `sessionId` (stable). Each Run/Reupload is a new `runId` under the same `id`. Reupload writes `status: failed, step: "superseded"` to old runId's last event, opens a new pending row with same `id`, new `runId`, `data.previousRunId = <old runId>`.

**Carry-forward step** — runs at end of `matching`, before `eid-lookup` fan-out. Only if `data.previousRunId` is set:

1. Load v1's records: read previousRunId's last entry (`data.records`).
2. Build a map `oldKeyToRecord: Map<string, TPreview>` keyed by `spec.carryForwardKey(r)` over v1 records.
3. For each new v2 record, compute `spec.carryForwardKey(v2)` and fuzzy-match (Levenshtein ≤ 2 on normalized key) against the v1 keys.
4. If best v1 candidate within threshold AND candidate's `forceResearch !== true`: inherit `employeeId`, `matchState`, `matchSource`, `matchConfidence`, `verification`, `selected`, `addressMatch` (when present).
5. Carried-forward records get `spec.needsLookup(r) = null` because employeeId is already populated and verification exists.
6. v1 records with no v2 match → dropped (operator scribbled them out, etc.).
7. v2 records with no v1 match → standard eid-lookup path.

**Operator edits** persist across reuploads via `localStorage["ocr-edits:<sessionId>"]` — single namespace, keyed by sessionId not runId. Cleared on approve/discard. Replaces today's `oath-prep-edits:*` and `ec-prep-edits:*` keys.

## Force-research

Per-row ↻ button + bulk toolbar. Force-research = drop matchState/employeeId/verification, re-trigger eid-lookup using current (possibly operator-edited) record data. Distinct from reupload: same PDF, same OCR text, just re-do the EID-lookup phase.

`POST /api/ocr/force-research`:
```ts
{ sessionId: string, runId: string, recordIndices: number[] }
```

Server:
1. Reads current OCR row (latest entry for `sessionId+runId`).
2. For each record at `recordIndices`: drops `employeeId`, `matchState ← "lookup-pending"`, `verification ← undefined`, `matchSource`, `matchConfidence`. Sets `forceResearch: true` (so next reupload skips this row's carry-forward).
3. Writes a `running, step: "eid-lookup"` tracker event with patched records.
4. Triggers eid-lookup fan-out for those records via `ensureDaemonsAndEnqueue` against the eid-lookup workflow with deterministic itemIds (`ocr-force-<sessionId>-<runId>-r<index>`).
5. Calls `watchChildRuns({ workflow: "eid-lookup", expectedItemIds: [...], onProgress })` to patch records back as each resolves.
6. When all targeted records terminal → final `running, step: "awaiting-approval"` event.

## Delegation primitive

**TrackerEntry** (in `src/tracker/jsonl.ts`):

```ts
interface TrackerEntry {
  workflow: string;
  timestamp: string;
  id: string;
  runId: string;
  parentRunId?: string;                                   // NEW — visual navigation
  status: "pending" | "running" | "done" | "failed" | "skipped";
  step?: string;
  data?: Record<string, string>;
  error?: string;
}
```

`parentRunId` is additive — old entries lack it, dashboard treats absence as "no parent." Stamped by spawners; never used for filtering in the watcher.

**`src/tracker/watch-child-runs.ts`:**

```ts
export interface ChildOutcome {
  workflow: string;
  itemId: string;
  runId: string;
  status: "done" | "failed";
  data?: Record<string, string>;
  error?: string;
}

export interface WatchChildRunsOpts {
  workflow:        string;
  expectedItemIds: string[];
  trackerDir?:     string;
  date?:           string;                                // YYYY-MM-DD; default today
  timeoutMs?:      number;                                // default 1h
  isTerminal?:     (entry: TrackerEntry) => boolean;      // default: status in {done,failed}
  onProgress?:     (outcome: ChildOutcome, remaining: number) => void;
}

export async function watchChildRuns(opts: WatchChildRunsOpts): Promise<ChildOutcome[]>;
```

Implementation: lift the fs.watch + 200ms polling + size-based JSONL re-scan + per-id terminal detection from today's `emergency-contact/prepare.ts::resolveEidsAsync` and `oath-signature/prepare.ts::resolveEidsAsync`. Generic over workflow name and terminal predicate. Both today's prepare files are deleted; OCR's orchestrator and force-research handler call this single function.

**Approval-gate variant** for parent workflows waiting on OCR (Piece 3 will use this):

```ts
await watchChildRuns({
  workflow: "ocr",
  expectedItemIds: [ocrSessionId],
  isTerminal: (e) =>
    (e.status === "done"   && e.step === "approved") ||
    (e.status === "failed" && (e.step === "discarded" || e.step === "superseded")),
});
```

## Dashboard surfaces

**TopBar.** New tab "OCR" auto-registers via `defineWorkflow`'s registry hook. `TopBarRunButton` becomes workflow-aware:

```ts
const RUN_ENABLED_WORKFLOWS = ["ocr"]; // expand to ["ocr", "oath-upload"] in Piece 3
function shouldShowRun(activeWorkflow: string): boolean {
  return RUN_ENABLED_WORKFLOWS.includes(activeWorkflow);
}
```

`RunModal` accepts a `workflow` prop and adapts:
- `workflow="ocr"`: form-type picker (loaded from `GET /api/ocr/forms`), PDF dropzone, roster picker (only when picked spec.rosterMode === "required").
- `workflow="oath-upload"` (Piece 3): no form-type picker (hardcoded to "oath" passed to OCR internally), PDF dropzone, no roster picker (oath-upload uses the oath-signature roster path).

**File moves** (single commit, mechanical — NO content change beyond imports + naming):
- `src/dashboard/components/PreviewRow.tsx`         → `src/dashboard/components/ocr/OcrQueueRow.tsx`
- `src/dashboard/components/PrepReviewPane.tsx`     → `src/dashboard/components/ocr/OcrReviewPane.tsx`
- `src/dashboard/components/OathReviewForm.tsx`     → `src/dashboard/components/ocr/OathRecordView.tsx`
- `src/dashboard/components/EcReviewForm.tsx`       → `src/dashboard/components/ocr/EcRecordView.tsx`
- `src/dashboard/components/PrepReviewPair.tsx`     → `src/dashboard/components/ocr/`
- `src/dashboard/components/PrepReviewMultiPair.tsx`→ `src/dashboard/components/ocr/`
- `src/dashboard/components/PrepReviewFormCard.tsx` → `src/dashboard/components/ocr/`
- `src/dashboard/components/preview-types.ts`       → `src/dashboard/components/ocr/types.ts` (consolidate with `oath-preview-types.ts`)
- `src/dashboard/components/oath-preview-types.ts`  → folded into `src/dashboard/components/ocr/types.ts`

**Discriminator change.** `OcrQueueRow` renders for `entry.workflow === "ocr"` (replacing today's `data.mode === "prepare"` check). Old EC/oath rows in pre-migration JSONL render as plain `EntryItem` with no special pane.

**Per-row UI additions** (in `OcrReviewPane`'s record list):
- Per-row ↻ refresh icon button (left of name).
- Per-row Reupload button at parent-row level (not per-record — reupload is whole-PDF).
- Toolbar: "↻ Re-research selected (N)" + "↻ Re-research all".
- Force-researched rows show a faint pulsing dot until eid-lookup terminates.

**Delegation rendering.**
- Child rows: `↗ from <workflow> #<runOrdinal>` pill in `EntryItem` header. Click → switch tab + select parent.
- Parent rows: in `LogPanel` detail, new "Delegated runs" section above `StepPipeline`. Renders each child as a mini-`EntryItem` with status badge + click-through. Section auto-collapses if no children.
- For OCR row in awaiting-approval state: `LogPanel` right pane swaps `StepPipeline` for `OcrReviewPane`. (Same condition today's `PrepReviewPane` uses, generalized.)

**ApprovalInbox rule change.** From `data.mode === "prepare" && status === "done" && step !∈ {approved, discarded}` to `workflow === "ocr" && status === "done" && step === "awaiting-approval"`. Single-line change in `buildPreviewInboxHandler`.

## HTTP endpoints + capture migration

**Delete** (6 routes + 2 files):
- `POST /api/oath-signature/prepare`
- `POST /api/oath-signature/approve-batch`
- `POST /api/oath-signature/discard-prepare`
- `POST /api/emergency-contact/prepare`
- `POST /api/emergency-contact/approve-batch`
- `POST /api/emergency-contact/discard-prepare`
- `src/tracker/oath-signature-http.ts`
- `src/tracker/emergency-contact-http.ts`

**Add** (all in `src/tracker/ocr-http.ts`):

| Endpoint | Method | Body | Returns |
|---|---|---|---|
| `/api/ocr/forms`           | GET  | —                                                      | `[{formType, label, description, rosterMode}]` |
| `/api/ocr/prepare`         | POST (multipart) | `pdf, formType, rosterMode, sessionId?, previousRunId?, rosterPath?` | 202 `{sessionId, runId}` or 409 if sessionId locked |
| `/api/ocr/reupload`        | POST (multipart) | `pdf, formType, sessionId, previousRunId, rosterMode`  | 202 `{sessionId, runId}` or 409 if sessionId locked |
| `/api/ocr/approve-batch`   | POST | `{sessionId, runId, records[]}`                        | `{ok, fannedOut: [{workflow, itemId}]}` |
| `/api/ocr/discard-prepare` | POST | `{sessionId, runId, reason?}`                          | `{ok}` |
| `/api/ocr/force-research`  | POST | `{sessionId, runId, recordIndices[]}`                  | `{ok}` |

`/api/ocr/prepare` and `/api/ocr/reupload` are aliases — `/reupload` enforces `sessionId` and `previousRunId` are present (400 if missing). Both fire-and-forget `runWorkflow(ocrWorkflow, input)`; response returns 202 synchronously.

**Sweep:** `sweepStuckOcrRows(dir)` runs at dashboard startup, marks any `workflow === "ocr"` row with `status ∈ {pending, running}` as failed with "Dashboard restarted while OCR was in progress — please re-upload." Replaces both `sweepStuckPrepRows` (EC) and `sweepStuckOathPrepRows` (oath).

**SharePoint roster integration — delegation, not a hook.** Today's `RunModal` has a "Download fresh from SharePoint" radio that fires `useSharePointDownload` directly from the browser, blocking the modal until the download completes. The resulting `sharepoint-download` row exists in its own tab with no visible link to the OCR run that needed the roster. This spec rewires it as proper delegation:

1. `RunModal` no longer calls `useSharePointDownload`. The modal's roster picker just sends `rosterMode: "existing" | "download"` in the prepare body.
2. `POST /api/ocr/prepare` body shape (extended):
   ```ts
   { pdf, formType, sessionId?, previousRunId?, rosterMode, rosterPath? }
   ```
   When `rosterMode === "download"`, server skips the `rosterPath` requirement.
3. OCR's `loading-roster` step:
   - If `rosterPath` provided: load and proceed.
   - If `rosterMode === "download"`: server-side `POST` to `/api/sharepoint-download/run` with `parentRunId = <OCR runId>`, then `await watchChildRuns({ workflow: "sharepoint-download", expectedItemIds: [downloadRunId] })`. On success, read the saved roster path from the download row's `data.path`, set `rosterPath`, proceed. On failure, fail the OCR row with the SharePoint error.
4. `src/workflows/sharepoint-download/handler.ts::buildSharePointRosterDownloadHandler` accepts an optional `parentRunId` parameter (passed in the POST body or query). When set, the handler stamps it on the launched workflow's tracker row via the kernel's `parentRunId` field.
5. Operator-visible result: while OCR's row sits at `step: loading-roster`, the LogPanel's "Delegated runs" section shows the live sharepoint-download child. When that finishes, OCR proceeds to `ocr` step. Modal closes immediately on submit; operator watches the OCR row, not a modal spinner.

**Capture migration** (`src/capture/`):
- `src/capture/sessions.ts` session metadata schema gains `formType: "oath" | "emergency-contact"` (required when `workflow === "ocr"`; optional otherwise for backwards compat).
- `src/capture/server.ts`'s `makeCaptureFinalize(dir)`: when session has `workflow === "oath-signature"` (legacy QR flow), redirect to `POST /api/ocr/prepare` with `formType: "oath"`. Same for `workflow === "emergency-contact"` → `formType: "emergency-contact"`. New capture sessions can target `workflow: "ocr"` directly with explicit `formType`.

## Edge cases + risks

**Kernel — empty `systems[]`.** OCR is the first kernel workflow with no browsers. `Session.launch` should return immediately for empty systems, but this isn't exercised (sharepoint-download has 1 system, the smallest current setup). Implementation order:
1. Smoke test: instantiate OCR workflow via `runWorkflow` with stubbed orchestrator, verify no browser launches and the handler runs to completion.
2. If kernel needs a patch (likely small — `withBatchLifecycle` may assume `systems[0].id` for auth-failure fanout), include it as the plan's first task.

**Old prep rows in pre-migration JSONL files.** Existing `oath-signature-*.jsonl` and `emergency-contact-*.jsonl` files contain rows with `data.mode === "prepare"`. After migration, these become orphans:
- They render as plain `EntryItem`s with no special pane.
- They cannot be approved/discarded/reuploaded (old endpoints are gone).
- The 7-day cleanup will drop them.
- **Decision:** skip the migration script. Deploy at end-of-day; document in CLAUDE.md that any in-flight prep rows need to be re-uploaded against the new OCR endpoint.

**LocalStorage migration.** Existing `oath-prep-edits:*` and `ec-prep-edits:*` keys go stale at deploy. **Decision:** skip the migration script. Deploy at end-of-day. Operators will lose unsaved edits and must re-upload — same outcome as a normal "I closed my tab" event today.

**OCR cache directory.** Today's `.ocr-cache/` content-addressed cache stays as-is. The new orchestrator calls `runOcrPipeline` exactly like today. Carry-forward layer is orthogonal.

**Daemon-mode list (`src/core/workflow-loaders.ts`).** OCR is NOT added to `WORKFLOW_LOADERS`. That map is consulted only by `cli-daemon.ts` and the dashboard's `/api/enqueue` route. OCR is HTTP-driven only (no CLI, no daemon).

**Orphan eid-lookup itemId collision.** Today's prep prefixes itemIds with `ec-prep-` and `oath-prep-`. After migration, OCR uses `ocr-{eid|verify|force}-<sessionId>-<runId>-r<index>`. Old in-flight prep eid-lookup itemIds will continue to land in the eid-lookup JSONL — `watchChildRuns` ignores any itemId not in its `expectedItemIds` set, so no collision.

**Concurrent reuploads of the same sessionId.** If an operator clicks Reupload twice in quick succession, two `runWorkflow` calls would fire concurrently for the same sessionId. The kernel doesn't serialize this. **Mitigation: per-sessionId server-side lock.** `src/tracker/ocr-http.ts` keeps an in-memory `Set<string>` of sessionIds with an active prepare/reupload call. New requests against an in-progress sessionId return 409 with a clear error ("Reupload already in progress for this session"). Lock is released in the HTTP handler's `finally` after the `runWorkflow` fire-and-forget hand-off (NOT after orchestrator completion — the lock guards the launch race, not the OCR run itself). Concurrent runs against different sessionIds proceed in parallel as today.

## Implementation order (for the plan)

1. **Kernel smoke test for empty systems.** Patch `withBatchLifecycle` if needed. (Likely a 0-line or 5-line change; we don't know yet.)
2. **`src/tracker/watch-child-runs.ts` + tests.** Hoist + generalize from today's two `prepare.ts` files. Tests cover: timeout, fs.watch failure → polling fallback, custom isTerminal predicate, partial completion, all-fail, missing-file (no entries yet).
3. **TrackerEntry `parentRunId` field.** Add to type, ensure JSONL writers preserve it.
4. **`OcrFormSpec` types + form-registry skeleton.** No actual specs yet, just the contract.
5. **Per-form spec files.** Move oath-signature's `preview-schema.ts` content into `ocr-form.ts`; same for EC. Old `preview-schema.ts` files deleted.
6. **OCR workflow + orchestrator.** `src/workflows/ocr/{schema,workflow,orchestrator,form-registry,types}.ts` + `CLAUDE.md`. Orchestrator passes integration tests against stubbed FORM_SPECS.
7. **OCR HTTP endpoints + sweep + per-sessionId lock.** `src/tracker/ocr-http.ts`, register routes in `dashboard.ts`, restart-sweep on startup, in-memory sessionId lock for concurrent prepare/reupload guard.

7b. **SharePoint download `parentRunId` parameter.** Update `buildSharePointRosterDownloadHandler` in `src/workflows/sharepoint-download/handler.ts` to accept and stamp `parentRunId`. Update OCR's `loading-roster` step to fire SharePoint as a delegated child when `rosterMode === "download"`.
8. **Frontend file moves + renames + workflow-aware RunModal.**
9. **Frontend delegation rendering.** Pills, "Delegated runs" section in LogPanel, ApprovalInbox rule change.
10. **Force-research UI + endpoint wiring.**
11. **Reupload UI flow** (button on OcrQueueRow → opens RunModal in reupload mode).
12. **Carry-forward unit + integration tests.** Fuzzy match on name, inherits fields, force-flag bypass, missing v1 record, dropped v1 record.
13. **Capture migration.** `src/capture/sessions.ts` + `server.ts` reroute.
14. **Delete old prep code.** `oath-signature/prepare.ts`, `emergency-contact/prepare.ts`, `oath-signature-http.ts`, `emergency-contact-http.ts`, removed routes from `dashboard.ts`.
15. **Update CLAUDE.md files.** Root + per-workflow + per-component as needed.
16. **End-to-end smoke test on a live PDF.** Approve an oath PDF, verify oath-signature daemon picks up the items. Approve an EC PDF, verify EC daemon picks up.

## Out of scope (Piece 3 will cover)

- `oath-upload` workflow itself (the new HR Inquiry form filling).
- Mapping the support.ucsd.edu HR Inquiry form via playwright-cli.
- The "loading row containing children" UX for oath-upload's row (the dashboard primitive — `parentRunId` pills + "Delegated runs" section — is built here; oath-upload is the first non-OCR consumer).
- Support for OCR being invoked with `formType: "oath-upload"` or any third form type. Adding a new form type post-Piece-3 is one new `ocr-form.ts` file in the consumer workflow + one line in the registry; no infrastructure changes.

## Testing strategy

**Unit:**
- `tests/unit/tracker/watch-child-runs.test.ts` — terminal detection, timeout, custom predicate, polling fallback.
- `tests/unit/workflows/ocr/orchestrator.test.ts` — full prep flow with stubbed FORM_SPECS, OCR pipeline, watch-child-runs.
- `tests/unit/workflows/ocr/carry-forward.test.ts` — fuzzy-match key, inherit fields, force-flag bypass.
- `tests/unit/workflows/ocr/form-registry.test.ts` — both specs load, schemas parse, fan-out shapes.
- `tests/unit/workflows/oath-signature/ocr-form.test.ts` — oath-specific match logic, signed/unsigned semantics.
- `tests/unit/workflows/emergency-contact/ocr-form.test.ts` — EC-specific match logic, address compare.
- `tests/unit/tracker/ocr-http.test.ts` — all 6 routes including 4xx error paths.

**Integration:**
- Existing `tests/integration/oath-signature/` and `tests/integration/emergency-contact/` continue to pass (kernel behavior is unchanged).
- New `tests/integration/ocr/` covers prep → approve → fan-out path with stubbed eid-lookup daemon.

**Live smoke:** documented in implementation order step 16.

## Decision log

- **Why hybrid (Section 3) over OCR-owns-all or OCR-is-dumb:** schemas + prompts + per-record renderers are domain knowledge of the consumer workflow (oath knows what "signed" means; EC knows what an address compare is). Hoisting them into OCR moves them away from where the rest of their cohort lives. But OCR needs a single place to enumerate "what form types exist" for the run modal picker. Hybrid: domain stays in consumer, registry is in OCR.
- **Why itemId-based watching over parentRunId-based:** today's prep already uses deterministic itemIds. Filtering by parentRunId in the watcher would add a second filter pass for no benefit and risks missing items if a future workflow's daemon re-emits an item with a different runId.
- **Why OCR is kernel-registered but not daemon-mode:** kernel registration gives OCR a dashboard tab, queue rows, log streaming, session-rail box, RunSelector — all "for free." Daemon mode would add nothing (no browsers, no Duo) and remove the ability to invoke from HTTP cleanly.
- **Why `awaiting-approval` is a step, not a status:** matches today's pattern in EC/oath prep. The kernel wrapper writes `done` when the handler returns; we use `step` to discriminate "ready for review" from "processing." Inventing a new status value would require dashboard-wide changes.
- **Why skip LocalStorage + JSONL migration scripts:** deploy at end-of-day, accept that operators with in-flight previews must re-upload. Migration scripts add risk + maintenance for marginal benefit.
- **Why session-edits keyed by sessionId not runId:** edits should survive reuploads (carry-forward UX). sessionId is stable; runId changes per upload.
- **Why per-sessionId in-memory lock over kernel-level serialization:** the race is purely at the HTTP-handler level (two concurrent `runWorkflow` launches against the same id). Kernel-level serialization would mean every workflow gains an "is another instance of me running for id=X?" check, which is wrong for legitimately-parallel workflows like eid-lookup. Lock lives in `ocr-http.ts` where the constraint actually applies.
- **Why SharePoint roster as a delegated child rather than a modal hook:** matches the user's stated intent ("delegate so we don't have to redo it"). The operator sees ONE row (OCR) doing one logical thing, with the SharePoint piece visible as a sub-step rather than a parallel popup. RunModal becomes a pure "submit a request" surface, not "wait while I do work in the background." Side benefit: SharePoint download gets a `parentRunId` stamp now, and any future workflow that needs SharePoint roster delegation reuses the same wiring.
