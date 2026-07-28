# Operator screenshot feedback — 2026-07-28

**Surface under review:** the rebuild demo at `http://localhost:<port>/?view=rebuild-demo`
**Code:** `src/dashboard/components/dev/rebuild-demo/`
**Screenshots:** `.screenshots/operator-feedback-2026-07-28/` (gitignored; copied out of the
session image cache so they survive — filenames carry both the image number and the item number)

This document exists so the feedback can be handed to another tool (Cursor) without the images
being present. Every item below describes **what the screenshot actually shows** in enough detail
that the surface can be located from the text alone, then states **what the operator asked for**,
then points at **where it probably lives** in the code.

The operator's own numbering is preserved verbatim, including the fact that **there is no item 14** —
they skipped from 13 to 15. Item 1 was unnumbered in the original message.

---

## Context for whoever picks this up

`?view=rebuild-demo` is a **dev-only replica** of the future rebuilt HR-automation dashboard. It is a
planning artifact, not production code: production must never import from
`src/dashboard/components/dev/`, and the whole directory is deleted once real components ship. The
operator's standing framing is that the mock has to look genuinely polished, because it is the thing
the rebuild plan is written against.

**Binding design rules live in `src/dashboard/components/dev/rebuild-demo/DESIGN.md`** (updated
through wave 16) and in `docs/rebuild/03-tracker-dashboard.md` §9 (decisions D6–D24). Two that come
up repeatedly below:

- **D24** — no explanatory prose in the UI; an ⓘ affordance or nothing.
- **Chip rules** — chips are bordered, matte, and never wrap.

Visual parity with the current dashboard is ratified
(`docs/rebuild/reviews/second-look-2026-07-22.md` §6.6): this is **refinement, not redesign**.

### File map (from grepping the strings visible in the screenshots)

| Surface | File |
|---|---|
| Queue cards, member rows, group headers | `DemoQueue.tsx`, `demo-data.ts` |
| Left workflow rail, top bar, worker modal | `DemoShell.tsx` |
| Detail pane, tabs, OCR review, gate banner | `DemoLogPanel.tsx` |
| Right context rail (Evidence, Data) | `DemoContextRail.tsx` |
| Capture / evidence lightbox | `DemoEvidence.tsx`, `DemoCapture.tsx` |
| Archive table | `DemoArchive.tsx`, `demo-archive-wire.ts` |
| Activity report | `DemoActivityReport.tsx`, `demo-report-wire.ts` |
| Settings | `DemoSettings.tsx`, `demo-settings-wire.ts` |
| Failure / retry affordances | `DemoFailure.tsx`, `demo-wire.ts` |
| Park + resolve affordances | `DemoParkResolve.tsx`, `demo-flows-wire.ts` |
| Version bump / change records | `DemoVersionBump.tsx` |
| Design tokens + primitives | `ds/tokens.ts`, `ds/tokens.css`, `ds/primitives-*.tsx` |

---

## Image index

All paths are relative to `.screenshots/operator-feedback-2026-07-28/`.

| Image | File | Shows | Item |
|---|---|---|---|
| 5 | `05-item2-member-list-black-bg.png` | Failed oath operation card with member list | 2 |
| 6 | `06-item1-row-highlight-too-light.png` | Selected/highlighted "Waiting on you" operation card | 1 |
| 7 | `07-item3-backlink-chip.png` | `← Oath Upload` back-link chip | 3 |
| 8 | `08-item4-detail-header-waiting-chip.png` | Detail header strip with "Waiting on you" chip | 4 |
| 9 | `09-item5-capture-lightbox-empty.png` | Capture/evidence lightbox, empty | 5 |
| 10 | `10-item6-toasts-coupled-to-log-panel.png` | Two stacked toasts, bottom-right | 6 |
| 11 | `11-item7-add-workers-modal.png` | "Add workers" modal with capacity chips | 7 |
| 12 | `12-item8-evidence-section.png` | EVIDENCE section in the right rail | 8 |
| 13 | `13-item9-rail-eye-badges.png` | Left workflow rail with eye badges | 9 |
| 14 | `14-item10-review-pane-dead-space.png` | OCR review pane with dead space below | 10 |
| 16 | `16-item12-panel-collapsed-sliver.png` | Panel collapsed to a narrow sliver | 12 |
| 17 | `17-item13-archive-app-version.png` | Archived runs table, app version rows | 13 |
| 18 | `18-item15-title-subtitle-spacing.png` | Settings "General" title/subtitle row | 15 |
| 19 | `19-item16-activity-header-daypicker.png` | Activity report header block | 16 |
| 20 | `20-item16-activity-topbar-settings.png` | Activity report top bar with Settings | 16 |
| 21 | `21-item17-back-to-dashboard.png` | `← Back to the dashboard` button | 17 |
| 23 | `23-item18-toolbar-heights.png` | Queue toolbar / filter chip row | 18 |
| 24 | `24-item19-retry-the-lookup.png` | Failed card with "Retry the lookup" | 19 |
| 25 | `25-item20-write-parked-no-footer-x.png` | Write-parked card, no footer ✕ | 20 |
| 26 | `26-item20-header-write-parked-chip.png` | Detail header with Write parked chip | 20 |
| 27 | `27-item20-duplicate-resolve.png` | Duplicate "Resolve" button | 20 |
| 28 | `28-item20-gate-banner-duplicate-chip.png` | Gate banner with Review button | 20 |
| 30 | `30-item2-i9-50-members.png` | I-9 card, 50 members, 6 rows shown | 2 |

(Images 15 and 22 are byte-identical duplicates of 16 and 23 — ignore them.)

---

## 1 — Row highlight colour is too light

**Screenshot:** `6.png`

**What it shows.** A queue card in its **selected / highlighted** state. Header: a person-search
icon, bold truncated title `Oath_Packet_Summ…`, an ⓘ, and on the right a solid amber chip
`Waiting on you · 7m 57s`. Second line: amber text "Approve the people to sign" with a blue-outlined
`Review` button. Then a `👥 6 people` chip. Then an amber-bordered well with a warm brown tint
holding a white pill `✓ Approve 5 of 6` and a black `Open review ↗` button, with
"1 excluded — Diego Diaz is inactive in UCPath" underneath. Then a `📋 OCR review · waiti… ↗` chip.
Footer: `2:20 PM  #5  os-142012-b410  10m 16s` with an ✕ on the right.

The problem is the card's background: when selected it lifts to a noticeably paler grey than the
surrounding surface, which reads as washed-out against the dark theme.

**Asked for, verbatim:** *"the color the row changes when highlighted is too light. we need a shade
close to the original color."*

**Interpretation.** Keep the selected state legible but bring the value much closer to the resting
surface — a small delta plus the existing left accent bar and border, rather than a large luminance
jump.

**Where it lives.** The selected-row background token in `ds/tokens.ts` / `ds/tokens.css`, consumed
by the card in `DemoQueue.tsx`. Both themes (Graphite Warm dark, Paper Ink light) need checking.

---

## 2 — Member-row lists need redesign, and must expand + scroll

**Screenshots:** `5.png` (the styling complaint), `30.png` (the expansion complaint)

**What `5.png` shows.** A failed operation card. Header: red ⚠, bold `Oath_Packet_Spring.pdf`, ⓘ;
right side an outlined amber `⚠ 1` chip and a solid red `Failed` badge. Below that a counts strip:
green `✓ 11`, `↻ 0`, `⏱ 0`, `⚠ 1`, and right-aligned green `✓ 0/12`. Then the member list — and this
is the part being criticised: it sits on a **pure black panel** inset inside the card, with rows of
`status icon · name · monospace outcome · EID`:

```
⚠  Grace Egan      signature fiel…   10531182
✓  Ana Alvarez     signed 11:08 AM   10531000
✓  Diego Hahn      signed 11:09 AM   10531091
✓  Felix Alvarez   signed 11:18 AM   10531910
✓  Iris Hahn       signed 11:19 AM   10532001
✓  Jonah Brooks    signed 11:11 AM   10531273   ← clipped mid-row
```

The list is hard-clipped mid-row at the bottom. Below it: `→ Open all 12 signers` and a
`📋 OCR review · done ↗` chip. Footer: `11:05 AM  #4  os-110531-c2f0  18m 49s` with ↺ and 🗑.

**What `30.png` shows.** The same shape at a much larger member count. Group header
`NEEDS YOU (1)`. Card: `I9_Quarterly_Retention.pdf`, amber `Waiting on you`. Counts strip:
`✓ 42`, spinner, `⏱ 3`, `👤 1`, `☢ 2 rejected`, right-aligned `✓ 10/50`. Member rows:

```
⚠  Xena Diaz     Not found     10534151
⚠  Emma Egan     Not found     10531548
👤 Liam Brooks   Unsure        10532507
❗ Tara Jones    Incomplete    10533603
◐  Grace Brooks  —             10535247
⏱  Noel Ito      —             10536206   ← clipped mid-row
```

Then `→ Open all 50 people` and the footer. **Only 6 of 50 people are reachable in the card**; the
rest require leaving for a different surface.

**Asked for, verbatim:** *"these types of rows need a redesign/polishing. i kinda like the design rn
but i dont like the black background. i feel like it needs outline, better spacing, better
alignment, etc… this should also allow expanding to like 20 people and scrolling everyone from
there"*

**Interpretation — two separate changes.**

1. **Restyle the member list.** Drop the pure-black inset background in favour of a bordered/outlined
   container consistent with the rest of the design system. Fix row rhythm (vertical padding),
   column alignment (name / outcome / EID should form clean columns across rows), and stop the
   half-row clipping at the bottom edge — a partially rendered row reads as a rendering bug.
2. **Make it expandable and scrollable in place.** The collapsed card shows ~6 rows; expanding should
   grow it to roughly **20 rows** with an internal scroll region that reaches **every** member. The
   `→ Open all N …` link stays as the escape hatch to the full surface, but the operator should not
   need it to scan a 50-person run.

**Where it lives.** `DemoQueue.tsx` (member row rendering + the `Open all N` affordance),
`demo-data.ts` (member fixtures — check there are ≥50 members on the I-9 fixture so scrolling can
actually be demonstrated), plus the list container styling in `ds/primitives-data.tsx`.

---

## 3 — Back-link chips need a border and a matte black fill

**Screenshot:** `7.png`

**What it shows.** A small pill on a dark background reading `← Oath Upload`. It is the
navigate-back-to-the-originating-workflow affordance. It currently reads as a flat, borderless dark
blob — barely distinguishable from the background.

**Asked for, verbatim:** *"all these like buttons/labels needs a border and a matte black
background."*

**Interpretation.** This is a **sweep**, not a one-off: every chip-shaped button/label of this class
gets a visible border and a matte black fill. Note the hard-won lesson from the previous session —
*"a design-system fix half-lands by default"* — when the primitive is fixed, hand-rolled siblings
must be swept too (the last pass found nine hand-rolled chips and four structural twins that were
missed).

**Where it lives.** `ds/primitives-core.tsx` (the `Chip` primitive), then grep for hand-rolled
equivalents across `Demo*.tsx`.

---

## 4 — Remove the "Waiting on you" chip from the detail header

**Screenshot:** `8.png`

**What it shows.** A full-width detail-pane header strip: bold white `Oath_Packet_Summer.pdf`, then a
solid amber chip `👤 Waiting on you · 3m 29s`, and far right an ⓘ plus monospace trace id
`os-142012-b410`.

**Asked for, verbatim:** *"remove this waiting for you."*

**Interpretation.** Drop the `Waiting on you` status chip from **this header**. The state is already
communicated by the gate banner directly beneath it (see `28.png`, item 20) and by the queue card the
operator clicked to get here — the chip is redundant. Keep the title, ⓘ, and trace id.

**Caution:** confirm whether the elapsed timer (`3m 29s`) exists anywhere else on this surface before
deleting it with the chip. If not, the timer may need to survive on its own.

**Where it lives.** `DemoLogPanel.tsx` (detail header).

---

## 5 — Design the capture/evidence lightbox properly, with real mock data

**Screenshot:** `9.png`

**What it shows.** A near-full-screen modal, and it is almost entirely empty:

- Title `Packet page 1 — capture 1 of 2`, subtitle `step capture · Oath_Packet_Summer.pdf · os-142012-b410`, ✕ top right.
- Body: `‹` and `›` chevrons flanking a large empty image frame containing a broken-image glyph and
  the text **"Image bytes are not in this corpus ⓘ"**. Two narrow empty dark strips sit either side
  of the frame (apparently adjacent-page peeks) — both blank.
- Right panel headed **`WHAT WAS RECORDED`** — completely empty. No content at all.
- Bottom-left: two thumbnail buttons, `1 📷 Packet page 1` (selected) and `2 📷 Roster match report`.
- Footer: `1 of 2 · ←→ to page through · Esc to close` and a white `Close` button.

Roughly 70% of a full-screen modal is dead space.

**Asked for, verbatim:** *"design this properly and make sure the mock data is there
'/Users/julianhein/Projects/hr-automation/data' you can use these as mock too. and do it properly and
polish it."*

**Interpretation.** Two things: (a) redesign the lightbox so the layout is justified at this size —
image area, page strip, and the `WHAT WAS RECORDED` metadata panel all need real proportions and real
content; (b) **stop showing the "Image bytes are not in this corpus" placeholder** — wire real page
imagery and real extraction metadata from the repo's own assets.

**Available mock assets in `data/`:**

```
data/i9/Xerox Scan_071020260902*.pdf         4 real scanned I-9 packets
data/i9/extracted/*.records.json             per-PDF extraction records
data/i9/extracted/merged.records.json        merged extraction output
data/documents/single-oath.pdf               single oath form
data/documents/multiple-oath.pdf             multi-person oath packet
data/documents/emergency-contacts.pdf        emergency contact forms
data/documents/i9.pdf
data/documents/e2e-roster-identities.json    identity fixtures
data/documents/e2e-fixture-roster.xlsx
data/rosters/*.xlsx, *.csv                   real roster exports
data/reports/i9-check-tracker.xlsx
```

The `.records.json` files are the natural source for the `WHAT WAS RECORDED` panel; the PDFs can be
rendered to page images for the viewer. Note these are **real HR documents** — check whether they
contain live PII before embedding anything into a committed fixture, and prefer generating
derived/redacted page images over committing the raw scans into the demo bundle.

**Where it lives.** `DemoEvidence.tsx` and `DemoCapture.tsx` (both contain the
"Image bytes are not in this corpus" string), `demo-evidence-wire.ts`.

---

## 6 — Toasts must not be coupled to the log panel's notification

**Screenshot:** `10.png`

**What it shows.** The bottom-right of the window with two stacked toasts:

1. A **red-bordered** toast: `⚠ Ping · Same failure, 3rd time — OnBase rejected the document type`,
   body *"'I-9 Supporting' is not enabled for queue SDCMP-HR. Three runs have now failed on the
   identical fingerprint; a fourth retry will fail the same way until the queue is changed. (3× on
   this fingerprint)"*, link `Open the newest failure`, ✕.
2. An **amber-bordered** toast below-left: `📋 Approve the people to sign` / `↳ Go to the decision`,
   with `open 9m 18s` and ✕.

Bottom status bar: `+  2026.07.3  ● Live`.

**Asked for, verbatim:** *"why is the toast notification affected by the notification in the log
panel? that should not be the case."*

**Interpretation.** There is unwanted coupling between the toast layer and the log-panel
notification state — dismissing, opening, or updating one is changing the other (or the two are
reading the same state slice, so a log-panel notification spawns/duplicates a toast). **They must be
independent surfaces.** The toast viewport is a global overlay; the log panel's inline notification
is panel-local. Neither should drive the other's lifecycle.

**Note for the fixer:** a previous wave shipped a defect where *"a Popover teleported the toast
viewport across the window"* — this may be the same class of bug (shared portal/viewport). Check the
toast viewport's mount point before assuming it's a pure state problem.

**Where it lives.** `DemoLogPanel.tsx` (panel notification), the toast provider in
`ds/primitives-overlay.tsx`, and whatever shared state `RebuildDemo.tsx` threads between them.

---

## 7 — Add-workers modal: drop the bottom line, fix the meaning of `ucpath 1/1`

**Screenshot:** `11.png`

**What it shows.** A modal titled `Add workers`, subtitle "Start parallel executors for one
workflow", ✕ top right.

- Row: a `Workflow` select showing `Onboarding` (focused, white ring); on the right `Workers` with
  a `− 1 +` stepper.
- A bordered well: `◔ 4/6 workers up  |  0 more Onboarding workers can start now`, then four capacity
  chips laid out 3-then-1: `crm 1/2`, **`ucpath 1/1`** (amber border and text), **`i9 1/1`** (amber),
  `kuali 1/2`.
- A tooltip overlays the row: `ucpath: 1 of 1 concurrent sessions in use · hel…`.
- Footer: **`1 of these will be refused`** on the left; `Close` and a white `Start 1 worker` on the
  right.

**Asked for, verbatim:** *"we dont need the bottom part and uc path 1/1 does not make any sense. uc
path 1/1 should mean that for each session there can only be 1 ucpath window. not for each
workflow."*

**Interpretation — two changes.**

1. **Remove the `1 of these will be refused` line** at the bottom of the modal.
2. **Re-scope the UCPath capacity semantics.** `ucpath 1/1` is currently computed and displayed
   **per workflow**, which is wrong. The real constraint is **one UCPath window per session,
   globally** — it is a session-wide singleton shared by every workflow, not a per-workflow budget.
   The chip must express the global session constraint. This is a **model** change, not just a label
   change: the capacity accounting behind it is wrong, and the tooltip copy
   ("1 of 1 concurrent sessions in use") needs to match the corrected model.

**Backend implication.** This belongs in
`docs/rebuild/reviews/backend-capabilities-from-the-demo-2026-07-28.md` — the backend must serve
**session-scoped** system capacity separately from per-workflow worker capacity, otherwise the
frontend cannot render the distinction honestly.

**Where it lives.** `DemoShell.tsx` (contains both "Add workers" and "workers up"),
`demo-workers-wire.ts`.

---

## 8 — The EVIDENCE section needs a better design

**Screenshot:** `12.png`

**What it shows.** A section in the right context rail. Header row: small-caps letterspaced
`EVIDENCE` with a `⤓ Export ⌄` button right-aligned. Beneath it, a **single** bordered card
containing a camera glyph in a rounded square, with `Signed oath` in white and `Steps` in muted grey
below. The card occupies roughly a third of the available width; the remaining two thirds are empty.

**Asked for, verbatim:** *"this needs to be designed better too."*

**Interpretation.** Open-ended. The concrete problems visible: the single card doesn't use the
available width, the card's internal proportions are awkward (large icon well, tiny two-line label),
the `Steps` sub-label is ambiguous, and there is no indication of how many evidence items exist or
what happens at higher counts. Needs a considered treatment at 1, 2, and many items.

**Where it lives.** `DemoContextRail.tsx` (contains the `EVIDENCE` header), `demo-evidence-wire.ts`.

---

## 9 — Rail: replace the eye badges with the count

**Screenshot:** `13.png`

**What it shows.** The left workflow rail. A right-aligned header reads `QUEUED | ALL`, and every row
carries two numbers in those columns. Some rows additionally carry an **amber eye badge** with a
number:

```
ONBOARDING
  Onboarding                        0 | 1
  Oath Signature       [👁 1]       2 | 8
  Oath Upload                       0 | 1
  Emergency Contact                 0 | 3     ← active (left bar + lighter bg)
ONBASE
  OnBase                            0 | 2
SEPARATIONS
  Separations          [👁 3]       0 | 5
  I-9 Check            [👁 1]       0 | 1
WORK STUDY
  Work-Study                        1 | 2
PAYROLL
  Kronos Pay Rule                   0 | 1
TIMEKEEPING
  Old Kronos Reports                0 | 1
SEARCH
  Person Lookup                     0 | 5
  Person Match                      0 | 0
  I-9 Lookup                        0 | 0
UTILS
  OCR                  [👁 1]       0 | 5     ← active
  CRM Doc Download                  0 | 1
  SharePoint Download               1 | 2
```

Note the pattern: every row with an eye badge has `0` in the QUEUED column. `Oath Signature` is the
one exception (`👁 1` with `2 | 8`).

**Asked for, verbatim:** *"remove the eye icons and put the numbers in there instead of the 0s."*

**Interpretation.** Delete the eye badge entirely. The needs-attention count it carried moves into
the **QUEUED column**, replacing the `0` currently shown there. So `Separations [👁 3] 0 | 5` becomes
`Separations 3 | 5`.

**Open question to resolve before implementing:** what happens to `Oath Signature`, which has both an
eye count (1) and a non-zero queued count (2)? Either the two counts are genuinely different
quantities — in which case they can't be merged without losing information — or the `0` in the other
rows is a bug and the eye count *is* the queued count. Determine which before writing the change; if
they are different quantities, go back to the operator rather than flattening them.

**Where it lives.** `DemoShell.tsx` (contains both `QUEUED` and the `Eye` icon import),
count derivation in `demo-data.ts`.

---

## 10 — The review pane must fill the space it is given

**Screenshot:** `14.png`

**What it shows.** The full OCR review pane, top to bottom:

- Header: `Oath_Packet_Summer.pdf`, amber `Waiting on you · 3m 26s` chip, ⓘ `oc-142012-d771`.
- A tooltip `Review — press 1` overlapping an amber gate banner:
  `…acted — 0 reviewed · 1 blocked · 2 flagged. Approve to release the signers.` with a blue `Review`
  button.
- Tabs: `📋 Review` (with an amber unread dot) · `📄 Logs` · `🧾 Receipt`.
- Progress row: `0/6 reviewed`, a progress bar, `0 approved · 1 blocked`, and a green-outlined
  `✓ Approve 5 of 6`.
- Person navigator: `‹ 1 of 6 ›  Ana Alvarez  10510221  [Ready]` and an amber-outlined
  `Next flagged →`.
- Two-column body. **Left:** `PAGE 2 OF 8 · OATH FORM` and a tall bordered box holding only a document
  glyph and the text `Page 2 — source image` (placeholder, no image). **Right:**
  `EXTRACTED FROM THIS PAGE — EDITABLE HERE, AND ONLY HERE` with editable fields
  `Printed name / Ana Alvarez / PAPER / 0.97`, `Employee ID / 10510221 / PAPER / 0.93`,
  `Signature date / 07/21/2026 / PAPER / 0.95`, then locked fields
  `🔒 Department / 000371 · Student Health / UCPATH` and `🔒 Payroll title / Blank Assistant 3 / UCPATH`.
  Then `CHECKS` — five green rows (Roster match `matched row 14`, UCPath person
  `1 active match · 10510221`, Employment status `Active`, Employee signed `yes — on paper`,
  Officer signed `yes — on paper`). Then `DELEGATED LOOKUP (DEPTH 2)` with a nested row
  `Person Lookup  resolved 105…  pl-142320-00a1  Done`.
- Actions: green `✓ Approve this person`, `⊘ Skip for now`.
- **Then roughly a third of the pane height is empty black.**

**Asked for, verbatim:** *"i want each review to take up the max space it provides. find a way to do
it."*

**Interpretation.** The review body must consume the full available height. The obvious win is the
left column: the source-image box should grow to fill, so the page scan is as large as the pane
allows — that is the thing the operator is actually reading. "Find a way to do it" means the operator
is open on *how* (flex-grow the image column, let the right column scroll independently, or both) but
not on *whether* — dead space at the bottom of a review surface is unacceptable.

Note this also depends on item 5: the source image is a placeholder today, so filling the space is
only meaningful once real page imagery from `data/` is wired in.

**Where it lives.** `DemoLogPanel.tsx` (contains `Approve this person`, `Skip for now`,
`Next flagged`).

---

## 11 — Back/forward navigation between workflows

**Screenshot:** none — described in words.

**Asked for, verbatim:** *"there should be like a back and forth button so when i click on like a
link to go to a different workflow from a queue row, i can quickly go back to my previous workflow."*

**Interpretation.** Cross-workflow links already exist on queue rows — the `📋 OCR review · done ↗`
chip in `5.png`, the `👥 person lookup · fa… ↗` chip in `24.png`, and the `← Oath Upload` chip in
`7.png` all jump the operator to a different workflow's panel. What's missing is **history
navigation**: a back/forward pair (browser-style) that returns to the previously viewed workflow +
selected row, and forward again.

Scope it as navigation *state*, not just a button: the history entry needs to restore workflow,
selected row, and probably the active tab, so returning lands exactly where the operator left.

**Where it lives.** Navigation state in `RebuildDemo.tsx` / `DemoShell.tsx`; the back-link chip in
`7.png` is the closest existing precedent (`demo-commands.ts` may already model navigation intents).

---

## 12 — Overall structure and alignment

**Screenshot:** `16.png` (duplicate: `15.png`)

**What it shows.** A tall, extremely narrow vertical sliver — the OCR panel squeezed to roughly 60px
wide. Everything is clipped mid-word: a shield badge `H`, a tab reading `oc`, the heading `OCR`, a
section label `NEED…`, a card showing only an icon, a timestamp `2:…`, `ACTI…`, another card, `2:…`,
`FINI…`, `Tod…`, a ⚠, and at the very bottom `^ Se…`. Nothing degrades gracefully; content is simply
cut off.

**Asked for, verbatim:** *"make sure all of these are aligned properly and the dashboard have proper
structure and alignment overall."*

**Interpretation.** Two readings, and both are worth acting on:

1. **Narrow-width behaviour is broken.** At this width the panel should collapse to a defined
   minimum, or hide, or show an icon-only rail — not render clipped text. Establish a minimum width
   and a deliberate collapsed state.
2. **A global alignment pass.** The operator explicitly widens this beyond the screenshot —
   *"the dashboard have proper structure and alignment overall."* Treat it as a systematic sweep:
   consistent gutters, consistent section-label treatment, consistent card padding, aligned baselines
   across adjacent panels. This overlaps heavily with items 15 and 18.

**Where it lives.** Layout in `DemoShell.tsx`, `ds/primitives-layout.tsx`, spacing tokens in
`ds/tokens.ts`.

---

## 13 — App version naming scheme

**Screenshot:** `17.png`

**What it shows.** The `Archived runs` table. Header: title left, `820 of 820 ⓘ` right. Filter row: a
search field (`Name, EID, trace, confirmation…`) and three selects (`Every workflow`, `Any outcome`,
`Any instance`). Sortable columns: `Outcome · Name · Trace · Workflow · When · Ran for`. Rows:

```
> [major]      app 2026.07.2 → app 2026.07.3   chg-app-2026073    🗔 Every workflow — app …   Jul 20, 9:02 AM    613
> [no record]  Change record missing            chg-migration-2…   (blank)                    (blank)             1
> [major]      v8.0 → v9.0                      chg-ocr-9          ⚙ OCR                      Jul 18, 11:20 …    101
> [major]      v3.1 → v4.0                      chg-ec-4           ⚙ Emergency Contact        Jul 22, 4:41 PM    105
```

So the app currently versions as a **date stamp** (`2026.07.2 → 2026.07.3`) while individual
workflows version semantically (`v8.0 → v9.0`).

**Asked for, verbatim:** *"we should also change our app version naming scheme. the app will be like
this 1.1 the first 1 is for the major dashboard change. the second 1 is for a minor change. the minor
change does not affect any workflows but the major change affect some/all workflows. only the trace
id will tell us which is which. is that a good way?"*

**Interpretation.** Replace the date-based app version (`2026.07.3`, also visible in the status bar
in `10.png`) with a two-part `MAJOR.MINOR`:

- **MAJOR** — a dashboard change that **affects some or all workflows**.
- **MINOR** — a dashboard change that **affects no workflow**.
- The trace id on a run is what tells you which app version a given run executed under.

**The operator asked a direct question — "is that a good way?" — and it is unanswered.** Do not
implement silently. Points worth putting back to them before building:

- Two components give no room for a patch level; a purely cosmetic fix and a minor behavioural change
  would share a bucket.
- "Affects some/all workflows" is a judgement call at release time — worth defining what counts
  (schema change? presentation change? a step reordering?).
- Per-workflow versions (`v8.0 → v9.0`) stay as they are; only the **app** version changes scheme.
  Worth confirming that's the intent.

**Where it lives.** `DemoVersionBump.tsx`, `demo-archive-wire.ts`, and the version string in the
bottom status bar (`DemoShell.tsx`).

---

## (no item 14 — the operator's numbering skipped it)

---

## 15 — Title/subtitle pairs need contrast and symmetric padding

**Screenshot:** `18.png`

**What it shows.** A single settings section row inside a bordered rounded container: a gear glyph on
the left, bold white `General` on the first line, muted grey `The dates that roll over each fiscal
year.` on the second. The two lines are close in size and weight, and the vertical padding above the
title differs from the padding below the subtitle.

**Asked for, verbatim:** *"this doesnt apply to just this but to all the like title
subtitle/description setups that are enclosed. there needs to be a more noticable difference between
the two and proper symmetrical spacing from the top and bottom from the borders."*

**Interpretation.** A **global sweep across every enclosed title + subtitle/description pair** in the
demo, not a fix to this one row:

1. **Increase the differentiation** between title and subtitle — size, weight, and/or colour. Right
   now they read as nearly the same thing.
2. **Make vertical padding symmetric** — equal space from the container's top border to the title and
   from the subtitle's baseline to the bottom border.

Same "sweep the hand-rolled siblings" caution as item 3. Surfaces known to use this pattern:
settings rows (`18.png`), the activity report header (`19.png`), evidence cards (`12.png`), and the
run/worker modals (`11.png`).

**Where it lives.** Whatever primitive renders the pair (check `ds/primitives-core.tsx` and
`ds/primitives-layout.tsx`), then every hand-rolled instance across `Demo*.tsx`.

---

## 16 — Move the day picker up; remove the report's own Settings button

**Screenshots:** `19.png` and `20.png`

**What `19.png` shows.** The Activity report header block: bold `Automation activity` with muted
`Sat, Jul 25` beneath it. Right-aligned: `38 runs · 110 people`, an `ⓘ How it is counted` affordance,
and a `⤓ Export` button. Directly below, a separate strip holding a chip `Sat, Jul 25` and the text
`Every day the tracker holds (3)` — the day/range selector.

**What `20.png` shows.** The Activity report's top bar: `← Back to the dashboard` button, then
`📊 Activity report`; far right a `⚙ Settings` button.

**Asked for, verbatim:** *"this part can be added [to the top bar] and the settings will be removed
since we already have a settings at the top most navbar. btw the keyboard icon will be removed from
there since we already have help in settings."*

**Interpretation — three changes.**

1. **Promote the day/range selector** (the `Sat, Jul 25` chip + `Every day the tracker holds (3)`
   strip from `19.png`) **into the top bar** shown in `20.png`, so it sits alongside the page title
   rather than as a separate band below the header.
2. **Remove the `⚙ Settings` button** from the Activity report top bar — Settings already exists in
   the top-most navbar, so this is a duplicate entry point.
3. **Remove the keyboard-shortcuts icon** from the top-most navbar — help is reachable through
   Settings, so it's redundant too. (The icon is not in either screenshot; it's on the main navbar.)

**Where it lives.** `DemoActivityReport.tsx` (contains `Automation activity` and
`How it is counted`), `demo-report-wire.ts`, and the navbar in `DemoShell.tsx` /
`DemoTopBarSurfaces.tsx` for the keyboard icon (`demo-shortcuts.tsx` is the shortcuts surface).

---

## 17 — Remove "Back to the dashboard" from the activity report

**Screenshot:** `21.png`

**What it shows.** The isolated `← Back to the dashboard` pill button (the same one visible at the
left of `20.png`).

**Asked for, verbatim:** *"no need to have this back to dashboard in activity."*

**Interpretation.** Delete the back button **from the Activity report specifically**. The operator
scoped it — "in activity" — so leave the equivalent button on Archive, Explorer, and Settings alone
unless told otherwise.

**Check before deleting:** make sure another route back to the dashboard exists from the Activity
report (navbar, Esc, or the rail). If this is the only exit, raise it rather than stranding the page.
Item 11's back/forward navigation may be the intended replacement.

**Where it lives.** `DemoActivityReport.tsx` (the string also appears in `DemoArchive.tsx`,
`DemoExplorer.tsx`, and `DemoSettings.tsx` — do **not** change those).

---

## 18 — Toolbar: uniform heights and proper alignment

**Screenshot:** `23.png` (duplicate: `22.png`)

**What it shows.** The full-width queue toolbar, one row, left to right:

```
[▷ se  6] [▶ Start a run]   [▦ All 5] [👁 Needs you 3] [⏱ 0] [◐ Running 1]
[👤 Waiting on you 2] [⏸ Write parked 1] [✓ 0] [ⓘ 0] [⚠ Failed 1] [⊘ 0]
                                              …            [⇅ Attention first] [☐ Select]
```

`All 5` is the selected filter (lighter fill). The controls visibly differ in height and internal
padding — the `Start a run` button, the filter chips, and the right-hand `Attention first` / `Select`
controls do not share a baseline or a box height.

**Asked for, verbatim:** *"all these should be the same height no matter what. the buttons and all.
make it symmetrical, align them properly like a professional dashboard."*

**Interpretation.** Every control in this toolbar gets **one fixed height** regardless of content
(icon-only, icon+label, label+count, selected vs unselected). Normalise horizontal padding, centre
contents vertically, and align the whole row on a single baseline. "No matter what" is the operative
phrase: a chip with a count must be the same height as one without.

This connects to item 3 — the same chips also need the border + matte black fill.

**Where it lives.** `DemoQueue.tsx` / `DemoBulkBar.tsx` (both reference `Start a run`), with the
control height token in `ds/tokens.ts`.

---

## 19 — Remove the inline "Retry the lookup" button

**Screenshot:** `24.png`

**What it shows.** A failed queue card: red ⚠, bold `Dana Whitmore`, ⓘ, and a solid red `Failed`
badge right-aligned. Body: red text `Person lookup failed — UCPath person sea…` (truncated) with a
red-outlined **`Retry the lookup`** button on the right. Below, a chip `👥 person lookup · fa… ↗`.
Footer: `1:18 PM  #4  se-131818-31c6  1m 10s` with a **↺ retry icon** and a 🗑 trash icon.

**Asked for, verbatim:** *"retry the lookup is not needed here since i know i can just do it myself
from the footer."*

**Interpretation.** Remove the inline `Retry the lookup` button — the footer's ↺ already does the
same job, and having both is redundant. Same theme as item 20: **avoid redundancy**. The failure
message text stays.

**Where it lives.** `DemoFailure.tsx` / `demo-wire.ts` (both contain the `Retry the lookup` string),
rendered by `DemoQueue.tsx`.

---

## 20 — Write-parked rows: restore the footer ✕, drop the duplicate chips and Resolve buttons

**Screenshots:** `25.png`, `26.png`, `27.png`, `28.png`

**What `25.png` shows.** A parked queue card with an amber left accent bar: ⏸, bold `Rosa Delgado`,
ⓘ; right side an amber **dashed-outline** chip `Write parked · 48m 49s`. Body: amber text
`Write outcome unknown — submit sent, confirmati…` with an amber-outlined `Resolve` button. Footer:
`1:48 PM  #3  10577201  52m 57s` — and the right side of the footer is **empty**. No ✕, no ↺, no 🗑.

**What `26.png` shows.** A detail-pane header: bold `Rosa Delgado` plus the amber dashed chip
`⏸ Write parked · 33m 50s` — the same status chip repeated in a second place.

**What `27.png` shows.** A cropped fragment: the tail of a trace id `…e-134802-c2d7`, some truncated
text, and **another** amber-outlined `Resolve` button — a second instance of the same action on a
different surface.

**What `28.png` shows.** A detail-pane header: bold `Maria Lopez-Garcia`, amber chip
`👤 Waiting on you · 22m 26s`, right side ⓘ `se-140211-9f3a`. Beneath it, an amber-bordered gate
banner: `● Paused on identity approval — 18m in gate · nothing written yet` with a blue `Review`
button. Then the tab row `📄 Logs · 🧾 Receipt`.

**Asked for, verbatim:** *"even for write parked, it should still have the x at footer for
cancellation. the [26] ride parked should not be there. [27] the resolve button should not be there
either. avoid redundancy. [28] same here."*

(Reading "ride parked" as a typo for "write parked".)

**Interpretation — four changes.**

1. **`25.png` — restore the footer ✕.** A write-parked run must still be cancellable from the footer,
   like every other row. Its absence is the bug.
2. **`26.png` — remove the `Write parked` chip from the detail header.** The status is already
   established by the queue card and by the gate banner; repeating it in the header is redundant.
3. **`27.png` — remove that duplicate `Resolve` button.** Keep exactly one Resolve affordance. Given
   item 19's logic (the operator prefers the canonical footer/inline location and dislikes doubles),
   determine which of the two is canonical and delete the other — don't keep both.
4. **`28.png` — same treatment for the `Waiting on you` header chip.** This is the identical pattern
   to item 4: the header chip duplicates what the gate banner underneath already says. Remove the
   chip; keep the banner and its `Review` button.

**The through-line for this item and item 4: the detail header should not repeat status that the gate
banner immediately below it already states.** That is a general rule worth applying to every gated
state, not just these two.

**Where it lives.** `DemoParkResolve.tsx` and `demo-flows-wire.ts` (park/resolve),
`DemoLogPanel.tsx` (detail header + gate banner), `DemoQueue.tsx` (footer actions).

---

## Cross-cutting themes

Several items are the same complaint in different places. Fixing them as themes rather than as
twenty separate patches will produce a more coherent result:

- **Redundancy elimination** — items 4, 19, 20. Status and actions are repeated between the queue
  card, the detail header, and the gate banner. Establish one canonical home per piece of
  information.
- **Chip/control consistency** — items 3, 18. Border + matte black fill, one fixed height, uniform
  padding, applied to the primitive *and* every hand-rolled sibling.
- **Enclosed title/subtitle rhythm** — items 15, 12. Contrast between the two lines, symmetric
  vertical padding, consistent across every surface that uses the pattern.
- **Space utilisation** — items 5, 8, 10. Three surfaces where content occupies a fraction of the
  space allotted to it.
- **Real data instead of placeholders** — items 5, 10. `data/` has real oath packets, I-9 scans,
  rosters, and extraction records; the demo should use them (mind the PII caveat in item 5).

## Constraints that apply to all of the above

- **This is refinement, not redesign** — visual parity with the current dashboard is ratified.
- **D24** — no explanatory prose in the UI; ⓘ or nothing.
- **Chips** — bordered, matte, never wrap.
- **Both themes** — every change must be checked in Graphite Warm (dark) and Paper Ink (light).
- **Typecheck is not verification.** Four previous waves shipped defects that only *booting the app*
  caught: a fixture holding a formatted clock string where a demo instant was required (crashed the
  panel on save), a Radix `Tooltip` with no `TooltipProvider` (blank page, swallowed by the error
  boundary), and a Popover that teleported the toast viewport. **Boot it and drive it.**
- **After `npm run build:dashboard` you must restart the server and close the browser session**, or
  you screenshot a stale bundle.
- **Port 3838 is the operator's own dashboard — never touch it.** Use a fallback port.
- **Never `git add -A`.** Stage explicit paths; the tree contains uncommitted operator work.
- **Never `git checkout` / `stash` / `reset` this tree** — a previous session discarded four
  uncommitted operator files that way.

### Booting the demo

```bash
npm run build:dashboard
HRAUTO_TRACKER_DIR=generated/.dashboard-preview/tracker npm run dashboard:prod -- --port 3941
#   http://localhost:3941/?view=rebuild-demo
```

---

## Also pending — carried in from the prior handoff

These two were ratified before this batch of screenshots and are still unbuilt. Full detail in
`docs/superpowers/handoffs/2026-07-28-demo-capability-matrix-and-dryrun.md`.

**A. A read-only capability matrix.** Per workflow, show which capabilities it has and which it
lacks: dry run · roster · workers · presets · capture · duplicate check · multi-file/merge ·
sub-selections · member outcomes · startability (and by which methods) · delegation targets · whether
it writes to a system of record. Must be **derived from the served descriptor**, never a
hand-maintained table. Crucially, **"missing" must be distinguishable from "not applicable"** —
`work-study` has no dry run *by decision*; `person-match` has no start path *because nothing calls
it*. Settings is the suggested home. Read-only, no toggles.

**B. Onboarding's dry-run boundary is broken.** `onboarding` creates the I-9 profile even on a dry
run — the dry-run guard sits *after* `i9-creation`. Operator, verbatim: *"onboarding should not
create i9 during dry run. dry run means nothing gets submitted."* This is a **correctness change to
the real product**, not a demo change: the boundary moves before `i9-creation`, and the rule to
encode is *dry run means no system of record is written, at all, by any step* — not merely "no final
submit."

The asymmetry between the two is the point: `work-study` lacking a dry run is fine because it claims
none. Onboarding is broken because it claims one and doesn't honour it. **A capability that lies is
worse than a capability that is absent.**
