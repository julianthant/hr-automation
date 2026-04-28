# Emergency Contact "Run" Button + Scalable OCR — Design

Status: Draft (brainstormed 2026-04-27, awaiting user review).
Owner: julianthant.
Related skills/specs: `2026-04-22-workflow-daemon-mode-design.md`, `2026-04-24-dashboard-operations-design.md`.

## Problem

Emergency-contact today requires Claude to hand-OCR a scanned PDF into a YAML batch file, then run `npm run emergency-contact <yaml>`. The user wants a self-service flow:

- Click a Run button in the dashboard, attach the PDF, optionally download a fresh roster.
- An LLM OCRs the PDF, matches each parsed person against the roster (and falls back to the eid-lookup workflow when needed), and writes a single **preview row** at the top of the queue with all extracted records.
- The user reviews + edits inline, hits Approve, and N normal emergency-contact items spawn — using the existing daemon flow.

Two new abstractions are introduced:
1. A scalable, schema-bound OCR primitive (`src/ocr/`) reusable across future workflows.
2. A "preview row" concept inside the existing emergency-contact tracker (no new workflow).

Plus several smaller fixes: a same-address-when-blank bug, missing `updateData` calls causing dashboard warnings, and the formal opt-in to edit-data mode.

## Non-goals

- Multi-PDF batch in one Run click (single PDF per click; user can re-Run).
- Cross-provider OCR fallback (Gemini-only for v1; provider stubs exist but inert).
- Generic preview-row tracker `kind` discriminator across all workflows (we use a per-workflow `data.mode` field instead — easier to maintain, no kernel changes).
- Add-New emergency-contact path (still throws `NoExistingContactError`; out of scope).
- Auto-save of edits per keystroke (localStorage + POST-on-Approve is sufficient).

## Architecture overview

```
[Run button] ──click──> [Modal: PDF + roster mode]
                              │
                              ▼
   POST /api/emergency-contact/prepare
                              │
                ┌─────────────┴──────────────┐
                ▼                            ▼
       [if mode=download]         [trigger sharepoint-download]
                ▼                            │
       [pick latest .xlsx]                   ▼
                │                  [downloaded]
                └────────────┬───────────────┘
                             ▼
                  [write prep tracker row: pending → running]
                             ▼
                  [src/ocr/ — Gemini-rotation OCR]
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        [roster match] [eid-lookup    [address compare
         per name]      daemon         per record]
                        per name]
              └──────────────┼──────────────┘
                             ▼
                  [emit "running" updates → status: done]
                             ▼
              [User reviews + edits in dashboard]
              [Click Approve]
                             ▼
                POST /api/emergency-contact/approve-batch
                             ▼
              [ensureDaemonsAndEnqueue with prefilledData.parentRunId]
                             ▼
                  [emergency-contact daemon fills UCPath]
```

## Components

### 1. `src/ocr/` — generic OCR primitive (cross-cutting)

```
src/ocr/
  index.ts              # Public API: ocrDocument<T>()
  providers/
    gemini.ts           # Multi-modal call to Gemini 2.5 Flash via responseSchema
    types.ts            # OcrProvider interface
  rotation.ts           # Per-key state machine + persisted state
  cache.ts              # File-based cache at .ocr-cache/{sha256}.json
  prompts.ts            # Schema → prompt template
  CLAUDE.md             # Module doc
```

**Public interface:**

```ts
interface OcrRequest<T> {
  pdfPath: string;        // local file, must exist
  schema: ZodType<T>;     // output validated against this
  schemaName: string;     // human label, used for cache key + prompt tuning
  examples?: Array<{ pdfPath?: string; output: T }>;
  pageRange?: { start: number; end: number };
  prompt?: string;        // optional override
  bustCache?: boolean;
}

interface OcrResult<T> {
  data: T;                // the typed output (may be an array)
  rawText?: string;
  pageCount: number;
  provider: string;       // "gemini"
  keyIndex: number;
  attempts: number;
  cached: boolean;
  durationMs: number;
}

export async function ocrDocument<T>(req: OcrRequest<T>): Promise<OcrResult<T>>;
```

**Cache contract:**
- Key: `sha256(pdfBytes + schemaName + schemaJsonHash + promptVersion)`.
- Location: `.ocr-cache/{key}.json` — gitignored.
- TTL: indefinite. Same key = same input = same expected output.
- Bust: `bustCache: true` flag (per-call) or delete the cache file.

**Schema-bound output:**
- Serialize Zod → JSON Schema for Gemini's `responseSchema` parameter (guaranteed structured output).
- On validation failure, retry once with the validation error fed back as a hint. Max 2 retries before throwing.

**Rotation contract** (`rotation.ts`):
- Per-key state: `available | throttled-until-{epoch} | quota-exhausted-until-{epoch} | dead`.
- Persisted at `.ocr-cache/rotation-state.json` (debounced 30s writes; flushed on shutdown via SIGINT hook).
- In-memory cache for the process; loaded on first call.
- Detection rules:
  - HTTP 429 → `throttled-until = now + 60s`.
  - HTTP 403 with quota error message → `quota-exhausted-until = next UTC midnight`.
  - HTTP 401 → `dead` (this session only; cleared on next rotation-state load if file deleted).
  - Network timeout (60s) → counts as transient; same key, one retry.
- Selection: pick first `available` key with smallest `dailyRequestCount`. Per-key 20 req/day soft limit (Gemini's actual quota).
- Per-call budget: max-attempts = `keyCount`. Hard 60s timeout per attempt. If all keys exhausted → throw `OcrAllKeysExhaustedError`.
- Cross-provider fallback (Mistral, OpenRouter, Groq, Cerebras, Cohere, Sambanova) deferred to v2 — provider interface exists but `gemini` is the only registered provider.

### 2. `src/workflows/emergency-contact/` — additions

```
src/workflows/emergency-contact/
  workflow.ts           # +runEmergencyContactPrepare (no-kernel, async)
  prepare.ts            # NEW — orchestrator: OCR + match + write prep row
  match.ts              # NEW — roster name match + address normalize/compare
  preview-schema.ts     # NEW — Zod for prep row's data shape (records[])
  config.ts             # +OCR_RETENTION_DAYS, +UPLOAD_DIR
  schema.ts             # +editable: true on detail fields (no shape change to record)
  enter.ts              # FIX: same-address-when-null bug
  CLAUDE.md             # update with prepare path + new endpoints
```

**Preview row data shape** (`preview-schema.ts`):

```ts
interface PrepareRowData {
  mode: "prepare";
  pdfPath: string;             // .tracker/emergency-contact/uploads/{runId}-{slug}.pdf
  pdfOriginalName: string;
  rosterMode: "download" | "existing";
  rosterPath: string;
  records: PreviewRecord[];
  ocrProvider?: string;
  ocrAttempts?: number;
  ocrCached?: boolean;
}

interface PreviewRecord extends EmergencyContactRecord {
  matchState: "extracted" | "matched" | "lookup-pending" | "lookup-running" | "resolved" | "unresolved";
  matchSource?: "form" | "roster" | "eid-lookup";
  matchConfidence?: number;       // 0..1
  rosterCandidates?: Array<{ eid: string; name: string; score: number }>;  // for ambiguous matches
  addressMatch?: "match" | "differ" | "missing";
  selected: boolean;              // checkbox state, default true
  warnings: string[];             // human-readable flags surfaced in UI
}
```

**Item row carries `parentRunId`** via the kernel's existing `prefilledData` channel — no new tracker field. Dashboard reads `data.parentRunId` to group children under their parent.

### 3. New backend endpoints (`src/tracker/dashboard.ts`)

| Method+Path | Purpose | Body | Response |
|---|---|---|---|
| `POST /api/emergency-contact/prepare` | Kick off OCR + match. Multipart with PDF + JSON body. | `{ pdfFile, rosterMode: "download" \| "existing" }` | `{ runId }` (returns 202 immediately; work continues async) |
| `POST /api/emergency-contact/approve-batch` | Spawn child items from approved preview row. | `{ parentRunId, records: PreviewRecord[] }` | `{ enqueued: N, parentRunId }` |
| `POST /api/emergency-contact/discard-prepare` | Mark prep row cancelled. | `{ runId }` | `{ ok: true }` |
| `GET /api/rosters` | List available rosters in `src/data/` (mtime DESC). | — | `[{ filename, mtime, sizeBytes }]` |

The first three handlers write tracker rows directly via the existing `trackEvent` emitter (already used by `withTrackedWorkflow`). They bypass the kernel because OCR + match is server-side compute, no browser, no Duo.

Dashboard backend does NOT hot-reload — every change here requires `npm run dashboard` restart. Document in CLAUDE.md.

### 4. Dashboard frontend (`src/dashboard/`)

New components:
```
src/dashboard/components/
  TopBarRunButton.tsx        # The "▶ Run" button + modal trigger
  RunModal.tsx               # PDF upload + roster mode toggle
  PreviewRow.tsx             # Special render for data.mode === "prepare"
  PreviewRecordRow.tsx       # One record line; expand-on-click
  PreviewRecordEditForm.tsx  # Inline edit form when row expanded
```

**Editing flow:**
- On expand, the row's current values populate the form.
- Edits update local component state.
- A debounced save writes to `localStorage` keyed by `parentRunId` (per-record, by index).
- On Approve, the merged state (server `data.records[]` overlaid by `localStorage`) is POSTed to the backend.
- On Approve-success, localStorage is cleared.
- On Discard, localStorage cleared.

**Approve button state:**
- Disabled if any `selected: true` record has `matchState !== "resolved"`.
- Tooltip: "Resolve EID for X records before approving".
- Label: "Approve N of M" where N = selected count.

**Children-under-parent grouping:**
- Existing queue rendering reads tracker rows. We add a parent-child join based on `data.parentRunId`.
- Children render indented under their parent (visual nesting).
- Parent's row keeps the preview-grid summary even after children spawn ("done · 7 children spawned").

### 5. Edit-data opt-in for emergency-contact

Per `src/workflows/CLAUDE.md` recipe:
- `detailFields` updated: `employeeId, employee.name, contact.name, relationship, contact.cellPhone, contact.homePhone, contact.workPhone, contact.address.street, contact.address.city, contact.address.state, contact.address.zip, sameAddressAsEmployee` — all `editable: true`.
- **No skipStep needed.** Emergency-contact has no extraction step in its handler — the records are the input. The kernel's `prefilledData` merge already populates `ctx.data` correctly.
- Dashboard's existing edit-data tab works on individual child rows out of the box.
- Detail fields gain new display-only entries: `contactPhone` (cell or home or work), `contactAddress` (one-line street).

### 6. Bug fixes

**Fuzzy duplicate detection + demote-existing** (`enter.ts`):
- Currently: `findExistingContactDuplicate` does strict normalized-equality and the workflow SKIPS adding when a match is found. This missed the "Tomako Langley" vs "Tomoko Longley" historical-typo case on Leo Longley (2026-04-27) and created a duplicate.
- Fix is two-part:
  1. **Detection**: Levenshtein distance ≤ 2 on normalized names. Returns `{ name, distance, isExact }`.
  2. **Action by match type**:
     - `distance === 0` (exact match): **skip** (current behavior — assume the form just reflects what's already there).
     - `0 < distance ≤ 2` (fuzzy match, likely historical typo of same person): **demote the existing contact** by unchecking its Primary Contact checkbox, then proceed to add the new contact as primary. This preserves history while making the correctly-spelled, current record the primary.
     - `distance > 2`: no match, add new normally.
- New helper needed: `demoteExistingContact(page, existingName)` — drill into the matching row, uncheck Primary Contact, save, return.
- Manual remediation for Leo's already-created duplicate: re-run the workflow on EID 10874572 with the new logic. The new run will see two existing contacts ("Tomako Langley" + "Tomoko Longley"), the new YAML's "Tomoko Longley" matches the second exactly (distance 0 → skip), and the first is left untouched. User then manually unchecks Primary on "Tomako Langley" in UCPath, OR we run a one-off remediation script.

**Same-address-when-blank** (`enter.ts` step 5):
- Currently: `if (!contact.address) { log.step("...leaving blank"); return; }` — leaves the box unchecked AND no address.
- Fix: when the YAML has `sameAddressAsEmployee: false` and `address: null`, treat it as `sameAddressAsEmployee: true` (check the box). Apply at the **YAML loader** level (`schema.ts` post-parse) — that way the prep handler, the existing CLI loader, and any future caller all benefit. Also keep the `!contact.address` guard in `enter.ts` as defense-in-depth.

**Dashboard "field never populated" warnings:**
- Fix: at the top of `emergencyContactWorkflow`'s handler, call `ctx.updateData({ emplId, contactName, relationship, contactPhone, contactAddress })` synthesized from `input`. The `onPreEmitPending` writes still run; this just satisfies the kernel's post-handler check.

## Matching contract

### Name match (roster lookup)

Tokenize both sides (lowercase, strip non-alpha). Compare:
1. Exact (sorted tokens equal) → score `1.0`.
2. Token-set intersection covers ≥ 80% of both sides → `0.9`.
3. First/last name swap (e.g., roster has "Doe, Jane" vs PDF "Jane Doe") → `0.85`.
4. Levenshtein distance ≤ 2 on full normalized name → `0.7`.
5. None of the above → `0.0`.

**Auto-accept threshold: `0.85`.** Score < 0.85 = `matchState: "extracted"` with `rosterCandidates[]` populated; UI shows "needs review" badge and the user picks from candidates or types an EID.

### Address match (US-focused)

Normalize:
- Lowercase.
- Strip punctuation (`,.;:`).
- Expand abbreviations: `st → street`, `ave → avenue`, `blvd → boulevard`, `dr → drive`, `rd → road`, `ln → lane`, `apt → apartment`, `ste → suite`, `n → north`, `s → south`, `e → east`, `w → west`, plus state-name normalization (`ca → california` etc., done with a fixed dict).
- Collapse whitespace.

Comparison rules (in order):
1. ZIP differs → no match.
2. Levenshtein distance on normalized street ≤ 3 → match.
3. Otherwise → differ.

`addressMatch` is a **sanity-check signal**, not a blocker. The user can override `sameAddressAsEmployee` in the edit form regardless of the computed value.

### EID resolution chain (per record)

```
record from OCR
   │
   ▼
EID present on form? ──yes──> matchState: "matched", matchSource: "form"
   │ no
   ▼
roster name match score >= 0.85 ? ──yes──> matchState: "matched", matchSource: "roster"
   │ no
   ▼
[lookup-pending → enqueue eid-lookup item with itemId "prep-{runId}-r{N}"]
[ensureDaemon for eid-lookup if not alive]
   │
   ▼
listen for eid-lookup-{date}.jsonl completions matching itemId
   │
   ▼
match found ? ──yes──> matchState: "resolved", matchSource: "eid-lookup"
   │ no
   ▼
matchState: "unresolved" — UI requires manual EID entry
```

## Two-mode run UX

### Mode A — "Download fresh from SharePoint"
1. Triggers existing `sharepoint-download` workflow (its own kernel run).
2. Waits for completion (mtime change in `src/data/`).
3. Adds 90-180s before OCR starts.
4. Failure (Duo not approved, file not found, etc.) → prep row goes `failed`, error message in `lastLogMessage`.

### Mode B — "Use existing roster"
1. Lists `src/data/*.xlsx` by mtime DESC.
2. Picks newest. UI shows the picked filename + age in days.
3. **Fails loudly if no .xlsx in `src/data/`** — prep row goes `failed` with `"No roster available — choose mode A or download manually."` per `feedback_fail_loud_over_auto_correct.md`.

## Storage

- **PDF uploads:** `.tracker/emergency-contact/uploads/{runId}-{originalSlug}.pdf`. Slug is `path.basename(file).replace(/[^A-Za-z0-9._-]/g, "_")` for safety.
- **Rosters:** `src/data/` (existing convention).
- **OCR cache:** `.ocr-cache/{sha256}.json` (project root, gitignored).
- **OCR rotation state:** `.ocr-cache/rotation-state.json` (gitignored).
- **Retention:** PDF uploads + OCR cache cleaned by extending `npm run clean:tracker` to sweep both directories on the same age threshold (default 7 days, configurable via `--days`).

## Daemon parity

- emergency-contact daemon already stays alive after batch completion (verified 2026-04-27 — `phase=idle, queue: queued=0 done=8 failed=0` after 8-record run). No code change needed.
- Document in CLAUDE.md that emergency-contact behaves like separations re: daemon lifecycle.

## Error handling matrix

| Failure | Where | Surface |
|---|---|---|
| OCR all keys exhausted | `ocrDocument` throws | Prep row `failed`, message: "All Gemini keys exhausted — retry tomorrow or fix .env." |
| OCR validation retry exhausted | `ocrDocument` throws | Prep row `failed`, message: "OCR returned data that didn't match schema after 2 retries." |
| Roster file missing (mode B) | `prepare.ts` early throw | Prep row `failed`, message: "No roster found in src/data/. Use mode A or download manually." |
| Roster download (mode A) failed | sharepoint-download fails | Prep row `failed`, message references sharepoint-download row id. |
| eid-lookup daemon spawn fails | `ensureDaemonsAndEnqueue` throws | Affected records → `matchState: unresolved` with warning. Other records can still be approved. |
| Approve with unresolved checked records | `/approve-batch` validation | HTTP 400, frontend already disables the button as primary defense. |
| Child enqueue fails partway | `/approve-batch` partial failure | Returns `{ enqueued: K, failed: [...records] }`. Parent stays `done`; user sees the failed subset and can retry just those. |
| User reloads mid-edit | localStorage repopulates form | Reload-safe; no backend round-trip needed. |

## Test plan

### Unit (vitest)
- `src/ocr/cache.test.ts` — cache hit/miss/bust, hash stability across whitespace differences in the schema.
- `src/ocr/rotation.test.ts` — state transitions for each error class, persistence round-trip.
- `src/workflows/emergency-contact/match.test.ts` — name-match scoring, US address normalization (table-driven), `sameAddressAsEmployee` computation.
- `src/workflows/emergency-contact/schema.test.ts` — same-address-when-null post-parse rewrite.

### Integration (vitest, mocked HTTP)
- Prepare endpoint happy path: one PDF, mocked Gemini response, 1 roster match + 1 eid-lookup-pending → row writes match the expected sequence.
- Approve-batch endpoint: validates parentRunId exists, enqueues correct number of items, sets `prefilledData.parentRunId`.
- Discard endpoint: marks parent cancelled.

### Manual end-to-end
- Run with a real PDF (the user's `Xerox Scan_04272026142351.pdf`) against the live UCPath. Expect the same 8 records to land identically to the 2026-04-27 hand-run.
- Geonmoo case: verify the saved record has "Same Address as Employee" checked.
- Discard then Run again: cache hits, OCR doesn't re-run, second run is fast.

## Open questions for follow-up specs

- Should the Run button be exposed for other workflows (onboarding-from-PDF, separations-from-Kuali-form)? Yes long-term, but the scaffolding is per-workflow `xxx-prepare` modules — no extra abstraction layer until two more workflows want it.
- Cross-provider fallback (Mistral, Groq, etc.) — defer to a v2 spec when we hit Gemini's daily quota in practice.
- Auto-save debounce per-cell vs save-on-Approve — we picked save-on-Approve + localStorage. Re-evaluate if multi-operator becomes a real use case.

## Implementation order (preview — full plan via writing-plans)

1. **Bug fixes** (urgent, ship before feature work):
   - Fuzzy duplicate detection (Levenshtein ≤ 2) — prevents new duplicates.
   - Same-address-when-null at YAML loader + enter.ts.
   - `ctx.updateData` for emplId/contactName/relationship/contactPhone/contactAddress at top of handler.
   - Manual: user inspects Leo Longley's UCPath record and deletes the duplicate "Tomoko Longley" we created on top of "Tomako Langley".
2. **Edit-data opt-in** — `editable: true` on detail fields. No skipStep. Smoke-test via dashboard's Retry on a child row.
3. **`src/ocr/` primitive** — Gemini provider + rotation + cache. Standalone, fully unit-tested before any consumer wires it up.
4. **`src/workflows/emergency-contact/match.ts` + `prepare.ts`** — roster + name + eid-lookup chain, address normalization, prep tracker writes.
5. **Backend HTTP endpoints** — `/api/emergency-contact/{prepare,approve-batch,discard-prepare}`, `/api/rosters`, multipart PDF handling, dashboard restart sweep for stuck prep rows.
6. **Dashboard frontend** — TopBar Run button, RunModal, PreviewRow, PreviewRecordRow, edit form with localStorage persistence, parent-child grouping render.
7. **Tests + docs** — vitest, CLAUDE.md updates per-module.
8. **Manual end-to-end** — re-run the user's `Xerox Scan_04272026142351.pdf` through the new flow; expect identical UCPath outcomes (modulo Leo dup remediation).
