# Oath Upload — Piece 3 design spec

**Date:** 2026-05-01
**Author:** brainstorm with Julian
**Status:** ready for review
**Depends on:** Piece 1 (OCR kernel workflow + delegation primitive — landed)

## What this is

A new daemon-mode workflow `oath-upload` that owns the end-to-end paper-oath
ingestion path:

1. Operator uploads a scanned oath PDF via the dashboard.
2. Workflow delegates OCR → operator reviews/edits/approves records.
3. Approval fans out N oath-signature daemon items (UCPath transactions).
4. Once every signer's UCPath transaction completes, the workflow files an
   HR General Inquiry ticket on `support.ucsd.edu` with the original PDF
   attached.

Today the operator does steps 1–3 by hand-driving the existing OCR / oath-
signature flows, then files the HR ticket manually. Piece 3 collapses that
into one operator action: **upload the PDF, walk through OCR review, walk
away.** The ticket is filed automatically once UCPath is done.

## Why now

Pieces 1 + 2 shipped the delegation primitive (`parentRunId` on
`TrackerEntry` + `watchChildRuns` watcher + dashboard parent→child pills).
Oath-upload is the first multi-tier consumer — it delegates OCR, which
itself delegates eid-lookup, which means the dashboard finally renders a
three-level nesting in the LogPanel "Delegated runs" section. It's also
the unblocker for Piece 4+ (an analogous emergency-contact-upload that
fans out into the EC daemon and files a different HR ticket on the same
form).

## Scope

### In

- New workflow `oath-upload` (kernel + daemon-mode).
- New system module `src/systems/servicenow/` for the HR Inquiry form.
- New auth flow `loginToServiceNow` mirroring `loginToUCPath`.
- New dashboard tab + Run modal for oath-upload (PDF picker only — form
  type is locked to oath).
- New HTTP endpoints `/api/oath-upload/{check-duplicate,start,cancel}`.
- Restart sweep + soft-cancel semantics for in-flight rows.
- Forward `parentRunId` from OCR's approve handler through the daemon
  enqueue path so fanned-out oath-signature children carry it. (Tiny OCR
  change + ~50 LOC daemon plumbing — completes the delegation primitive
  Pieces 1+2 stopped short of.)

### Out

- No changes to OCR's record-editor UI, its form-type spec contract, or
  the oath-signature workflow itself. The OCR approve handler gains one
  read + one option pass-through; no behavior change for existing OCR
  runs (parentRunId undefined → undefined → existing path).
- No emergency-contact-upload counterpart. Piece 4 will mirror this
  shape but is out of scope here.
- No GAS form / different form types. Subject/description/specifically/
  category are hardcoded constants per the brief.
- No multi-PDF parallelism above what `-p N` already gives us. Default
  is `-p 1`.

## Architecture

### One workflow, one row per PDF, daemon-mode

```
defineWorkflow({
  name:          "oath-upload",
  label:         "Oath Upload",
  systems:       [{ id: "servicenow", login: loginToServiceNow }],
  authSteps:     false,                    // we declare auth step by hand
  steps: [
    "servicenow-auth",
    "delegate-ocr",
    "wait-ocr-approval",
    "delegate-signatures",
    "wait-signatures",
    "open-hr-form",
    "fill-form",
    "submit",
  ],
  schema:        OathUploadInputSchema,
  authChain:     "sequential",
  tiling:        "single",
  batch: { mode: "sequential", preEmitPending: true,
           betweenItems: ["reset-browsers"] },
  detailFields: [
    { key: "pdfOriginalName", label: "PDF" },
    { key: "ocrSessionId",    label: "OCR session" },
    { key: "signerCount",     label: "Signers" },
    { key: "ticketNumber",    label: "HR ticket #" },
    { key: "submittedAt",     label: "Filed" },
    { key: "status",          label: "Status" },
  ],
  getName:       d => d.pdfOriginalName ?? "",
  getId:         d => d.sessionId ?? "",
  handler:       oathUploadHandler,
})
```

This is the same shape as `oath-signature`: kernel workflow, daemon-mode
default, single browser, `betweenItems: ["reset-browsers"]` to keep the
ServiceNow page state clean across queued items. The differences are in
the handler body, not the kernel config.

### Delegation tree

```
oath-upload row                          ← parent (this spec)
  ├── ocr row (parentRunId = oath-upload.runId)
  │     └── eid-lookup rows (already wired by OCR's orchestrator)
  └── oath-signature rows × N (parentRunId = oath-upload.runId)
```

Both children level-1 (OCR + N oath-signature rows) share the same
`parentRunId` (oath-upload's runId), giving the dashboard's existing
"Delegated runs" section everything it needs to render the nested view.
The OCR row is also a parent in its own right — its eid-lookup
grandchildren stay wired via OCR's existing `parentRunId`-on-eid-lookup
emissions.

## File layout

### New: `src/workflows/oath-upload/`

| File | Role |
|---|---|
| `CLAUDE.md` | module doc, mirrors `oath-signature/CLAUDE.md` shape |
| `schema.ts` | `OathUploadInputSchema` |
| `workflow.ts` | `defineWorkflow` + `runOathUpload` + `runOathUploadCli` |
| `handler.ts` | step-by-step handler body, exported for unit testing |
| `fill-form.ts` | the Playwright form-fill (selectors registry consumer) |
| `duplicate-check.ts` | PDF SHA-256 + scan oath-upload JSONLs for prior runs |
| `index.ts` | barrel |

### New: `src/systems/servicenow/`

| File | Role |
|---|---|
| `CLAUDE.md` | module doc, links to LESSONS + SELECTORS |
| `selectors.ts` | role-based selectors with `// verified 2026-05-01` |
| `navigate.ts` | `gotoHrInquiryForm(page)` + `verifyOnInquiryForm(page)` |
| `SELECTORS.md` | auto-generated by `npm run selectors:catalog` |
| `LESSONS.md` | empty initially |
| `common-intents.txt` | hand-curated 5–10 typical intents |

### New: `src/tracker/oath-upload-http.ts`

Mirrors the shape of `src/tracker/ocr-http.ts` and
`src/tracker/oath-signature-http.ts`:

- `buildOathUploadDuplicateCheckHandler(opts)` →
  `POST /api/oath-upload/check-duplicate`
- `buildOathUploadStartHandler(opts)` → `POST /api/oath-upload/start`
- `buildOathUploadCancelHandler(opts)` → `POST /api/oath-upload/cancel`
- `sweepStuckOathUploadRows(dir)` — restart sweep

### New: `src/dashboard/components/oath-upload/`

| File | Role |
|---|---|
| `OathUploadRunModal.tsx` | minimal modal — PDF picker + duplicate banner + Submit |
| `DuplicateBanner.tsx` | renders `priorRuns` from check endpoint |
| `OathUploadRowDetails.tsx` (optional) | extra row affordances if needed |

### Touched

- `src/auth/login.ts` — add `loginToServiceNow(page, instance?)`.
- `src/tracker/ocr-http.ts` — `buildOcrApproveHandler` reads OCR entry's
  `parentRunId` and forwards it as a new option to
  `ensureDaemonsAndEnqueue`. Also stamps `fannedOutItemIds:
  JSON.stringify(itemIds)` into the post-approve tracker entry's `data`.
- `src/core/daemon-types.ts` — `QueueEvent.enqueue` gains optional
  `parentRunId?: string`.
- `src/core/daemon-queue.ts` — `enqueueItems(...)` accepts a
  `parentRunId?` parameter; threads into the on-disk event.
- `src/core/daemon.ts` — claim path reads `parentRunId` from the queue
  event and threads it into `runOneItem({ parentRunId })` (kernel
  already accepts this via `RunOpts`).
- `src/core/daemon-client.ts` — `ensureDaemonsAndEnqueue(...)` gains a
  `parentRunId?` option, forwards to `enqueueItems`. The
  `onPreEmitPending(item, runId)` callback signature gains a third
  optional argument `parentRunId?: string`. **Only one caller updates**
  in this spec: `oath-signature/workflow.ts`'s callback gains a
  `...(parentRunId ? { parentRunId } : {})` spread on its `trackEvent`
  call (~1 LOC). Other workflows ignore the new argument; their pending
  rows continue to lack `parentRunId`, which is harmless because they
  aren't yet consumed as children of a delegation parent. Piece 4+
  workflows that become children later add the same one-line edit
  on demand.
- `src/cli.ts` — new `oath-upload` Commander subcommand.
- `src/cli-daemon.ts` — `WORKFLOWS` map gains `"oath-upload"` lazy
  loader.
- `package.json` — `oath-upload`, `oath-upload:stop` scripts.
- `src/tracker/dashboard.ts` — wires the three new oath-upload routes
  + invokes `sweepStuckOathUploadRows` on startup.
- `src/dashboard/components/RunModal.tsx` — when `workflow ===
  "oath-upload"`, dispatches to `OathUploadRunModal`. Otherwise
  unchanged.
- Root `CLAUDE.md` — workflow registry table gains the row + step list.

## Schema

```ts
// src/workflows/oath-upload/schema.ts
export const OathUploadInputSchema = z.object({
  pdfPath:         z.string(),
  pdfOriginalName: z.string(),
  sessionId:       z.string(),
  pdfHash:         z.string(),  // sha256 hex; required, computed by HTTP handler
});
export type OathUploadInput = z.infer<typeof OathUploadInputSchema>;
```

`pdfHash` is required so the duplicate-check pre-flight is durable across
restarts. The HTTP `start` handler computes it server-side after writing
the upload to disk; the frontend's pre-upload SubtleCrypto-derived hash
is only used to pre-warn the operator before they commit.

## Handler walkthrough

```
oathUploadHandler(ctx, input):
  ctx.updateData({
    pdfOriginalName: input.pdfOriginalName,
    sessionId:       input.sessionId,
    pdfHash:         input.pdfHash,
    status:          "running",
  });

  // step 1: auth
  ctx.markStep("servicenow-auth");
  const page = await ctx.page("servicenow");

  // step 2: delegate OCR
  await ctx.step("delegate-ocr", async () => {
    const ocrSessionId = `oath-upload-${ctx.runId}-ocr`;
    ctx.updateData({ ocrSessionId });
    void runWorkflow(ocrWorkflow, {
      pdfPath:         input.pdfPath,
      pdfOriginalName: input.pdfOriginalName,
      formType:        "oath",
      sessionId:       ocrSessionId,
      rosterMode:      "download",
      parentRunId:     ctx.runId,
    }).catch(err =>
      log.warn(`[oath-upload] OCR child crashed: ${errorMessage(err)}`));
  });

  // step 3: wait for operator approval (via existing OCR approve UI)
  let fannedOutItemIds: string[] = [];
  await ctx.step("wait-ocr-approval", async () => {
    const outcome = await waitForOcrApproval({
      sessionId: ocrSessionId,
      timeoutMs: SEVEN_DAYS_MS,
    });
    if (outcome.step === "discarded")
      throw new Error(`OCR run ${ocrSessionId} was discarded by operator`);
    fannedOutItemIds = outcome.fannedOutItemIds;
    ctx.updateData({ signerCount: String(fannedOutItemIds.length) });
  });

  // step 4: marker — fan-out happened inside OCR's approve handler
  ctx.markStep("delegate-signatures");

  // step 5: wait for every UCPath transaction to terminate "done"
  await ctx.step("wait-signatures", async () => {
    await watchChildRuns({
      workflow:        "oath-signature",
      expectedItemIds: fannedOutItemIds,
      timeoutMs:       SEVEN_DAYS_MS,
      isTerminal:      e => e.status === "done",
    });
  });

  // step 6: open & navigate
  await ctx.step("open-hr-form", async () => {
    await gotoHrInquiryForm(page);
    await verifyOnInquiryForm(page);
  });

  // step 7: fill the four fields + attach
  await ctx.step("fill-form", async () => {
    await fillHrInquiryForm(page, {
      subject:     "HDH New Hire Oaths",
      description: "Please see attached oaths for employees hired under HDH.",
      specifically: "Signing Ceremony (Oath)",
      category:     "Payroll",
      attachmentPath: input.pdfPath,
    });
    await ctx.screenshot({ kind: "form", label: "hr-inquiry-pre-submit" });
  });

  // step 8: submit + capture ticket number
  await ctx.step("submit", async () => {
    const ticketNumber = await submitAndCaptureTicketNumber(page);
    await ctx.screenshot({ kind: "form", label: "hr-inquiry-submitted" });
    ctx.updateData({
      ticketNumber,
      submittedAt: new Date().toISOString(),
      status:      "filed",
    });
  });
```

`waitForOcrApproval` is a thin wrapper around `watchChildRuns` that:

1. Calls `watchChildRuns({ isTerminal: e => e.step === "approved" || e.step === "discarded" })`.
2. After resolution, re-reads the OCR JSONL to find the latest entry
   with `step === "approved"`. If the latest is `discarded`, returns
   `{ step: "discarded" }`. Otherwise returns
   `{ step: "approved", fannedOutItemIds: JSON.parse(latest.data.fannedOutItemIds) }`.

Storing `fannedOutItemIds` on the OCR approve entry (rather than
deriving them by replaying `spec.approveTo.deriveItemId`) means
oath-upload doesn't need to import `oath-signature/ocr-form.ts` or
duplicate the deriveItemId formula. It also makes the approve handler's
contract explicit — "the IDs I just fanned out are right here" — which
helps any future delegation parent.

## Failure & retry semantics

### Child failures pause the parent

| Child state | Watch resolves? | Operator action |
|---|---|---|
| OCR step="approved" | yes (OCR child watch) | nothing — handler proceeds |
| OCR step="discarded" | yes (OCR child watch) | parent fails — operator must run a new oath-upload |
| OCR status="failed" (errored) | no — neither approved nor discarded | operator retries OCR, watch waits for the next "approved" |
| oath-signature status="done" | yes (signatures watch) | nothing — handler proceeds |
| oath-signature status="failed" | no | operator retries failed children; watch resolves once all reach "done" |

**OCR retry mechanism.** When OCR fails, the operator clicks the OCR
row's existing reupload button (or `RetryButton` if/when the
record-editor lands one). That dispatches to `/api/ocr/prepare` with
`isReupload=true, sessionId=<existing>, previousRunId=<failed runId>`,
which marks the prior run `superseded` and starts a fresh OCR run
under the SAME sessionId. The new run carries `parentRunId` from its
input (oath-upload preserves this on the reupload payload). Once the
operator approves the new run, the OCR approve handler emits a
`step="approved"` entry — and oath-upload's `watchChildRuns` (still
waiting on `expectedItemIds: [ocrSessionId]` with predicate
`step==="approved" || step==="discarded"`) resolves on it. No
oath-upload-side change needed.

Backstop: 7-day timeout on each watch. If the timeout fires, the parent
fails with an error message naming the unsatisfied itemIds; the operator
re-runs oath-upload (fresh sessionId — duplicate-check banner will warn
them). The dashboard's existing `RetryButton` on the failed parent row
calls `/api/retry`, which re-enqueues the same input — but since the
fresh handler computes a fresh `ocrSessionId = "oath-upload-${runId}-ocr"`
and the runId changes per retry, this is effectively a fresh run.
Acceptable.

### Restart while waiting

The daemon process holds the watcher in memory. If the daemon is killed
(SIGINT / hard restart):

1. The daemon's existing teardown unclaims the in-flight queue item (or
   marks it failed with `--force`). With unclaim:
2. On daemon respawn, `recoverOrphanedClaims` re-queues the unclaimed
   item.
3. The respawned daemon claims it again, re-enters the handler from
   step 1.
4. `delegate-ocr` re-fires `runWorkflow(ocrWorkflow, …)`. Since the OCR
   sessionId is deterministic (`oath-upload-${runId}-ocr`), and OCR's
   prepare handler sees the existing sessionId, it would 409 — but
   actually, since this is a fresh runId after recovery (re-claim
   generates a new runId per the `runWorkflow` semantics), the OCR
   sessionId would change too. **Edge case.**

To avoid this re-OCR cost on restart, the runId must be stable across
the unclaim/reclaim cycle. The kernel's `pre-assigned runId` channel
(`onPreEmitPending` callback in oath-signature/work-study) is the
existing mechanism. **Decision:** oath-upload's `runOathUploadCli`
adapter writes the pending row with a pre-assigned runId, and the
queue's `enqueue` event carries that runId so the daemon reuses it
on claim. This already works today (`QueueEvent.enqueue.runId` is in
the schema, see `daemon-types.ts:53`).

In practice: after restart, the handler re-runs with the same runId →
same ocrSessionId → OCR's `/api/ocr/prepare` would 409 if the original
OCR row is still active. Two paths forward:

- **(a)** OCR restart sweep marks the in-flight OCR row as failed
  (`sweepStuckOcrRows` already does this). Then re-running OCR with the
  same sessionId is fine — it's a re-prepare against a failed prior. No
  OCR change needed.
- **(b)** oath-upload's handler probes the OCR JSONL on entry; if a
  prior OCR row exists with status "failed" or "running", it skips
  re-firing and goes straight to `wait-ocr-approval`. Idempotent
  re-entry.

We pick **(b)**. Cleaner — doesn't depend on OCR's sweep timing.

The signatures watch is naturally restart-safe: the IDs are written to
disk (`data.fannedOutItemIds`), reading them back is one JSONL parse,
and `watchChildRuns` is stateless across restarts.

### Soft-cancel from the dashboard

The dashboard backend and the oath-upload daemon are separate processes,
so an in-process AbortController in the dashboard can't reach the
daemon's running watcher. Cancel goes through the JSONL instead.

`POST /api/oath-upload/cancel` emits two tracker lines on the
oath-upload JSONL:
1. A sentinel `running` entry on the oath-upload row with
   `step: "cancel-requested"`.
2. A terminal `failed` entry on the oath-upload row with
   `step: "cancelled"` and `error: "Cancelled by operator"` — written
   by the daemon when its watcher observes the sentinel (not by the
   HTTP handler directly).

The handler's two `watchChildRuns` calls each gain a per-tick check
that reads the LATEST entry on its OWN row (oath-upload, sessionId =
`input.sessionId`) and aborts if it sees `step: "cancel-requested"`.
This adds one optional opt to `watchChildRuns`:
`abortIfRowState?: { workflow: string; id: string; step: string }`.
~15 LOC addition. Generic — any future delegation parent uses the
same pattern.

If the daemon is no-longer-alive when cancel is requested (rare —
operator shouldn't cancel a daemon that already crashed), the
sentinel sits unread; the orphan-sweep on next dashboard restart
flips the row to `failed step="swept"`.

## Duplicate PDF handling

### Pre-flight (frontend, in `OathUploadRunModal`)

```ts
const buf = await file.arrayBuffer();
const hashBuf = await crypto.subtle.digest("SHA-256", buf);
const hash = Array.from(new Uint8Array(hashBuf))
  .map(b => b.toString(16).padStart(2, "0"))
  .join("");
const r = await fetch(`/api/oath-upload/check-duplicate?hash=${hash}`);
const { priorRuns } = await r.json();
if (priorRuns.length > 0) showBanner(priorRuns);
```

### Server (`buildOathUploadDuplicateCheckHandler`)

Scans the last 30 days of `oath-upload-*.jsonl` for entries whose
`data.pdfHash === hash`, deduped to latest run per (id), returns:

```ts
priorRuns: Array<{
  sessionId:     string;
  runId:         string;
  startedAt:     string;
  terminalStep:  "filed" | "cancelled" | "failed" | "awaiting-…" | …;
  ticketNumber?: string;
  pdfOriginalName: string;
}>
```

Banner copy: `"This PDF was previously uploaded on YYYY-MM-DD — run
{shortRunId} reached step '{terminalStep}'{ticketNumber? ', ticket
'+ticketNumber : ''}."`

The operator can dismiss and proceed. Non-blocking by design (per Q4 of
the brainstorm).

### Persistence

The `start` HTTP handler computes the hash server-side and writes it
into both the input passed to `runWorkflow` AND the pending tracker
row's `data.pdfHash`. Subsequent state-transition rows inherit it via
`ctx.updateData({ pdfHash })` in the handler's first call.

### Upload size cap

50 MB, mirroring `/api/emergency-contact/prepare`. Enforced in the
multipart parser; rejects with HTTP 413 on overflow.

## ServiceNow form mapping (verified 2026-05-01)

URL: `https://support.ucsd.edu/esc?id=sc_cat_item&table=sc_cat_item&sys_id=d8af3ae8db4fe510b3187d84f39619bf`

Login: UCSD SSO (a5.ucsd.edu / TritON SAML) + Duo. Mirrors
`loginToUCPath`'s pattern — fill username, password, submit, then
poll Duo via `requestDuoApproval`. The form lives in the main DOM
(no iframe traversal needed), unlike UCPath. Page title verification:
`"HR General Inquiry - Employee Center"`.

Selectors (role-based, all in main DOM):

| Intent | Selector | Notes |
|---|---|---|
| Subject textbox | `getByRole('textbox', { name: 'Subject' })` | required |
| Description textbox | `getByRole('textbox', { name: 'Description' })` | required |
| Specifically combobox | `getByRole('combobox', { name: 'Specifically:' })` | ServiceNow typeahead — type "Signing Ceremony" → click match |
| Category combobox | `getByRole('combobox', { name: 'Category:' })` | placeholder "-- None --" — `selectOption('Payroll')` |
| Choose-file button | `getByRole('button', { name: 'Choose a file' })` | drives a hidden `<input type="file">`; use `page.setInputFiles` |
| Submit button | `getByRole('button', { name: 'Submit' })` | end |
| Save-as-Draft button | `getByRole('button', { name: 'Save as Draft' })` | escape hatch — not used by handler |

The ServiceNow typeahead for "Specifically" requires the operator-style
"type and pick" pattern; ServiceNow doesn't support `selectOption` on
this widget. Implementation will fill the inner textbox + wait for the
suggestion list + click the matching option. Selector for the
suggestion list TBD on first live run; logged as a follow-up if
flaky.

The "Choose a file" button surfaces an OS file picker if clicked
directly. Standard ServiceNow Service-Catalog markup wraps a hidden
`input[type="file"]` adjacent to the button — `page.setInputFiles` on
that input bypasses the picker. Selector: `input[type="file"]` scoped
within the Attachments region. If the markup turns out to use a
different idiom (e.g. dropzone-only), implementation falls back to
`button.click()` + Playwright's `page.on("filechooser", ...)` handler.

Captured ticket number after submit: ServiceNow typically redirects to
the ticket detail page (`?id=ticket&number=HRC0XXXXXX`) on submit. The
handler reads `page.url()` post-submit, parses the `number=` param,
and stores it on `data.ticketNumber`. If the redirect doesn't contain
the number directly, fallback: scrape the heading on the redirected
page (TBD on first live run).

A reference screenshot of the form lives at
`.screenshots/oath-upload-mapping/hr-inquiry-form-2026-05-01.png`
(local-only; not committed).

## Dashboard UX

### New tab

A new top-level tab `"oath-upload"` joins the existing workflow tab
list. The dashboard reads it from `/api/workflow-definitions` (which
the kernel populates from `defineWorkflow`) — no per-workflow frontend
edits. Step pipeline shows the 8 steps + auto-prepended `auth:servicenow`.

### Run modal

A new `OathUploadRunModal` (rendered when `workflow === "oath-upload"`
in the existing `RunModal` host):

- **PDF picker** — single file, drag-and-drop or click.
- **Pre-flight duplicate check** — fires on file select; hashes locally,
  fetches `/api/oath-upload/check-duplicate?hash=...`, renders banner.
- **Submit button** — POSTs multipart to `/api/oath-upload/start`.
- **No form-type chooser** — locked to oath. (Reflects the brief:
  "no form-type picker — locked to oath; otherwise similar to OCR's
  modal but submits to /api/oath-upload/start".)

### Row expansion

The existing `EntryItem` parentRunId pill + `LogPanel` "Delegated runs"
section render the OCR + N oath-signature children inline once the
parentRunId plumbing lands. No frontend nesting code changes.

## Concurrency

Daemon mode default. `npm run oath-upload <pdfPath>` enqueues to an
alive daemon or spawns one (one Duo per spawn). Multiple uploads queue
sequentially through the same daemon's browser. `--parallel N` spawns
N daemons (N Duos) and N uploads progress concurrently. Default
`-p 1`; the user processes 1–3 rosters/week so concurrency is
typically not needed, and the dashboard's TopBar Run button enqueues
1-at-a-time anyway.

## ServiceNow session expiry during long waits

The handler's `wait-ocr-approval` and `wait-signatures` steps can each
last days. While waiting, the daemon's open ServiceNow tab sits idle.
ServiceNow SAML sessions typically expire after ~12h of inactivity.

The kernel's existing 15-minute idle keepalive
(`session.healthCheck("servicenow")` in `runWorkflowDaemon`) handles
this — it pings the page, refreshing the session cookie. No new
mechanism needed; this matches how every other long-lived daemon
(`separations`, `oath-signature`) handles UCPath session expiry.

If `healthCheck` ever fires and finds the session dead, the kernel's
3-attempt re-auth (`loginWithRetry`) re-runs `loginToServiceNow`,
which surfaces a Duo prompt. The operator gets a `duo_waiting`
overlay in the dashboard's SessionPanel (existing UX) and can approve
mid-wait without restarting the run.

## Testing

### Unit tests (`tests/unit/workflows/oath-upload/`)

- `handler.test.ts` — drive the handler with a stubbed `Ctx`,
  stubbed `runWorkflow`, stubbed `watchChildRuns`. Assert each step's
  emitted tracker rows + the final `data.ticketNumber` /
  `submittedAt` / `status: "filed"` shape.
- `duplicate-check.test.ts` — stub fs, supply a few prior-run JSONLs,
  assert the `priorRuns[]` shape and the latest-run dedup.
- `fill-form.test.ts` — drive `fillHrInquiryForm` against a stubbed
  Playwright Page (use the existing pattern from
  `tests/unit/systems/ucpath/`). Assert each selector is queried
  exactly once + the final field values.
- `selectors.test.ts` — verify every exported selector loads + the
  inline-selectors guard passes.

### Unit tests for the OCR approve change (`tests/unit/tracker/ocr-http.test.ts`)

- Approve handler with no OCR-row parentRunId → no parentRunId on
  child enqueue (existing behavior preserved byte-identical).
- Approve handler with parentRunId on OCR row → forwards through to
  `ensureDaemonsAndEnqueue`. Mocked, so we just assert the option was
  passed.
- Post-approve tracker entry's `data.fannedOutItemIds` matches the
  serialized JSON of the IDs the handler computed.

### Unit tests for daemon plumbing (`tests/unit/core/daemon-{queue,client}.test.ts`)

- `enqueueItems` writes `parentRunId` into the queue event when
  passed; omits the field otherwise.
- Claim path reads `parentRunId` from the queue event and forwards
  to `runOneItem`.
- `ensureDaemonsAndEnqueue` accepts `parentRunId` and forwards.

### Integration test (`tests/integration/oath-upload-end-to-end.test.ts`)

- Spin up an isolated dashboard server (existing `createDashboardServer`
  factory) with a temp tracker dir.
- Stub `runWorkflow` + Playwright + `loginToServiceNow`.
- POST a fake PDF to `/api/oath-upload/start`.
- Assert oath-upload pending row writes immediately.
- Manually trigger the orchestrator phases via test escape hatches
  (mirroring OCR's `_emitOverride` / `_watchChildRunsOverride` pattern).
- Assert the final `done` row + `data.ticketNumber`.

### No live-target test

No CI test against the actual `support.ucsd.edu` form — that's a
production-side ticket creation. Implementation will verify against the
form once during build (manual), and the unit + integration coverage is
the regression net thereafter. Match the pattern used for every other
UCPath workflow (no live UCPath in CI either).

## Open questions and resolution log

### Resolved during brainstorm

1. **Auth model** — fresh system entry mirroring `loginToUCPath`. Daemon
   amortizes Duo across uploads.
2. **Partial child failure** — parent waits for *all* children to be
   `done`. Failed children pause the parent indefinitely (subject to 7d
   backstop); operator retries via existing dashboard buttons.
3. **Approval timeout** — 7 days. Beyond that the parent fails; operator
   re-runs.
4. **Re-uploads of the same PDF** — soft warning via duplicate-check
   pre-flight; never blocks; shows prior-run terminal step and ticket
   number.
5. **Handler shape** — single workflow, daemon-mode, linear handler with
   waits. The browser's idle cost during waits is acceptable; the
   alternative shapes (no-daemon, two-workflow split) violate
   "consistent with other workflows."
6. **Where do oath-signature children's parentRunId come from?** — OCR's
   approve handler forwards it through the daemon enqueue path. ~10
   LOC OCR-side + ~50 LOC daemon-side. Bundled into Piece 3 as
   primitive completion (not a sneak-in feature).

### Deferred

- **Multi-PDF concurrency tuning.** Default `-p 1` is sufficient for
  current volume. If this becomes a bottleneck, `-p 2` or `-p 3` is the
  immediate fix; no spec change needed.
- **Ticket-number scrape fallback.** If the post-submit redirect URL
  doesn't carry `number=`, implementation falls back to heading scrape.
  Specific selector TBD on first live run; will be added to
  `servicenow/LESSONS.md`.
- **Specifically-typeahead suggestion-list selector.** TBD on first live
  run for the same reason.

## Interaction with concurrent specs

### `2026-05-01-ocr-per-page-retry-design.md`

The two specs are independently mergeable. Both touch
`src/tracker/ocr-http.ts` but in disjoint functions: per-page retry
adds new endpoint handlers (`/api/ocr/retry-page`,
`/api/ocr/reocr-whole-pdf`) plus a per-row mutex map; this spec
modifies `buildOcrApproveHandler` to forward `parentRunId` and write
`fannedOutItemIds` to the post-approve entry. Different tracker
entries: per-page retry adds `data.failedPages` +
`data.pageStatusSummary` on the **awaiting-approval** entry; this
spec adds `data.fannedOutItemIds` on the **`step="approved"`** entry.

**Behavioral interaction**: per-page retry's "approve with pages
still failing is allowed" semantics flow through cleanly. If the
operator approves an OCR run where some pages failed, the fan-out
contains fewer signers, and oath-upload's `wait-signatures` watches
that smaller set. No oath-upload-side awareness needed — failed
pages are invisible to the parent.

**Build order**: either spec can ship first. If per-page retry ships
first, existing OCR rows gain `failedPages` data that oath-upload
ignores. If this spec ships first, per-page retry's
awaiting-approval write naturally preserves `parentRunId` because
the orchestrator's `writeTracker` already spreads `input.parentRunId`
into every emit.

## Estimated cost

| Area | LOC | Notes |
|---|---|---|
| `src/workflows/oath-upload/` | ~400 | handler + fill-form + duplicate-check + workflow def |
| `src/systems/servicenow/` | ~150 | selectors + navigate + module sibs |
| `src/auth/login.ts` ServiceNow flow | ~80 | mirror of `loginToUCPath` |
| `src/tracker/oath-upload-http.ts` | ~250 | three handlers + sweep |
| `src/dashboard/components/oath-upload/` | ~200 | modal + banner |
| OCR approve handler change | ~10 | read parent + forward |
| Daemon plumbing | ~60 | types + queue + dispatch |
| Tests | ~600 | unit + integration |
| **Total** | **~1750** | |

## Pieces 4+ implications (scope only)

Once Piece 3 lands, Piece 4 ("emergency-contact-upload") will mirror
this shape: same workflow definition, same delegation handler shape,
different OCR formType + different oath-signature → emergency-contact
fan-out + same HR Inquiry form (different Subject/Description/
Specifically). The daemon parentRunId plumbing built here is a one-time
investment.

## Acceptance criteria

- Operator uploads an oath PDF in the dashboard, walks through OCR
  review, walks away.
- All N UCPath transactions complete autonomously.
- An HR ticket is filed automatically with the correct
  Subject/Description/Specifically/Category and the original PDF
  attached.
- Dashboard shows one oath-upload row with the OCR child + N
  oath-signature children nested in the "Delegated runs" section.
- Restart-during-wait recovers cleanly (no double-OCR, no double-fan-out,
  no double-file).
- Duplicate-PDF upload shows a non-blocking banner with the prior run's
  outcome.
- 7-day timeout fires and surfaces a clear failure message.
- Unit + integration coverage as listed above passes.
