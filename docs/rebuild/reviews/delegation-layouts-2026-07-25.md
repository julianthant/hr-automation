# Delegation — topology, shapes, and layouts (2026-07-25)

**Status:** proposal — **§7 ANSWERED and ratified 2026-07-25 as D6–D20 in
`docs/rebuild/03-tracker-dashboard.md` §9** (§5's S4 layout is deleted by D6). Where this ledger and
doc 03 §9 disagree, §9 wins.
**Question this answers:** "figure out how single and multiple delegations should look across
multiple workflows and how the design should be laid out and all the design layouts and what
should be there."

**Provenance:** code-grounded sweep of all 16 workflows by an Opus subagent, with `file:line`
citations retained so every claim is checkable. Claims are cited, not vouched for line-by-line —
verify a citation before you depend on it.

Designed inside the ratified model (`second-look-2026-07-22.md` §6.6): three row types
(Run / Group / Member), review-as-status, eight statuses, persistent step strip, visual parity
with today's dashboard.

---

## 1. Delegation topology — all 16 workflows

| # | Workflow (code) | Delegates to | Depth | Cardinality | Child gets its own row? | Gate in the middle? |
|---|---|---|---|---|---|---|
| 1 | **ocr** (`oc`) | `person-lookup` per record, `i9-lookup` (verify), `sharepoint-download` (roster) | 1 (2 when itself delegated) | 1:N, 1:N, 1:1 | Yes — own rows in their panels | Yes when delegated; no standalone |
| 2 | **oath-signature** (`os`) | nothing | 0 (is a child) | — | n/a | no |
| 3 | **oath-upload** (`ou`) | OCR prep under it; then waits on N signer rows | 1 | 1:1 + 1:N | Yes (both) | Yes — `wait-approval` |
| 4 | **emergency-contact** (`ec`) | OCR under it; on approve, N EC members | 1 (2 via OCR) | 1:1 + 1:N | OCR yes; members nested | **Yes** |
| 5 | **onbase** (`ob`) | same as EC | 1 / 2 | 1:1 + 1:N | same as EC | **Yes** |
| 6 | **i9-check** (`ic`) | OCR under it (auto-completes), then N real member tasks | 1 | 1:1 + 1:N | OCR yes; members nested | **No** (`completeDelegatedRun`) |
| 7 | **separations** (`se`) | `person-lookup` — **conditional**, only on name mismatch / bad EID | 1 | 1:1 (0 on the happy path) | Yes | Yes, after — the EID-approval pause |
| 8 | **onboarding** (`on`) | nothing — CRM docs in-process on purpose (a delegate would force a fresh CRM Duo) | 0 | — | n/a | no |
| 9 | **person-lookup** (`pl`) | nothing | 0 | — | n/a | no |
| 10 | **i9-lookup** (`i9`) | nothing | 0 | — | n/a | no |
| 11 | **person-match** (`pm`) | nothing | 0 | **zero callers today** — i9-check searches inline | no |
| 12 | **sharepoint-download** (`sp`) | nothing | 0 | — | Yes | no |
| 13 | **crm-doc-download** (`cd`) | nothing | 0 | — | n/a | no |
| 14 | **kronos-pay-rule** (`kp`) | nothing | 0 | — | n/a | no |
| 15 | **work-study** (`ws`) | nothing | 0 | — | n/a | no |
| 16 | **old-kronos-reports** (`kr`) | nothing | 0 | — | n/a | no |

**Cross-cutting mechanism (not a workflow):** any input-run workflow with **N > 1 typed values**
mints a coordinator + member children (`core/daemon/enqueue-dispatch.ts:270-281`). Applies to
separations, person-lookup, oath-signature, crm-doc-download, onboarding, kronos-pay-rule.
`oath-signature` does it at N = 1 too.

**Maximum real depth in the system is 2** (coordinator → OCR → person-lookup). Nothing reaches 3.

---

## 2. The seven delegation shapes

| Shape | Name | Workflows | Definition |
|---|---|---|---|
| S0 | **Just a run** | work-study, kronos-pay-rule, crm-doc-download, onboarding, kronos-reports, standalone person-lookup | Run Row, no children. |
| S1 | **Looked someone up mid-run** | separations (conditional), OCR → sharepoint-download | Run pauses, hands one sub-job to another workflow, resumes. |
| S2 | **Packet with a review gate** | oath-signature, emergency-contact, onbase | PDF → Group Row → delegated OCR review → **you approve** → N member writes. |
| S3 | **Packet with no gate** | i9-check | PDF → Group Row → OCR auto-completes → N member checks. |
| S4 | **Packet that ends in one filing** | oath-upload (full mode) | The parent is a real task that waits for its own children, then does one final act (the ticket). |
| S5 | **A list you typed** | separations, onboarding, crm-doc-download, kronos-pay-rule, person-lookup ×N; oath-signature ×1+ | Group Row from N typed inputs. No OCR, no gate. |
| S6 | **Read-only packet report** | standalone OCR | OCR Run Row that fans out lookups and finishes. No approve, nothing downstream. |
| S7 | **The helper run's own view** | person-lookup, i9-lookup, sharepoint-download panels | How a delegated child looks **in its own panel**, when its parent lives elsewhere. |

Two corrections to the obvious guesses: there is **no** gate-less coordinator that is not
OCR-backed, and one-hop enrichment is **conditional and rare** — separations skips it on the happy
path. S7 is the half of delegation nobody designs, and roughly half the delegated rows in the
system are viewed from the child side.

---

## 3. The whole model in one field: `containment`

Everything below reduces to one bit stamped on the child at enqueue.

- **`member`** — created by the parent fanning out over its own work items. Renders **only** nested
  in the group. Counts toward the group's member count and rollup.
  *(approve fan-out, i9-check members, oath-upload signers, multi-value input-run children)*
- **`linked`** — an independently-meaningful sub-run the parent waits on. Keeps its **own row in
  its own panel**; the parent shows a **chip**, never a copy. Never counted as a member.
  *(OCR under a coordinator — D4; person-lookup / i9-lookup / sharepoint-download under anything)*
- **`rejected`** — an item the parent could not turn into work. Member Row, delete-only (D3),
  counted separately as `N rejected`, excluded from the rollup.

**Amended by `../03-tracker-dashboard.md` §9 D6:** oath-upload's signers are **`linked`**, not
`member` — they keep their own rows in the Oath Signature panel and are never counted as members.

No workflow-name switches in the projection path.

---

## 4. Group Row anatomy (shared by S2 / S3 / S4 / S5)

**Collapsed (default, D5):**

```
▸ [icon] Oath_Packet_Summer.pdf            OATH SIGNATURE    Waiting on you · 10m
         Waiting on you — approve the people to sign              [Review]
         ↳ OCR review · waiting on you  ↗
         ▪▪▪▫▪✕   6 people · 1 rejected                        0/6 checked
         2:20 PM  #5  os-142012-b410              10m 40s   Cancel remaining  ×
```

- **Title/subtitle by subject kind** — file → PDF name, person → resolved name, catalog → spec
  label. Subtitle = trace id · time · `#run`.
- **Member chiclets** — one cell per member up to 12; 13+ becomes a proportion bar.
- **Count badge** — kind-aware noun (`6 people`, `50 people`, `4 reports`). Rejected is always its
  own muted chip.
- **Linked chip** — `OCR review · waiting on you ↗`. Present whenever a `linked` child exists and
  is non-terminal, or terminal-failed.
- **Outcome line** — one present-tense sentence saying what is blocked and what is at risk. Never
  a step name.

**The presentation ladder** (member count is continuous — this is presentation, not a row type):

| Members | Expanded body |
|---|---|
| 1–3 | Full Member Rows inline, always expanded |
| 4–12 | Compact member list; first 4 + `Show all N` |
| 13–40 | Compact list in a scroll well + `Open all N` |
| 41+ | **Status matrix** + attention strip + `Start review` → drill-in |

**Auto-expand (D5):** any member `Waiting on you` or `Failed` expands the group regardless of the
operator's collapse state; at 41+ the attention strip renders **above** the matrix.

**Rollup precedence** — one server-side function shared by the row, the Status Bar and the panel
badge, never recomputed:

`Waiting on you` > `Failed` > `Write parked` > `Running` > `Queued` > `Done with warnings` >
`Verified done` > `Cancelled`

`Verified done` requires every member terminal, none failed/warned/rejected-unacknowledged. A group
whose only non-done members are rejected is `Done with warnings`.

---

## 5. Layouts per shape

### S2 — Packet with a review gate (oath-signature / emergency-contact / onbase)

**Queue Panel — three row objects, two panels:**

| Row | Panel | Type | Notes |
|---|---|---|---|
| The packet | target panel | **Group Row** | Owns the count, the rollup, the link chip. |
| The OCR review | **OCR panel** | **Run Row** (D4) | Own trace; carries `Delegated by <packet> ←`. |
| Each approved person | target panel, nested only | **Member Row** | Never top-level. |
| Each un-approvable person | target panel, nested only | **Rejected Member Row** | Delete-only. |
| Each person-lookup during OCR | Person Lookup panel | Group Row mirroring a foreign parent | `6 lookups for <packet>`. Depth 2 — **not** shown on the packet. |

Before approval the Group Row shows **zero members** — honest, they do not exist yet. The body is
the OCR status line + the chip, and the count reads `6 people extracted`, flipping to `6 people` at
fan-out.

**Parent Log Panel.** Step strip is the operation pipeline, not any member's:
`Upload 9s → Read forms 2m 8s → Match roster 31s → ⏸ Your review → Signer fan-out (0/5) → Rollup`.
Hovering a step gives status, real duration, attempts, key log lines, screenshot link. The fan-out
chip is a fill bar.

| Tab | Content |
|---|---|
| **People** | The member work surface: attention-first list, per-person facts, checked-by-you count, click into any person. |
| **Logs** | Coordinator stream with member events **folded** (`▸ 44 member events (3 failed)`), never a 50-way interleave. |
| **Data** | Packet-level facts: pages, readable pages, roster + match count, model, and the staged writes. Not per-person. |
| **Receipt** | Rollup table: person · outcome · confirmation number · observed identity at commit · screenshot. Q8 acceptance — the double-check completes without opening UCPath. |

The gate itself is a **banner pinned above the tabs**, not a tab: `Waiting on you — approve the
people to sign · open 10m · since 2:22 PM`, with `Open review` (jumps to the OCR row's Review tab),
`Approve 5 of 6`, `Discard packet`. The record-by-record work is never duplicated on the parent.

**Child Log Panels.** The OCR row carries a `← <packet>` back chip and the Review tab —
**the ratified page ↔ extraction pair**: rendered page left, extracted fields right with provenance
chips (`paper 0.44` / `roster` / `ucpath`), per-record `ready / flagged / blocked`, per-record
re-lookup, and a running `Approve N of M`. A Member Row is **identical to a Run Row** plus a
conveyor header (`‹ 3 of 6 ›`) and a `From packet page 4` provenance line. A Rejected Member Row
shows one greyed `Not run` chip, the rejection reason, and delete only.

**Across the 8 statuses:**

| Status | Group Row | OCR child | Members |
|---|---|---|---|
| Queued | `Queued · uploading`, no chip yet | — | — |
| Running | `Running · reading 8 pages` + `OCR · running` | running | — |
| **Waiting on you** | **auto-expanded**, gate summary, `Open review` | Review tab default | — |
| Write parked | per member after approval; group rolls up, expands | terminal | parked member shows resolve present/absent |
| Verified done | collapsed, Receipt default, `6 people · 6 verified` | done | each with confirmation number |
| Done with warnings | `1 rejected · 1 low-confidence read`; expands only the offenders | may carry fabrication warnings | warning count + first warning |
| **Failed** | **auto-expanded**; a failed OCR child's error is **mirrored onto the group** — never "Unknown error" | error card inline at the failing line | per-member retry |
| Cancelled | tree-scoped: group, OCR child and its lookups cancel together | cancelled | queued + running cancelled |

### S3 — Packet with no gate (i9-check)

Same anatomy minus the gate:
- Strip: `Upload → Read packet → Pair pages → Match roster → Member checks (44/50) → Rollup`. No
  "Your review" step; the OCR child goes straight to `Verified done`.
- **No gate banner** — never render an empty one.
- The chip reads `OCR extraction · done →`, muted rather than urgent.
- Rejected Member Rows are load-bearing here: `Not run — page 7 named nobody searchable`,
  delete-only, excluded from the rollup, shown in the count as `50 people · 3 rejected`.
- The coordinator **stays Running** until member rollup — never look done at 44/50.
- Receipt is the retention-tracker receipt: rows appended + per-person Action, so the sheet is
  auditable from here.

### S4 — Packet that ends in one filing (oath-upload)

> **SUPERSEDED by `../03-tracker-dashboard.md` §9 D6 — this layout is deleted.** Oath Upload is a
> **Run Row** with `linked` signer children (own rows in the Oath Signature panel + a
> `6 signers · 3 done ↗` chip), not a Group Row. Everything below about members, member counts, and
> a member rollup on the upload row is void; the strip, the ticket-number headline, tree-scoped
> cancel, and the Write-parked handling survive as Run Row behavior.

The parent is a real task, not a display coordinator. **Render it as a Group Row anyway**, whose
members ARE the signer runs — and **do not** also list those signers as top-level rows in the Oath
Signature panel. Nobody starts one of those signers independently; double-listing is precisely the
count-divergence bug class the rebuild exists to kill.

- Strip: `Upload → OCR review (linked) → ⏸ Your approval → Signatures (0/5) → ServiceNow auth →
  Fill form → Submit`. The last three belong to the **parent itself** — that is what separates S4
  from S2: after the members finish, the parent keeps working.
- The collapsed row shows both the member count and the parent's own progress; after submit its
  headline fact becomes the **ticket number**.
- Cancel is tree-scoped and labelled with its casualties: *"Cancels the ticket, the OCR review, and
  5 signer tasks."*
- The dangerous status is **Write parked** (crash between POST and persist): *"a ticket may already
  exist"*, with `Record ticket number…` / `Confirm no ticket, re-file`. Never auto-retry.

### S5 — A list you typed

Group Row, no linked child, no gate, no OCR.
- No title on the anchor — `5 separations` + a name preview.
- All children are `member`, same workflow as the parent.
- The strip is **the members' shared pipeline with per-step fill bars**
  (`Kuali extraction 5/5 → Identity check 4/5 → …`), because every member runs the identical step
  list. This is the one legitimate case of a group strip being a member aggregate.
- A member hitting an identity gate flips the group to `Waiting on you` + auto-expand.
- oath-signature at N=1 renders on the 1–3 rung: a group of one, visibly a group.

### S6 — Read-only packet report (standalone OCR)

A Run Row, never a group, no approve, no members.
- Strip ends `… → Person lookup → Done`. No `Awaiting approval` phase — approval ≡ delegation.
- Review still exists but is **read-only**: same page ↔ extraction pairs with a ✓/✗ completeness
  checklist and per-check re-lookup.
- Its lookups are `linked` → own rows, surfaced as a `6 lookups →` chip.
- It can never be `Waiting on you` or `Write parked` — nothing downstream, nothing written.

### S7 — The helper run seen from its own panel

- Lookups delegated by one parent **collapse into one Group Row** titled by the parent
  (`6 lookups · Oath_Packet_Summer.pdf`), subtitle = the parent's trace prefix, plus a
  `Delegated by →` chip. Never N loose top-level rows.
- An operator-started lookup is a plain Run Row; the chip is the only difference.
- Its Data tab must say what the parent will do with the answer:
  `Result feeds → Oath_Packet_Summer.pdf · record 3 (Ben Brooks) EID`. Without that line a
  delegated lookup is context-free.
- A `linked` child that fails must not leave the parent hanging — the parent shows
  `Failed — person lookup for Ben Brooks failed` with the child's error mirrored, and its retry
  retries **the child**, keeping the child's task id so the dependency reopens.

---

## 6. Single vs multiple delegation — the hard cases, decided

**Two different child workflows at once** (an EC coordinator with an OCR review child *and* N EC
members — the live case, not hypothetical): they are different containment kinds, so they never
compete for space. The `linked` child lives in the **header region** as one chip; `member` children
live in the **body region** as the ladder. Sequencing makes it clean — before approval the body is
empty and the chip carries the story; after approval the chip goes muted and the body fills. The
chip never disappears: the operator must always be able to get back to what was read off the paper.

**Two `linked` children** (an OCR run with both person-lookups and a sharepoint-download): one line
of up to two chips ranked by attention, `+N` overflow opening a popover. No delegation sub-panel.

**Does a member ever delegate (depth 2 under a group)?** Not today. Depth 2 exists only under a
`linked` child. Allow it structurally and present it identically — a Member Row that acquires a
linked child renders the same header chip a Run Row would. Member Rows are Run Rows with a
containment header; that equivalence is the load-bearing simplification.

**Navigation model — two primitives, no breadcrumb trail** (max real depth is 2; a breadcrumb for
depth 2 is ceremony):

1. **Expand in place** for `member` containment. Groups expand inline, the Log Panel follows
   selection, never a page change.
2. **Jump + back-chip** for `linked` containment and large-group drill-in. One level of back,
   because there is only ever one parent worth returning to. Depth-2 children show
   `← OCR · <packet>` — the chips are not stacked; home is two named clicks away.
3. **Conveyor inside a member set** — `‹ 3 of 6 ›` plus `n` for next-needing-attention. At 41+
   members `Start review` enters the drill-in, which is a **rung of the ladder**, not a new route.

**Which panel owns a run that appears twice?** Exactly one owns it; the other shows a chip, never a
copy. Owner = the workflow that executes it. One row, one home, one count.

**What does the parent's status do while a linked child is mid-flight?** It adopts the child's
*attention-bearing* status, never its neutral one. Running child → parent Running. Child reaching
`Waiting on you` → parent `Waiting on you` (the gate is genuinely the parent's). Child `Failed` →
parent `Failed` with the child's error mirrored. Finished child → parent's own work decides.

---

## 7. Open questions for the operator

> **ANSWERED 2026-07-25 — CLOSED, not open.** All twelve are ratified into
> `../03-tracker-dashboard.md` §9: Q1→D6, Q2→D7, Q3→D8, Q4→D9, Q5→D10, Q6→D11, Q7→D12, Q8→D13,
> Q9→D14, Q10→D15, Q11→D16, Q12→D17 (plus D18 Status Bar pills, D19 tab model, D20 write-parked
> semantics). **Q1, Q10 and Q11 were answered AGAINST the recommendation printed below** — read the
> decision in doc 03 §9, never the recommendation here.

Each with a recommendation — answer inline and this becomes ratified.

1. **Should oath-upload's signers disappear from the Oath Signature panel and live only inside the
   Oath Upload packet?** *Recommend yes* — they are not independently meaningful, and
   double-listing is the count-divergence bug class.
   → **ANSWERED NO — superseded by doc 03 §9 D6:** signers stay in the Oath Signature panel as
   `linked` children; Oath Upload stays one Run Row with a chip; shape S4 is deleted.
2. **Should a packet still at OCR review show `6 people extracted` before those members exist?**
   *Recommend yes* — it answers "how big is this" at a glance.
3. **Should the group be able to bulk-approve without opening the OCR row?** *Recommend yes for the
   bulk action, no for editing* — any edit forces `Open review` so the page is on screen when a
   value changes.
4. **Do rejected members count toward done?** *Recommend no* — a packet with rejections is
   `Done with warnings` until each is deleted or acknowledged.
5. **Are depth-2 lookups visible from the packet?** *Recommend no* — only from the OCR row. From
   the packet you ask "why is this person blank", and that answer belongs on the record card.
6. **At what member count does the matrix replace the list?** *Recommend 41.* If your real packets
   cluster at 15–25 rather than 50–60, say so and it drops to ~25.
7. **Show the gate's age on the collapsed row?** *Recommend yes* (`Waiting on you · 10m`) — an
   aging gate is the most actionable fact in the queue.
8. **When a linked OCR child fails, is the parent `Failed` or `Waiting on you`?** *Recommend
   `Failed` with a `Re-upload` action* — "Waiting on you" should mean a decision is pending, not
   that something broke.
9. **Should a 1-member group ever render as a plain Run Row?** *Recommend no* (D2). A group of one
   that looks like a run makes the next fan-out look like a new object.
10. **`person-match` has zero callers — keep it in the Workflow Panel?** *Recommend hiding it*
    (keep it registered). A panel that can never have a row is noise.
    → **ANSWERED KEEP IT VISIBLE — superseded by doc 03 §9 D15.**
11. **Should cancelling any group default to tree scope?** *Recommend yes*, with a confirm naming
    the casualties. Row-scoped group cancel is what produced orphaned OCR reviews historically.
    → **ANSWERED tree scope YES, confirm NO — superseded in part by doc 03 §9 D16:** no dialog and
    no undo window; cancel is final, recovery is a re-run from history.
12. **Per-member confirmation numbers inline on the packet receipt, or a link per member?**
    *Recommend inline* — the Q8 acceptance test is "double-check without opening UCPath", and a
    link per member re-introduces N clicks.
