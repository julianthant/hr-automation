# 06 — Data Intake (operator column mapping) & Edit Data over checkpoints

Status: **revised 2026-07-22 after the whole-plan/legacy-code review; amended 2026-07-26
(Round 8, §5.1 — the mobile-capture durability trim, D79d).** Intake now produces a
durable, replayable admission manifest; every data boundary is strict; scenario coverage and
evidence make partial/excluded rows impossible to mistake for silently completed work.

## Ownership (D1 — this doc owns / this doc references)

| This doc **owns** (siblings reference, never redefine) |
|---|
| The **operator column-mapping design** — the mapping object, per-source persistence + header fingerprint, the upload→map→validate→run UI flow, per-cell coercion, the unmapped-required block, fuzzy-suggestion policy |
| The **extraction** intake task designs (`extraction/parse-csv`, `extraction/parse-pdf-fields`), **roster** matching (`roster/match-spreadsheet`), and typed **normalization** service outcomes — their contract shapes + intake semantics |
| The **intake pipeline**: how a parsed+mapped dataset becomes N workflow inputs, and the pre-run per-row rejection review (nothing half-launches) |
| Durable mobile-photo capture intake: session/photo/finalization state, bundle outbox, artifact handoff, expiry, restart recovery, and phone-scope lifecycle (network exposure policy remains doc 12) |
| The **Edit-Data surface** — its data source, editable/read-only rules, the edit-during-resume concurrency rule |
| Roster/retention projection semantics: typed stable-key record, blocking outbox, idempotent xlsx upsert, and concurrent-edit conflict policy (storage/projector authority remains doc 03) |

| This doc **references** (owner) |
|---|
| **Canonical field definitions** — the field vocabulary + zod schemas live in `temp_src/domain/` (defined THERE). This doc owns the *mapping/intake semantics onto* those fields, not the vocabulary itself |
| Task contract/impl split (`defineTaskContract`/`defineTask`), service stores (D4), `freshness` field, error taxonomy → **doc 01** |
| The **injected-data mechanism** (`RunEnvelope.injected`, §5.6 #3), checkpoint store + resume scope (D9), freshness walk (D8), the "Live Edit Data over checkpoints" subsection → **doc 02** |
| SSE wire shapes (`detailSurfaces` incl. `edit-data`), `span.patched`, notes stream, SQLite projection role (D14) → **doc 03** |
| Standard CAS command path for Edit Data → **doc 03** |
| Scenario manifests, evidence receipts, run explanation, knowledge/fix records → **doc 12** |

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
redefine the field schemas. **The ids shown below are an excerpt, not the Phase-1 inventory.** Before
the registry freezes, D58/D68 scan every legacy workflow input/schema, roster/header rule, OCR form,
and Edit-Data field; each shared mappable concept is assigned one canonical id/schema or explicitly
remains a workflow-local strict field with a reason. No current mappable field may be silently
omitted because it was absent from this example. The registry entry shape is:

```ts
// temp_src/domain/fields/registry.ts  — domain-owned; imports zod + domain identity only
import { z } from "zod";

export type CanonicalFieldId = // excerpt; generated inventory/type is exhaustive in the build
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

**The load-bearing invariant—each mapped field uses the target field's exact schema.** A
spreadsheet-capable workflow declares an `intake` projection naming which input fields are mappable;
those field schemas reuse canonical schema objects rather than parallel regexes:

```ts
// temp_src/workflows/work-study/input.ts
export const WorkStudyInput = z.strictObject({
  emplId:        fields.eid.schema,            // same object the mapper coerces to
  effectiveDate: fields.effectiveDate.schema,
});
export const WorkStudyIntake = defineIntakeProjection(WorkStudyInput, {
  emplId: fields.eid, effectiveDate: fields.effectiveDate,
});
```

This proves each coerced cell satisfies its target field. The assembled row is still parsed through
the **full workflow schema**, so cross-field refinements/default interactions may reject it visibly;
the plan does not overclaim that field validity implies whole-input validity. A guard (§7 #6)
asserts every field exposed by an intake projection reuses its declared canonical schema. Workflows
may still have non-intake fields such as file refs, selectors, options, and discriminants.

> **Resolved base decision:** `Eid` means the canonical UCPath 8-digit identifier matching
> `/^10\d{6}$/` everywhere. The old `work-study`/`separations` `/^\d{5,}$/` validators are loose
> validation bugs, not evidence for a second domain value. Before each migration, scan its real
> fixtures/tracker inputs through the canonical schema and quarantine/report every rejection. If
> evidence proves a genuinely different source identifier exists, give it a domain-specific name
> and brand plus an explicit, verified conversion to `Eid`; never add a vague `legacyEid` or widen
> `Eid` globally.

---

## 2. Operator-defined column mapping

### 2.1 The mapping object (zod-typed)

```ts
// temp_src/domain/intake/mapping.ts  (domain — bundle-safe, zod only)
export const ColumnMapping = z.strictObject({
  workflow:       WorkflowIdSchema,
  /** Exact target-field set/schema this map was built against (D66). */
  intakeProjectionFingerprint: FingerprintSchema,
  /** header fingerprint of the source this mapping was built for (§2.3). */
  fingerprint:    Sha256Schema,
  savedAt:        IsoInstantSchema,         // provenance, drives stale display
  headerRowIndex: z.number().int(),        // which sniffed row is the header (parsers agree on this)
  /** Stable within one parsed layout: normalized header + duplicate occurrence. */
  columns:        z.array(z.strictObject({
    sourceColumnId: z.string(), header: z.string(), normalizedHeader: z.string(),
    occurrence: z.number().int().positive(), currentIndex: z.number().int(),
  })),
  /** Target-field binding, not canonical-concept binding (D66). Two target paths may intentionally
   * use the same canonical field, e.g. homeCity and mailingCity. */
  bindings: z.array(z.strictObject({
    targetFieldId: IntakeTargetFieldIdSchema,
    canonicalFieldId: CanonicalFieldIdSchema,
    sourceColumnId: SourceColumnIdSchema,
    confirmedAt: IsoInstantSchema,
  })),
});
export type ColumnMapping = z.infer<typeof ColumnMapping>;
```

The mapping binds each stable target id from `defineIntakeProjection` by
`sourceColumnId = base64url(canonicalJson({ normalizedHeader, occurrence }))`, never raw header,
delimiter concatenation, or position. Duplicate `Name` columns are distinct. Current index is diagnostic only; duplicate-header reuse
requires visible confirmation because reordered identical headings are semantically unknowable.
Load validates that every binding's target id still exists, its recorded canonical id matches the
current intake projection, no target appears twice, and the projection fingerprint is unchanged.
This permits two target fields with the same canonical concept without one binding overwriting the
other.

All saved mapping, parse result, validation request/result, intake plan, edit snapshot, and edit
command schemas are strict and versioned. Unknown keys are errors. Missing, blank, null, invalid,
and unresolved are distinct states; UI code never converts them to `""` or omits them to make a
schema pass. Canonical scalars (`WorkflowId`, `SourceColumnId`, SHA-256, EID, ISO instant/date,
artifact id) are branded at parse time, so equally shaped strings cannot be interchanged by a cast.

### 2.2 The UI flow (upload → map → validate → run)

1. **Upload.** Operator uploads a `.csv`/`.xlsx`. `extraction/parse-csv`|`parse-pdf-fields` (§3)
   returns the **detected columns + a few sample values per column** (never the whole file to the
   client at this stage — sample rows only).
2. **Map.** The mapping grid shows each stable target field/path the *target workflow* requires
   (+ optionals), including its canonical concept label,
   with a dropdown of detected source columns and each column's sample values inline. The operator
   connects each canonical field to a column. Fuzzy header matches appear as **suggestions** the
   operator confirms — never pre-applied (§2.5).
3. **Validate.** On "Validate", every data row is coerced+parsed against the bound target fields'
   canonical schemas
   (§2.4). The result is a **rows-valid / rows-rejected** split shown in the grid, each rejection
   naming the offending row + column + value.
4. **Run.** Enabled only when **every required target field is bound**, at least one row is valid,
   and the operator has reviewed the rejection list (§5). A valid zero-row intake is not a no-op
   success: it stays blocked with `no-valid-rows` and the manifest remains inspectable. Running fans
   out the *valid* rows as N workflow inputs; rejected rows are never launched.

### 2.3 Per-source persistence — header fingerprint (recommended scheme)

A recurring layout (the same weekly work-study export) should not be re-mapped each time. Reuse is
keyed by a **header fingerprint**:

```
fingerprint = sha256(canonicalJson(
  detectedColumns.map(c => ({ header: normalize(c.header), occurrence: c.occurrence }))
                 .sort(byHeaderThenOccurrence)
))
normalize(h) = h.trim().toLowerCase().replace(/\s+/g, " ")
```

Order-insensitive and unambiguous: canonical JSON preserves element boundaries, so `["a b","c"]`
cannot collide semantically with `["a","b c"]`. Duplicate counts/occurrences are included.
Saved at `config/column-mappings/<workflow>/<fingerprint>.json` (gitignored operator state, mirrors
`config/settings.json`).

- **Exact fingerprint hit** → the saved `ColumnMapping` is **pre-loaded into the grid, visibly**,
  and the operator still clicks Run. This is reuse-with-a-glance, **not** a silent auto-run — the
  operator always sees the resolved bindings before any row launches.
- **Stale-fingerprint guard (fail-closed).** Even on a hit, each bound field is re-resolved by
  normalized header + occurrence. A bound column that is now absent → that
  field reverts to **unmapped + loud** ("saved mapping bound `eid` to column 'Employee ID#', which is
  no longer present — re-map"). We never fall back to stored positional index (a
  column-insertion would then map the wrong column silently). The stored `index` is kept only to
  *detect* a header that moved. Any reused binding involving duplicate headers is marked
  `confirmationRequired`; Run remains disabled until the operator confirms samples.
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

The suggestion engine scores each detected header against every target field's referenced canonical
field `aliases` + `label` (the redesigned successor of `COLUMN_PATTERNS`). It **proposes** a binding (a highlighted
dropdown default the operator can accept in one click) but **never applies it** — the grid starts
with the field *unbound* and the suggestion shown as a hint. Rationale (charter fail-loud): a
confident-but-wrong header guess ("Name" → `fullName` when the file's real name is in "Legal Name")
is exactly the silent-substitution class we ban. Mechanically enforced: the mapping is only
`bindings`-populated by an operator action (accept-suggestion or manual pick); a guard (§7 #1)
asserts no code path writes `bindings` from the suggestion scorer directly.

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
  provenance: { default: "live" }, // observes these content-addressed bytes now
  freshness: { defaultMaxAgeMs: Infinity }, // content-addressed bytes do not age;
                                       // justified: re-parsing the same bytes is deterministic (grep ratchet).
  subject: { kind: "none", reason: "deterministic local artifact parsing" },
  scenarios: ["intake/csv/happy", "intake/csv/no-header", "intake/csv/duplicate-headers",
              "intake/csv/unreadable"],
  input:  z.strictObject({ fileRef: FileRefSchema, sheet: z.string().min(1).optional() }),
  output: z.strictObject({
    headerRowIndex: z.number().int().nullable(), // null means operator selection required
    headerCandidates: z.array(z.strictObject({ rowIndex:z.number().int(), cells:z.array(z.string()),
                                               confidence:z.number().min(0).max(1) })),
    columns: z.array(z.strictObject({ header: z.string(), index: z.number().int(),
                                      samples: z.array(z.string()) })), // sample values for the grid
    rows:    z.array(z.array(z.string())),                          // raw cell matrix, header-relative
  }),
  errorCodes: ["unreadable-file", "empty-sheet", "invalid-header-selection"],
  example: { /* … */ },
});
// parse-pdf-fields: same shape for a fielded PDF (onboarding's extraction step ports here).
```

- **Header discovery does not require a known alias.** The first 20 rows are ranked using generic
  structure (non-empty cell density, mostly-string cells, uniqueness, data rows beneath). Existing
  recognizable-header logic contributes confidence but is not a precondition. High confidence may
  preselect visibly; otherwise `headerRowIndex:null` and the operator chooses from candidate rows.
  The chosen row is re-parsed and validated before mapping.
- **Fail-loud stays.** Empty/unreadable sheets throw. If no plausible row exists, the UI requires an
  explicit row selection or rejects it; novel headings never abort before the mapping grid.
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
  provenance: { default: "derived" }, // carries subject+roster sources/oldest observedAt
  /** D8: a roster match may feed a WRITE (an OnBase upload keyed on the matched
   *  EID). A stale match must not silently ride into that write on resume. The base maximum is 24h;
   *  a consuming workflow may narrow it, never widen it without a reviewed policy change. */
  freshness: { defaultMaxAgeMs: 24 * 60 * 60_000 },
  subject: { kind: "none", reason: "pure cross-source roster matching" },
  scenarios: ["roster/match/exact-eid", "roster/match/name-only", "roster/match/ambiguous",
              "roster/match/name-eid-conflict", "roster/match/no-match"],
  input:  z.strictObject({
    subjects: z.array(z.strictObject({ subjectId: StableItemIdSchema,
                                 name: fields.fullName.schema.optional(),
                                 eid:  fields.eid.schema.optional() })),
    rosterFileRef: FileRefSchema,
    mapping: ColumnMapping,                     // the roster is operator-mapped too (§2)
  }),
  output: z.array(z.strictObject({
    subjectId:       StableItemIdSchema,
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
  commit transaction, naming the roster + age + limit.

### 4.1 Mutable retention workbooks are serialized projections, not read-task side effects

`i9-check` currently appends to a master retention workbook. Calling that append part of the
`roster/match-spreadsheet` read would make task retry duplicate rows and would violate the effect
contract. The rebuilt roster task therefore returns only the typed match/retention record. Its
workflow descriptor declares a `DurableArtifactProjectionSpec` that names the exact producing
node+field, a canonical record schema, a stable non-positional key (subject identity plus document/
roster version), the `xlsx-retention` sink, and `blocking:true`.

The checkpoint and stable-keyed `artifact_outbox` row commit atomically in SQLite. One sink
projector holds the local exclusive lease, verifies the workbook's previously recorded content
hash, applies an idempotent upsert in memory, writes temp → fsync → atomic replace, and records the
new hash before acknowledging the outbox. A duplicate key is a verified no-op/update, never a
second append. If the operator or another process changed the workbook since the last head, the
projector parks the run with both hashes and preserves both files; it never overwrites concurrent
edits. Because the projection is blocking, the member cannot report `done` until the outbox is
acknowledged. The finite sink registry is infrastructure keyed by sink kind, not another workflow-id
registry; descriptor coverage validates every source/key path and sink id.

Input/download `FileRef` values are likewise content-addressed artifact references created through
doc 01's atomic writer, not arbitrary mutable paths.

### 4.2 Contact/address normalization is typed advice, not a silent fallback

The old path mixes deterministic phone/state/ZIP cleanup, Census→Nominatim fallback, and optional
LLM inference inside `services/llm/normalize-contact.ts`; provider failure collapses to `null`, which
is indistinguishable from “nothing needed changing.” The rebuild exposes one reusable
`normalization/normalize-contact` read contract whose output names what happened:

```ts
const ContactFieldIdSchema = z.enum([
  "relationship", "cellPhone", "homePhone", "address1", "address2",
  "city", "state", "postalCode", "country",
]);
const NormalizationChangeSchema = z.strictObject({
  field: ContactFieldIdSchema,
  before: RedactedValueSchema,
  after: CanonicalJsonValueSchema,
  source: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("rule"), ruleId: NormalizationRuleIdSchema }),
    z.strictObject({ kind: z.enum(["census", "nominatim"]),
                     observedAt: IsoInstantSchema, evidence: EvidenceRefSchema }),
    z.strictObject({ kind: z.literal("ai"), provider: AiProviderIdSchema,
                     model: AiModelIdSchema, confidence: z.number().min(0).max(1) }),
  ]),
});
export const NormalizeContactOutputSchema = z.strictObject({
  normalized: ContactFieldsSchema,
  changes: z.array(NormalizationChangeSchema),
  disposition: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("complete") }),
    z.strictObject({ kind: z.literal("advisory-unavailable"),
                     unavailable: z.array(ProviderFailureSchema).nonempty() }),
    z.strictObject({ kind: z.literal("ambiguous"),
                     fields: z.array(ContactFieldIdSchema).nonempty() }),
  ]),
});
```

Deterministic rules execute first. Provider-backed paths are individually observed and recorded;
one provider may try the next provider only through a declared, scenario-pinned provider policy.
Exhaustion is `advisory-unavailable`, not an empty change list. AI/geocoder values never overwrite
OCR/input silently: the review gate shows before/after/source/confidence and accepted changes become
operator-correction provenance. Ambiguous or unavailable **mandatory** fields block approval; truly
optional suggestions may yield `done-with-warnings` only under doc 12's evidence rule. The contract
uses a finite freshness budget for provider-derived facts and registers rule-only, each-provider,
rate-limit/failure, malformed-model-output, ambiguous, and approval/rejection scenarios.

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

Before enqueue, validation produces one immutable, strict `IntakePlanManifest`:

```ts
const RejectLocation = {
  rejectId: RowRejectIdSchema,
  sourceRow: z.number().int().positive(),
  code: IntakeErrorCodeSchema,
  reason: z.string().min(1),
};
export const RowRejectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...RejectLocation, kind: z.literal("unmapped-required"),
                   field: IntakeTargetFieldIdSchema }),
  z.strictObject({ ...RejectLocation, kind: z.literal("cell-coercion"),
                   field: IntakeTargetFieldIdSchema, column: SourceColumnRefSchema,
                   raw: RedactedValueSchema }),
  z.strictObject({ ...RejectLocation, kind: z.literal("field-schema"),
                   field: IntakeTargetFieldIdSchema, column: SourceColumnRefSchema,
                   raw: RedactedValueSchema, issues: z.array(BoundaryIssueSchema).nonempty() }),
  z.strictObject({ ...RejectLocation, kind: z.literal("workflow-schema"),
                   path: WorkflowInputPathSchema, issues: z.array(BoundaryIssueSchema).nonempty() }),
  z.strictObject({ ...RejectLocation, kind: z.literal("duplicate-identity"),
                   itemId: ItemIdSchema, collidingSourceRows: z.array(z.number().int().positive()).min(2) }),
  z.strictObject({ ...RejectLocation, kind: z.literal("cross-field"),
                   paths: z.array(WorkflowInputPathSchema).min(2) }),
]);

export const IntakePlanManifestSchema = z.strictObject({
  version: z.literal(1),
  planId: IntakePlanIdSchema,
  workflow: WorkflowIdSchema,
  source: z.strictObject({ artifactId: ArtifactIdSchema, sha256: Sha256Schema,
                           originalName: z.string().min(1) }),
  mappingFingerprint: Sha256Schema,
  mappingSnapshotHash: Sha256Schema,
  workflowContractFingerprint: FingerprintSchema,
  createdAt: IsoInstantSchema,
  totals: z.strictObject({ sourceRows: z.number().int().nonnegative(),
                           valid: z.number().int().nonnegative(),
                           rejected: z.number().int().nonnegative(),
                           rejectionEvents: z.number().int().nonnegative(),
                           excluded: z.number().int().nonnegative(),
                           corrected: z.number().int().nonnegative() }),
  /** Exactly one current disposition per source row; totals are derived from this, never guessed
   * from the event arrays. */
  sourceRowDispositions: z.array(z.strictObject({
    sourceRow: z.number().int().positive(),
    disposition: z.enum(["valid", "rejected", "excluded"]),
    itemId: ItemIdSchema.optional(),
    currentRejectIds: z.array(RowRejectIdSchema),
  })),
  validRows: z.array(z.strictObject({ sourceRow: z.number().int().positive(),
                                     itemId: ItemIdSchema, inputHash: Sha256Schema,
                                     parsedInput: CanonicalJsonValueSchema })),
  rejectedRows: z.array(RowRejectSchema),
  /** Corrections never rewrite the source artifact. The parsed value is revalidated through the
   * canonical field and full workflow schemas before it appears in validRows. */
  corrections: z.array(z.strictObject({
    sourceRow: z.number().int().positive(),
    field: IntakeTargetFieldIdSchema,
    original: RedactedValueSchema,
    correctedValue: CanonicalJsonValueSchema,
    correctedAt: IsoInstantSchema,
  })),
  exclusions: z.array(z.strictObject({ sourceRow: z.number().int().positive(),
                                      reason: z.string().min(1), operatorConfirmedAt: IsoInstantSchema })),
});
```

`parsedInput` is stored under the generic canonical-JSON envelope only because manifests cover many
workflows. No caller casts or reads it as a workflow input directly: manifest load, rerun, and
enqueue resolve the named descriptor and parse each value through that descriptor's exact current
transform-free `canonicalInput` schema (D62), never its ingress parser. The stored workflow
fingerprint controls whether that is a same-contract replay or a
visible migration/diff. A parse failure quarantines the manifest; it never reaches a task bind.

The manifest is the rerun/explanation authority: it proves which file and mapping were used, which
rows became which stable items, which cells were corrected without rewriting the source, which rows
were rejected or explicitly excluded, and the exact validated input hashes. Invariants verify that
every source row is represented exactly once in the final valid/rejected/excluded disposition and every
correction points to that row's source value. `rejectedRows` and `rejectionEvents` are immutable
validation history and may overlap a later corrected valid row; consequently the manifest stores a
separate current disposition per source row (`valid|rejected|excluded`) and does not infer it by
adding historical event arrays. Schema refinement requires `itemId` only for `valid`, at least one
current reject id only for `rejected`, neither for `excluded`, unique source-row coverage from
`1..totals.sourceRows`, exact derived totals, and `valid > 0` before enqueue. “Rerun with existing data” references this manifest
and immutable artifact; it revalidates against the current workflow fingerprint and shows a diff
before creating a new run. It never silently reparses a changed file or applies a newer mapping.

**The pre-run rejection review is mandatory—nothing silently half-launches (charter fail-loud).** `Run` is
disabled until (a) every required canonical field is bound and (b) the operator has seen the reject
list. `RowRejectSchema` is a strict discriminated union whose variants are `unmapped-required`,
`cell-coercion`, `field-schema`, `workflow-schema`, `duplicate-identity`, and `cross-field`; every
variant carries source row, canonical field/path when applicable, source column id/header,
redacted raw value, stable error code, and legible reason. The operator either
**fixes the cell in the intake grid** (re-coerces that row live) or **excludes it** — an unresolved
rejection is never silently dropped into or out of the run. Only the `valid` set fans out; a partial
file may run only after every non-valid row has a durable rejection or explicit exclusion in the
manifest. Coordinator, all member inputs, stable ids, dependency rows, and the intake manifest are
inserted atomically; a single invalid input/constraint failure creates none of them.

This is the structural version of "the parsed+mapped dataset becomes N workflow inputs": each
assembled input has passed the full strict workflow schema, so the fan-out cannot enqueue a member
the workflow input schema then rejects. The coordinator evidence receipt displays source/valid/
excluded/enqueued counts plus rejection-event and correction history and links to the manifest; `done` can never imply every source row
ran when exclusions exist.

### 5.1 Mobile photo capture is a recoverable artifact-intake source

> **Scope trim (D79d, operator 2026-07-24) — read before implementing.** Phone capture is
> **rarely used**: most documents arrive as scanned PDFs. So this section's durability obligations
> are cut to the two that matter, and the rest is explicitly not built:
> **KEEP** — durable capture sessions (an open session survives a dashboard restart) and **one
> durable finalize outbox** (bundle → register → enqueue either succeeds visibly or fails visibly;
> it can never return success and silently lose the handoff, which is the actual recorded failure).
> **CUT** — the restart-between-every-state scenario matrix. Proving restart recovery from each of
> six session states, for the lowest-stakes subsystem in the program, is ceremony. Two crash points
> are covered: restart with an **open** session, and restart **mid-finalize**.
> This trim touches test surface only; the schemas and the outbox contract below are unchanged.

Capture is an input-acquisition service, not a workflow and not an in-memory callback. Its strict
SQLite authority records are:

```ts
export const CaptureSessionSchema = z.strictObject({
  sessionId: CaptureSessionIdSchema,
  tokenDigest: Sha256Schema,                 // raw phone token is never logged/projected
  workflow: WorkflowIdSchema,
  formType: OcrFormTypeSchema.optional(),
  contextHint: z.string().max(200).optional(),
  state: z.enum(["open", "finalizing", "finalized", "failed", "discarded", "expired"]),
  version: z.number().int().positive(),
  createdAt: IsoInstantSchema,
  connectedAt: IsoInstantSchema.optional(),
  expiresAt: IsoInstantSchema,
  photoRefs: z.array(z.strictObject({
    photoId: CapturePhotoIdSchema,
    artifact: ArtifactRefSchema,             // immutable converted JPEG/PNG bytes + digest
    ordinal: z.number().int().nonnegative(),
    originalMediaType: MediaTypeSchema,
  })),
  finalArtifact: ArtifactRefSchema.optional(),
  handoff: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("pending") }),
    z.strictObject({ kind: z.literal("enqueued"), runId: RunIdSchema,
                     intakePlanId: IntakePlanIdSchema }),
    z.strictObject({ kind: z.literal("failed"), failureId: FailureIdSchema }),
  ]),
});

/** D67 command-family arm; each payload is strict and commandId/requestedAt/reason come from doc
 * 03's CommandEnvelope. Upload bytes are accepted into a temporary bounded request stream and
 * become an ArtifactRef before this authority mutation commits. */
export type CaptureCommandRequest = CommandEnvelope & (
  | { type: "capture-upload" | "capture-replace";
      target: { sessionId: CaptureSessionId; expectedVersion: PositiveInt };
      payload: CapturePhotoMutationPayload }
  | { type: "capture-reorder";
      target: { sessionId: CaptureSessionId; expectedVersion: PositiveInt };
      payload: { orderedPhotoIds: readonly CapturePhotoId[] } }
  | { type: "capture-delete";
      target: { sessionId: CaptureSessionId; expectedVersion: PositiveInt };
      payload: { photoId: CapturePhotoId } }
  | { type: "capture-finalize" | "capture-retry-finalize" | "capture-discard";
      target: { sessionId: CaptureSessionId; expectedVersion: PositiveInt }; payload?: never }
);
```

- **Every mutation is versioned and idempotent.** Upload/replace/reorder/delete/finalize/discard
  takes a command id plus expected session version. Duplicate phone retries return the prior result;
  stale ordering/finalize requests conflict and reload. These are doc 03 D67
  `CaptureCommandRequest` arms, not route-local mutations. Only `finalized|discarded|expired` are
  terminal and never reopen; `failed` is a durable recoverable state whose Retry Finalize command
  creates a new finalization generation/outbox under CAS without changing photo identity/order.
- **Photos are immutable refs.** HEIC conversion happens before acceptance; the server validates
  decoded image type/dimensions/size, writes through the content-addressed artifact writer, and
  records only refs/order. Replace changes the ref; it never overwrites bytes. Empty, corrupt,
  oversized, duplicate, and conversion-failure scenarios are explicit.
- **Finalize is an outbox, not fire-and-forget.** The finalize command atomically sets
  `state:"finalizing"` and inserts one stable-keyed bundle/handoff outbox. A serialized projector
  builds temp PDF → validates page count/digest → content-addressed atomic publish, then one SQLite
  transaction records `finalArtifact`, creates the immutable intake/OCR manifest and downstream run,
  marks the outbox done, and sets `finalized`. Crash at every boundary replays the same outbox. The
  phone says “Sent” only after polling/receiving `finalized`; a failure is `failed` with Retry
  Finalize/Discard—not silently converted to `discarded`.
- **Restart and expiry are authoritative.** Open/finalizing/failed sessions reload after dashboard
  restart. The Clock drives the 15-minute pre-connect and 60-minute active idle budgets; expiry is a
  durable transition and notification. Artifact retention distinguishes active evidence from
  expired/discarded staging, with cleanup only after the recorded retention boundary.
- **The handoff uses the same intake proof.** The bundled PDF gets a `FileRef`, source digest,
  capture-session id, ordered photo digests, and form/workflow binding in its manifest. The
  downstream descriptor parses it like any upload; no special `pdfPath` or callback bypass exists.
- **Network scope is explicit.** The loopback dashboard starts no public listener by default. When
  the operator starts capture, a short-lived ingress/tunnel may serve only the phone asset and
  token-scoped manifest/upload/replace/reorder/delete/finalize/status routes. Start/list/discard,
  queue, files, settings, evidence, and commands remain loopback-only (doc 12 §7).

Mandatory scenarios cover restart between every state, duplicate/reordered phone requests, expired
token, HEIC conversion, corrupt/empty image, bundle failure/retry, crash before/after artifact
publish and before/after enqueue commit, wrong form/workflow binding, and attempts to reach a
non-capture route through the phone origin. The dashboard shows session state, photo count/order,
bundle digest/page count, handoff run, expiry, and structured failure.

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

The snapshot reads checkpoint values plus descriptor/contract/implementation fingerprints and
field-level provenance `{ source, observedAt?, correctedAt?, supersedes? }`.

### 6.2 What is editable vs read-only

| Run state | Edit Data |
|---|---|
| **Parked at a gate** (approval / await-signatures / identity-approval) | **Visible; explicitly declared fields editable.** Descriptor `capabilities.editData.fields` names node+field paths. Default is read-only, never "all checkpoint JSON." |
| **Stopped / failed** (terminal but resumable — `single`, real `operation-member`, D9) | Same explicit field policy; an accepted edit becomes `injected` on retry/resume. |
| **Running** (actively claimed, a live task owns a page) | **READ-ONLY** — the run's checkpoints are being written by the live task; editing not-yet-written state is meaningless and racy. Show live checkpoint state read-only. |
| **Terminal `done`** | **Read-only.** Correcting-and-rerunning a done item is the *separate* new-input path (§6.5), not Edit Data. |
| **Display-only rows** (operation coordinators, i9 display-only members) & **OCR per-page internals** | **No Edit-Data tab** — D9 excludes them (nothing to resume). |

### 6.3 Editing = typed field patches; editing is not freshness

An edit is **not** a free-form blob write. Each editable path is explicitly declared on the
descriptor and checked against the producing contract's output schema. Stable item/match identity,
workflow input, idempotency-key inputs, write intent/proof/receipt fields, and provenance metadata are
structurally non-editable; changing identity or original input uses the separate new-input path.
Each edited step value is parsed against **the producing contract's full output schema after applying
the patch. A bad edit is
rejected loudly at save time. Changed fields receive operator-correction provenance and link to the
superseded fact. Untouched fields retain their original live-source `observedAt`; saving one edit
does not refresh the whole checkpoint. Operator-corrected values do not assert current external
truth. If a corrected/old fact reaches a commit beyond its source freshness limit, resume requires
the normal explicit, field-scoped audited freshness override **only if that field's contract permits
one**; identity/idempotency/proof fields always require a live read rerun.

This is why Edit Data is safe where the `prefilledData` hack was not: the hack edited stringified
`data` and re-injected it as accumulated strings *bypassing* schema parse (`splitPrefilled` strips
before validation); the new path parses every edit through the **same** contract schema that produced
the value, so a corrupt edit cannot enter the run.

### 6.4 Concurrency — edit-during-resume is fail-closed (loud), the resume wins

A parked run holds no browser (D5), so normally no task executes while the operator edits. But a
resume can be triggered concurrently (a watcher gate resolving, an operator elsewhere clicking
Retry). **Rule: the resume claim is the fence; the Edit-Data save is a compare-and-swap against it.**

- The operator loads the snapshot at generation `G` (`attempt` + span-seq).
- On Save, the UI issues doc 03's standard `edit-checkpoint` command. Its injected-checkpoint write
  is a **conditional SQLite transaction**: it commits only if
  the run is still in a non-executing state at generation `G` — i.e. **no `run.claimed` for a newer
  attempt** has landed and the gate has not resolved since load.
- If a resume claimed the run between load and save, the CAS **fails and the save is rejected
  loudly**: *"run `sp-0912-4c2e` resumed while you were editing — your edit was not applied; reload
  the current state."* The **resume wins**; the command is rejected and the proposed patch remains
  only in the local editor for copy/review, never silently merged into a
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
| 1 | **Fuzzy header auto-applies a wrong binding** (Name→fullName when Legal Name is the real one) | Suggestions are hints only; a guard asserts `ColumnMapping.bindings` is written ONLY by an operator action, never by the scorer. Fingerprint reuse pre-loads a *visible* mapping the operator still confirms (§2.3) |
| 2 | **Coercion swallows a bad cell** (a malformed EID becomes `""` or a guessed value) | `field.coerce` throws a per-cell error naming row/column/value; the cell becomes a **row rejection** (§5), never a substituted default. `fail-loud-catch-default` + `nullish-literal-data-fallback` ratchets extend to `temp_src/intake` from day one |
| 3 | **Mapping reuse on a changed/duplicate layout** | unambiguous canonical-JSON fingerprint; bindings resolve by header+occurrence; missing columns unmap; duplicate headings require visible sample confirmation; index never silently binds |
| 4 | **A rejected row silently vanishes (or a partial file launches)** | `Run` is disabled until the reject list is reviewed; only the `valid` set fans out; each reject carries row/column/value/reason and must be fixed or explicitly excluded (§5) — nothing half-launches |
| 5 | **An Edit-Data save races a resume and clobbers a running item** | The save is a CAS against the resume-claim fence at generation `G`; a concurrent claim → **loud reject, resume wins** (§6.4). Running-task checkpoints are read-only outright (§6.2) |
| 6 | **An intake projection re-declares a regex looser than its canonical field** | Guard asserts every *mapped* input key points at the same `CanonicalField.schema` object; non-intake workflow fields remain legal. The full assembled input still parses through the workflow schema; every migrated legacy EID fixture is audited against canonical `Eid`, and a truly distinct identifier must get a separately named/validated domain type (§1) |
| 7 | **Roster match fabricates an EID on no-match** | `matchedEid` is `nullable`; `mismatch:"no-match"` is a first-class output; the caller falls through to person-lookup — a guard bans `?? "<eid-literal>"`-shaped fallbacks in the roster impl |
| 8 | **A stale roster match rides into a write on resume** | finite field freshness + declared DAG walk refuses stale facts feeding a commit; an unrelated Edit Data patch cannot reset their observed time |
| 9 | **Novel headers never reach mapping** | parser candidate generation is alias-independent; fixture with zero known aliases must reach header selection + mapping rather than throw |
| 10 | **Edit Data changes identity or write proof** | Default read-only; descriptor allowlists exact node+field paths. Guard rejects item/match/idempotency/proof/provenance paths and paths absent from the producing schema; the full patched output re-parses |
| 11 | **A rerun called “same data” actually uses a changed file, mapping, or workflow schema** | rerun references an immutable `IntakePlanManifest`; artifact/mapping/contract hashes are compared and any difference requires a visible new-plan diff + confirmation |
| 12 | **A partial intake looks like all source rows completed** | coordinator/evidence receipt always shows source, valid, rejected, explicitly excluded, enqueued, and terminal counts; manifest/member insert is atomic and counts are invariant-checked |
| 13 | **Two target fields sharing one canonical concept overwrite each other** | bindings key on the intake projection's stable target-field id and also record its canonical field id; duplicate targets, changed projection fingerprints, or canonical mismatch fail before validation (D66) |

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
   valid) and row 31 to `10998801` (valid). Now **42 valid, 0 unresolved**; the immutable manifest
   still records two rejection events and two corrections linked to the original cells. The mapping is saved under
   `config/column-mappings/work-study/<fingerprint>.json` for next week's identically-shaped export.
5. **Run.** `Run` enables; 42 inputs fan out as an `operation` coordinator + 42 `operation-member`
   rows, each input `WorkStudyInput`-valid by construction.
6. **A member parks / stops.** Member #12 (`emplId 10456712`) parks at a gate (or fails at a step).
   The operator opens **Edit Data**, sees the run's checkpoint state (typed, per step), and corrects
   `effectiveDate` on the relevant checkpoint — the edit parses against the producing contract's
   output schema (loud if wrong), and records correction provenance on that field. Other live facts
   retain their original observed times. If the corrected value reaches a commit, the operator
   explicitly confirms a field-scoped freshness override or reruns its source read. Had a concurrent resume claimed the run first, the save would
   have been rejected loudly and the resume would have won (§6.4).

---

## 9. Settled intake defaults

1. ~~Canonical EID width~~ — **resolved 2026-07-22:** adopt `/^10\d{6}$/` everywhere and audit the
   loose legacy consumers at migration. A genuinely different source identifier gets a distinct
   domain type and explicit conversion; there is no `legacyEid` escape hatch (§1).
2. ~~Mapping storage location~~ — **resolved 2026-07-21:** versioned, schema-validated JSON at
   `config/column-mappings/<workflow>/<fingerprint>.json`, written temp+fsync+rename. It is
   operator-greppable configuration, not run authority; malformed files fail loud and never fall
   back to a nearest mapping.
3. ~~Roster freshness budget~~ — **resolved 2026-07-22:** 24h is the conservative base maximum and
   consumers may narrow it. File mtime is not truth (copying a file changes it); freshness is the
   observation time of the immutable content-addressed roster artifact. Crossing the budget requires
   a new artifact/match or an allowed audited field override, never an mtime substitution (§4).
4. ~~Suggestion engine source of truth~~ — **resolved:** aliases live on `CanonicalField`; the
   suggestion engine consumes them but cannot write a mapping without operator action.
5. ~~Edit-Data on a `done` item~~ — **resolved:** read-only. Correction/rerun is always the separate
   new-input/new-item path; a done item's identity, proof, and checkpoints are never reopened.
