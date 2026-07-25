# Rebuild demo — production feature & data plan (2026-07-25)

**Status:** working plan. This is a **features/data** document, not a design document — it says WHAT
the demo frontend must show and WHAT data the production backend will serve for it. A separate
design pass decides how each surface looks (bound by the §6.6 visual-parity directive and
`shell-build-spec-2026-07-25.md`).

**Question this answers:** the operator's "we need our frontend to show what our backend can serve
properly" — a coverage plan so `?view=rebuild-demo` becomes a faithful preview of every capability
the rebuilt backend serves, instead of a polished subset.

**Companions:** `legacy-keep-ditch-2026-07-25.md` (row/log-panel verdicts) ·
`delegation-layouts-2026-07-25.md` (S0–S7 shapes, the 12 open questions) ·
`shell-build-spec-2026-07-25.md` (pixel spec for the four shell surfaces) ·
`docs/rebuild/03-tracker-dashboard.md` (wire contract) · `second-look-2026-07-22.md` §6.5–6.6
(ratified decisions).

---

## 0. Ground rules

1. **Ratified decisions override stale doc text.** Doc 03 predates the 2026-07-24 decision sheet.
   Where they conflict, this plan follows §6.6: **pause-until-done** (no lift adapter, no scoped
   flip, no engine/cutoverGeneration on the wire, no quarantine surface), **8 first-class statuses
   with review-as-status**, **3 row types**, **run rename**, **archive-on-version-bump**,
   **actor attribution everywhere**, **notifications slimmed to read/unread + snooze with
   Ping-vs-Inbox routing**.
2. **The demo consumes wire shapes, not a hand-authored view model.** Today `demo-data.ts` is a
   module constant shaped for the components. The single biggest structural change in this plan:
   restructure the demo world model as **mock server projections typed as the wire contract**
   (§1 below), and have every demo component render only those. That is literally "the frontend
   shows what the backend can serve" — if a surface can't be drawn from the wire shape, the wire
   shape (or the surface) is wrong, and we find out in the demo instead of in production.
3. **Naming canon** (operator's words, final): Workflow Panel · Status Bar · Queue Panel ·
   Queue Row · Log Panel · Session Panel · Session Card · Run Modal. Everything below uses these.
4. **Demo-only code stays demo-only** — `dev/rebuild-demo/` is deleted when real components ship;
   never imported from production code.

---

## 1. The wire contract the demo must model

This is the data inventory. Every field here is something the production backend will serve
(citations: doc 03 §2.2 unless noted; §6.6 = second-look ratifications). The demo's world model
should be typed as these shapes.

### 1.1 `QueueSurfaceWire` — one Queue Row (reconciled)

```ts
interface DemoQueueSurface {                    // ← doc 03 QueueSurfaceWire + §6.6 amendments
  // identity — stamped once at enqueue, immutable
  runId: string;  itemId: string;               // stable business key
  workflow: { id: string; code: string; label: string; icon: IconName; category: string };
  traceId: string;                              // <code>-<HHMMSS>-<runId4>, frozen
  rowType: "run" | "group" | "member";          // §6.6 D1 (3 ratified types)
  subjectKind: "person" | "file" | "catalog";
  parentRunId?: string;
  containment?: "member" | "linked" | "rejected"; // delegation ledger §3 — drives WHERE it renders
  attempt: number;  retryOf?: string;           // cross-run retry lineage

  // presentation — server-resolved, client never derives
  title: string;  subtitle: string;             // kind dispatch + "EID else trace id" rule
  displayName?: string;                         // §6.6 operator rename — rides row + receipt
  status: { key: Status8; label: string; tone: Tone; secondaryTag?: string };
  liveMessage?: string;                         // lastLogMessage → error → step fallback chain

  // run facts
  dryRun: boolean;                              // chip — the rehearsal/real separator
  priority: "interactive" | "bulk";
  resolvedInstance: Partial<Record<BrowserSystemId, "prod" | "test">>;  // doc 11 §4
  workflowVersion: number;  appVersion: string; // §6.6 version stamps (archive keying)
  enqueuedAt: string; startedAt?: string; endedAt?: string;  // queue-wait + elapsed derive
  requestedBy: string;                          // actor attribution (M1) — "local-operator" today

  // pipeline — the persistent strip; real recorded durations, never reconstructed
  pipeline: {
    step: string; label: string;
    state: "pending" | "running" | "done" | "failed" | "cancelled" | "skipped";
    durationMs?: number; attempt?: number; system?: SystemId;
    hover?: { keyLogLines: string[]; screenshotRef?: string };   // §6.6 hover-depth rule
  }[];
  gates: { gate: string; open: boolean; statusKey?: string; openedAt?: string;
           resolutionKey?: string }[];          // waiting age = now − openedAt (delegation Q7)

  // actions — footer buttons derive ONLY from this (keep/ditch §4.2); never client status branches
  actions: ActionDescriptorWire[];              // command|navigation + expectedVersion (CAS)

  // group only
  memberRunIds?: string[];                      // ids, never nested trees (D10)
  memberRollup?: { status: Status8; count: number }[];
  rejectedCount?: number;                       // excluded from rollup (D3)
  checkedCount?: { done: number; total: number };  // operator "checked by you" progress

  // detail routing
  detailSurfaces: DemoTab[];                    // capability-driven tabs (panel kind)
  links?: { review?: { workflow: string; runId: string } };   // D4 jump chip

  // trust
  evidence: { receiptId?: string; failureId?: string;
              confidence: "verified" | "partial" | "unknown" };
  warnings?: { count: number; first: string };
}
type Status8 = "queued" | "running" | "waiting" | "parked"
             | "verifiedDone" | "doneWarnings" | "failed" | "cancelled";
```

**Status mapping rules the demo must encode** (keep/ditch §1, §6.6): legacy
`needsReview`/`awaitingApproval` → `waiting`; `notFound`/`dismissed`/`skipped` → `doneWarnings`
(with `secondaryTag`); outcomes `discarded` → `cancelled` family, `interrupted` → `failed` with a
legible reason; `superseded` runs leave the active queue. **Group rollup precedence** (one
server-side function): waiting > failed > parked > running > queued > doneWarnings >
verifiedDone > cancelled.

### 1.2 Per-run detail (Log Panel data) — request/response + per-run SSE topic

| Block | Fields the backend serves | Source |
|---|---|---|
| **Span tree** | task spans (real `durationMs`, `attempt`, outcome incl. `skipped` for `when:false` branches), gate open/resolve events with timestamps, run outcome | 03 §1.1 |
| **Notes (log stream)** | `ts`, `level: step\|success\|error\|waiting\|warn\|debug`, `message`, `fields[]` (closed KV), `action` (semantic UI id + page-state transition — never a raw selector), `attachment` (screenshot \| data-point \| diagnostic). Run-scoped only — daemon heartbeats never enter a run's stream | 03 §1.1 |
| **Data points** | `{ step, dir: read\|write, field, value, system, ts, provenance { source: live\|derived\|operator; observedAt; correctedAt?; supersedes? }, staged? }` | 01 §2.3, 06 §6.1 |
| **Checkpoint snapshot** (Data tab edit mode) | per-step outputs + field-level provenance + **generation token**; descriptor-allowlisted editable paths; identity/input/idempotency/proof/provenance structurally read-only | 06 §6 |
| **Receipt** (`RunEvidenceReceipt`) | input (redacted + hash) · observations · decisions · actions · verification · output · **reuse** (fresh live / checkpoint / corrected / prior-proof) · warnings · `confidence` · `result`. **Q8 acceptance:** confirmation/transaction number + post-submit screenshot + observed person-identity at commit — double-check without opening UCPath | 12 §2.3, §6.6 Q8 |
| **Failure detail** (`FailureRecord`) | stable `fingerprint`, `code`, `summary`, `transient`, subject expected/observed, page screen/state/redacted URL, failed action (element + operation), cause chain, **remediation actions**, diagnostic-bundle link, "same failure seen before" links | 12 §2.1 |
| **Evidence/screenshots** | content-addressed refs, kind (step/error/form), error frame flag, per-record OCR page images | 03 §2.1, 12 §2.2 |
| **Run history** | attempt list + `retryOf` lineage (RunSelector), **rerun diff**: input changed?, checkpoint reused vs rerun (age/freshness/provenance), operator-corrected fields, prior write-proof reused (no click) vs new fenced write. "Never label replayed data as newly observed" | 12 §2.4 |
| **Review records** (OCR panel-kind only) | per record: page image ref + extracted fields with per-field provenance (`paper 0.44` / `roster` / `ucpath`) + confidence, match warnings + tier (high/med/low), mismatch (`name-eid-conflict`/`ambiguous`/`no-match`), completeness checks, per-check relookup, ready/flagged/blocked state | 06 §4, keep/ditch §2 |

### 1.3 Commands (the one protocol — doc 03 §2.4 + D67, slimmed per §6.6)

Everything below is an idempotent envelope + CAS `expectedVersion` (enforced where races exist);
every command records `requestedBy`. **The demo must render actions only from the server-sent
`actions[]`, and must model the three result states: `applied`, `conflict` (stale version → forced
refresh), `rejected` (typed code + message).**

| Family | Commands | Frontend obligations |
|---|---|---|
| Run | `retry` · `cancel` (tree-scoped, confirm names casualties — delegation Q11) · `bump` · `hide`/`unhide` (never "Delete") · `rename` (§6.6) | status-gated per row from `actions[]`; rejected members are delete(hide)-only by construction |
| Data | `edit-checkpoint` (CAS vs resume; stale → loud rejection, patch preserved locally) · freshness-override confirm (audited fields only) · rerun-with-existing-data (shows manifest diff first) · rerun-with-different-input (separate command) | 06 §6, 02 §5.6 |
| Write park | `resolve-write-present` (proof parsed through the completion proofSchema, incl. operator-attestation arm) · `resolve-write-absent` (non-empty evidence note) — **the ONLY two actions; no generic Done/Retry exists** | 09 §4.1 |
| Gate | `resolve-gate` (typed per gate: approval approve/discard, identity-approval pick-EID/manual/dismiss) | 02 §4 |
| Bulk | retry/cancel/bump/hide over frozen target+version sets; `all-or-none` \| `best-effort` returning the **complete applied/conflict/rejected vector — the UI may never collapse a partial result into "Done"** | 03 §2.4 |
| Notification | read/unread · snooze(until) | §6.6 Q10 slim |
| Enqueue | typed input-run / upload-run starts; policies `reject-active` \| `supersede-active` \| `allow-parallel`; instance prod/test request; dry-run flag | 02 §1.1, 11 §4 |

### 1.4 Hub payload (SSE) — what arrives push-side

`descriptorHash` (skew tripwire) · `queue` surfaces per subscribed panel + `queuePatch` (one
changed surface, never the member tree) · `wfCounts` + `wfQueuedCounts` (backend-authoritative,
same collapse as the panel — the §6.6 acceptance requirement) · `sessions` (executor-card
projections) · `notifications`. *(Doc 03's `quarantine` topic is cut — pause-until-done.)*

### 1.5 Session Panel → executor cards (doc 05)

Worker span **per executor process** (not per workflow), with browser child spans:
`instance`, `pidAlive`, `crashedOnLaunch`, `daemonPhase (idle|keepalive)`, in-flight run's
`currentTraceId` (subtitle while in flight ONLY), `finalStatus`, lanes in use,
**per-system `in-use / cap`** (BudgetSnapshot), browsers keyed by `browserId` (never index):
`system`, `authState (idle|authenticating|authed|duo_waiting|failed)`, `health
(healthy|refreshing|unhealthy|failed|paused|unknown — never-probed shows unknown)`,
recovery-ladder commands (check/front/refresh/reopen/pause-resume), queued count, add-worker
options (join the shared queue). Contention is visible: `waiting`-on-lease notes, sleep-per-task.

### 1.6 Beyond the queue — the rest of the served surface

| Area | Data served | Source |
|---|---|---|
| **Notifications inbox** | durable records: `notificationId`, dedupeKey, trigger (run failed · gate opened · write recovery needs you · subject mismatch · storage/backup failure · repeated fingerprint · capture/projection done/failed), severity, `read\|unread` + snooze, `count`/lastSeen dedupe, link to run/failure/storage; **routing: failed/gate/parked/repeating/storage = Ping (silent); verified-done = Inbox**; actor-keyed | 03 §2.6 slimmed, §6.6 Q10 |
| **Search** | tracker history matches (email, EID, docId, name, trace) — **fail-loud**: a failed search renders an error state, never "no matches" | shell spec §1 |
| **Intake (Run Modal / spreadsheets)** | header-row candidates + confidence; detected columns + samples; mapping grid (target field + canonical label × source column); fuzzy suggestions (1-click accept, never pre-applied); saved-mapping fingerprint hit / missing-column loud revert / duplicate-header confirm; per-cell coercion rejects naming row+column+value; whole-column mis-map hint; exclude-with-reason; workflow-constant inputs; **`IntakePlanManifest`** totals + per-row dispositions; rerun diff; zero-valid-rows block | 06 §2–5 |
| **Input runs** | `surfaces.inputRun` (placeholder, parser, supportsDryRun, emptyOpensUpload) per descriptor; N>1 typed values mint a Group (S5); presets | 02 §1.1 |
| **Settings** | effective value + **source (env > settings > default)** per leaf; System URLs prod/test split; Performance (lanes, per-system pool modes read-only + 3 budget caps, OCR concurrency, timeouts); preflight/doctor results (`pass|warning|fail` + blocks + remediation — advisory-only); **storage health**: backup age/health, authority generation, integrity, read-only degraded mode; fiscal-year entries; capture config; version registry + change records | 11 §3–6, 04 D51 |
| **Archive** | read-only prior-version runs (self-contained: final projected row + receipt + evidence pointers — zero old-version code); relaunch-from-archive = fresh run on current version from archived immutable input; bump flow lists non-terminal old-version runs that must terminalize first | §6.6 |
| **Ledger** | never-pruned per-system write receipts (`instance` prod/test, proofSource, operator, confirmation ids) — greppable; `already-present`/`observed-present` distinguished from a real filing (no ledger entry) | 09 §6 |
| **Explorer (Phase A, read-only)** | descriptor graph (nodes/edges/branches/gates/delegation + per-task contracts, UI ids, dry-run boundary, editable fields) + **selected-run timeline overlay** (timings, attempts, checkpoint reuse incl. "reran with existing data", failures, children, evidence, safe actions) | 12 §5.2, second-look §5.1 |
| **Activity report** | runs / people / error-rate / hours-saved over spans + ledger (supervisor demo, format TBD) | §6.6 M2 |
| **Workflow reference** | `/api/workflow-definitions` client projection: rail grouping by category, icons, input/upload specs, steps, gates, verdicts, presets — the demo's rail/catalog should read a mock of THIS, not a hand list | 02 §1.2 |

---

## 2. Surface-by-surface: served capability vs demo today

Legend: ✅ functional in demo · 🟡 present but stubbed/partial · ❌ absent.
(Demo state from the 2026-07-25 code inventory of `dev/rebuild-demo/`.)

### 2.1 Top Bar
| Feature | Demo | Notes |
|---|---|---|
| Search with results / zero-hits / **failed** states | ❌ (dead input) | fail-loud copy is specced (shell §1) |
| Date navigator ‹ date › + calendar; day-partitioned queue | ❌ (NOOP; top bar says Jul 25, queue says Jul 24 — disagree) | needs a real date axis in the world model |
| Bell: unread badge, failure tint, filter chips, backfill-failed state, Re-run | ❌ (badge only) | consumes the inbox model §1.6 |
| Shortcuts guide | 🟡 (inline legend) | full chord list in shell §1 |
| Settings entry | ❌ (NOOP) | opens §2.8 |

### 2.2 Workflow Panel
| Feature | Demo | Notes |
|---|---|---|
| Category grouping + counts from one projection | ✅ (`countRows()` single path) | keep — this is the acceptance requirement made visible |
| Queued amber sub-badge | ✅ | |
| **Rail selection filters the Queue Panel** | ❌ (heading changes only) | essential: per-panel views are where D4 (OCR row in its own panel), S7 (helper-panel view) and one-projection counts become demonstrable |
| SSE-discovered/Other binning, `person-match` hidden (Q10) | ❌ | `sp`/`pm` absent from rail entirely — decide + show |

### 2.3 Status Bar
| Feature | Demo | Notes |
|---|---|---|
| Pills read the same projection as rail + queue | ✅ | |
| Pill layout for 8 statuses (grid-cols-5 won't hold) | 🟡 (7 pills incl. All/Needs-you; doneWarnings double-counted by design) | pill vocabulary needs ratification |
| Sort dropdown (persisted), bulk Retry/Stop/Delete-all, upload button, empty-state CTA, resizer | ❌ | bulk actions must demo the **partial/unknown outcome vector** (§1.3) |

### 2.4 Queue Panel / Queue Rows
| Feature | Demo | Notes |
|---|---|---|
| 3 row types × 8 statuses, attention bands, auto-expand (D5), member ladder + matrix, drill-in, rejected member, checked tracking, delegation chips (D4 both directions), trace/time/#run footer | ✅ | the demo's strength — keep |
| Footer actions wired to command results (applied/conflict/rejected) | ❌ (all NOOP) | derive buttons from `actions[]`; add confirm dialogs (tree-cancel names casualties) |
| Row facts (per-workflow detail chips) | ✅ | |
| Dry-run chip · version chip · renamed-run display · instance `test` badge · priority | ❌ | all §1.1 fields absent from world model |
| Attempt history beyond a chip (`RunSelector` ‹ #N of N ›, stale glyph) | ❌ | |
| Delegation shapes: S2 (gated packet) ✅ · S3 (i9, 50 members) ✅ · S0 ✅ | ✅ | |
| **S4 oath-upload as a Group whose members are the signer runs** | ❌ (`ou-packet` is a plain done Run Row) | delegation §5-S4; also its Write-parked "ticket may exist" state |
| **S5 typed-list group** (e.g. 5 separations, shared per-step fill bars) | ❌ | |
| **S6 standalone OCR** (read-only report, no approve) | ❌ | |
| **S7 helper run in its own panel** (`6 lookups · <packet>` group + "Delegated by →" + "result feeds →" Data line) | ❌ | needs rail filtering first |
| Group of one renders as a group (D2) | ❌ | |
| Ladder rung 13–40 (scroll well) | ❌ (only 6, 12, 50) | |
| Group misclassification: `oath-batch` lacks `reviewRunId` → catalogued Roster Group | 🟡 bug | fix in fixtures |

### 2.5 Log Panel
| Feature | Demo | Notes |
|---|---|---|
| Panel-kind tabs, state-driven defaults, identity strip, outcome bar, gate banner above tabs, duration-true timeline, evidence bar, conveyor member header | ✅ | pending ratification into doc 03 (supersedes the five-tab wording) |
| Timeline hover: real duration/attempts/key lines/screenshot link | 🟡 (hover cards exist; gate wedge width is fabricated ≥90s) | derive from `gates[].openedAt` |
| Logs tab: levels, x-N collapse, category lenses (Errors/Debug), free-text filter, virtualizer | 🟡 (search only; live stream is 4 canned lines on one row) | notes-stream shaped lines with `action`/`fields` |
| Data tab: read/write ledger + provenance + staged chips + edit-when-stopped + load-prior + start-from-data | 🟡 (visual only; buttons NOOP; no provenance timestamps; no CAS-stale state; no freshness-override prompt) | 06 §6 states are the interesting part |
| Review tab: page↔extraction pair, per-field provenance + confidence, per-person approve, approve-all gated on reviewed==total | ✅ concept | missing: editable fields (declared, unrendered), match-tier badges, per-check relookup, re-OCR/reupload, preview gate ("N/M pages loaded" — port verbatim, keep/ditch §4.20), records-as-commands (not browser state) |
| Receipt tab: tone + lines + read-back marks | 🟡 | upgrade to full `RunEvidenceReceipt` blocks: reuse lane, warnings, confidence, observed-identity-at-commit + confirmation screenshot (Q8) |
| Failure card: fingerprint, remediation, seen-before links, bundle link | 🟡 (title+meta only) | `FailureRecord` shape §1.2 |
| Screenshots: lightbox, filter chips, export menu (logs .txt / run .json / copy trace) | ❌ (tiles dead) | keep/ditch keeps all three |
| Write-parked resolution UI: the TWO typed actions + proof form | ❌ — **demo semantics wrong**: `sep-rosa` says "staged, parked before submit — Resume & submit". Ratified `parked` means UNKNOWN write outcome; its only actions are Confirmed-present (proof) / Confirmed-absent (evidence note). A pre-submit operator hold is a **gate (`waiting`)**, not Write parked | fix fixture + build the resolution flow |
| EID/identity gate: two candidates, use-this-EID, manual entry, dismiss | ✅ visual, ❌ actions | promote to its own pinned banner (not sharing the failure slot) |

### 2.6 Session Panel
| Feature | Demo | Notes |
|---|---|---|
| Cards, 3-way bucketing, browser tiles all states incl. unknown, right-click recovery menu, crashed card | ✅ | |
| Executor-card semantics: per-system in-use/cap, lanes, subtitle cycling in-flight trace ids, waiting-on-lease visibility, sleep-per-task | ❌ | doc 05 reshapes this surface |
| Stop (with reassignable-aware confirm), add-worker picker (queued-desc sort, shared queue) | ❌ (NOOP) | |
| Peek modal | ❌ | |

### 2.7 Run starts (the missing half of the product)
| Feature | Demo | Notes |
|---|---|---|
| Run Modal: upload spec (fields/accepts/success), target-workflow intent, reupload/supersede | ❌ | |
| Intake pipeline: header pick → mapping grid → validate → rejects/exclusions → manifest → run (all states in §1.6) | ❌ | the largest wholly-unrepresented operator flow |
| InputRunPanel: typed values, parser preview, N>1 → S5 group, presets, dry-run toggle | ❌ | |
| Per-run instance selector (prod default loud; test refusal when unconfigured) | ❌ | |
| Capture session card (state/photos/expiry/handoff) | ❌ | low priority (rarely used, §6.5) |

### 2.8 Shell-level surfaces
| Feature | Demo | Notes |
|---|---|---|
| Notifications inbox page/popover (Ping vs Inbox, snooze, dedupe count, links) | ❌ | |
| Settings: provenance display, System URLs, Performance budgets, preflight/doctor, storage health + backups, version registry + change records, fiscal dates | ❌ | |
| Archive view + version-bump flow (listing non-terminal blockers) | ❌ | |
| Storage degraded read-only banner ("dashboard remains diagnostic") | ❌ | |
| Explorer (read-only graph + run overlay) | ❌ | ships with first vertical slice — demo should show the concept |
| Activity report | ❌ | format still an open decision |
| Ledger view (per-person grep answer) | ❌ | could live as a Receipt link / search facet; decide |

---

## 3. The plan — four tiers

Ordered so each tier leaves the demo coherent. Tier 1 is the structural correction; 2–3 are the
missing feature mass; 4 is trust/periphery.

### Tier 1 — make the world model the wire model (structural)
1. Retype `demo-data.ts` into `DemoQueueSurface` + per-run detail payloads (§1.1–1.2): add
   `runId`/`itemId`, `workflow {id,code,label}`, `containment`, `actions[]`, `detailSurfaces`,
   `evidence.confidence`, `dryRun`, `priority`, `resolvedInstance`, `workflowVersion`,
   `displayName`, `requestedBy`, real `enqueuedAt/startedAt/endedAt` (kill the two-date mismatch),
   `gates[].openedAt` (kill the fabricated gate-wedge width).
2. Derive ALL footer/banner buttons from `actions[]`; wire every action to a mock command service
   returning `applied | conflict | rejected` so the three result flows render (incl. a stale
   `expectedVersion` → conflict → refresh demonstration). Confirm dialogs for destructive/tree
   commands, naming casualties.
3. Make the Workflow Panel actually filter (per-workflow Queue Panels + an All view), with
   `wfCounts` still derived from the one `countRows()` path. This unlocks D4/S7 demonstrations.
4. Fix fixture bugs: `oath-batch` → proper packet-group; `sep-rosa` reclassified (see §2.5);
   status-pill vocabulary decision surfaced as a visible annotation.

### Tier 2 — complete the queue's delegation + status coverage
5. Add the missing shapes: S4 oath-upload group (signers as members, ticket as the parent's own
   tail steps, plus a second S4 fixture in `parked` with the "ticket may already exist" resolution),
   S5 typed-list group (5 separations, shared per-step fill bars, one member tripping the identity
   gate → group auto-expand), S6 standalone OCR (read-only review, no approve), S7 person-lookup
   panel view (`6 lookups · Oath_Packet_Summer.pdf` + "result feeds →" Data line), a
   group-of-one (D2), a 13–40-member group (scroll-well rung).
6. Run identity features: rename flow (displayName over subject, trace preserved), dry-run row,
   version chip + preset merge, instance `test` badge row, attempt lineage with RunSelector and a
   rerun-diff block ("reran with existing data — 3 checkpoints reused, 1 reread").
7. Bulk actions + sort + empty state on the Status Bar row, with a best-effort partial result
   (e.g. retry-all → 2 applied, 1 conflict, 1 rejected — rendered as the full vector).

### Tier 3 — the missing operator flows
8. Write-park resolution: parked row → Review tab default → the two typed resolutions with proof
   form (parse failure demo) and evidence-note path; double-fence refusal toast; requeue-while-
   settling state.
9. Run starts: Run Modal (PDF → target workflow → S2 packet appears), InputRunPanel (typed
   multi-value → S5), and the intake mapping grid with its full state set (§1.6): suggestions,
   saved-mapping hit, missing-column loud revert, duplicate-header confirm, per-cell rejects,
   exclude-with-reason, zero-valid block, manifest receipt, rerun diff.
10. Notifications: inbox model + bell (Ping vs Inbox, snooze, dedupe counts, links that select the
    run), backfill-failed state.
11. Search: results, zero hits, failed (fail-loud) states; date navigation over a 2–3 day fixture
    corpus (history vs live day).
12. Data tab completion: CAS-stale save rejection (patch preserved), freshness-override prompt
    (checkpoint age vs limit vs consuming write node), edit-unlock rules by run state.

### Tier 4 — trust + periphery
13. Receipt upgrade to full `RunEvidenceReceipt` (Q8-complete on a UCPath row); failure detail to
    full `FailureRecord` + diagnostic-bundle link; screenshot lightbox + export menu.
14. Settings (provenance, System URLs, Performance budgets, preflight/doctor, storage health +
    backup age, version registry + change records); storage degraded read-only banner.
15. Archive view + version-bump flow; executor-card upgrade (in-use/cap, lanes, waiting notes);
    Explorer concept page (graph + run overlay on one fixture workflow); activity report mock
    (pending format decision).

---

## 4. Fixture coverage matrix (world states to author)

The demo corpus must contain at least one instance of every served state. Beyond today's 15
top-level rows:

| Axis | Required fixtures |
|---|---|
| Statuses × types | all 8 on Run Rows (have 7 — `parked` needs the corrected semantics); group rollup landing on each precedence rung; member set covering all 8 |
| Delegation | S0✅ S1 (separations conditional lookup) S2✅ S3✅ S4 (×2: running + parked) S5 S6 S7 |
| Ladder | 1(D2) · 3 · 6✅ · 12✅ · 13–40 · 50✅ |
| Gates | approval✅ · identity✅ · write-park (2 resolutions) · await-signatures (S4) · children-terminal rollup |
| Run identity | dry-run · renamed · preset/version chip · `test`-instance · interactive vs bulk · attempt ≥2 with lineage · superseded (archived from view) |
| Commands | each of retry/cancel-tree/bump/hide/rename/resolve-gate/resolve-write on some row; one conflict; one rejected; one bulk partial vector |
| Notifications | one per trigger class; Ping vs Inbox; snoozed; dedupe count >1 |
| Intake | one spreadsheet fixture exercising all 6 `RowReject` variants + exclusion + manifest |
| Health | degraded-storage banner state; backup age in Settings; executor at cap with a `waiting` lane |
| Days | ≥2 dates so date-nav + "Finished today" digest + history search are real |

---

## 5. Cut list — do NOT build into the demo

Per pause-until-done (§6.6) and ratified trims: lift adapter/quarantine cards ·
`engine`/`cutoverGeneration` display · golden-parity surface · 5-state notification lifecycle ·
DSL workflow-authoring editor · synthetic-data "demo mode" toggle (removed at operator request —
the rebuild-demo view itself remains the dev-only reference) · ledger hash-chain UI ·
per-workflow `npm run <workflow>` starts (dashboard-only rule) · drill-in as a separate queue page
below the matrix threshold · `OperationScreenshotsPanel`-style forks · Screenshots as a tab
(evidence bar instead, per operator direction).

---

## 6. Open decisions that gate features (surface to operator)

1. **The 12 delegation questions** (`delegation-layouts-2026-07-25.md` §7) — esp. Q1 (oath-upload
   signers leave the Oath Signature panel — Tier 2 #5 assumes YES), Q6 (matrix threshold 41 vs the
   demo's 20 — pick one), Q7 (gate age on collapsed row — demo shows it, assume YES), Q8 (failed
   linked child → parent Failed), Q10 (hide `person-match`).
2. **Status Bar pill vocabulary for 8 statuses** (7-pill demo model with All/Needs-you vs 8 pills
   vs two rows) — shell spec flags `grid-cols-5` breakage; needs a call before design.
3. **Tab model ratification** — the demo's panel-kind tabs + evidence bar + merged Data tab
   supersede §6.6's five-tab wording; ratify into doc 03 or revert.
4. **Writes read-only in the merged Data tab** — session judgement call, unconfirmed.
5. **Write-parked demo semantics** (§2.5) — confirm `parked` = unknown-outcome-only, and pre-commit
   holds are gates.
6. **Coordinator terminalization** (second-look §2.4, gate vs projection) — affects whether a
   group's terminal state is a span the timeline can show.
7. **Evidence-obligation declaration + FailureRecord shape** (second-look §3 #15/#16) — Receipt
   and Failure surfaces render these; the demo will mock a shape, flag it as provisional.
8. **Activity report + supervisor demo format** (M2) — pending on the decision sheet.
9. **Ledger surface in the dashboard** (view vs grep-only + receipt links) — not yet decided
   anywhere; this plan defaults to receipt-links only.

---

## 7. Acceptance

The demo is "showing what the backend can serve" when:

1. Every wire field in §1 is consumed by at least one visible surface (a field-to-surface audit
   table lives beside the mock projections).
2. Every command in §1.3 is demonstrable, including its conflict and rejected paths.
3. Every fixture row in §4 exists and is reachable by click or keyboard from a fresh load.
4. The rail badge, Status Bar pill, and visible rows never disagree on any filter/date/workflow
   combination (the §6.6 acceptance requirement, now also under rail filtering).
5. No surface renders data that the wire contract cannot serve (fabrications like the fixed gate
   wedge are gone), and nothing the contract serves is silently absent without a §5 cut-list or
   §6 open-decision entry.
