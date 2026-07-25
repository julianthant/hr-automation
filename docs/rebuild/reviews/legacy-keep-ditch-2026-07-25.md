# Legacy Queue Row + Log Panel — keep / ditch ledger (2026-07-25)

**Status:** proposal, awaiting operator ratification. Feeds `docs/rebuild/03-tracker-dashboard.md`.
**Question this answers:** "look at how the old rows and log panels look like and see what we can
take from there and what we should ditch."

**Provenance:** code-grounded audit by an Opus subagent with `file:line` citations retained.
Citations are checkable, not vouched for line-by-line — verify one before you depend on it.
Companion docs: `delegation-layouts-2026-07-25.md` (how delegation is laid out),
`shell-build-spec-2026-07-25.md` (pixel spec for the four shell surfaces).

**Scale of the problem being replaced:** 114 special-casing sites across 30 files, status decoded
from `step` strings at ~32 sites, and the failed→cancelled override implemented 3× (second-look
§7).

---

## 1. Queue Row — element by element

### Card shell (`QueueRowCard.tsx`)

| Element | Where | Verdict | Reason |
|---|---|---|---|
| Gutter `px-3 pt-2 first:pt-3` | `:56` | **KEEP** | Rows read as cards in a rail; `first:pt-3` avoids a clipped top edge. |
| `bg-card border border-border rounded-lg overflow-hidden transition-all duration-200` | `:60` | **KEEP** | The bento chrome the visual-parity directive protects. |
| Hover `hover:border-primary/40 hover:shadow-lg hover:shadow-black/20` | `:63` | **KEEP** | The only affordance that a row is clickable. |
| Selection `ring-2 ring-primary` + `border-primary/50 shadow-lg` | `:72-73` | **KEEP** | Ring, not bg-shift, "so it pops against neighbouring cards" — correct on card-on-card. |
| Muted member selection `border-primary/25` | `:77` | **KEEP-WITH-CHANGE** | Right idea, but it is a prop threaded through two components. Member Row becomes its own component — bake it in, drop `selectionTone`. |
| **Left accent `border-l-[3px]`** | `:17-21`, `group-row-base.tsx:63` | **DITCH** | Encodes worst-member rollup, which contradicts the ratified "a failed member does not fail the group". Redundant with the chip + progress bar. |

### Run Row body (`EntryItem.tsx`)

| Element | Verdict | Reason |
|---|---|---|
| Status icon `w-3.5 h-3.5`, spin + `motion-reduce` | **KEEP** | Icon shape carries status, not just colour. |
| Title `font-semibold text-[14px] truncate` | **KEEP** | |
| **Dry-run chip** + explanatory `title` | **KEEP** | The only visual separator between a rehearsal and a real UCPath submit. |
| Preset chip (`data.__preset`) | **KEEP-WITH-CHANGE** | Merge into the ratified per-run **version** chip. One "how was this configured" chip, not two. |
| Secondary tag (A/IA, `N/M verified`) | **KEEP-WITH-CHANGE** | Keep the *slot* as a generic qualifier. Ditch `statusExtensions` as the mechanism — a per-workflow hook in the projection path is banned by the ratified guard. |
| Status badge `text-[10px] px-2 py-0.5 rounded-md` | **KEEP** | This is the ratified 8-status chip; only the vocabulary changes. |
| `STATUS_CONFIG` (10 entries) | **KEEP-WITH-CHANGE** | Collapse to 8. `needsReview`+`awaitingApproval` → **Waiting on you**; `notFound`/`dismissed`/`skipped` → **Done with warnings**; **Write parked** and **Verified done** do not exist today and must be built. |
| Derived-status resolution | **DITCH** | `needsReview` is `running`+`awaiting-approval`; `awaitingApproval` is mechanically `done`. Review-as-status kills the whole derivation layer. |
| Live message line | **KEEP** | |
| `showLiveRow` gate (failed+error OR running+message) | **KEEP-WITH-CHANGE** | Silent for Done-with-warnings and Write-parked — the two new statuses that most need a one-line reason. Extend to all 8. |
| `resolveQueueRowLiveMessage` fallback chain | **KEEP** | lastLogMessage → error → `<Step>…` → "Running…". No fabrication, always says something. |
| Running border tint `border-primary/30` | **KEEP-WITH-CHANGE** | Extend: attention statuses need the strongest tint, since D5 auto-expands on them. |
| a11y root (role/tabIndex/aria-pressed/aria-label/keydown/`data-queue-entry-id`) | **KEEP** | All of it — see §4. |
| **No progress indicator on a single Run Row** | **GAP** | Only groups get a bar. A long single run shows only an elapsed timer. |

### Footer (`RowFooter.tsx`)

| Element | Verdict | Reason |
|---|---|---|
| Bar `px-3.5 py-1.5 bg-secondary/20 text-[11px] font-mono` | **KEEP** | |
| `time` `tabular-nums` | **KEEP** | |
| `#run` pill | **KEEP-WITH-CHANGE** | Pair it with the version chip now that archive-on-version-bump is ratified. |
| `secondaryId` (EID / trace id) truncate + `title` | **KEEP** | |
| `suppressIdWhenEquals` | **KEEP** | Prevents `Smith_Oath.pdf … Smith_Oath.pdf`. |
| One timing slot (elapsed **else** duration) | **KEEP** | "Timing is one muted value… status is conveyed by the badge, never the timer colour." Ratify as a rule. |
| Action cluster ▲↻×🗑 `h-6 w-6` | **KEEP** | Best thing in the row — see §4.2. |
| `actions` ReactNode override for group bulk | **KEEP** | One slot, two fillings; group and flat footers cannot drift. |

### Group Row extras

| Element | Verdict | Reason |
|---|---|---|
| Titled header + `N / M` count badge | **KEEP** | |
| **Titleless (headerless) variant** | **DITCH** | Removes status icon, badge, OCR jump and live subline entirely. D2 (uploads are always identified Groups) removes the need. |
| Count strip + `StatusCounts` | **KEEP** | |
| Progress segments `h-[5px] rounded-[2px] gap-[2px]` | **KEEP** | Real counts, no fabricated %. Cancelled has its own segment. |
| Member preview (3 kids) | **KEEP-WITH-CHANGE** | Two implementations coexist — inert `div`s vs real `button`s that select the member. Unify on the button version. |
| Expand chevron + `aria-expanded` | **KEEP** | |
| Expanded list `max-h-[24rem]` | **KEEP-WITH-CHANGE** | "~4 rows" is too tight. Use the ratified ladder. |
| `showOcrWorkZone` strip | **DITCH** | A third unpredictable card state; the jump link alone covers it. |
| "Open OCR review" jump | **KEEP** | This is ratified D4. |
| `OperationCancelButton` "Cancel remaining" | **KEEP** | Tree-scoped BFS cancel — the one-click bulk stop the operator actually needs. |
| **Drill-in as a separate queue page** | **DITCH below 20 members** | Swaps the whole panel into a second mode with a different toolbar. Keep only as the 20+ escape hatch. |
| Preview surface with 0 members → flat `EntryItem` | **DITCH** | D2 makes single-member uploads Groups; the degenerate 0/0 special case disappears. |

---

## 2. Log Panel — element by element

| Element | Verdict | Reason |
|---|---|---|
| **Header — there isn't one** | **KEEP-WITH-CHANGE** | Add a one-line identity strip: run **display name** (runs are renameable) + status chip. One line. |
| Detail grid `grid-cols-4`, cell `69.5px` | **KEEP-WITH-CHANGE** | Keep the band + typography. Fixed `grid-cols-4` leaves ragged rows and dangling borders; use auto-fit. |
| `hideDetailGrid` (preview / dispatch / coordinator) | **DITCH** | See §3.2 — replaced by the ratified Data tab. |
| `historicalDataUnavailable` message | **KEEP** | Fail-loud, see §4.3. |
| **Step pipeline** (persistent strip) | **KEEP** | Already exactly what was ratified. |
| Dashed pending rail | **KEEP** | "Not yet run" reads distinct from "ran quickly". |
| Hover detail — only on `AuthSuperChip` | **KEEP-WITH-CHANGE** | Generalise that tooltip to **every** chip (status, real duration, attempts, key log lines, screenshot link). This is the ratified "extra depth comes from hover detail per step". |
| `auth:*` grouping into "Authenticating (N)" | **KEEP** | 4 Duo prompts → one chip. |
| `computeOcrPipelineView` + retired-step folds | **DITCH** | See §3.3. |
| Cancelled-step recovery from `stepDurations` | **DITCH** | See §3.3. |
| `stepDisplay` / `applyStepDisplay` plumbing | **DITCH** | Self-documented as dead: "no workflow declares it yet". |
| Failure banner + Retry, suppressed for cancelled | **KEEP** | |
| **EID-approval banner** (two candidates side by side, per-candidate "Use this EID", manual entry, Dismiss) | **KEEP → promote** | The working prototype of the ratified gate block. |
| …but it shares the failure slot (`failureBanner ?? eidApprovalBanner`) | **DITCH the sharing** | Mutual exclusion by accident. The gate is its own pinned banner. |
| Surface-bar chrome (segmented control geometry) | **KEEP exactly** | |
| The 5 surfaces (Logs/Screenshots/Preview/View Data/Edit Data) | **KEEP-WITH-CHANGE** | Preview→Review; View Data + Edit Data→one Data tab; Screenshots→evidence bar; **Receipt is new**. |
| `All ▾` category dropdown (7 lenses) | **KEEP-WITH-CHANGE** | Keep Errors + Debug. Ditch fill/navigate/extract — they duplicate the per-line icon, and the free-text box does more work. |
| `visibleSurfaces` gating + self-heal to Logs | **KEEP** | The panel never strands on a hidden surface. |
| `initialTab` deep-link guard | **KEEP** | Clearing a deep link "felt like the buttons themselves switched tabs". |
| Maximize toggle | **KEEP the button, DITCH what it hides** | It hides the detail grid **and the pipeline**. Ratified: the strip stays visible regardless of tab. |
| Log line anatomy (12-category icon map, source badge, `x{count}`, hover Copy, copy-on-Enter) | **KEEP** | Only change: raw `#4ade80` → `--success`. |
| Event lines — geometry deliberately matched to log lines | **KEEP** | |
| `EVENT_LABEL` humanisation + `workflowInstance` fallback | **KEEP** | |
| x-N collapse (two mechanisms) | **KEEP** | |
| `MERGE_DROPPED_EVENTS` | **KEEP-WITH-CHANGE** | Fix at emit; keep as defence in depth. See §3.4. |
| Free-text "Filter logs…" | **KEEP** | |
| Virtualizer (est 30px, overscan 20, rAF autoscroll) | **KEEP** | |
| Footer live dot + trace-id chip | **KEEP** | The old `from <Parent>` / `Standalone` chip is **already gone**, replaced by the trace chip. Correct call — don't revive it. |
| `RunSelector` ◀ `#N of N` ▶ with status glyph, `stale` warning | **KEEP** | Shows ordinal + status only, no dates. |
| `ExportMenu` — Logs .txt / Run .json / Copy trace id, client-side | **KEEP** | Zero backend cost; "Copy trace id" is the grep handoff. |
| Screenshots grid + filter chips (counts by group) | **KEEP** | |
| Tile `aspect-[16/10] object-cover object-top`, kind badge, error ring | **KEEP** | |
| Lightbox fixed-size view box + gutter arrows + thumbnail rail | **KEEP** | The box exists explicitly "so the prev/next buttons never shift between images". |
| `chunk i / N` caption + folder/multi-file handling | **DITCH** | Dormant — the kernel replaced paged chunking with one whole-page capture per event. `isFolder`, `Layers N`, "View all N pages" are mostly unreachable. |
| `OperationScreenshotsPanel` | **DITCH** | Stale fork: still says "No batch rows" post-rename, duplicates chip styling, **no filters, no grouping, no lightbox**, and abuses `screenshotCount` as a 3s poll counter. |
| `ViewDataPanel` read/write ledger (spine stations, Extracted vs Inputted lanes) | **KEEP → the Data tab's read half** | Icon **and** colour, never colour alone. |
| `EditDataTab` (`max-w-2xl` column, callout, grouped sections, dirty dots, two-zone action bar, Find-prior) | **KEEP → the Data tab's edit half** | `max-w-2xl` exists specifically to kill "1900px-wide inputs" when maximized. |
| Edit Data on-blur validation / `hasBlockingErrors` | **KEEP-WITH-CHANGE — a trap today** | See §3 runners-up. |
| Edit Data "Refresh from logs" | **KEEP-WITH-CHANGE** | Skip-on-empty means it **can never clear a field** — a wrongly-extracted value that is now absent upstream stays in the form. |
| **OCR page ↔ extraction grid**, page image `sticky top-4` | **KEEP verbatim** | This *is* the ratified "always an expanded pair, never a collapsed table". |
| …two contradictory sticky conventions | **KEEP-WITH-CHANGE** | Pick one: stick the page image, scroll the extraction. |
| …the grid literal exists 3× | **DITCH the copies** | One layout component. |
| PDF frame + error state with "try the URL directly" | **KEEP** | Also keep the load discipline — see §4.24. |
| OCR toolbar pill (Select all │ Unselect all │ Reupload │ Approve N) | **KEEP** | There is **no** record-count text; the CLAUDE.md lesson describing one is stale. |
| …but the pane is **two context slots**, not a pane | **DITCH the pattern** | `OcrReviewPrepProvider` publishes `{active, toolbar, body}` as JSX through context, and the chrome belongs to `LogStream`. Make Review a real tab that owns its header — this pattern is why toolbar and body cannot share state cleanly. |
| Record nav (doc-kind chip / title / phase badge / checkbox) | **KEEP-WITH-CHANGE** | Drop the `#{rowOrdinal}` fallback — queue rows already retired session-local ordinals. |
| Record footer chip | **KEEP-WITH-CHANGE** | It recomputes a bare word from `tracker.phase` and **discards `tracker.label`**, so "Person lookup running" / "I-9 lookup failed" never reach the operator. |
| **Completeness report** three-tier elevation (found → raised card; unavailable → warning card; present/missing → flat) + `N on paper · N looked up · N gaps` | **KEEP wholesale** | Clearest "what's left for me to do" surface in the app; elevation encodes actionability. |
| Per-check relookup button | **KEEP-WITH-CHANGE** | Registered only for verify, so **i9 runs never get it**. |
| `MatchWarnings` + `MatchConfidenceBadge` on all three record bodies | **KEEP** | Fixed the defect where a low-confidence auto-match was invisible on the card you approve from. |
| i9 person-grouping branch | **KEEP the concept, DITCH the branch** | Express "a record may own N pages" generically, so no form kind needs its own render list, ordinal rule, or missing affordances. |
| Coordinator merged 3-source timeline | **KEEP** | `selectKeyOcrLogLines` keeps it "a sparse overview, not a firehose". But it dedupes on message **text**, so two genuinely distinct same-second messages collapse. |
| Synthetic Prepare→Review→Fan-out pipeline | **DITCH** | Fabricated stages, with durations deliberately withheld because the stored ones don't match. |
| Hand-synced `OPERATION_COORDINATOR_WORKFLOWS` client copy | **DITCH** | Exactly the hand-synced duplication the audit flagged. |

---

## 3. The five worst things

**1 — Status is derived, not stored: six status tables and three resolvers.**
`STATUS_CONFIG`, `HEADER_STATUS`, `STATUS_ICON`, `MEMBER_PREVIEW_ICON`, `COUNT_SPECS`, `STATS` — six
near-identical status→icon/tone maps. The states themselves live in `step` strings:

> *"A cancelled row is the tracker shape `status: "failed"` + `step: "cancelled"` — there is no
> separate `cancelled` enum value, so `step` is the discriminator."* — `status-styles.ts:44`

> *"Delegated OCR only — trackers use `status: done` + `awaiting-approval`."* — `EntryItem.tsx:98`

Cost: ~32 sites decoding status from step strings; the failed→cancelled override implemented 3×.
The ratified 8 first-class statuses eliminate the whole layer — ship **one** status table.

**2 — `hideDetailGrid`: the right panel goes blank for exactly the rows the operator lives in.**
Preview rows, delegation dispatchers, and **every operation coordinator** show no fields at all:

> *"a file/operation row has no person `detailFields` — showing empty cells would read as broken."*

So a PDF batch — the highest-dwell-time row — has nothing, and the rebuild's Data tab has no legacy
design to inherit. The same block hid a silent bug for months: `conditional` fields never hid
anything, because a missing value renders as an em-dash, never `""`.

**3 — The step pipeline lies for cancelled and OCR runs, via two heuristic remappers.**
The cancelled reached-step is *inferred* from which steps happen to have durations — an inference
that collapses the moment any step ends without writing one. On top of it, `computeOcrPipelineView`
hides steps, folds retired names, and re-positions a parked step against an order list that is
"never rendered" — three layers of fiction so one workflow's timeline is legible. Plus a known
unshipped hazard: hiding a step a run is parked at "would orphan the `currentStep` highlight".

**4 — The log stream is de-duplicated at RENDER time because it is too noisy at EMIT time.**
`MERGE_DROPPED_EVENTS = {step_change, daemon_phase, idle_signal}`, with 25 lines of justification:

> *"102 daemon_phase events vs 67 item_start events in a typical session means they are the single
> noisiest non-step event class."*

The panel is correctly forbidden from rewriting log content — *"readability of a verbose log is a
SOURCE concern"* — a rule the emit layer never held up its end of. **Rebuild: run-scoped events
only; daemon heartbeats never enter a run's stream.**

**5 — The group row has three mutually-exclusive shapes, one with no header at all.**
When titleless, the entire header strip vanishes. Three operator passes were needed to get there,
and member clicks needed a dedicated fix because they selected the *parent* — now patched with
`stopPropagation` at three levels, with two member-preview implementations still coexisting.
Ratified fix: one Group Row, always identified, inline expand, one Member Row component.

**Runners-up:**
- **The drill-in queue page** swaps the whole panel into a second mode with a different toolbar — a
  queue you can get lost inside. The density ladder makes it unnecessary under 20 members.
- **Edit Data can block Save with nothing highlighted.** `hasBlockingErrors` ignores `touched` but
  the error line requires it — a field pre-populated with an invalid value disables Save **and**
  Run with the title "Fix the highlighted fields first" while nothing is visibly marked.
- **Review state is browser-local.** All OCR field edits and record removals live only in
  `localStorage` keyed by run; another browser sees the un-edited records, and "Re-OCR whole PDF"
  wipes them with no undo. This collides head-on with the ratified multi-user seams — **review
  edits must be commands against the run, not browser state.**

### Live bugs found — do not port these forward

1. **The I-9 doc-kind chip never renders** — the check matches `formKind === "i9"` but i9 records
   carry `"i9 section 1"`. Every i9 card silently falls back to `#ordinal`.
2. **`addBlankRow` injects an EC-shaped record into i9 runs** — it early-returns only for `verify`.
   The comment two lines above warns about exactly this bug class.
3. **The record footer chip discards `tracker.label`** — the rich lookup labels never surface.
4. **Save/Run can be blocked with nothing highlighted** (above).
5. **Screenshot `refreshKey` is a count, not a nonce** — it cycles 0→1→0, so consecutive relookups
   of the same kind may not refetch.
6. **`runNumber` returns 0 for every run** without a `runOrdinal` — all sort equal, all show `#0`.
7. **`copyTrace` toasts success unconditionally** — a denied clipboard permission reads as success.
8. **`FailedPageCard.onRetryComplete` is never passed** — a successful page retry toasts but does
   not refresh the pane.

**Fail-loud violations on the approve path** (the repo's own #1 rule): corrupt localStorage reads as
"no edits" so typed corrections vanish silently; a full quota silently stops persisting; three
renderer guards `console.error` then `return null`, rendering an **empty card body** with no
operator-visible error.

### Dead / unreachable code to delete rather than port

`verificationBadge` / `signatureBadge` / `verificationBanner` props (never passed, 3 unreachable
branches) · the legacy non-ordinal nav layout · `PrepReviewMultiPair.titleBar` (never passed, so
multi-record pages render **no page header at all**) · `renderFormCardNav` `rowOnPage` params ·
`ScreenshotCard.tsx` (misfiled in `log-panel/`, only OCR imports it, divergent chip styling) ·
`filterLogsForDebugVisibility` (only its own test calls it) · `isValidEid` (exported and
unit-tested but **unused by its own component** — the regex is inlined twice more; three copies of
the highest-stakes validation rule).

---

## 4. Secretly good — do not drop these

1. **`EntryItem` memo comparator keyed on `entry._hash`.** "Queue rows re-render on every SSE tick
   (1–5 Hz)… without memoization that's 50+ subtree re-renders per second." A rebuild minting a
   fresh projection object per tick will visibly stutter at 50 rows.
2. **Footer actions status-gated by kernel descriptors, never client status branches.** running →
   `×`; queued → `▲ ×`; done/failed → `↻ 🗑`. This is why the queue never offers an action that 400s.
3. **`resolveDetailEntry` returns `null` rather than falling back** — a wrong-person guard *in the
   UI layer*: showing the live run's data under a selected historical run "would render the wrong
   person's fields". Keep it and its visible "Data unavailable for this run" state.
4. **aria-label derived from the same resolver as the visible chip** — extracted as a pure function
   specifically to be testable, because otherwise a screen-reader user hears a different state than
   sighted users see.
5. **`suppressIdWhenEquals`** — one boolean that stops every file-kind row printing its filename twice.
6. **Trace-id subtitle rules** — `<code>-<HHMMSS>-<runId4>`; EID if present else trace id; and
   `preferTraceIdSubtitle` on group anchors so the EID isn't repeated. The Session Card shows the
   *same* id, which is the only way to correlate a card to a row.
7. **`StatusCounts` renders a fragment, not a wrapper** — the caller owns the flex row, which is why
   one tally fits both a titled header and a count strip.
8. **`UNKNOWN_EVENT_VISUAL`** — "a runtime undefined-lookup unmounts the whole tree because
   EventLine has no error boundary above it." One `?? fallback` standing between a new backend event
   type and a blank right panel.
9. **Log-line vertical rhythm** — `items-start` + `mt-[3px]` on timestamp/icon + `min-w-0 break-words`,
   with `EventLine` deliberately copying the geometry so both stream types align in one column.
10. **Cross-panel edge tiling** — both footers are `h-12`; the StatPills band, each detail-grid cell
    and the StepPipeline rail are all exactly **69.5px**. The two columns line up across the gutter —
    easy to lose, extremely visible when lost.
11. **Keyboard chords chosen against real collisions** — retry is `Ctrl+Shift+R` so Cmd/Ctrl+R page
    reload stays untouched, using `e.code === "KeyR"` for layout independence; bare `x` is guarded
    against every modifier; editable-focus bails first.
12. **Scroll-into-view via `data-queue-entry-id`** + `CSS.escape` + `block:"nearest"`. A refs-map
    rebuild will regret this.
13. **`formatSeconds` rollup** matched to `formatStepDuration` "so footer + step timings agree",
    paired with `tabular-nums` on every number in the app.
14. **Dashed pending rail** — two states that look identical in most timeline UIs.
15. **Count dedupe that does not hide history** — retried members count once, but the member LIST
    still renders every attempt: "keep history, fix the number — not collapse the row".
16. **`RunSelector.stale`** — a warning glyph rather than a silently-truncated run list.
17. **From Edit Data, keep**: empty is always a valid edit ("presence requirements live in the
    workflow handler"), the `aria-live` error lines, and the two-zone action bar (data-in left,
    act-on-data right). Fix the gate to key on the same `touched` state the error line does.
18. **Client-side export** — no endpoint, works from already-streamed data.
19. **The Approve gate is a 4-level priority chain with a fail-loud top rung** — "a poll error must
    never read as '0 pending' and silently unblock", and `handleApprove` re-checks before POST.
20. **You cannot approve what you haven't seen.** `derivePreviewApprovalGate` blocks Approve until
    every required PDF page has actually *rendered*, counting down "(N/M pages loaded)".
    **This is the strongest write-safety affordance in the current UI. Port it verbatim.**
21. **Hard-blocked selection is scrubbed, not just disabled** — inactive/unknown rows are skipped by
    Select all and scrubbed on merge, so the count can never look frozen.
22. **Scroll-cursor persistence via IntersectionObserver, not hover** — the hover version "only
    fired when the operator actively hovered; keyboard / trackpad / scrollbar scrolling all silently
    failed".
23. **`MediaLightbox` fixed-size view box** — `min(78vw,1280px) × 82vh`, explicitly so the flanking
    arrows never shift between images.
24. **`PdfPagePreview` load discipline** — lazy `rootMargin: 800px`, a **15s safety-net timeout**,
    `fetchPriority="high"`, `opacity-0` until ok. A plain `<img loading="lazy">` will show blank
    pages and silently fail the preview gate.
25. **`EidApprovalBanner.post` requires explicit `json.ok === true`** — "a malformed/unparseable 2xx
    body must NOT read as success" on the highest-stakes separations gate.

---

## 5. Layout + density — numbers for a faithful replica

**Global.** IBM Plex Sans / IBM Plex Mono; `--radius: 0.5rem` → sm 4 / md 6 / lg 8 / xl 12px. Split:
queue `defaultSize 28, min 18, max 50`; detail `72 / 40`; `autoSaveId="dashboard.queue-split"`; no
gap — the handle is the divider. Non-fill queue widths `w-[300px] min-[1440px]:w-[380px]
2xl:w-[460px]`. **Magic band = 69.5px** (StatPills row, detail-grid cell, StepPipeline rail).
**Footer = h-12** in both panels.

**Queue Panel.** Panel `px-3 / min-[1440px]:px-4, py-2`. Row gutter `px-3 pt-2 first:pt-3`; card
`rounded-lg border`; hover `shadow-lg shadow-black/20`. Row header `px-3.5 py-2.5`; title
`text-[14px] font-semibold`; status icon `w-3.5 h-3.5`. Chips: status `text-[10px] font-medium
px-2 py-0.5 rounded-md`; qualifier chips `text-[10px] font-semibold px-1.5 py-0.5 rounded-md`. Live
line `mt-1.5 ml-5 text-[11px] font-mono`. Footer `px-3.5 py-1.5 bg-secondary/20 gap-2 text-[11px]
font-mono`; `#run` pill `px-1.5 py-px rounded`. Action buttons `h-6 w-6 rounded-md`, icon
`h-3.5 w-3.5` (md variant `h-8 w-8`). Group: count strip `px-3.5 pt-2 pb-2.5`, counts `font-mono
text-[10.5px] gap-x-2.5 mb-1.5`; **progress bar `h-[5px] rounded-[2px] gap-[2px]`**; preview rows
`px-3.5 py-2 gap-1.5 font-mono text-[10.5px]`, EID `text-[9.5px]`; dividers `border-border/60`
structural, `border-border/40` member hairlines; expanded cap `max-h-[24rem]`; preview kids = 3.
StatPills `grid grid-cols-5 gap-1.5`, pill `rounded-lg px-1.5 py-2`, count `text-[16px] font-bold
font-mono`, label `text-[10px] font-semibold uppercase tracking-[0.14em]`, dim `opacity-50`.
StatusCounts icons `size-3 gap-1`. Sort toolbar `min-h-8 gap-1.5`; dropdown `rounded-lg px-2.5
py-1.5 text-[11px]`, menu `min-w-[12rem]`.

**Log Panel.** Detail cell `height:69.5px px-6 gap-1`, label `text-[11px] uppercase tracking-wider
leading-none`, value `text-sm truncate leading-tight`. Step pipeline: row `px-6 gap-3` at 69.5px;
chip `flex-1 min-w-[86px] gap-1.5`; label `text-[11.5px] tracking-tight`; rail `h-[3px] rounded-full`
(dashes 4px on / 4px off); duration `text-[10px] font-mono h-[10px]`. Surface bar: row `px-4 py-2
gap-2.5`; tablist `h-8 rounded-lg p-0.5 gap-0.5`; tab `h-7 rounded-md px-3 text-xs` + icon
`h-3.5 w-3.5`; maximize `h-8 w-8`. Banner slot `px-4 py-2.5`; failure banner `rounded-lg px-3 py-2.5
gap-x-3 gap-y-2`, text `text-[12.5px] leading-snug`. Filter box `px-4 py-1.5 gap-2`, input
`text-[13px]`. Log list `py-3`; line `px-6 py-[3px] gap-3.5 font-mono text-[13px] leading-relaxed`;
ts `text-xs min-w-[72px] mt-[3px]`; icon `w-[14px] h-[14px] mt-[3px]`; virtual est **30px**, overscan
**20**. Footer `h-12 px-6 gap-3 text-[12px]`; live dot 7px; trace chip `px-2 py-0.5 rounded-md
text-[11px] font-mono`. RunSelector nav `h-8 w-8`, trigger `h-8 min-w-[126px] px-3`, menu `w-[200px]
max-h-[320px]`. Screenshots: filter bar `sticky top-0 z-10 px-6 py-2.5`, chip `px-2.5 py-1
rounded-md text-[11px]`; grid `px-6 py-4 grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3`;
tile cover `aspect-[16/10]`. Lightbox: view box `min(78vw,1280px) × 82vh`; panel `max-h-[92vh]
max-w-[92vw] p-3 gap-3`; arrows `h-10 w-10` (icon `h-5 w-5`); rail `w-[7rem] gap-2`, thumbs
`aspect-[16/10]`.

**OCR review.** Toolbar container `px-6 py-4`, filename `text-sm max-w-[min(100%,28rem)]`; pill
`h-8 rounded-lg p-0.5`, segments `h-7 rounded-md px-2.5 text-xs`, Approve `h-7 px-3 text-xs
font-semibold`. Body `px-6 py-5 space-y-5 bg-secondary/30`. **Pair grid
`grid-cols-[minmax(420px,1.15fr)_minmax(360px,0.85fr)] gap-4`**, sticky column `top-4 self-start`.
PDF frame `rounded-md border bg-white aspect-[8.5/11]`, img `object-contain`. Record card
`rounded-lg border bg-card p-4 shadow-sm`, nav slot `mb-3 border-b pb-2`, footer `mt-4 border-t
pt-3 gap-3`, checkbox `h-4 w-4 accent-primary`. Form inputs `h-8 w-full rounded-md px-2.5 text-sm`,
field grids `grid-cols-2`/`grid-cols-3 gap-3`. Report shell `rounded-lg border bg-secondary/30 p-4
gap-2.5`, found card `rounded-md px-3 py-2.5 shadow-sm ring-1 ring-border/60 gap-3`, flat row
`px-3 py-1.5 gap-3`, relookup `h-6 w-6`.

**Edit Data.** Body `px-4 py-4`, column `mx-auto max-w-2xl space-y-6`; callout `rounded-lg px-3.5
py-3 gap-3` + icon tile `h-8 w-8 rounded-md`; section heading `text-[11px] uppercase tracking-wider`
+ `h-px flex-1 bg-border/60` rule; **field grid `grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-4`**,
full-width (`sm:col-span-2`) when `multiline` or a lone field; dirty dot `h-1.5 w-1.5 bg-warning`;
inputs `px-2.5 py-1.5 text-sm rounded-md`; action bar `border-t px-4 py-3`, buttons `h-8 px-3
rounded-md text-xs`; Find-prior popover `w-[360px] p-0 max-h-[420px]`.

**Timing constants.** localStorage edit flush 300ms · cursor write debounce 250ms · PDF preload
margin 800px, load safety net 15000ms · IntersectionObserver thresholds `[0.25,0.5,0.75,1]` ·
OperationScreenshots poll 3s.

**Two raw-hex exceptions to migrate:** `#4ade80` (success green) and `#fbbf24` (waiting amber). The
rebuild should have real `--success` / `--warning` tokens and zero exceptions.
