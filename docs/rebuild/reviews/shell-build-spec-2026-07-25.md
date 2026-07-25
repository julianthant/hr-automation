# Shell build spec — Top Bar · Workflow Panel · Status Bar · Session Panel (2026-07-25)

**Status:** reference spec for the rebuild. Extracted from the shipped `src/dashboard/` so the four
shell surfaces can be rebuilt faithfully without reading the originals.
**Companions:** `legacy-keep-ditch-2026-07-25.md` (row + log panel verdicts),
`delegation-layouts-2026-07-25.md` (delegation).

Naming per the ratified canon: Workflow Panel · Status Bar · Queue Panel · Queue Row · Log Panel ·
Session Panel · Session Card · Run Modal. **The code is not renamed yet — the canon is on paper
only, and the session drawer alone has 5 different names in code and prose.** The rebuild renames.

---

## 0. Foundation

**Shell layout:** `div.flex.flex-col.h-screen` → Top Bar → `div.flex.flex-1.overflow-hidden`
[ Workflow Panel 200px | ResizablePanelGroup( Queue Panel · handle · Log Panel ) ] → Session Panel.

**Theme:** `dark` on **both** `<html>` and `<body>` (a scoped toggle must flip both). IBM Plex Sans
/ IBM Plex Mono. `--radius: 0.5rem`.

```
--background 240 4% 4%    --foreground 240 5% 96%   --card 240 4% 7%
--secondary  240 4% 10%   --muted 240 4% 9%         --accent 240 4% 13%
--muted-foreground 240 4% 56%   --border 240 3% 14%   --ring 240 4% 50%
--destructive 0 58% 62%   --success 142 48% 55%     --warning 38 55% 58%   --info 211 62% 64%
--log-cyan 189 58% 58%    --log-teal 172 44% 54%    --log-violet 258 55% 72%  --log-slate 215 16% 60%
--primary 240 5% 90%      ← near-WHITE, not an accent colour
```

Active nav, `bg-primary` CTAs and the running-step dot all render monochrome. Only two raw hex
values are sanctioned today (`#4ade80` auth-ready green, `#fbbf24` duo/queued amber) — **the rebuild
should tokenise both and have zero exceptions.**

Icons: lucide only, never glyphs. Interactive: real `<button type="button">`. Motion: `motion-safe:` /
`motion-reduce:animate-none`, no `@keyframes`.

**Hygiene numbers the rebuild should beat:** 122 components, exactly **1** `data-testid`, 155
`aria-label`s versus **199 uncontrolled `title=`** attributes.

---

## 1. Top Bar

`div  relative z-20 flex items-center justify-between gap-4 px-6 py-2 bg-card shrink-0 border-b border-border`

- **Brand** — `span text-[16px] font-bold tracking-tight` → `RRSS HR`.
- **Search** — absolutely positioned so it escapes the flex row, left `200px`, width
  `calc(300px + ((100vw - 200px - 300px)/4))` (380/460 at 1440/1536). Container
  `flex items-center gap-2 bg-secondary border border-border rounded-lg h-8 px-3 focus-within:border-primary`;
  `<Search w-3.5 h-3.5 text-muted-foreground>`; input `flex-1 bg-transparent border-none outline-none text-xs`;
  trailing slot = spinner while in flight, else a clear `<X>`.
- **Right cluster** `flex items-center gap-1`: bell → `‹` → date → `›` → help → settings. Every
  button `h-8 w-8 rounded-md border border-border bg-secondary … focus-visible:ring-2 focus-visible:ring-primary`;
  the date button is `h-8 px-3 … font-mono text-[12px] tabular-nums min-w-[126px]` +
  `data-[state=open]:border-primary`.
- **Bell badge** — `absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full ring-2 ring-card
  font-mono text-[10px] font-bold`; `bg-destructive` when any unread failure, else `bg-primary`; `99+` cap.
- **Bell popover** `align="end" w-[420px] p-0`. Filter chips `rounded-full border px-2 py-0.5
  text-[11px]` (All · Errors · Runs · OCR · Capture). Cards `rounded-lg border-border/60 bg-card/40
  shadow-sm hover:border-border hover:bg-accent/30`, kicker = severity icon + workflow label
  `text-[10.5px] uppercase tracking-wider` + right-aligned `font-mono text-[10px]` time; title is the
  click target `text-[13px] line-clamp-2`; footer trace id `font-mono text-[10px]
  text-muted-foreground/60` + `Re-run` revealed by `opacity-0 group-hover:opacity-100
  focus-within:opacity-100`.
  Severity map: success `CheckCircle2/text-success` · info `Info/text-info` · warning
  `AlertTriangle/text-warning` · error `XOctagon/text-destructive` · message `Bell/text-muted-foreground`.

> **No `Today` button and no amber `History` chip.** Both were removed 2026-06-17 after operator
> friction. The date navigator is exactly `‹ [date] ›` + calendar popover; the only off-today cue in
> the whole shell is the `History` pill in the Session Panel bar. Do not re-add them.

### States

| Surface | State | Treatment |
|---|---|---|
| Date button | open | `data-[state=open]:border-primary` |
| Search | typing / settled / focus | trailing spinner · trailing clear `X` · `focus-within:border-primary` |
| Search panel | results / zero hits / **failed** | panel · centered empty · `role="alert"` + `border-destructive/30` + `TriangleAlert` |
| Bell | 0 unread / unread / unread+failures | no badge · `bg-primary` · `bg-destructive` |
| Bell panel | loading / empty / backfill-failed / populated | distinct copy each |
| Gear | open | `border-primary bg-accent text-foreground`, `aria-pressed` |

### Copy

| Element | String |
|---|---|
| Search placeholder | `Search history (email, emplId, docId, name)...` |
| **Search failed** | `Search failed` / `Could not reach the search service — this does NOT mean there are no matches. Try again before concluding a subject was never processed.` |
| Zero hits | `No matches` / `No tracker entries matched "<q>" in the last 30 days.` |
| Date aria | `Calendar — currently <Jul 25, 2026>`; format `en-US { month:"short", day:"numeric", year:"numeric" }` |
| Bell aria | `Notifications — nothing new` / `Notifications — N new`; sr-only live `N unread notification(s)` |
| Bell empty | `No notifications` / `You're all caught up.` |
| Bell backfill error | `Couldn't load notification history` / `The live feed is current, but past failures may be missing — try reopening.` |
| Shortcuts | `↑ ↓` move selection · `Ctrl Shift R` retry · `x` cancel · `/` focus search · `[ ]` prev/next workflow · `g t` today · `?` toggle guide · `Esc` close · `⌘/Ctrl J` toggle session drawer |

### Data shape

```ts
TopBarProps { date: string; onDateChange(d): void; availableDates: string[] /* DEAD — accepted then voided */;
              rightSlot?: ReactNode; onSearchSelect?(row): void; onOpenNotification?(ref): void;
              failureCounts?: Record<string, number> }
AppNotification { id; kind: `${domain}.${event}`; severity: "success"|"info"|"warning"|"error"|"message";
                  title; description?; source?; entityRef?; traceId?; dedupeKey?; ts; rerunnable? }
```

### Behaviours

- Search debounce **300 ms**; Enter bypasses; Escape closes + blurs; outside `mousedown` closes; a
  monotonic request id discards out-of-order responses.
- **Fail-loud search**: a non-2xx / network error renders a distinct alert and must never collapse to
  an empty result list — an operator reading "no matches" could re-run an irreversible transaction.
- Date chevrons move ±1 calendar day, not limited to dates that have data.
- Bell backfills `/api/failures` on open, merged with the live feed, deduped by key (live wins). Two
  watermarks: a `failureTotal − ack` integer and a `lastSeenAt` timestamp, with `run.failed` excluded
  from the timestamp count so it isn't double-tallied.
- **Known open defect to fix in the rebuild:** a malformed `/api/failures` body currently degrades to
  "no failures" instead of an error state.
- The Live pill deliberately lives in the Session Panel bar — the top bar is navigation only.

---

## 2. Workflow Panel (left rail)

`nav aria-label="Workflows"  w-[200px] shrink-0 bg-card flex flex-col` — **no `border-r`.**
Body `flex-1 overflow-y-auto py-3`. Group header `px-3 mb-1.5` > `span text-[10px] font-semibold
uppercase tracking-[0.14em] text-muted-foreground`. List `ul px-1.5 flex flex-col gap-px`.

```
button aria-current={active ? "page" : undefined}
  group w-full h-10 pl-1 pr-2.5 flex items-stretch gap-2 rounded-md text-left
  transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-pointer
  + active ? "bg-accent/40" : "hover:bg-secondary"
├── span aria-hidden  w-[3px] my-1.5 rounded-r-full
│        + active ? "bg-primary" : "bg-transparent group-hover:bg-border"
├── span flex-1 min-w-0 flex items-center
│     └── span text-[13px] truncate
│            + active ? "font-semibold text-foreground" : "font-medium text-foreground/90"
└── span shrink-0 flex items-center gap-1.5
      ├── QUEUED PILL (queued > 0)  px-1 py-0.5 rounded-sm bg-[#fbbf24]/15 text-[#fbbf24]
      │                             text-[9px] font-mono font-semibold tabular-nums leading-none
      └── TOTAL  font-mono text-[11px] tabular-nums
            count===0 ? "text-muted-foreground/50" : active ? "text-primary font-semibold" : "text-foreground"
```

**No per-workflow icon in the rail** — rows are deliberately icon-free (icons exist for the same
workflows on Session Cards and the add-worker picker).

### States

| State | Left bar | Row bg | Label | Total |
|---|---|---|---|---|
| inactive, 0 | transparent | — | `font-medium text-foreground/90` | `text-muted-foreground/50` |
| inactive, >0 | transparent | — | same | `text-foreground` |
| hover | `group-hover:bg-border` | `hover:bg-secondary` | — | — |
| **active** | `bg-primary` | `bg-accent/40` | `font-semibold text-foreground` | `text-primary font-semibold` |
| active, 0 | `bg-primary` | `bg-accent/40` | bold | zero wins → `text-muted-foreground/50` |
| queued > 0 | — | — | — | amber pill left of the total |

`active = wf === workflow && !overviewActive && !editorActive`.

### Grouping

```
PREFERRED_CATEGORY_ORDER = [Onboarding, OnBase, Separations, Work Study, Payroll, Timekeeping, Search, Utils]
OTHER_GROUP = "Other"   // always last
```
Workflows bin by their `defineWorkflow` category; missing → `Other`. SSE-discovered names not yet in
the registry (first-paint race) also bin to `Other` so they never vanish. Group order = preferred
(present ones) → newly-seen in first-seen order → `Other`. Member order = registration order, then
SSE-only names appended.

### How the badges arrive — the load-bearing part

```
SSE /events/hub topic "entries"
  payload { entries, workflows, wfCounts, wfQueuedCounts, failureCounts }
    wfCounts       = countSidebarRowsFromTrackerHistory()  — server-side collapse:
                     latest-row dedupe, EID merge, top-level queue-surface collapse, visible OCR prep rows
    wfQueuedCounts = same collapse model, QUEUED subset → guarantees queued <= total
→ entryCounts  = buildWorkflowRailEntryCounts(...)   // pass-through of wfCounts
→ queuedCounts = wfQueuedCounts                      // straight through
```

**The rail never trusts client math.** Queue Panel state must never override the active workflow's
badge.

**Standing operator complaint, still open:** the per-workflow badges "always error out". Recorded as
a rebuild *acceptance requirement*, not a legacy fix. The sharpest instance: rail vs StatPills vs
visible surfaces **never reconciled** for operations — StatPills read `0 Done / 1 Active / 1 Failed`
for a fully-terminal operation while the coordinator chip and rail disagreed. A related leak: a
cancelled delegated member counted into **Failed** while the Cancel pill read 0. Another standing
pitfall: the rail can show work the panel cannot render, because an empty derived item id poisons
the row while the rail counts control-DB `queued` directly.

**Acceptance for the rebuild: rail badges, Status Bar counts and Queue Panel rows all read the same
server projection. A count can never be computed by a second path.**

---

## 3. Status Bar (+ queue toolbar row)

```
Queue Panel root  div flex flex-col bg-background min-h-0
  + fill ? "h-full w-full flex-1" : "shrink-0 w-[300px] min-[1440px]:w-[380px] 2xl:w-[460px]"
├── HEADER BLOCK  flex flex-col shrink-0 border-b border-border bg-card/60
│   ├── STATUS BAR ROW  h-[69.5px] flex items-center px-3 min-[1440px]:px-4 py-2
│   │     StatPills: div role="group" aria-label="Filter queue by status"
│   │                    w-full grid grid-cols-5 gap-1.5 h-full items-center
│   │       button ×5  aria-pressed
│   │         group flex flex-col items-center justify-center gap-1.5 rounded-lg px-1.5 py-2
│   │         cursor-pointer transition-all outline-none h-full border border-transparent
│   │         focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1
│   │         focus-visible:ring-offset-card
│   │         + isActive ? cn(tint, "ring-1", ring) : "bg-secondary/40 hover:bg-secondary/80"
│   │         + dim ? "opacity-50 hover:opacity-100" : ""
│   │       ├── span text-[16px] font-bold font-mono leading-none tabular-nums + countClass
│   │       └── span text-[10px] font-semibold uppercase tracking-[0.14em] leading-none whitespace-nowrap
│   └── TOOLBAR ROW  px-3 min-[1440px]:px-4 py-2 border-t border-border/60
│         div flex min-h-8 items-center gap-1.5 min-w-0
│           [leading: Back]  ·  QueueSortDropdown (flex-1 min-w-0)  ·  [actions: Upload Retry Stop Delete]
├── LIST  flex-1 overflow-y-auto border-b border-border
└── RUN CONTROLS  flex h-12 items-center gap-2 px-3 min-[1440px]:px-4 bg-card/40 shrink-0
```

| key | label | colour | active tint | active ring |
|---|---|---|---|---|
| `done` | `Done` | `text-success` | `bg-success/12` | `ring-success/40` |
| `running` | `Active` | `text-primary` | `bg-primary/15` | `ring-primary/40` |
| `failed` | `Failed` | `text-destructive` | `bg-destructive/12` | `ring-destructive/40` |
| `cancelled` | `Cancel` | `text-warning` | `bg-warning/12` | `ring-warning/40` |
| `pending` | `Queue` | `text-warning` | `bg-warning/12` | `ring-warning/40` |

`countClass = (count === 0 && !isActive) ? "text-muted-foreground" : colour`; `dim = !isActive && count === 0`.

> **`grid-cols-5` will not hold 8 statuses.** Labels are *already* truncated to fit (`Cancel`,
> `Queue`). The rebuild needs a wrapping or two-row layout, not more columns.

**Bulk buttons** — all 32×32 (`h-8 w-8`, `rounded-lg` override), icon `w-3.5 h-3.5`: Upload
(`bg-primary text-primary-foreground` + a pulsing amber dot while prepares are in flight) · Retry all
(`bg-destructive/10 border-destructive/40`) · Stop all (warning tone) · Delete all
(`bg-destructive/15 border-destructive/50`). Pending state → `Loader2` spin + `disabled:opacity-60
disabled:cursor-wait`.

**Resizer:** `w-px bg-border` with an invisible 12px hit area (`after:w-3 after:-translate-x-1/2`),
`hover:bg-info/60`, `data-[resize-handle-state=drag]:bg-info`, and a grip that fades in on hover.

### Status bucketing

```ts
statusKeyForEntry(e) = e.status === "failed" && (e.step === "cancelled" || e.step === "discarded")
                       ? "cancelled" : e.status

isAuthRunningEntry(e) = e.status === "running" && e.step?.startsWith("auth:")
isQueueLikeEntry(e)   = e.status === "pending" || e.status === "skipped" || isAuthRunningEntry(e)

countEntriesByQueueStatus:
  OCR awaiting-approval → running, skip
  else                  → counts[statusKeyForEntry(e)]++
  plus: e.status !== "pending" && isQueueLikeEntry(e) → pending++     // skipped + auth-running

entryMatchesStatusFilter:
  "pending" → isQueueLikeEntry ·  "running" → running || ocrAwaitingApproval
  "done"    → done && !ocrAwaitingApproval ·  "failed"|"cancelled" → statusKeyForEntry === f
```

Pill input rows = `collapseEntriesForStatStrip(...)` — a delegation/daemon group counts as **one**
surface row, not N members. `counts.total` is computed and never rendered.

### Copy

Pills `Done · Active · Failed · Cancel · Queue`; group aria `Filter queue by status`. Sort options
`Start · newest first` / `oldest first` / `Name · A–Z` / `Z–A`, persisted as `hr-dashboard-queue-sort-v1`.
Empty queue `No entries yet` / `Runs you start will appear here.` Delete-all confirm: `Delete N
entries?` / `This permanently removes tracker history for all N runs in the current <workflow> view
(<date>). This can't be undone.`

### Behaviours

- Clicking the **active** pill clears the filter; `aria-pressed` reflects it.
- The Status Bar has no border-bottom, no background and no padding of its own — the Queue Panel
  supplies the chrome so search + stats read as one filter rail. The header block is a hard
  **69.5px** so it tiles with the log-panel filter bar across the column gap.
- **Stop All ≠ daemon teardown.** It is a per-item bulk *cancel*; in-view pending/running items go
  amber Cancelled and daemons **survive**. Workflow-scoped daemon teardown has no operator UI at all.
  (`docs/engineering/dashboard-api-reference.md:75` still wrongly attributes `/api/daemon/stop` to
  this button.)
- **Bulk actions must surface partial and unknown outcomes explicitly.** A malformed 2xx body once
  became `{}` → "success, 0 errors", so delete-all/retry-all reported success while the real per-item
  outcome was unknown.
- Keyboard: `↑/↓` move, `Ctrl+Shift+R` retry (a chord, deliberately not bare `r`, so it cannot
  collide with page reload; matched on `e.code === "KeyR"` for layout independence), bare `x` cancels
  — both guarded against unintended modifiers.

---

## 4. Session Panel (bottom drawer)

Constants: `BAR_HEIGHT = 36`, `MAX_DRAWER_HEIGHT = 320`, `MIN_BODY_HEIGHT = 32`. Height animates
`180ms cubic-bezier(0.16,1,0.3,1)`, disabled under `prefers-reduced-motion`.

```
BAR  h-9 flex items-center justify-between pl-4 pr-6 shrink-0
     border-accent-foreground/40 + (open ? "border-b" : "border-t") hover:bg-foreground/5
├── button (toggle)  flex items-center gap-3 min-w-0 flex-1 h-full rounded-sm text-[12px]
│     <Terminal w-3.5 h-3.5>  ·  span text-[10px] uppercase tracking-[0.14em] → "session"
│     ·  SessionSummary  ·  BrowserHealthSummary
└── span (SIBLING, not nested)  flex items-center gap-3 shrink-0 pl-3
      AddWorkerButton · LiveIndicator · clock (font-mono text-[12px] tabular-nums)
BODY  flex-1 min-h-0 transition-opacity duration-[120ms] delay-[60ms]
      empty → "No active workflows"
      strip → flex gap-2.5 px-3.5 pt-3 pb-5 overflow-x-auto items-stretch
```

`SessionSummary` renders dot groups in the order **failed → running → authenticating → idle**, each
only when > 0, aria `"R running, A authenticating, I idle, F failed"`. Dots: failed `bg-destructive`,
running `bg-info` + pulse, authenticating `bg-warning` + pulse, idle `bg-muted-foreground`.
`BrowserHealthSummary` renders only when failed+degraded+refreshing > 0, separated by
`pl-2.5 ml-0.5 border-l border-border/60`.

### Session Card

```
div role="article" aria-label={`${instance} session`}
    shrink-0 w-[290px] rounded-xl border bg-card/60 h-full flex flex-col cursor-pointer
    + (active ? "" : "opacity-55") + borderClass
└── div px-2.5 pt-2 pb-2.5 flex flex-col gap-2 flex-1
    ├── HEADER: <WorkflowIcon w-3 h-3> + title text-[14px] font-semibold truncate
    │           subtitle mt-0.5 text-[10.5px] font-mono text-muted-foreground truncate
    │           right stack min-w-[64px]: StopPill (or a 20px spacer) + elapsed pill
    │             elapsed: font-mono text-[10px] px-[7px] py-[2px] rounded-md bg-muted
    │                      + duoAlert && "text-[#fbbf24] bg-[#fbbf24]/10"      → elapsed || "—"
    ├── SYSTEM LANE  min-h-[43px] > grid grid-cols-2 gap-1 > BrowserTile ×N
    ├── SPACER  flex-1 min-h-0          ← bottom-aligns the lower block across cards
    ├── MICRO PIPELINE (steps >= 2)  dots w-1.5 h-1.5 + links flex-1 h-px
    └── FOOTER  font-mono text-[10px] min-h-[16px]
          queued chip (bg-primary/10 text-primary) · spacer · step text (max-w-[140px] truncate)
```

`borderClass`: focused → `border-primary` + primary glow (**trumps in-flight**); `itemInFlight &&
active` → `border-log-cyan/30` + cyan glow; else `border-border`.

**Copy derivation — first match wins:**

| # | Condition | Subline | Footer step |
|---|---|---|---|
| 0 | `crashedOnLaunch` | destructive `<button>` card: `Launch failed` / `Check Queue row for details` | — |
| 1 | inactive, `finalStatus==="failed"` | `Run failed` | `failed` |
| 2 | inactive, `finalStatus==="done"` | `Run complete` | `complete` |
| 3 | inactive, `finalStatus===null` | `Daemon ended` | `ended` |
| 4 | `itemInFlight` | **`currentTraceId`** | step name ?? `running…` |
| 5 | `daemonPhase==="keepalive"` | `keepalive — checking browsers` | same |
| 6 | `daemonPhase==="idle"`, queued>0 | `N queued — ready` | same |
| 7 | `daemonPhase==="idle"`, queued=0 | `idle — waiting for work` | same |
| 8 | authed ≠ total, or total=0 | `Authenticating A/T` | `authenticating` |
| 9 | all authed, no phase, queued>0 | `N queued — waiting for next item` | same |
| 10 | all authed, no phase, queued=0 | `waiting for next item` | `idle` |

**Bar bucketing — 3-way, never 2-way:**

```ts
crashedOnLaunch || finalStatus === "failed"   → failed
itemInFlight                                  → running
daemonPhase === "idle" | "keepalive"          → idle
otherwise (alive, no daemonPhase yet)         → authenticating
```

The absence of `daemonPhase` reliably means "still in serial Duo prompts / browser launch / login
retries". Bucketing those as idle misleads the operator into thinking capacity is free.

### Browser tile

```
relative rounded-md border px-1.5 py-1 min-w-0
+ tone (health override, else auth)
+ canControl && "cursor-context-menu select-none outline-none focus-visible:ring-2 focus-visible:ring-ring"
+ menuOpen && "ring-1 ring-ring/60"
├── <AuthIcon w-3 h-3> + system name (text-[11px] font-mono truncate)
├── [IdleCountdownRing] [HealthIcon] [CircleHelp] [PauseCircle]   ← each w-3 h-3
└── state word  block text-[9.5px] uppercase tracking-wider font-semibold truncate
```

| AuthState | colour | bg | label | icon |
|---|---|---|---|---|
| idle | `text-muted-foreground` | `bg-muted/20 border-border/60` | `Pending` | `Hourglass` |
| authenticating | `text-info` | `bg-info/10 border-info/30` | `Authing` | `Loader2` spin |
| authed | `text-[#4ade80]` | `bg-success/10 border-success/30` | `Ready` | `Check` |
| duo_waiting | `text-[#fbbf24]` | `bg-warning/10 border-warning/40` + pulse | `Duo` | `KeyRound` |
| failed | `text-destructive` | `bg-destructive/10 border-destructive/40` | `Failed` | `X` |

| Health (non-healthy **overrides** auth) | tone | label | icon |
|---|---|---|---|
| refreshing | `bg-info/10 border-info/40` | `Refreshing` | `Loader2` spin |
| unhealthy | `bg-warning/10 border-warning/40` | `Unhealthy` | `AlertTriangle` |
| failed | `bg-destructive/10 border-destructive/50` | `Failed` | `AlertTriangle` |
| *undefined* (never probed) | no override | — | `CircleHelp` + `health not yet checked` |

**The tile is zero-chrome at rest — no visible buttons, ever.** The state word owns the full tile
width. This is load-bearing: an earlier design put a six-glyph hover strip at `gap-0.5` in a ~120px
tile and **crushed "Refreshing" down to "R"** — the operator's "buttons + text clumped" complaint.

**Recovery menu — RIGHT-CLICK (Radix `ContextMenu`).** The tile IS the trigger (`asChild`), plus
`tabIndex={0}` + `aria-haspopup="menu"` so Enter/Space/Arrow also open it; `onOpenChange` drives the
`ring-1 ring-ring/60`. Items:

```
Peek (live screenshot)          ← closes the menu first, then opens the peek modal
──────────────
Check now · Bring to front · Refresh page · Reopen tab
──────────────
Pause auto-recovery | Resume auto-recovery
```

The four ladder items `preventDefault()` on select so the menu **stays open** while the request runs
(that item's icon swaps to a spinner, all items disable).

> **Do NOT implement the retired double-click design.** An older iteration used a controlled
> `DropdownMenu` opened by `onDoubleClick`, with `onPointerDown` *and* `onClick` both calling
> `preventDefault()` + `stopPropagation()` to suppress Radix's single-pointer-down open. That seam is
> gone from shipped code (`components/CLAUDE.md` still describes it — the doc is stale, not the code).

### Data shape

```ts
WorkflowInstanceState {
  instance; workflow; startedAt?; active; pidAlive; pid?; crashedOnLaunch?;
  currentItemId: string|null;      // NEVER displayed
  currentTraceId: string|null;     // subtitle WHILE IN FLIGHT only
  itemInFlight; currentStep; finalStatus: "done"|"failed"|null;
  daemonPhase?: "idle"|"keepalive";
  sessions: { sessionId; browsers: BrowserState[] }[];
  idleBySystem?: Record<string, { lastTouchAt; refreshing }>;
  recentDaemonLogs?  // carried, deliberately NOT rendered
}
BrowserState { browserId;          // the ONLY correct binding key — never tile order
               system; authState; health?; lastError?; url?; healthHistory?; autoRecoveryPaused? }
```

Visible set = `pidAlive || crashedOnLaunch`, then `active || crashedOnLaunch`. Elapsed: `<1h → "Xm SSs"`,
`<24h → "Xh Mm"`, else `"Xd Hh"`.

### Behaviours and gotchas

1. **A real button cannot nest inside the drawer-toggle button.** The bar is a `div` holding the
   toggle `button` (`flex-1`) and a **sibling** `span` right cluster. Accepted consequence: clicking
   `+`, the Live pill or the clock does not toggle the drawer.
2. **Title-ordinal stripping is unconditional** — `instance.replace(/\s\d+$/, "")`, every instance.
   The numbered identity survives only in the `title`. Cards disambiguate by subtitle + elapsed timer.
3. **Subtitle = trace id ONLY while in flight.** `currentTraceId` is retained in state after
   `item_complete` but must not be *displayed* — a stale trace id on an idle card reads as a bug. If
   you add the field, mirror it in backend `session-state.ts`, frontend `shared/types.ts`, **and**
   `session-state-equal.ts`, or the drawer won't re-render on a new trace id.
4. **The footer never shows an item id.** A 50 ms dedup once swallowed every `step_change`, pinning
   `currentStep = null` and falling back to an opaque item id — the operator's "random numbers like
   an id".
5. **Tiles bind by `browserId`, never by index.** Operator verbatim: *"ucpath/crm tiles aren't mapped
   to their browsers — it goes by order, so when one fails the order gets messed up."* A
   `browser_health` event with no `browserId` is DROPPED, never applied positionally.
6. **A never-probed browser must not read as healthy** → neutral `CircleHelp`, and the idle countdown
   ring is gated on an *actual* healthy probe so a stalled monitor cannot look forever fine. (The bar
   rollup still counts `undefined` as healthy — a known open weakness; the rebuild should surface
   unknown.)
7. **One toast per browser failure**, keyed by `browserId` in a ref so the 1s tick cannot re-fire it;
   a recovery clears the key.
8. **Stop is per-instance.** Peers keep running and absorb the in-flight item. The destructive confirm
   fires only for `itemInFlight && !reassignable`, where `reassignable` is derived client-side.
   **Leaving the `reassignable={false}` default in place makes the confirm fire spuriously**, and an
   operator who sees a false "this will fail the live work" warning avoids a safe stop.
9. **Card height**: body = ResizeObserver `scrollHeight`, floored 32, capped so total ≤ 320. Strip is
   `items-stretch` + card `h-full`; the internal `flex-1` spacer bottom-aligns pipeline + footer
   across cards with different browser counts. `pb-5` keeps Stop off the viewport bottom edge.
10. **Cmd/Ctrl+J** toggles globally (skipped when an editable element has focus); state persists to
    `localStorage["terminal-drawer-open"]`, default closed.
11. `crashedOnLaunch` instances stay visible after `pidAlive` flips false so the operator learns about
    the failure. The early return happens **after** all hooks.
12. Add-worker options sort queued-desc → workers-desc → label-asc; a new worker joins the **same
    shared SQLite queue**, so already-queued work is absorbed with no re-enqueue.
13. **Terminal-event hygiene** (all previously mis-coloured the card): a clean idle shutdown must not
    emit a phantom `final=failed` `workflow_end` (it inflated the failure bell); `stop-instance` must
    not emit two `workflow_end` events 64ms apart with conflicting `finalStatus`; `workflow_end` must
    key on the display label, not the raw instance id, or it cannot correlate back to its card.
14. Concurrent daemons once all received the identical label `<Workflow> 1` — fixed at the data layer,
    but `displayInstance` still strips the ordinal, so two idle peers still *render* identically.
