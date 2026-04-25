# Dashboard Ops — Visual Spec

Companion to `2026-04-24-dashboard-operations-design.md`. Describes the
exact visual treatment for each new surface so the implementation matches
the existing dashboard's aesthetic without further design ambiguity.

**Conventions** (already live, do not violate):
- All colors via CSS variables — `--background`, `--foreground`, `--card`,
  `--border`, `--primary`, `--success`, `--destructive`, `--warning`,
  `--muted-foreground`, `--radius` (`0.5rem`).
- Mono (`font-mono` → JetBrains Mono): IDs, timestamps, step names,
  raw values, log lines, pid, uptime numbers.
- Sans (`font-sans` → Inter): names, labels, descriptions, button text.
- No emoji icons — `lucide-react` only.
- Status-driven colors: running=`--primary`, done=`--success`,
  failed=`--destructive`, pending=`--warning`.
- Badge style: `bg-{status}/15 text-{status}`-ish — translucent tinted
  background + colored text. Match existing `EntryItem` badges.
- Border radius: `rounded-md` (default for inline controls), `rounded-lg`
  (panels). `rounded-full` for pills/chips.
- Transitions: `transition-colors duration-150` — match existing.
- Focus rings: `focus-visible:outline-none focus-visible:ring-2
  focus-visible:ring-primary/40` (a11y requirement).

---

## 1. RetryButton

**Use:** appears on `EntryItem` (failed) inline at the right edge, and in
`LogPanel` header next to the status badge. Single click → toast confirm
("Retrying \<id\>...") → POST `/api/retry` → toast result.

**shadcn/ui:** wrap a plain `<button>` in `<Tooltip>`. Tooltip text:
"Retry this run". Don't use `<Button>` — `EntryItem`'s right-rail buttons
are 24px-tall icon-only and `<Button>` defaults to 36px+.

**Icon:** `RotateCcw` (lucide-react). 14×14px.

**Sizing:**
- Button frame: `h-6 w-6` (24×24px). A11y minimum for inline secondary
  controls; the visible touch target on touch screens isn't a target
  surface for this app (desktop-only).
- Icon: `h-3.5 w-3.5` (14×14).
- Spacing from neighbors: `ml-1.5` from elapsed timer, `mr-0.5` from row edge.

**Color:**
- Default: `text-muted-foreground` icon, `bg-transparent`, no border.
- Hover: `text-foreground bg-muted` (subtle surface lift; matches the
  log-line copy button hover treatment).
- Active (during the 200ms POST roundtrip): `text-primary` + a `<Loader2
  className="h-3.5 w-3.5 animate-spin">` swap-in. Disable the button
  while pending.

**Why icon-only:** the row already shows the run as failed via the badge.
A textual "Retry" button would dominate; an icon at the row edge is the
right level of emphasis. Tooltip handles discoverability.

---

## 2. BulkRetryBar

**Use:** sticky bar inside `QueuePanel`, positioned BELOW `StatPills` and
ABOVE the entry list. Visible only when ≥1 failed entry is in the
current filter view. Shows the count + a single "Retry N failed" primary
action button. Sticky to the QueuePanel scroll area (not viewport).

**shadcn/ui:** `<Button variant="default" size="sm">` for the action. No
banner primitive — render the bar directly with `<div>`.

**Icon:** `RotateCcw` (matches RetryButton — visual continuity), 14×14
inside the button.

**Layout:**
```tsx
<div className="sticky top-0 z-10 flex items-center justify-between gap-3
                 px-3 py-2 border-b border-border/60
                 bg-destructive/10 backdrop-blur-sm">
  <div className="flex items-center gap-2 text-xs">
    <AlertCircle className="h-3.5 w-3.5 text-destructive" />
    <span className="font-medium text-foreground">
      {n} failed
    </span>
    <span className="text-muted-foreground">in current view</span>
  </div>
  <Button size="sm" variant="default" onClick={...}>
    <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Retry all
  </Button>
</div>
```

**Why:** the failed-row tint (subtle `--destructive/10` wash) draws the eye
without overwhelming — the StatPills above stay legible. The bar is sticky
inside the panel so it's always reachable while scrolling. Single
primary-button action; chosen over a chip cluster because the only useful
operation is "retry them all" (filter-then-retry-by-step is downstream
work via the FAILED stat pill click).

**Trade-off:** sticky bar adds 32px of vertical real estate. Acceptable
because it's only present when failures exist — empty-state has zero cost.

---

## 3. QueueItemControls

**Use:** Cancel (X) + Bump (▲) icon buttons on `EntryItem` rows when
status=pending. They sit in the existing right-rail area of row 4 (where
time/run/elapsed live). Pending rows have no elapsed counter, so there's
visual room.

**shadcn/ui:** same pattern as RetryButton (Tooltip-wrapped plain button).

**Icons & semantics:**
- Cancel: `X` icon, 14×14, `text-muted-foreground hover:text-destructive`.
  Tooltip: "Cancel queued item". Click triggers an `<AlertDialog>` (NOT a
  toast confirm — destructive actions deserve a modal per the skill's
  guidelines). On confirm: POST `/api/cancel-queued`. On 409:
  toast.error("Already claimed by daemon \<pid\>").
- Bump: `ArrowUp` icon, 14×14, `text-muted-foreground hover:text-primary`.
  Tooltip: "Bump to top of queue". Click → POST `/api/queue/bump` → toast
  on success.

**Layout (within EntryItem row 4):**
```
[time]  [run #N]  [—]                   [▲] [×]
                                        ^^^^^^^
                                        gap-1, ml-auto
```

**Why X for cancel + ArrowUp for bump:** these are the most universally-read
glyphs for "remove" and "promote upward." The Bump icon is a single chevron
(not double) so it doesn't read as "scroll to top of page" or "first page."

**Trade-off:** X is also commonly "close/dismiss." We accept the overlap
because (a) tooltip clarifies, (b) the AlertDialog confirm prevents
accidental cancellation. If this proves confusing in user testing, swap
for `Trash2`.

---

## 4. DaemonRow

**Use:** per-daemon row inside `SessionPanel` (240–320px wide right rail).
Sits in a new section above existing `WorkflowBox` rows, under a header
that names the workflow + holds spawn/stop controls.

**Layout:**
```tsx
<div className="rounded-md border border-border/60 bg-card/40 p-2.5 space-y-1.5">
  <div className="flex items-center justify-between gap-2">
    <span className="text-xs font-mono text-foreground">
      pid {pid}
    </span>
    <PhaseChip phase={phase} />
  </div>
  <div className="flex items-center justify-between gap-2 text-[11px]">
    <span className="font-mono text-muted-foreground">{uptime}</span>
    <span className="font-mono text-muted-foreground">
      {itemsProcessed} done
    </span>
  </div>
  <div className="text-[11px] truncate">
    {currentItem ? (
      <span className="font-mono text-primary">▶ {currentItem}</span>
    ) : (
      <span className="text-muted-foreground italic">idle</span>
    )}
  </div>
  <div className="flex items-center justify-end gap-0.5 pt-1">
    <button title="Logs"><FileText className="h-3.5 w-3.5" /></button>
    <button title="End"><PowerOff className="h-3.5 w-3.5" /></button>
  </div>
</div>
```

**PhaseChip** renders a tiny badge:
- `launching` / `authenticating` → `bg-warning/15 text-warning`
- `idle` → `bg-muted text-muted-foreground`
- `processing` → `bg-primary/15 text-primary`
- `keepalive` → `bg-muted text-muted-foreground` (italic)
- `draining` / `exited` → `bg-destructive/15 text-destructive`

Chip sizing: `text-[10px] px-1.5 py-0.5 rounded-full font-medium`.

**Icons:**
- `FileText` for "view logs" (more specific than `Terminal`; this surface
  is reading log lines, not running commands).
- `PowerOff` for "End" (the existing per-workflow End button uses this
  too — keep visual consistency).

**Why this row shape:** SessionPanel is narrow (240–320px), so the layout
must stack rather than flow. The 4-line stack (header / timing / current /
actions) packs ~6 facts into ~80px of vertical space, matching the
information density of the existing WorkflowBox.

**Trade-off:** at the lower bound (240px) the timing row may wrap if
itemsProcessed is 4+ digits. Use `tabular-nums` to keep digits aligned and
truncate at 999+ via formatter.

### Header above the daemon-row list

Above the list of DaemonRows, render a workflow-grouped header:

```tsx
<div className="flex items-center justify-between px-2 py-1.5">
  <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
    {workflowLabel} daemons ({n})
  </span>
  <div className="flex items-center gap-1">
    <button title="Spawn one more"><Plus className="h-3.5 w-3.5" /></button>
    <button title="Stop all"><Square className="h-3.5 w-3.5" /></button>
  </div>
</div>
```

`Plus` and `Square` (lucide) for the spawn/stop affordances. Square for
"stop" beats `PowerOff` here because PowerOff is already used at the
per-daemon level — visual differentiation between "end one" and "stop
all."

---

## 5. DaemonLogTail

**Use:** opens beneath a `DaemonRow` (in-place expansion, NOT a modal or
slide-out — keeps context with the daemon you're watching).

**Layout:**
```tsx
<div className="mt-1 rounded-md border border-border/60 bg-background">
  <div className="flex items-center justify-between gap-2 px-2 py-1
                  border-b border-border/60">
    <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
      Daemon log · pid {pid}
    </span>
    <button title="Copy" className="...">
      <Copy className="h-3.5 w-3.5" />
    </button>
  </div>
  <div className="max-h-[200px] overflow-y-auto px-2 py-1.5
                  font-mono text-[11px] leading-relaxed
                  whitespace-pre-wrap break-all">
    {lines.map((l) => (
      <div key={l.ts} className="text-muted-foreground hover:text-foreground">
        {l.line}
      </div>
    ))}
  </div>
</div>
```

**Auto-scroll:** sticks to bottom unless user scrolls up. Match the
existing `LogStream` scroll-snap pattern (`useLayoutEffect` to scroll
before paint).

**Color:** muted by default, brightens on hover so the cursor signals
"this is what you'll be reading." Errors (lines containing `error`/`fail`
case-insensitive) get `text-destructive`. Step lines (`[Step:`) get
`text-primary`. Match existing LogLine icon-mapping conventions.

**Why in-place not slide-out:** SessionPanel is the right rail —
slide-out from the left would cover the queue panel; from the right
would extend past the screen edge. In-place expansion is the only
option that doesn't fight the existing layout.

**Trade-off:** stretches the SessionPanel height. Acceptable because
SessionPanel is on the right rail with its own scroll; expanding one
daemon doesn't push others below the fold permanently — they're still
reachable.

---

## 6. EditDataTab

**Use:** new tab inside `LogPanel`, peer to the existing log content +
the new Screenshots peer. Today LogPanel stacks `StepPipeline` + `LogStream`
+ `ScreenshotsPanel` vertically; this introduces a higher-level tab bar.

**Decision:** introduce a `LogPanel`-level shadcn `<Tabs>` switcher with 3
tabs: **Logs** (existing LogStream + filter sub-tabs) / **Screenshots**
(existing ScreenshotsPanel) / **Edit Data**. The existing 7-tab filter
inside LogStream stays — it's a sub-tab system within the Logs view.

**Tab bar layout:**
```tsx
<Tabs defaultValue="logs" className="flex-1 flex flex-col">
  <TabsList className="bg-transparent border-b border-border/60
                       rounded-none px-2 py-0 h-auto justify-start gap-3">
    <TabsTrigger value="logs"
      className="data-[state=active]:bg-transparent
                 data-[state=active]:border-b-2
                 data-[state=active]:border-primary
                 data-[state=active]:text-foreground
                 rounded-none py-2 text-xs font-medium">
      Logs
    </TabsTrigger>
    <TabsTrigger value="screenshots" ...>Screenshots</TabsTrigger>
    {hasEditableFields && (
      <TabsTrigger value="edit-data" ...>Edit Data</TabsTrigger>
    )}
  </TabsList>
  ...
</Tabs>
```

**Edit Data form layout:**

```tsx
<div className="p-4 space-y-3">
  <div className="text-xs text-muted-foreground">
    Override extracted values. The workflow will skip extraction and use
    these values directly.
  </div>
  {editableFields.map((f) => (
    <div key={f.key} className="space-y-1">
      <label className="text-[11px] font-medium text-muted-foreground
                        uppercase tracking-wider">{f.label}</label>
      <input type="text"
             className="w-full rounded-md border border-border/60
                        bg-background px-2.5 py-1.5
                        text-sm font-mono text-foreground
                        focus:border-primary focus:outline-none" />
    </div>
  ))}
  <div className="pt-3 flex justify-end gap-2">
    <Button variant="outline" size="sm" onClick={reset}>Reset</Button>
    <Button size="sm" onClick={runWithData}>
      <Play className="h-3.5 w-3.5 mr-1.5" />
      Run with these values
    </Button>
  </div>
</div>
```

**Field defaults:** populate from `entry.data[field.key]`. User edits
override; "Reset" reverts to the original tracker values.

**Validation:** none client-side (server returns a Zod error → toast).
Inline error display would require duplicating the workflow's schema in
the frontend, which violates "single source of truth" — the server
schema is canonical.

**When the tab is hidden:** the workflow's metadata has no
`editable: true` detailFields. The tab simply isn't rendered (don't gray
it out — render-or-not is cleaner).

**Why mono font for inputs:** the values are EIDs, dates, doc IDs —
mono prevents the dashboard's general "humans see structured tokens
here" pattern from breaking. Sans would feel like a contact form.

---

## 7. QueueDepthPill

**Use:** tiny number badge inside the TopBar's workflow-dropdown items,
next to the workflow name. Indicates pending items waiting in the
shared daemon queue.

**Layout (inside each `<DropdownMenuItem>`):**
```tsx
<div className="flex items-center justify-between w-full">
  <span>{workflow.label}</span>
  <div className="flex items-center gap-1.5">
    {entryCount > 0 && (
      <span className="text-[10px] font-mono text-muted-foreground">
        {entryCount}
      </span>
    )}
    {queueDepth > 0 && (
      <span className="px-1.5 py-0.5 rounded-full
                       bg-warning/15 text-warning
                       text-[10px] font-mono font-medium tabular-nums">
        {queueDepth}
      </span>
    )}
  </div>
</div>
```

**Color:** warning-tinted (the same `--warning` that the pending status
uses). Aligns the visual semantics: warning = "waiting/pending."

**Why a pill not a plain number:** the existing dropdown items already
show entry counts as plain `text-muted-foreground` numbers. The queue
depth is a distinct concept (waiting in the daemon queue, not the
dashboard's per-day tracker rows), so a tinted pill prevents visual
confusion. Adjacent placement to the entry count lets the operator
compare at a glance.

**Trade-off:** two adjacent counts can be visually busy when both are
non-zero. Hide the entry count when `queueDepth > 0`? No — both are
useful and the tint differentiation is clear.

---

## Implementation order

Build in this order to land working features early and keep risk
isolated:

1. RetryButton (smallest blast radius, ships value immediately).
2. QueueItemControls (Cancel + Bump — uses the same pattern, same row).
3. BulkRetryBar (composes RetryButton's POST endpoint behavior).
4. QueueDepthPill (tiny TopBar change; needs the new
   `/api/queue-depth` polling hook).
5. DaemonRow + spawn/stop header (composes the new `/api/daemons`
   endpoint; high-impact for daemon-mode operators).
6. DaemonLogTail (depends on DaemonRow being shipped + the SSE endpoint).
7. EditDataTab (most novel; pulls in the LogPanel-level Tabs refactor —
   ship last so Logs/Screenshots regression risk is minimized).

## Accessibility checklist

- All icon-only buttons → wrap in `<Tooltip>` with descriptive content.
- All inputs in EditDataTab → have visible `<label>`.
- Keyboard nav: Cancel/Bump/Retry buttons are focusable in document order
  (right of the entry's primary content); Tab/Shift-Tab traverses them.
- `aria-label` on every icon button (mirrors the tooltip text).
- Color is never the only signal — every state has an icon or label too.
- AlertDialog for cancel-queued (destructive — confirm step required).
- Toast for retry/bump (non-destructive, lightweight).
- Loading states: spinner swap-in on icon buttons during POST roundtrip;
  disable button while pending to prevent double-fire.

## Anti-patterns avoided

- No emoji icons (project rule + skill rule).
- No popover for action lists (use DropdownMenu — already in TopBar).
- No `<Dialog>` for destructive confirmation (use `AlertDialog`).
- No scale-on-hover transforms (causes layout shift; use color/opacity).
- No `title` attribute for tooltips (use `<Tooltip>` for proper a11y).
- No light-mode treatment (dashboard is dark-only by design choice; the
  light-mode contrast checklist in the skill doesn't apply).
