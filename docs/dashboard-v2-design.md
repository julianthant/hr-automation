# HR Automation Dashboard v2 — Design Spec

**Status:** Design only. No implementation. Companion mockup: [`dashboard-v2-mockup.html`](./dashboard-v2-mockup.html).

A complete redesign of the operator dashboard, using the `ui-ux-pro-max` skill's design intelligence (Bento Box Grid + Data-Dense Dashboard styles, Dark Mode OLED palette, Fira pair typography). Goal: turn the current "three-panel viewer" into a **command center** where triage, drill-in, and historical investigation each have a dedicated zone instead of competing for the same canvas.

---

## 1. Design philosophy

The current dashboard is a viewer. v2 is a **mission control surface**. Three principles:

1. **Triage first, drill second.** The first paint should answer "anything broken right now?" without a click. Live KPI strip + 24-hour timeline above the fold; queue + log detail below.
2. **Bento over rigid columns.** A 12-column responsive grid lets each module (KPIs, timeline, queue, log, sessions, failures) claim the right amount of space for the current screen size. The current strict 3-column split wastes the right rail at <1280 px and squeezes the log at >1920 px.
3. **Persistence is structural, not stateful.** A persistent left nav rail makes workflow switching one click instead of a dropdown round-trip. No more dropdown amnesia ("which workflow was I in?").

---

## 2. Design system

### Palette (extends current CSS variables)

| Role | Token | Hex (OLED-safe) | Use |
|---|---|---|---|
| Background | `--background` | `#020617` | Page background — true black-ish for OLED |
| Surface 1 | `--card` | `#0F172A` | Bento tiles, panels |
| Surface 2 | `--card-hover` | `#1E293B` | Active tile, hover state |
| Border | `--border` | `#1E293B` | 1 px tile dividers |
| Primary | `--primary` | `#E07B3F` | Brand accent (kept from v1) |
| Accent (new) | `--accent-teal` | `#14B8A6` | Interactive accents, link hovers, focus rings |
| Success | `--success` | `#4ADE80` | Done states, healthy indicators |
| Warning | `--warning` | `#FBBF24` | Queue, pending, mid-priority warns |
| Destructive | `--destructive` | `#EF4444` | Failed, error, breach |
| Muted FG | `--muted-foreground` | `#64748B` | Labels, secondary text |
| Foreground | `--foreground` | `#F8FAFC` | Primary text |

The teal accent (`#14B8A6`) is the only net-new addition — used sparingly for interactive affordances (focus rings, active-tile borders, link hovers) so the orange `--primary` stays reserved for "running" status semantics. Trust signal + technical precision; complements the dark surface without competing with status colors.

### Typography pair

From `ui-ux-pro-max`'s "dashboard, data, analytics" recommendation: **Fira Sans + Fira Code**.

- **Fira Sans** — UI text, labels, names, headings (replaces Inter)
- **Fira Code** — numbers, IDs, timestamps, step names, log messages (replaces JetBrains Mono)

Fira Code's coding-tool DNA matches operator workflows (HR ops staff watching automation logs feels closer to a programmer's view than a spreadsheet's). Fira Sans is its sister face, so the pair feels intentional rather than mismatched.

| Token | Size / Weight | Use |
|---|---|---|
| `text-display` | 32px / 700 | KPI metric numbers |
| `text-headline` | 18px / 600 | Tile titles |
| `text-body` | 13px / 500 | List rows, card content |
| `text-mono` | 12px / 500 (Fira Code) | IDs, timestamps, log messages |
| `text-label` | 10px / 600 (uppercase, `tracking-wider`) | Tile section labels, axis labels |
| `text-meta` | 11px / 400 | Footnotes, run-IDs, secondary metadata |

### Effects (dark-mode safe)

- **Tile elevation:** `box-shadow: 0 0 0 1px var(--border), 0 8px 24px -16px rgba(0,0,0,0.6)` — subtle inner ring + soft drop shadow that reads as raised but not floating.
- **Tile radius:** `12px` (between current 8px and bento-spec 16-24px — denser than marketing bento, looser than tableau-style 4px).
- **Hover transition:** `border-color`, `box-shadow`, `background` only (per CSS Triggers — never width/height). 180ms ease-out.
- **Focus ring:** `outline: 2px solid var(--accent-teal); outline-offset: 2px` — visible on every interactive element. Never `outline: none` without a replacement.
- **Status pulse:** for "running" and "Duo waiting" badges, `@keyframes pulse-ring` — animates `box-shadow` opacity 0→1→0 over 1.6s. Honors `prefers-reduced-motion`.

### Spacing (tighter than v1)

| Token | Value | Use |
|---|---|---|
| `--space-tile-gap` | `8px` | Between bento tiles |
| `--space-tile-pad` | `14px` | Inside-tile padding |
| `--space-row` | `8px` | Between list rows |
| `--space-section` | `20px` | Between major sections (rare in v2 — bento prefers gap) |

---

## 3. Layout

### 12-column bento grid

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  COMMAND BAR — workflow tabs · cross-workflow search · global clock · live · launcher    │  56 px
├──────┬───────────────────────────────────────────────────────────────────────────────────┤
│      │  ▎KPI STRIP — 6 tiles (Today · Running · Done · Failed · Queued · Avg dur)        │  84 px
│      ├───────────────────────────────────────────────┬───────────────────────────────────┤
│ NAV  │  ▎24-HOUR TIMELINE                             │  ▎LIVE SESSIONS                   │
│ RAIL │   sparkline of runs/min, stacked by status     │   active workflows + Duo queue     │  180 px
│      │   click bucket → filter queue                  │   selector-warning badge           │
│ icon ├───────────────────────────────────────────────┴───────────────────────────────────┤
│ +    │  ▎QUEUE                                        │  ▎ENTRY DETAIL                    │
│ name │   entries scoped by workflow + filter          │   step pipeline · logs ·          │
│ +    │   stat pills as filter chips at top            │   screenshots · failure           │  flex
│ ct   │                                                │   drill-down                      │
│      │                                                │                                   │
│      ├───────────────────────────────────────────────┴───────────────────────────────────┤
│      │  ▎RECENT FAILURES (collapsible) — last 10 across all workflows + classified error │  120 px
└──────┴───────────────────────────────────────────────────────────────────────────────────┘
   72 px                                  flex                                   240 px
```

### Responsive breakpoints

| Width | Layout shift |
|---|---|
| `< 1024px` | Right rail (Sessions) collapses to a header-mounted popover (badge + click). Recent failures stays at bottom. Nav rail collapses to icons only (no labels). |
| `1024–1440px` | Default layout above. |
| `> 1440px` | Nav rail expands labels back; KPI strip gains a 7th tile (Selector Warns); Recent Failures becomes a 2-row sparkline+list. |
| `> 1920px` | Bento grid widens to 14 columns; queue + entry detail split shifts to 5/9 (more log space). |

### Modules

#### Command bar (56 px)
Replaces v1 TopBar. Three zones still aligned with the panels below (per v1's panel-aware design — kept), but flatter and denser:
- Brand mark (HR Auto monogram, 24×24 SVG, Fira Sans bold) + system health dot
- **Workflow tabs** (replaces dropdown) — horizontal tab bar showing all 6 workflows with their counts. Active tab gets `border-b-2 border-primary`. Saves a click vs dropdown; everything visible at once.
- **Search** centered (kept from v1)
- **Date nav** + **Live** + **Clock** + **launcher slot** on the right

#### Nav rail (72 px → 200 px on hover or wide screens)
Vertical icon-first nav. Each workflow is one icon + count badge. Hover expands to show label. Pinned at the bottom: settings, theme toggle, help. Persistent context — no losing the workflow when navigating.

#### KPI strip (6 tiles, 84 px tall)
| Metric | Value | Sparkline |
|---|---|---|
| Today | 47 entries | 6h micro-bar |
| Running | 3 | live-pulse halo |
| Done | 39 | green check |
| Failed | 2 | red trend arrow |
| Queued | 3 | yellow dot |
| Avg duration | 4m 12s | 24h trend line |

Each tile is clickable: clicking "Failed" filters the queue to failures only (replaces the StatPills filter row from v1).

#### 24-hour timeline (left, ~70%)
Stacked area chart of runs/15-minute-bucket, colored by status (success/running/failed/skipped). Click a bucket → queue filters to that bucket's entries. Provides "what time of day are we breaking" context that doesn't exist in v1.

#### Live sessions (right, ~30%)
Compact list of active workflow instances + their browsers + Duo queue. Replaces v1's SessionPanel but flatter — each session is a single row with mini browser chips inline. Selector-warning chip lives at the top with a count badge.

#### Queue (left, flex)
Same data as v1's QueuePanel but with stat-pill filters moved to the KPI strip above. Search input stays at the top of the queue. Each row uses the v1 EntryItem's 4-line layout (name+badge / id / running-log-or-error / time+run+elapsed) — already polished, no need to redesign.

#### Entry detail (right, flex)
Same content as v1's LogPanel — step pipeline + logs + failure drill-down — but visually unified with the queue beside it via shared bento tile background. Removes the column gutter that visually orphans the log from its source entry.

#### Recent failures (bottom, 120 px)
NEW — a horizontally scrollable strip of the last 10 failures across **all** workflows. Each card = workflow icon + entry name + classified error + time. Click → jumps to that entry. Surfaces incident patterns without forcing the operator to switch workflows.

---

## 4. Component patterns

### Bento tile

```html
<section class="bento-tile">
  <header class="bento-tile-head">
    <h3 class="bento-tile-title">Title</h3>
    <span class="bento-tile-meta">Meta</span>
  </header>
  <div class="bento-tile-body">…</div>
</section>
```

CSS sketch:
```css
.bento-tile {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px;
  box-shadow: 0 8px 24px -16px rgba(0, 0, 0, 0.6);
}
.bento-tile:focus-within {
  border-color: var(--accent-teal);
  outline: 2px solid color-mix(in srgb, var(--accent-teal) 25%, transparent);
}
```

### KPI tile

```html
<button class="kpi-tile" data-active="false">
  <span class="kpi-tile-label">RUNNING</span>
  <span class="kpi-tile-value">3</span>
  <span class="kpi-tile-trend">↑ 1 from yesterday</span>
</button>
```

### Workflow tab (in command bar)

```html
<button class="wf-tab" aria-current="page">
  <Icon /> Onboarding
  <span class="wf-tab-count">12</span>
</button>
```

### Entry row in queue (kept from v1, lightly restyled)

Same 4-line layout, but tile-background instead of full-bleed list, and active row gets a 2px left accent border in `--accent-teal` instead of a fill highlight.

---

## 5. Interaction & motion

| Interaction | Motion | Duration | Easing |
|---|---|---|---|
| Tile hover | border-color + shadow lift | 180ms | ease-out |
| Tab change | underline slides + content cross-fade | 220ms | ease-out |
| KPI filter click | tile glows + queue filters in place | 180ms | ease-out |
| Timeline bucket click | bucket pulses + queue filters | 220ms | ease-out |
| Session badge update | count number flips (no slide) | instant | — |
| Status change (run → done) | row badge color transitions | 220ms | ease-out |
| `prefers-reduced-motion` | All transitions become instant; pulse halos become static rings. | — | — |

No scale transforms, no slide-in panels, no parallax — they cost more than they communicate in an operator tool.

---

## 6. Accessibility checklist

Carried over from `ui-ux-pro-max`'s critical rules:

- [x] All text contrast ≥ 4.5:1 (verified against `--background` + `--foreground` pair)
- [x] Focus rings visible on every interactive element (teal outline)
- [x] `aria-label` on every icon-only button (workflow nav, date chevrons, KPI tiles)
- [x] Tab order matches visual order (command bar → nav rail → KPI strip → timeline → queue → entry detail → failures)
- [x] Color is never the only signal — every status has both a color and an icon (Check / X / Hourglass / ArrowRight / Pause)
- [x] `prefers-reduced-motion` honored (no pulses, no slides)
- [x] Touch targets ≥ 32×32 px in the dense areas (44×44 in command bar)
- [x] Screen-reader landmarks: `<header>` for command bar, `<nav>` for rail, `<main>` for bento grid, `<aside>` for sessions

---

## 7. What changes vs v1

| v1 | v2 | Why |
|---|---|---|
| Workflow dropdown in TopBar | Workflow tabs (command bar) + Nav rail (icons + counts) | One-click switching; current workflow always visible |
| StatPills above queue list | KPI strip across the top of the bento grid | Triage before drill-in; clickable filters |
| 3-column rigid split | 12-col bento with responsive tile spans | Adapts to viewport; right rail collapses on small screens |
| No timeline | 24-hour stacked-area chart | Reveals time-of-day patterns invisible in v1 |
| Failures buried in QueuePanel | Recent Failures strip at bottom | Cross-workflow incident surfacing |
| SessionPanel right rail | Live Sessions tile (smaller, denser) | Frees space for the timeline + lets sessions collapse on narrow screens |
| Inter + JetBrains Mono | Fira Sans + Fira Code | Operator-tool DNA; matches log-watcher mental model |
| Existing palette | Adds `--accent-teal` for interactive affordances | Reserves `--primary` for "running" semantics; teal cues clickability |
| One-row TopBar | One-row command bar + KPI strip | Splits "where am I" from "what's happening" |

---

## 8. Implementation note (out of scope, FYI)

If/when this lands, the migration is feasible without touching workflow files:
- TopBar becomes the new command bar (replace its content; same 3-zone props)
- App.tsx grid changes from `flex flex-1` to `grid grid-cols-[var(--nav-w)_1fr_var(--right-w)]` with bento children
- New components: `KpiStrip`, `Timeline`, `RecentFailuresStrip`, `NavRail`
- Reused as-is: `EntryItem`, `LogPanel` (just gets re-mounted in a tile), `StepPipeline`, `LogStream`, `FailureDrillDown`, `SearchBar`, `RunSelector`, `BrowserChip`, `WorkflowBox`
- Backend additions: `/api/timeline?workflow=X&hours=24` + `/api/failures/recent?limit=10` (the JSONL data already supports both — no kernel changes)
- Bundle: estimate +25 KB for the timeline (use `<svg>` line/area chart hand-rolled, no Recharts)

But again — this doc is design-only. Implementation gets its own plan.

---

## 9. Mockup

See [`dashboard-v2-mockup.html`](./dashboard-v2-mockup.html) — a single-file static HTML page rendering the layout with realistic mock data so you can `open` it in a browser and judge the visual quality of the design without running anything.
