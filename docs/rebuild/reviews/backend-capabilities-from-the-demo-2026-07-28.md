# Backend capabilities the demo discovered (2026-07-28)

**Status (2026-07-30): harvest complete and incorporated.** The numbered findings remain the
evidence appendix for individual backend capabilities. The cross-surface production architecture,
route/stream/command composition, state ownership, delivery slices, and parity gates now live in
`docs/rebuild/13-frontend-backend-integration.md`; doc 07 remains the only build sequence.

**Why this exists.** The `?view=rebuild-demo` redesign programme (commits `d1530a1f`..`fa6c251c`,
on top of `1d656f76`..`a380406c`) was never only a frontend exercise. The operator's stated
purpose, verbatim: *"the whole point of the mock is to build a frontend very realistic, we learn
how we should structure our backend in a way that would support whatever we want to do in the
frontend."* This document is that harvest: **each item below is something the backend must be
designed to do, discovered by building the frontend honestly and hitting a wall.** None of them
is speculative — every one has a rendered surface in the demo that either consumes the capability
from a mock wire (`demo-*-wire.ts`) or states, on screen, that the capability does not exist.

Each item gives: **what the frontend needs · what the backend must therefore do · what breaks if
it does not.** The mock wire modules named per item are the reference shapes — they are the demo's
half of the contract, kept deliberately close to what a real server would serve.

Owners: most items land in doc 02 (descriptor), doc 03 (wire/projection/commands), doc 06
(data/checkpoints), doc 09 (write safety), doc 12 (evidence). Suggested owner noted where it is
not obvious.

The final whole-frontend audit added six integration-level requirements that cut across the
numbered capabilities rather than belonging to one demo component: one bootstrap document, one
strict frontend transport client, resumable cursor-based SSE, panel-kind/section projection for the
approved tabs + Context + Receipt composition, a command family for every product mutation, and a
surface-to-authority acceptance matrix. They are specified once in doc 13 rather than duplicated as
items 19–24 here.

---

## 0. Two findings about the REAL product (read these first)

These are not demo notes. They are facts about the **live system**, surfaced only because the demo
had to state, for every workflow, where the dry-run boundary sits. Both now have explicit operator
decisions; the onboarding defect is fixed and the accepted absences remain facts the capability
matrix must expose.

1. **ACCEPTED: `work-study` and `kronos-pay-rule` honour no dry run at all.** Neither workflow's handler
   reads a `dryRun` flag anywhere (`src/workflows/work-study/`, `src/workflows/kronos-pay-rule/`
   — grep is empty). Both write to a system of record, and both offer no rehearsal mode. This is
   consistent with the run-surface survey, which found dry-run offered only on separations,
   onboarding, emergency-contact, oath-signature, oath-upload and onbase. **For those two
   workflows, the first real run *is* the run.** This is not a defect to paper over with a false
   rehearsal; the descriptor must serve the absence and its reason so the capability matrix can
   distinguish it from a capability that has not been built.

2. **RESOLVED 2026-07-28: `onboarding` dry run stops before I-9 creation.** The handler now
   completes its read-only CRM extraction and UCPath identity checks, then returns before the
   combined `i9-creation` step and therefore before Smart HR too. A rehearsal writes to no system
   of record. `tests/unit/workflows/onboarding/workflow.test.ts` pins the boundary before both
   mutation sites. The demo Explorer must draw the same corrected boundary: I-9 creation and
   Smart HR are both below it.

---

## 1. Per-candidate identity capture

- **What the frontend needs:** an unsure identity gate shows a screenshot of *each* candidate as
  seen in the source system, side by side, so the operator decides from evidence rather than from
  two names (`GateCandidateSpec` in `demo-wire.ts`; captures fetched by id from
  `candidateCaptureFor` in `demo-evidence-wire.ts`). More than two candidates is supported — the
  demo proves the surface against a three-candidate gate.
- **What the backend must do:** take a capture **at identity-resolution time**, per candidate,
  retain it with the run, and serve it fetch-by-id. A candidate that was never on a page (a typed
  name from the input record) has **no** capture, and that absence is served — the surface renders
  "No capture — this was never on a page". It must never be synthesised or borrowed from a
  neighbour.
- **What breaks otherwise:** the wrong-person gate — the single most expensive decision surface in
  the product (a real wrong-person termination is on record) — degrades back to comparing two
  typed strings, or worse, shows one candidate's page beside another candidate's name.

## 2. Operator corrections are evidence

- **What the frontend needs:** a hand-typed value over a machine read flips the field's provenance
  to `source: "operator"`, carries **no** model confidence (an em dash, never the 0.97 that
  belonged to the value it replaced), and appears on the receipt beside the value it replaced.
- **What the backend must do:** record each correction as a first-class evidence record —
  `RecordCorrectionWire { recordId, field, from, to, priorSource, priorConfidence?, correctedBy,
  correctedAt }` (`demo-wire.ts`) — keep the machine's reading verbatim on the correction, count
  corrections on the approve surface from the same list the approve command carries, and print
  them on the receipt **beside the prior value, with the prior source and prior confidence**.
- **What breaks otherwise:** a hand-typed value inherits a machine confidence it never earned, the
  receipt shows a value nobody can trace to paper or person, and the number shown on the approve
  bar and the list sent with the approval become two derivations that can disagree.

## 3. `continue-with-data` — patch the checkpoint, resume the SAME run

- **What the frontend needs:** two distinct exits from an edited checkpoint: continue *this* run
  from where it stopped (same runId, same attempt lineage, same receipt), or start a *new* run
  from this data — and exactly one save arm on the surface at a time (`demo-commands.ts`).
- **What the backend must do:** a `continue-with-data` command that patches the checkpoint and
  releases the same run, fenced by checkpoint-generation CAS. An applied correction **returns the
  new generation** and the client adopts it — the client never derives `held + 1` (a surface that
  mints its own generation disagrees with the server silently the first time anything else
  writes). A refused correction returns a quotable code. A checkpoint's `capturedAt` is a real
  instant, never a display string — the demo crashed on exactly that fixture bug, twice, and the
  fail-loud parse that caught it must stay.
- **What breaks otherwise:** every mid-run correction becomes a new run — new trace, new receipt,
  broken attempt lineage — or, worse, two writers race the checkpoint with no fence and the last
  save silently wins.

## 4. A typed member outcome, orthogonal to status

- **What the frontend needs:** `memberOutcome` answers *what did it find*; `status` answers *did
  it run*. A member is routinely terminal-`done` with outcome `not-found`. The queue's member
  lines and the People tab render the same typed word from one renderer.
- **What the backend must do:** workflows declare their vocabulary —
  `WorkflowDescriptor.memberOutcomes: { key, label, tone, meaning }[]` — and resolution is
  **fail-loud**: an undeclared key throws at projection rather than rendering blank
  (`memberOutcomeSpec` in `demo-wire.ts`). A member still looking sends **no** outcome, and the
  backend must not default one. Declared today: **i9-check** (Found · Not found · Unsure ·
  Incomplete · Not searchable) and **person-lookup** (Search: Resolved · **Separated** · Not found;
  Match: Matched · No match · Ambiguous). The selected mode determines which declared subset is valid;
  projection fails loud if a Match row reports a Search-only answer or vice versa. `separated`
  is its own key, not a qualifier on a successful `resolved` — UCPath *found* the
  person, and what it reports is that they no longer work here, which is a different answer and
  the one that stops an oath packet signing them.
- **What breaks otherwise:** "done" swallows "found nothing", free-text detail strings drift per
  surface (the operator saw `Not found` in the queue and `no UCPath mat…` on the People tab for
  the same person, one click apart), and a defaulted outcome claims a result no system reported.

## 5. Start capability is a served descriptor fact

- **What the frontend needs:** ONE run modal for every workflow that renders entirely from what
  the workflow declares — no `workflow === "onbase"` branch anywhere in the modal
  (`DemoWorkflowRef.start`, `demo-runstart-wire.ts`).
- **What the backend must do:** serve, per workflow: accepted input kinds per method
  (typed / upload / capture / spreadsheet / bare) with separator and parser label; the coordinator
  shape each document method creates (`packet-group | single-run | review-only`); whether multiple
  files merge; the sub-selection catalogue **with per-option availability and its reason**
  (OnBase's 24 document types are served, 23 disabled and saying why — hiding them teaches the
  operator the product has never heard of a type they can see in OnBase); the roster listing; and
  run flags scoped **per method** (oath-signature offers dry run on a packet, not on a typed EID).
  Today this knowledge is split across two frontend registries (`RUN_MODAL_REGISTRY`,
  `INPUT_RUN_REGISTRY`) — it must move behind the descriptor.
- **What breaks otherwise:** a workflow registered tomorrow gets no start surface, or a wrong one,
  until someone edits the frontend; a choice the operator cannot see rides an enqueue; a start
  method that exists in one registry and not the other leaks the registry split into the UI.

## 6. Three NEW startability requirements

Not parity — the demo models start paths the production system does not have, on the operator's
direction, and the backend must grow them:

- **`work-study` must become startable by typed EID.** Production has no start path; the
  operator's own diagnosis of the missing path is **disuse, not design**.
- **`sharepoint-download` must become startable at all.** Its button component
  (`SharePointDownloadButton.tsx`) has zero importers; today the workflow is reachable only as an
  OCR-orchestrator delegation (`rosterMode: download | wait`). A workflow that exists but cannot
  be started is invisible precisely when the operator wants the roster refreshed on its own.
- **`old-kronos-reports` must take its report span per run.** Its report span and the patience
  derived from it are per-run values, so a global UKG timeout for a workflow the dashboard cannot
  start is **a setting with no home** — the demo moved both onto the run itself (`reportSpan` +
  `reportPatience` choices), which is only implementable if the backend accepts them at enqueue.

## 7. Rail grouping is a registry concern

- **What the frontend needs:** the Workflow Panel groups by real product categories with no
  frontend membership list (`DemoShell.tsx` groups by each descriptor's own `category`).
- **What the backend must do:** `/api/workflow-definitions` serves each descriptor's `category`;
  the frontend hardcodes only the display order; category stays an **open string** (an unlisted
  category appends; an empty one drops); and **every registered workflow is served with its real,
  unique `code`** — a code prefixes every trace id, so an unserved or colliding code breaks run
  identity, not just grouping.
- **What breaks otherwise:** a workflow registered tomorrow lands in no group (or in a frontend
  "misc" that is a lie), and the rail's shape is maintained by hand in a second place that drifts
  from the registry — the same class of defect as the count divergence §10.1 exists to kill.

## 8. Progressive record streaming

- **What the frontend needs:** the OCR review's member list grows as the packet is read — records
  appear one at a time *because they were read one at a time*, with the remainder as a number,
  never a drawn placeholder (`recordStream(row, tick)`, `DemoRecord.readAt`).
- **What the backend must do:** emit **each person's record as extraction reads it** — one record,
  one instant (`readAt`) — not a batch at completion. A record's instant is when extraction
  emitted it, not when the page was scanned. A run still reading must stamp **every** record it
  has emitted, or "unstamped" silently comes to mean "already read" and the arrival animation
  fires on the wrong rows. Only a running run streams: `Waiting on you` is non-terminal too, but
  its reading is over, and a partial list there would claim the extraction is still going.
- **What breaks otherwise:** `12 lookups` means something only once extraction finishes; before
  that the surface either lies (a drawn placeholder for a person who may not exist — a page can
  carry nobody, and a row already drawn would have to be taken away) or says nothing.

## 9. Worker spawn takes a count and answers per worker

- **What the frontend needs:** the Session Panel's `+` starts N workers at once and reports each
  one's fate (`demo-workers-wire.ts`).
- **What the backend must do:** `spawnWorkers(workflowId, count)` returns a **vector**, one
  outcome per requested worker, never an aggregate. Refusals carry a quotable code
  (`executor-pool-full`, `system-at-cap`) naming the real constraint **and its holder**. **Partial
  success is the normal case, not an error case** — the server walks the budget one worker at a
  time, so worker 1 can take the last lease and worker 2 is refused *for the reason worker 1
  created*. A capacity preview must run **the same walk**, so the dialog can never promise a count
  the command then refuses.
- **What breaks otherwise:** "2 of 3 started" collapses into either a false success or a false
  failure; the operator retries a partial success and over-spawns; and the preview and the command
  disagree because they were two derivations of one budget.

## 10. Archive retention and integrity

- **What the frontend needs:** an archive that is a record, not a list — searchable, sortable
  across years, safe to relaunch from, and fully inspectable per run (`demo-archive-wire.ts`,
  `DemoArchive.tsx`).
- **What the backend must do:**
  - **Retention:** an archived row is kept indefinitely (it is the audit copy); evidence images
    are kept **90 days from the run's end** then purged, with the pointer retained so the record
    still names what was captured; the **write ledger is never archived and never pruned**.
  - **Integrity:** each record carries `archivedBy`, a `sha256:` snapshot hash,
    `snapshotVerifiedAt` and a schema tag — and something must **periodically re-verify the
    hash**, or the archive's whole claim rests on a row nothing has checked since it was written.
  - **Self-containment (D80 made real):** an archived run renders with **zero old-version code**,
    which the demo proved requires far more than "final row + receipt + hashes": the log stream,
    the timeline, the members, the decision history, the failure record, the data ledger **with
    corrections**, the attempt history, and `dryRun` / `resolvedInstance` / `priority` / `preset`
    — without which an archived *rehearsal* reads as a *filing*, the most expensive misread the
    product can produce.
  - **A real instant beside every display clock:** `endedAt` is currently a display string with no
    year and no zone; a true chronological sort across years needs a real instant stored beside
    the label. (The demo refuses to parse display clocks — inventing a date to sort by is the
    fabrication this product refuses — so today it sorts by fixture order, which a real archive
    cannot.)
- **What breaks otherwise:** the archive answers "what happened" but not one question about it
  (one demo run's receipt reads "13 of 14 updated · 1 not found" — without the member list, the
  other thirteen are unrecoverable); a relaunch fires blind from one click; and an unverified hash
  is a seal nobody has ever checked.

## 11. `major.minor` versioning, where the major digit is the archive gate

- **What the frontend needs:** version copy that can name the right thing when it refuses —
  descriptor identity, archive key and the start form's staleness token were ONE integer, while a
  different integer was the row CAS token, and both reached the operator as the word "version"
  (`demo-settings-wire.ts` / `DemoVersionBump.tsx`).
- **What the backend must do:** **major** = the run's *shape* changed (steps added / removed /
  renamed, or the data contract moved) → the only digit the archive keys on, and the only one that
  forces in-flight runs to be archived (non-terminal runs listed as blockers, parked writes called
  out specially, per D80 rule 3). **Minor** = presentation only → archives nothing, leaves
  in-flight runs untouched, leaves open start forms valid — the start contract token
  (`startContractToken`, an opaque string that moves only when the shape does) does not move — and
  still writes a change record recording *which kind* the bump was. A **third digit was rejected
  on principle**: it would need a category that is neither shape-breaking nor cosmetic, and a
  change invisible to a run needs no version. A change record serves `scope` + `workflowIds` so
  the archive can name *which workflow* changed versus *the app*.
- **What breaks otherwise:** every reworded label archives production runs (or none do and a shape
  change strands them); an open start form goes stale on a cosmetic edit; and a CAS refusal cannot
  tell the operator which of two "versions" moved.

## 12. Settings save is one transaction over N leaves

- **What the frontend needs:** a Save that saves — the demo found the real Settings page building
  the dirty list, submitting `dirty[0]`, and clearing the whole draft under a footer reading
  "3 unsaved changes" (`submitSettingChanges` in `demo-settings-wire.ts` is the corrected shape).
- **What the backend must do:** accept all N edited leaves as **one transaction**, returning a
  per-leaf result vector — **all-or-nothing on storage failure, per-leaf on validation** — and
  leave a refused value in the form rather than dropping it. The server's numeric bounds are the
  **same numbers** the control enforces (one source, not a client copy). The doctor is a command
  returning freshly stamped checks **from local state only** — no browser, no Duo — which is what
  lets it be a standing Top Bar indicator rather than a page.
- **What breaks otherwise:** the four bugs the demo catalogued: a partial save under a
  full-looking footer, a draft surviving section switches as unowned state, an uncontrolled input
  whose Save writes a hardcoded value, and a doctor button wired to nothing.

## 13. Per-system prod/test hosts are served, and an impossible choice is refused

- **What the frontend needs:** the run modal's instance selector prints the host each choice
  resolves to, per system (`demo-runstart-wire.ts`, `DEMO_SYSTEM_INSTANCES`).
- **What the backend must do:** serve each system's production and (where provisioned) test hosts;
  a `test` choice on a system with **no test host is refused at enqueue** — never silently
  resolved to production. (I-9 is the standing example: no test host is provisioned, and the
  refusal says so.)
- **What breaks otherwise:** the worst version of a config fallback — an operator who chose "test"
  files a real transaction in production, believing they rehearsed.

## 14. Failure `writeState` is load-bearing UI, not diagnostics

- **What the frontend needs:** the write-state sentence ("Nothing was written to UCPath, Kronos or
  Kuali…") rendered unconditionally and prominently in the log stream, above every disclosure —
  it is the difference between a safe retry and a duplicate termination (`InlineFailureRecord`,
  D18 amendment in doc 03 §9).
- **What the backend must do:** **always** populate `writeState` on a failed run. It is not an
  optional diagnostic field; a failure record without it cannot be rendered honestly, and the
  frontend will not invent one.
- **What breaks otherwise:** the operator answers "is it safe to retry?" from absence of
  information, on the one surface where a wrong guess files a duplicate HR transaction.

## 15. Action descriptors carry a `menu` placement

- **What the frontend needs:** a row's right-click context menu holding the row's complete command
  set (`ActionPlacement` includes `"menu"` in `demo-wire.ts`; the `⋯` overflow is deleted).
- **What the backend must do:** serve `menu` as a first-class placement on action descriptors, so
  the menu renders the served set directly rather than the client unioning footer + banner
  placements and guessing what else belongs.
- **What breaks otherwise:** the client re-derives "everything this row can do" from placements
  that mean "where it is drawn", and the menu drifts from the served command set — a command the
  server withdrew stays reachable, which is the D20 class of bug generalised.

## 16. The day partition serves per-day row counts for a whole month

- **What the frontend needs:** the date pill's badge and the calendar's day cells both show what
  each day holds before the operator navigates to it (`dayCounts()` in `demo-days.ts`).
- **What the backend must do:** serve per-day row counts for a whole month from **one function**,
  so the calendar's cells and the pill's badge cannot disagree (the §10.1 one-projection rule
  applied to the time axis).
- **What breaks otherwise:** the calendar is a grid of guesses, or it fires thirty-one queries, or
  — the standing failure mode — two surfaces count the same day differently.

## 17. A second descriptor graph for the Explorer, with the boundary optional

- **What the frontend needs:** the Explorer draws every workflow's step graph with its dry-run
  boundary — and Person Lookup, which writes nothing, has **no boundary at all**
  (`demo-explorer-wire.ts`, `dryRunBoundaryNodeId?: string`).
- **What the backend must do:** serve the descriptor's graph with `dryRunBoundaryNodeId`
  **optional** — a workflow with no writes has no boundary, and that **absence is served, not
  inferred**. A page that could only draw the boundary-bearing shape teaches the wrong lesson
  about the other kind (and §0's two findings are exactly the cases where the served answer must
  be allowed to be uncomfortable).
- **What breaks otherwise:** the Explorer either invents a boundary for a read-only workflow or
  cannot draw it at all, and the surface that exists to answer "where does this workflow start
  writing?" cannot represent "it never does" — or "it starts before you think" (finding §0.2).

## 18. Per-capture dimensions on every evidence pointer

- **What the frontend needs:** a document page (612×792) and a browser viewport (1600×1000) are
  told apart *before* either is opened — the lightbox and the tiles size by each capture's own
  served dimensions (`DemoCapture.size: { w, h }` in `demo-evidence-wire.ts`;
  `--ds-aspect-page: 612 / 792`).
- **What the backend must do:** stamp width × height on every evidence pointer at capture time and
  serve it with the pointer (the bytes may be purged later — item 10 — but the shape survives on
  the pointer).
- **What breaks otherwise:** every capture renders in one assumed shape — the demo measured a
  612×792 portrait page drawn at 499×342 landscape before the fix — and a purged capture cannot
  even say what shape it was.

---

*Companion documents:* the ratified presentation decisions these capabilities serve are in
`docs/rebuild/03-tracker-dashboard.md` §9 (D5–D24 as amended 2026-07-28); the pending
components-CLAUDE.md lesson for the same waves is
`docs/rebuild/reviews/pending-lesson-dashboard-components-2026-07-28.md`.
