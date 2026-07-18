# 06 — Data Intake (operator column mapping) & Edit Data over checkpoints

Status: **Phase 0 design — for operator review.** Conforms to `00-charter.md` (§11 first-class
`extraction`/`ocr`/`roster` service systems + operator-defined column mapping onto canonical fields;
§12 Edit Data over checkpoints; fail-loud non-negotiable) and to `04-reconciliation.md` (D3 contract/
impl split, D4 service stores, D6 RunEnvelope, D8 freshness, D9 resume scope). Slotting is
`07-master-plan.md`'s: the service **stores** are Phase 1h (they need only 01+11); the **column-
mapping + Edit-Data UI** land in the scoped dashboard-flip window (§3.5 there), off the critical path.

## Ownership (D1 — this doc owns / this doc references)

| This doc **owns** (siblings reference, never redefine) |
|---|
| The **operator column-mapping design** — the mapping object, per-source persistence + header fingerprint, the upload→map→validate→run UI flow, per-cell coercion, the unmapped-required block, fuzzy-suggestion policy |
| The **extraction** intake task designs (`extraction/parse-csv`, `extraction/parse-pdf-fields`) and the **roster** matching task designs (`roster/match-spreadsheet`) — their contract shapes + intake semantics |
| The **intake pipeline**: how a parsed+mapped dataset becomes N workflow inputs, and the pre-run per-row rejection review (nothing half-launches) |
| The **Edit-Data surface** — its data source, editable/read-only rules, the edit-during-resume concurrency rule |

| This doc **references** (owner) |
|---|
| **Canonical field definitions** — the field vocabulary + zod schemas live in `temp_src/domain/` (defined THERE). This doc owns the *mapping/intake semantics onto* those fields, not the vocabulary itself |
| Task contract/impl split (`defineTaskContract`/`defineTask`), service stores (D4), `freshness` field, error taxonomy → **doc 01** |
| The **injected-data mechanism** (`RunEnvelope.injected`, §5.6 #3), checkpoint store + resume scope (D9), freshness walk (D8), the "Live Edit Data over checkpoints" subsection → **doc 02** |
| SSE wire shapes (`detailSurfaces` incl. `edit-data`), `span.patched`, notes stream, SQLite projection role (D14) → **doc 03** |

Grounding (read, not imagined): `src/services/matching/roster-loader.ts` (today's **hardcoded**
`COLUMN_PATTERNS` header regexes — the thing operator mapping replaces),
`src/dashboard/components/ocr/shared/match-confidence.ts` (confidence→tier bucketing),
`src/domain/identity/{eid,ocr-person-name}.ts` (canonical EID + name shapes),
`src/workflows/{work-study,separations,person-lookup}/schema.ts` (target input shapes),
`src/dashboard/components/log-panel/EditDataTab.tsx` + `/api/{run-with-data,save-data,find-prior-by-key}`
+ the kernel `prefilledData`/`splitPrefilled` side-channel (the Edit-Data hack this replaces).

---

## 0. What today does, and what specifically hurts

- **Roster ingest hardcodes the schema.** `roster-loader.ts` recognizes columns via a fixed
  `COLUMN_PATTERNS` table (`/^ucpath\s*id$|^empl(oyee)?\s*id$/i`, `/first\s*name/i`, …) and dynamic
  header-row sniffing. A spreadsheet whose column is `"Employee ID#"` or `"Student Name"` — real
  operator layouts — silently yields `eid = ""` or is skipped, because no operator ever *told* the
  system which column means what. It works only for the layouts someone pre-baked a regex for.
- **Ingest is not schema-validated at the source.** Parsed rows flow onward as loose
  `RosterRow`/blob shapes; a malformed EID or date surfaces much later (a wrong UCPath search, a
  failed write) instead of at the cell that was wrong.
- **Edit Data is a side channel.** The dashboard's Edit-Data tab POSTs `prefilledData`; the kernel's
  `splitPrefilled` strips it *before* schema parse and re-injects it as accumulated strings
  (`/api/run-with-data`) or overlays a terminal row (`/api/save-data`). It is gated on
  `detailFields.some(f => f.editable)` and only **separations** opts in. There is no typed contract
  for "what data does this run currently hold" — the tab edits stringified `data`, not checkpoints.

The new model makes intake **operator-mapped and schema-validated by construction**, and makes Edit
Data a **typed view of the run's checkpoints** edited through doc 02's `injected` mechanism.

---

## 1. Canonical field registry (vocabulary lives in `temp_src/domain/`, referenced here)

The closed, typed field vocabulary is domain-owned (charter §11). This doc consumes it; it does not
redefine the field schemas. The registry entry shape (domain-defined) is:

```ts
// temp_src/domain/fields/registry.ts  — domain-owned; imports zod + domain identity only
import { z } from "zod";

export type CanonicalFieldId =
  | "eid" | "firstName" | "lastName" | "fullName" | "email"
  | "deptId" | "department" | "effectiveDate" | "kualiDocId";   // closed union — one-line edit to grow

export interface CanonicalField<S extends z.ZodType = z.ZodType> {
  id: CanonicalFieldId;
  label: string;                       // "Employee ID (EID)"
  /** THE schema. A workflow input schema composes from this SAME object, so a
   *  value the mapper coerces is, by construction, valid for the workflow input. */
  schema: S;
  /** string cell → pre-parse value (z.input<S>). Throws a legible per-cell error
   *  naming the row + column + value on a bad cell (fail-loud — §2.4). */
  coerce: (raw: string, loc: CellLocation) => z.input<S>;
  /** Header-name hints for the SUGGESTION engine only — NEVER auto-applied (§2.5). */
  aliases: readonly string[];
  /** Canonical sample values — power the mapping-grid preview + fuzzy suggestion. */
  examples: readonly string[];
}
```

`eid` reuses `src/domain/identity/eid.ts`: `coerce` runs `normalizeEid` (strip non-digits) then the
schema is `z.string().regex(/^10\d{6}$/)` (doc 01 §9.1 `SearchPersonOrg` + `isUcpathEmployeeId`).
`firstName`/`lastName`/`fullName` reuse `ocr-person-name.ts` shapes (title-cased "Last, First").
`effectiveDate`/date fields coerce `MM/DD/YYYY` via the ported `dates.ts` helpers.

**The load-bearing invariant — "mapped ⇒ schema-valid" holds by construction.** A workflow input
schema is *assembled from* canonical field schemas, never a parallel re-declaration:

```ts
// temp_src/workflows/work-study/input.ts
export const WorkStudyInput = z.object({
  emplId:        fields.eid.schema,            // same object the mapper coerces to
  effectiveDate: fields.effectiveDate.schema,
});
```

So an operator mapping that satisfies the workflow's *required canonical fields* cannot produce a
value the workflow input schema then rejects — the schema is literally the same node. A guard
(§7 #6) asserts every workflow input field is a canonical-field schema (no ad-hoc re-declared
regex), which is what keeps this true.

> **Reconciliation flag (open, §9):** today's `work-study`/`separations` accept a *looser* EID
> (`/^\d{5,}$/`) than canonical `/^10\d{6}$/`. That divergence is real and must be resolved at
> migration (adopt the canonical field, or declare a distinct `legacyEid` field with its own
> schema) — **not** papered over by widening the canonical field, which would weaken every consumer.

---

## 2. Operator-defined column mapping

### 2.1 The mapping object (zod-typed)

```ts
// temp_src/domain/intake/mapping.ts  (domain — bundle-safe, zod only)
export const ColumnMapping = z.object({
  workflow:       z.string(),
  /** header fingerprint of the source this mapping was built for (§2.3). */
  fingerprint:    z.string(),
  savedAt:        z.string(),              // ISO — provenance, drives stale display
  headerRowIndex: z.number().int(),        // which sniffed row is the header (parsers agree on this)
  /** the source columns as detected, by header string AND positional index (§2.3 stale guard). */
  columns:        z.array(z.object({ header: z.string(), index: z.number().int() })),
  /** canonical field id → the source header it is bound to. A required field
   *  absent from this map is a LOUD block at run time (§2.4). */
  bind:           z.record(z.enum(CANONICAL_FIELD_IDS), z.string()),
}).strict();
export type ColumnMapping = z.infer<typeof ColumnMapping>;
```

The mapping binds by **header string**, not index — a reordered spreadsheet with the same headers
reuses cleanly; a renamed/removed header does not silently rebind (§2.3).

### 2.2 The UI flow (upload → map → validate → run)

1. **Upload.** Operator uploads a `.csv`/`.xlsx`. `extraction/parse-csv`|`parse-pdf-fields` (§3)
   returns the **detected columns + a few sample values per column** (never the whole file to the
   client at this stage — sample rows only).
2. **Map.** The mapping grid shows each canonical field the *target workflow* requires (+ optionals),
   with a dropdown of detected source columns and each column's sample values inline. The operator
   connects each canonical field to a column. Fuzzy header matches appear as **suggestions** the
   operator confirms — never pre-applied (§2.5).
3. **Validate.** On "Validate", every data row is coerced+parsed against the bound canonical fields
   (§2.4). The result is a **rows-valid / rows-rejected** split shown in the grid, each rejection
   naming the offending row + column + value.
4. **Run.** Enabled only when **every required canonical field is bound** and the operator has
   reviewed the rejection list (§5). Running fans out the *valid* rows as N workflow inputs; the
   rejected rows are never launched.

### 2.3 Per-source persistence — header fingerprint (recommended scheme)

A recurring layout (the same weekly work-study export) should not be re-mapped each time. Reuse is
keyed by a **header fingerprint**:

```
fingerprint = sha256( detectedHeaders.map(normalize).sort().join(" ") )
normalize(h) = h.trim().toLowerCase().replace(/\s+/g, " ")
```

Order-insensitive (a reordered-but-same-columns file reuses; binding is by header string anyway).
Saved at `config/column-mappings/<workflow>/<fingerprint>.json` (gitignored operator state, mirrors
`config/settings.json`).

- **Exact fingerprint hit** → the saved `ColumnMapping` is **pre-loaded into the grid, visibly**,
  and the operator still clicks Run. This is reuse-with-a-glance, **not** a silent auto-run — the
  operator always sees the resolved bindings before any row launches.
- **Stale-fingerprint guard (fail-closed).** Even on a hit, each bound field is **re-resolved by its
  header STRING** against the freshly detected columns. A bound header that is now absent → that
  field reverts to **unmapped + loud** ("saved mapping bound `eid` to column 'Employee ID#', which is
  no longer present — re-map"). We never fall back to the stored positional `index` (a
  column-insertion would then map the wrong column silently). The stored `index` is kept only to
  *detect* a header that moved (diagnostic), never to bind.
- **Fingerprint miss** → treated as a brand-new layout: no reuse, fuzzy suggestions only. A
  near-miss layout can never partially reuse a stale mapping.

### 2.4 Per-field coercion + loud per-cell errors

Coercion is per canonical field (`field.coerce`), then the value is `field.schema.parse`d. A bad
cell **throws a legible error naming row + column + value** — never a substituted default, never a
skipped cell counted as valid:

```
CellCoercionError: work-study intake, row 12, column "Employee ID#" (→ eid):
  value "10-4567" is not a UCPath EID (must be 10xxxxxx, 8 digits).
```

Dates (`MM/DD/YYYY`), EIDs (`normalizeEid` then `/^10\d{6}$/`), names (title-cased) each have their
own coercion; a coercion that cannot produce a schema-valid value is a **row rejection** (§5), not a
guessed value. A whole-column coercion that fails on *every* row is surfaced as a likely **mis-map**
hint ("column 'DeptCode' bound to `effectiveDate` — all 42 rows failed date coercion; wrong column?").

### 2.5 Fuzzy header auto-match — SUGGESTIONS only, never silent auto-apply

The suggestion engine scores each detected header against every canonical field's `aliases` +
`label` (the redesigned successor of `COLUMN_PATTERNS`). It **proposes** a binding (a highlighted
dropdown default the operator can accept in one click) but **never applies it** — the grid starts
with the field *unbound* and the suggestion shown as a hint. Rationale (charter fail-loud): a
confident-but-wrong header guess ("Name" → `fullName` when the file's real name is in "Legal Name")
is exactly the silent-substitution class we ban. Mechanically enforced: the mapping is only
`bind`-populated by an operator action (accept-suggestion or manual pick); a guard (§7 #1) asserts no
code path writes `bind` from the suggestion scorer directly.

---

## 3. Extraction store tasks (service store — D4)

`extraction` is a service store (`sessions: []`, no browser, no `page` ctx). Contracts live in
`temp_src/domain/contracts/extraction/`; impls in `temp_src/stores/extraction/tasks/` (doc 01 §3.4).

```ts
// temp_src/domain/contracts/extraction/parse-csv.ts   (effect: "read")
export const ParseCsv = defineTaskContract({
  id: "extraction/parse-csv",
  title: "Parse CSV/XLSX into rows + detected columns",
  effect: "read",
  freshness: { maxAgeMs: Infinity },   // a parsed file's bytes don't age — the FILE is content-addressed;
                                       // justified: re-parsing the same bytes is deterministic (grep ratchet).
  input:  z.object({ fileRef: FileRef, sheet: z.string().optional() }),
  output: z.object({
    headerRowIndex: z.number().int(),
    columns: z.array(z.object({ header: z.string(), index: z.number().int(),
                                samples: z.array(z.string()) })),   // sample values for the grid
    rows:    z.array(z.array(z.string())),                          // raw cell matrix, header-relative
  }),
  errorCodes: ["no-header-row", "unreadable-file", "empty-sheet"],
  example: { /* … */ },
});
// parse-pdf-fields: same shape for a fielded PDF (onboarding's extraction step ports here).
```

- **Header detection ports the proven logic** (`roster-loader.ts` `findHeaderRow` — first row with a
  recognizable cell, scan first 20 rows, ExcelJS cell-object coercion `cellToString`) — but the
  *column-meaning* decision is no longer baked in; it moves to operator mapping (§2). The parser
  reports the columns; the operator says what they mean.
- **Fail-loud stays.** No recognizable header row → `ctx.fail("no-header-row", …)`, never "return
  zero rows" (parity with today's throw).
- The task is pure/deterministic; its output feeds §5's mapping+fan-out, never a write directly.

---

## 4. Roster store tasks (service store — D4)

`roster` matches one dataset against another (a mapped spreadsheet against extracted OCR records, or
two rosters), producing per-subject matches with confidence.

```ts
// temp_src/domain/contracts/roster/match-spreadsheet.ts   (effect: "read")
export const MatchSpreadsheet = defineTaskContract({
  id: "roster/match-spreadsheet",
  title: "Match subjects against a roster",
  effect: "read",
  /** D8: a roster match may feed a WRITE (an OnBase upload keyed on the matched
   *  EID). A stale match must not silently ride into that write on resume, so
   *  this is a real, finite budget — NOT Infinity. */
  freshness: { maxAgeMs: 24 * 60 * 60_000 },   // 24h — a roster download older than a day is re-fetched (§9 OQ)
  input:  z.object({
    subjects: z.array(z.object({ name: fields.fullName.schema.optional(),
                                 eid:  fields.eid.schema.optional() })),
    rosterFileRef: FileRef,
    mapping: ColumnMapping,                     // the roster is operator-mapped too (§2)
  }),
  output: z.array(z.object({
    subjectIndex:    z.number().int(),
    matchedEid:      fields.eid.schema.nullable(),
    matchConfidence: z.number().min(0).max(1),  // 0–1 — same axis as today
    tier:            z.enum(["high", "medium", "low"]),   // ported bucketing (below)
    mismatch:        z.enum(["none", "name-eid-conflict", "no-match", "ambiguous"]),
  })),
  errorCodes: ["roster-unreadable", "no-name-column"],
  example: { /* … */ },
});
```

- **Match confidence ports `match-confidence.ts` HONESTLY.** The confidence→tier thresholds
  (`high ≥ 0.6` = the backend `LLM_HIGH_CONFIDENCE` cutoff, `low < 0.4`, non-finite → `low`) are a
  **live-verified pure mapping** — they port **verbatim** into a domain module both the roster task
  and the dashboard badge import (no re-implementation). The *scoring* that produces the 0–1
  confidence (name/address/EID alignment) is **redesigned** onto the canonical fields and must be
  **re-verified** at the roster migration (order 3) — flagged as redesigned, not claimed
  live-verified.
- **Mismatch surfacing.** A `name-eid-conflict` (the roster's name and EID point at different people)
  or `ambiguous` (multiple candidates) is a **first-class output field**, not a swallowed default —
  the intake review (§5) and the OCR approval cards surface it exactly like today's `warnings` +
  `MatchConfidenceBadge`. A match the roster cannot make is `matchedEid: null` + `mismatch:"no-match"`
  (the caller then falls through to person-lookup), **never** a fabricated EID.
- **Freshness (D8).** Because a roster match can feed a write, the contract declares a finite
  `maxAgeMs`; the resume freshness walk (doc 02 §5.5) refuses a stale replayed match feeding a
  mutate step, naming the roster + age + limit.

---

## 5. Intake pipeline: mapped dataset → N inputs, with a pre-run rejection review

The mapping (§2) + the parsed rows (§3) + any roster match (§4) compose into **N workflow inputs,
one per valid row**, feeding the run-surface fan-out (the multi-subject `operation` coordinator +
`operation-member` children, doc 02):

```
parse-csv → detected columns ─┐
operator ColumnMapping ────────┼─► coerce+parse each row ─► { valid: WorkflowInput[], rejected: RowReject[] }
(optional) roster match ───────┘                                    │
                                                                    ▼
                                        operator reviews REJECTED before Run  ── nothing launches yet
                                                                    │  (Run enabled only after review)
                                                                    ▼
                                        fan out `valid` as N inputs → operation coordinator + members
```

**The pre-run rejection review is mandatory — nothing half-launches (charter fail-loud).** `Run` is
disabled until (a) every required canonical field is bound and (b) the operator has seen the reject
list. Each `RowReject` carries `{ rowIndex, field, column, value, reason }`. The operator either
**fixes the cell in the intake grid** (re-coerces that row live) or **excludes it** — an unresolved
rejection is never silently dropped into or out of the run. Only the `valid` set fans out; a partial
file never produces a run where some rows silently vanished.

This is the structural version of "the parsed+mapped dataset becomes N workflow inputs": each input
is `field.schema`-valid by construction (§1), so the fan-out cannot enqueue a member the workflow
input schema then rejects.

---

## 6. The Edit-Data surface (charter §12)

Edit Data is a **typed view of a run's checkpoint state**, edited through doc 02's `injected`
mechanism. It replaces the `prefilledData`/`splitPrefilled`/`save-data` side channel entirely.

### 6.1 Data source — fetch the snapshot, SSE only signals staleness

**Decision: the editable checkpoint snapshot is FETCHED (request/response), not SSE-streamed; the
per-run SSE topic is consumed only as an invalidation signal.** Justification:

- Checkpoints are **SQLite system-of-record** (D14) — low-frequency, not a stream.
- An editable form must be a **consistent point-in-time snapshot**; a form whose values mutate under
  the operator's cursor (a live SSE feed) is a footgun.
- Doc 03 already keeps per-run detail as request/response + a per-run SSE topic. Edit Data fetches
  the checkpoint snapshot on open (carrying a **generation token** — the run's `attempt` + the
  latest span sequence it was loaded against). The per-run SSE topic's `run.claimed`/`gate.resolved`
  events are consumed **only** to warn "this run just resumed — your edit is stale" (drives the
  fail-closed reject in §6.4 *before* the operator wastes effort).

The snapshot reads the `run_checkpoints` rows (doc 02 §5.7) for the item, keyed by step, each with
its `captured_at`, `schema_hash`, and `source` (`task` | `operator`).

### 6.2 What is editable vs read-only

| Run state | Edit Data |
|---|---|
| **Parked at a gate** (approval / await-signatures / identity-approval) | **Editable** — every `replay:"checkpoint"` step output is editable before resume. This is the charter §12 case: checkpoint state always live-visible + editable. |
| **Stopped / failed** (terminal but resumable — `single`, real `operation-member`, D9) | **Editable** — an edit becomes `injected` on the retry/resume. |
| **Running** (actively claimed, a live task owns a page) | **READ-ONLY** — the run's checkpoints are being written by the live task; editing not-yet-written state is meaningless and racy. Show live checkpoint state read-only. |
| **Terminal `done`** | **Read-only.** Correcting-and-rerunning a done item is the *separate* new-input path (§6.5), not Edit Data. |
| **Display-only rows** (operation coordinators, i9 display-only members) & **OCR per-page internals** | **No Edit-Data tab** — D9 excludes them (nothing to resume). |

### 6.3 Editing = doc 02's `injected` mechanism (schema-parsed, source:"operator", fresh captured_at)

An edit is **not** a free-form blob write. Each edited step value is parsed against **the producing
contract's output schema** (per-field via `schema.shape[field]`, doc 02 §5.6 #3). A bad edit is
rejected **loudly at save time** — naming the zod path — never at 2am mid-run. A good edit becomes a
`run_checkpoints` row flagged `source:"operator"` with a **fresh `captured_at`** (injection time), so
it enters the freshness walk (D8) like any checkpoint. On resume, the engine treats it exactly as if
the producing step had run — the run proceeds with the corrected value.

This is why Edit Data is safe where the `prefilledData` hack was not: the hack edited stringified
`data` and re-injected it as accumulated strings *bypassing* schema parse (`splitPrefilled` strips
before validation); the new path parses every edit through the **same** contract schema that produced
the value, so a corrupt edit cannot enter the run.

### 6.4 Concurrency — edit-during-resume is fail-closed (loud), the resume wins

A parked run holds no browser (D5), so normally no task executes while the operator edits. But a
resume can be triggered concurrently (a watcher gate resolving, an operator elsewhere clicking
Retry). **Rule: the resume claim is the fence; the Edit-Data save is a compare-and-swap against it.**

- The operator loads the snapshot at generation `G` (`attempt` + span-seq).
- On Save, the injected-checkpoint write is a **conditional SQLite transaction**: it commits only if
  the run is still in a non-executing state at generation `G` — i.e. **no `run.claimed` for a newer
  attempt** has landed and the gate has not resolved since load.
- If a resume claimed the run between load and save, the CAS **fails and the save is rejected
  loudly**: *"run `sp-0912-4c2e` resumed while you were editing — your edit was not applied; reload
  the current state."* The **resume wins**; the edit is dropped, never silently merged into a
  now-executing run.
- Symmetrically, the resume path never blocks on an open editor — it just claims; the open editor
  discovers it is stale via the SSE `run.claimed` signal (§6.1) and disables Save before the operator
  even tries.

Fail-closed by construction: an unknown/raced state → reject, never last-writer-wins, never apply an
edit onto a run that has moved on. (Editing a *running* task's checkpoints is forbidden outright,
§6.2, so the only race is park/stop ↔ resume, which the CAS closes.)

### 6.5 Edit Data before first start — the intake grid is a SEPARATE surface (shared core)

**Decision: the pre-first-start intake correction grid (§5) and the checkpoint Edit-Data tab are
SEPARATE surfaces that share ONE pure per-cell coercion/validation core.** Justification:

- They **parse against different schemas**: the intake grid parses each row against the *workflow
  input* schema (pre-run); Edit Data parses each field against the *producing contract's output*
  schema (mid-run). Same UX ("loud per-cell error naming row/column/value"), different contract.
- They have **different lifecycles + endpoints**: doc 02 §5.6 #4 already mandates that new-input and
  injected are *separate endpoints* — "`injected` is rejected on a new-input run" so changed input
  can never silently ride stale context. Merging the two grids into one would blur exactly that
  boundary.
- Sharing the pure coercion/validation module (the successor of `validateEditField` +
  `mmddyyyyToYmd`) keeps the two surfaces consistent without coupling their contracts.

So: **intake grid** = correct cells before N inputs fan out (§5); **Edit-Data tab** = correct a
parked/stopped run's checkpoints before resume (§6.1–6.4). One validation core, two surfaces, two
endpoints.

---

## 7. Adversarial self-review — silent-fallback vectors and their guards

| # | Silent-fallback vector | Mechanical guard |
|---|---|---|
| 1 | **Fuzzy header auto-applies a wrong binding** (Name→fullName when Legal Name is the real one) | Suggestions are hints only; a guard asserts `ColumnMapping.bind` is written ONLY by an operator action, never by the scorer. Fingerprint reuse pre-loads a *visible* mapping the operator still confirms (§2.3) |
| 2 | **Coercion swallows a bad cell** (a malformed EID becomes `""` or a guessed value) | `field.coerce` throws a per-cell error naming row/column/value; the cell becomes a **row rejection** (§5), never a substituted default. `fail-loud-catch-default` + `nullish-literal-data-fallback` ratchets extend to `temp_src/intake` from day one |
| 3 | **Mapping reuse on a changed layout via stale fingerprint** | Fingerprint is a content hash of normalized headers; binding re-resolves by header STRING, never stored index; a missing header → unmapped+loud, never a positional silent rebind (§2.3) |
| 4 | **A rejected row silently vanishes (or a partial file launches)** | `Run` is disabled until the reject list is reviewed; only the `valid` set fans out; each reject carries row/column/value/reason and must be fixed or explicitly excluded (§5) — nothing half-launches |
| 5 | **An Edit-Data save races a resume and clobbers a running item** | The save is a CAS against the resume-claim fence at generation `G`; a concurrent claim → **loud reject, resume wins** (§6.4). Running-task checkpoints are read-only outright (§6.2) |
| 6 | **A workflow input re-declares a regex looser than the canonical field** (mapped-⇒-valid breaks) | Guard asserts every workflow input field is a `CanonicalField.schema` reference, not an inline `z.string().regex(...)`; the EID divergence is an explicit migration decision (§1 flag / §9), not a silent widening |
| 7 | **Roster match fabricates an EID on no-match** | `matchedEid` is `nullable`; `mismatch:"no-match"` is a first-class output; the caller falls through to person-lookup — a guard bans `?? "<eid-literal>"`-shaped fallbacks in the roster impl |
| 8 | **A stale roster match rides into a write on resume** | Contract declares finite `freshness.maxAgeMs`; doc 02's bind-graph freshness walk refuses a stale match feeding a mutate step, naming roster+age+limit (D8) |

Honest residual (no full mechanical guard): the redesigned roster *scoring* (0–1 confidence) is only
verified at the roster migration (order 3) live-verify — the *tiering* ports verbatim, the *scoring*
is new code and must be re-checked against real rosters, not assumed.

---

## 8. Worked example — a work-study spreadsheet, end to end

Operator uploads `WorkStudy_July.xlsx` targeting the work-study workflow.

1. **Upload → parse.** `extraction/parse-csv` sniffs the header row and returns three columns:
   `"Employee ID#"`, `"Student Name"`, `"Dept"` (+ sample values per column). Fingerprint computed.
2. **Map.** No saved mapping for this fingerprint (first time). The grid shows the two required
   canonical fields — `eid`, and a name field — plus optional `department`. Fuzzy suggestions
   highlight `"Employee ID#"→eid`, `"Student Name"→fullName`, `"Dept"→department`; the operator
   accepts each with a click (never auto-applied). `effectiveDate` is a workflow constant typed once
   in the run panel (not a spreadsheet column) — a required *input* field with no column bound is a
   loud block until supplied.
3. **Validate.** 42 rows coerce. **40 pass**; **2 reject**, each named loudly:
   - row 17, column `"Employee ID#"` → `eid`: value `"10-4567"` — not a UCPath EID (must be 10xxxxxx).
   - row 31, column `"Employee ID#"` → `eid`: value `"TBD"` — not numeric.
4. **Fix in the intake grid.** The operator corrects row 17's cell to `10456712` (re-coerces live →
   valid) and row 31 to `10998801` (valid). Now **42 valid, 0 rejected**. The mapping is saved under
   `config/column-mappings/work-study/<fingerprint>.json` for next week's identically-shaped export.
5. **Run.** `Run` enables; 42 inputs fan out as an `operation` coordinator + 42 `operation-member`
   rows, each input `WorkStudyInput`-valid by construction.
6. **A member parks / stops.** Member #12 (`emplId 10456712`) parks at a gate (or fails at a step).
   The operator opens **Edit Data**, sees the run's checkpoint state (typed, per step), and corrects
   `effectiveDate` on the relevant checkpoint — the edit parses against the producing contract's
   output schema (loud if wrong), commits as a `source:"operator"` checkpoint with a fresh
   `captured_at`, and the operator **Resumes**. The freshness walk passes (fresh edit), and the run
   proceeds with the corrected value. Had a concurrent resume claimed the run first, the save would
   have been rejected loudly and the resume would have won (§6.4).

---

## 9. Open questions for the operator / orchestrator

1. **Canonical EID width** — adopt `/^10\d{6}$/` everywhere (breaking work-study/separations' looser
   `/^\d{5,}$/`), or add a distinct `legacyEid` field? (§1 flag.) Proposed: adopt canonical; audit the
   loose consumers at their migration.
2. **Mapping storage location** — `config/column-mappings/<workflow>/<fingerprint>.json` (gitignored,
   mirrors settings), or a SQLite table? Proposed: JSON files (operator-greppable, matches the
   settings/design-scaffold precedent).
3. **Roster freshness budget** — is 24h the right `maxAgeMs` for a roster match feeding a write, or
   should it key off the roster file's mtime vs a fixed window? (§4.)
4. **Suggestion engine source of truth** — do the `aliases` live on the canonical field (domain), or
   in an intake-owned suggestion table? Proposed: on the field (one home for "what this field is
   called in the wild"), consumed by intake.
5. **Edit-Data on a `done` item** — is "correct and rerun" always the new-input path (§6.5), or is
   there a case for editing a done item's checkpoints to feed a *targeted* resume-from-step? Proposed:
   new-input only; keep the two endpoints separate (§6.5 rationale).
