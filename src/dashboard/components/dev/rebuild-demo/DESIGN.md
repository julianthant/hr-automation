# Rebuild demo — design brief

**Read this before building a surface. It is binding.**

> **The principle:** this is a dense, keyboard-first console for one operator who
> files real HR transactions all day — every pixel either helps them see what
> needs them or gets out of the way.

Consequences of that one line, in order of authority:

1. **Attention is the scarce resource.** Exactly two things may shout —
   `Waiting on you` and `Failed`. Everything else recedes on a ladder.
2. **Density beats decoration.** More true rows on screen wins over more
   whitespace. No hero spacing, no illustrations, no marketing gloss.
3. **Nothing may lie.** No fake progress, no "probably fine" empty state, no
   success styling on an unverified write. This mirrors the codebase's
   fail-loud rule at the pixel level.
4. **Parity is ratified.** The rebuilt dashboard must still read as the same
   product to the operator who uses it daily (`docs/rebuild/reviews/second-look-2026-07-22.md`
   §6.6). Raise quality *within* the existing language; never introduce a new one.

---

## How to build a surface

```tsx
import { Panel, PanelHeader, Button, StatusPill, dsText } from "../demo-ui";
```

- **One import**: `demo-ui.tsx`. Never import from `ds/*` directly.
- **Compose primitives.** If a primitive is missing a variant you need, add it
  *in the primitive*, so every surface inherits it. Never fork one locally.
- **Never write a literal value** for colour, size, radius, shadow or duration.
  If a token is missing, add it to `ds/tokens.css` — that file is the only place
  a raw value may appear.
- The specimen page `DemoUiKit.tsx` shows every primitive in every state. Skim
  it before choosing a component.

---

## Tokens — what to reach for

All tokens are CSS custom properties in `ds/tokens.css`; `ds/tokens.ts` exports
the class names you type. Use `bg-[var(--ds-…)]` / `text-[color:var(--ds-…)]` /
`border-[color:var(--ds-…)]` when you need one directly.

### Surface (depth = surface + hairline, never shadow)

| Token | Use |
|---|---|
| `--ds-surface-page` | the app background, behind everything |
| `--ds-surface-1` | the default plane: panels, cards, bars |
| `--ds-surface-2` | inset wells, table headers, code blocks |
| `--ds-surface-3` | hover / pressed / selected fill |
| `--ds-surface-overlay` | dialogs, drawers, menus, tooltips |
| `--ds-surface-scrim` | behind a modal |

A `Panel` sits on the page, a `Card` sits in a Panel, a `Well` sits in a Card.
**Anything with a shadow is floating.** If it does not float, it has no shadow.

### Text

`--ds-fg` (values, names) → `--ds-fg-secondary` (supporting) →
`--ds-fg-muted` (labels, meta, units) → `--ds-fg-faint` (disabled, placeholder).
Four steps. If you want a fifth, the surface is saying too much.

### Type — seven sizes, and only these

| Class | Size | Use |
|---|---|---|
| `dsText.display` | 20px | the one big number on a summary |
| `dsText.section` | 16px | dialog titles, page section heads |
| `dsText.title` | 14px | panel and card titles |
| `dsText.ui` | 13px | control labels, row titles, nav — **the default** |
| `dsText.body` | 12px | table cells, log lines, descriptions |
| `dsText.meta` | 11px | timestamps, trace ids, chips, footers |
| `dsText.micro` | 10px | count badges, kbd |
| `dsText.caps` | 10px upper | group headers, column heads — never sentences |
| `dsText.nums` | — | **every** id, count, duration, rate, amount |

### Space — 8px rhythm

`hair 2 · tight 4 · snug 6 · base 8 · cozy 12 · loose 16 · section 24 · page 32`
Inside a control: hair/tight. Between controls: snug/base. Between groups:
cozy/loose. Between page sections: section/page.

### Size, radius, elevation, focus, motion

- Heights: `--ds-h-xs 20 · sm 24 · md 28 (default) · lg 32`; `--ds-h-row 32`,
  `--ds-h-bar 36`, `--ds-h-topbar 44`.
- Radius: `xs 3 · sm 4 (chips) · md 6 (controls, rows) · lg 8 (cards, panels) ·
  xl 12 (dialogs) · pill`.
- Elevation: **0 is the default.** `ds-elev-1` raised card, `2` menu/popover,
  `3` dialog/drawer.
- Focus: one ring, `dsFocus` on every interactive element. Never remove it.
- Motion: `--ds-dur-1 90ms` press · `2 140ms` default · `3 200ms` entering ·
  `4 260ms` drawer. Easings `--ds-ease-out / -in / -standard`.
- Layering (`dsLayer`): `sticky z-10 · menu z-20 · drawer z-30 · modal z-40 ·
  toast z-50`. Arbitrary z-index is banned by the architecture guard.

---

## The eight statuses — the load-bearing decision

Render a status **only** via `<StatusPill>` / `<StatusDot>` from `demo-ui`.
Never hand-roll a coloured span, never change an icon, never abbreviate a label.

Each status is separated on **four independent channels** — hue, emphasis tier,
icon and label — so colour is never doing the work alone.

| Status | Hue | Tier (the non-colour cue) | Icon | Loudness |
|---|---|---|---|---|
| **Waiting on you** | amber `--warning` | **solid fill**, dark ink, semibold, `· age` suffix | `UserRoundSearch` | **1 — loudest** |
| **Failed** | red `--destructive` | **solid fill**, dark ink, semibold | `TriangleAlert` | **2 — loudest** |
| **Write parked** | violet `--log-violet` | tint + **dashed** hairline (nothing else dashes) | `PauseCircle` | 3 |
| **Done with warnings** | amber, faint tint | amber icon, **muted grey label** — FYI, not a demand | `CircleAlert` | 4 |
| **Running** | blue `--info` | tint + **the only spinning icon** | `Loader2` | 5 |
| **Queued** | slate `--log-slate` | **outline only, no fill** — nothing has happened yet | `Clock` | 6 |
| **Cancelled** | neutral muted | ghost + **struck-through label** | `Ban` | 7 |
| **Verified done** | green `--success` | **no chip at all** — green check, muted label | `CheckCircle2` | 8 — quietest |

Two decisions worth knowing:

- **Waiting and Done-with-warnings share amber on purpose.** Amber means "a
  human is involved". Solid = act now; faint tint = look when you can. The fill
  weight, not the hue, is the priority signal.
- **Cancelled is neutral, not amber and not red.** A deliberate stop is neither
  a warning nor a failure; the strikethrough carries it.

`StatusDot` shapes by tier: filled **disc** (solid) · **ring** (dashed/tinted/
outline) · hollow ring (ghost). Always pair a bare dot with the label somewhere
in the row — the dot carries an accessible name, but the eye needs the word too.

Always pass `age` when you have it. *"Waiting on you"* is a state;
*"Waiting on you · 10m"* is a priority.

---

## The three shapes every surface repeats

These exist because twenty surfaces each invented their own version. Reach for
the component; do not re-draw the pattern.

| Shape | Component | The rule |
|---|---|---|
| **A refusal** — the product declined, on purpose | `Refusal` | Always carries a `code`, and says what was **not** done (`outcome`). Uses `ShieldAlert`, never `TriangleAlert`: the triangle means something broke, the shield means something was refused. A `Banner tone="danger"` is for a *failure*; a refusal is a different sentence. |
| **A provenance line** — where this came from | `MetaLine` | ids, codes, clocks, actors, hashes — `dsText.meta` + `dsText.nums`, segments joined with ` · `, empty segments dropped. **Never `font-mono`**: that loses the tabular figures that stop a clock from jittering. |
| **A group heading** | `SectionLabel` | Never hand-roll `cn(dsText.caps, dsFg.muted)`. |

A dialog's quiet left-hand note goes in `DialogFooter`'s `meta` slot, not a
hand-rolled `mr-auto` span — see the footer rule below.

## Layout rules

- A screen is **Panels**. A Panel has one `PanelHeader`, an optional
  `PanelToolbar`, exactly one scrolling `PanelBody`, and an optional
  `PanelFooter`. Only the body scrolls.
- Tables get `THead` (sticky) and a `label` — a header must survive scrolling a
  long queue, and an unnamed table is a mystery to a screen reader.
- **One primary and at most one danger action per surface.** Actions go
  right-aligned in a footer, primary last, so the eye ends on the verb.
- **Every dialog footer is the same footer**, in this order:
  `meta (quiet, left) · Back? · Cancel · [primary]`. Put the quiet note in
  `DialogFooter`'s `meta` prop. The dismiss verb is **`Cancel`** when the
  surface was building something that will not now exist, and **`Close`** when
  it was only showing you something. Never both words in one flow.
- Rows are `--ds-h-row` (32px). Do not invent a row height.
- Truncate with `truncate` + `min-w-0` on the flex child; never wrap a person's
  name onto two lines in a dense list.
- Empty is a **state**: say what would be here, why it is not, and what to do —
  `EmptyState`, in that order.
- A count that hits zero **dims, it does not disappear** (`CountBadge`), so the
  eye does not have to re-scan the rail.

---

## Motion rules

Motion is functional only. It answers *where did this come from* or
*did my press register* — nothing moves for delight.

- **Do animate:** dialog/drawer entry (they come from somewhere), toast entry,
  press feedback (`active:translate-y-px`), hover tints, determinate progress
  width, the `Running` spinner.
- **Do not animate:** anything on first page load, list reordering, numbers
  counting up, status changes, or a tooltip (a delayed fade after a delayed
  open feels broken — tooltips appear instantly, on purpose).
- Transform and opacity only. Never animate layout properties.
- Durations come from `--ds-dur-*`. `prefers-reduced-motion` zeroes all four
  tokens, which removes every transition in the system at once — do not add a
  separate reduced-motion branch for a transition.
- Tailwind `animate-*` utilities **must** carry `motion-reduce:animate-none` on
  the same line (the architecture guard enforces this).

---

## Accessibility floor — not optional

This demo is asserted through the accessibility tree, so a missing label is a
**broken build**, not a polish item.

- Every interactive element is reachable by keyboard and shows `dsFocus`.
- `IconButton` cannot be built without a `label`; `Table`, `PanelToolbar`,
  `TabList` and `ProgressBar` all require an accessible name.
- Form controls go inside `Field`, which wires `aria-describedby` /
  `aria-invalid` and announces the error via `role="alert"`. Never hand-roll it.
- Dialog and Drawer are Radix: focus enters on open, **returns to the trigger on
  close**, Escape dismisses, the rest of the page is hidden from assistive tech.
- Toasts: `role="status"`, except `danger` which is `role="alert"` and **never
  auto-dismisses** — a failed write is acknowledged by a human. **While a Dialog
  or Drawer is open the toast viewport steps aside** (bottom-right → bottom-left,
  away from the footer's action gutter) **and goes inert** (cards
  `pointer-events: none`, their controls disabled), so a persistent toast can
  never swallow a click meant for the decision the operator is making. It stays
  fully visible and becomes live again when the modal closes.
  **A dialog built on any OTHER primitive must call `useDsModalPresence()`** from
  a component that mounts only while it is open — the registry is what makes the
  step-aside happen, and a dialog that skips it is one a persistent `danger`
  toast can still click-block.
- Contrast is WCAG AA minimum, including text on a solid status fill (which is
  why the loud statuses use dark ink on a bright fill).
- Colour is never the only differentiator, anywhere.

---

## Never do this

- ❌ Hardcode a colour, px size, radius, shadow or duration in a component.
- ❌ Use a Tailwind palette class (`text-amber-400`) or a raw hex — the
  architecture guard fails the build.
- ❌ Render a status as anything other than `StatusPill` / `StatusDot`; recolour
  one; abbreviate a label; drop the icon in a place where it fits.
- ❌ Give `Verified done` a fill, or make anything other than `Waiting on you` /
  `Failed` the loudest thing on a screen.
- ❌ Put two primary buttons, or two danger buttons, on one surface.
- ❌ Use a shadow on something that is not floating.
- ❌ Write a key-frame animation or a bare `animation` property anywhere under
  `src/dashboard/**` — guard-enforced, and motion belongs in the tokens.
- ❌ Use an arbitrary `z-[…]`; use `dsLayer`.
- ❌ Put load-bearing information in a tooltip only.
- ❌ Show a determinate progress bar for something whose denominator you do not
  know — use the indeterminate form.
- ❌ Fork a primitive to add a variant. Add the variant to the primitive.
- ❌ Introduce a new font, a brand colour, an illustration, or an emoji as an
  icon. Icons are lucide, and only lucide.

---

## Files

| File | What it is |
|---|---|
| `ds/tokens.css` | every value in the system — the only place a literal may live |
| `ds/tokens.ts` | the class names builders type (`dsText`, `dsLayer`, `dsFocus`, …) |
| `ds/primitives-core.tsx` | Button, IconButton, Badge, CountBadge, Chip, Kbd, Spinner, Skeleton, Separator |
| `ds/primitives-status.tsx` | the eight statuses + StatusPill / StatusDot / StatusIcon |
| `ds/primitives-layout.tsx` | Panel, Card, Banner, **Refusal**, **MetaLine**, **BulletList**, EmptyState, Tabs, Well, FloatingSurface |
| `ds/primitives-form.tsx` | Field, Input, Textarea, Select, Checkbox, RadioGroup, Switch, SearchInput |
| `ds/primitives-overlay.tsx` | Dialog, Drawer, Tooltip, Toast |
| `ds/primitives-data.tsx` | Table, ProgressBar, TimelineSteps, KeyValueList |
| `demo-ui.tsx` | **the barrel — import from here** |
| `DemoUiKit.tsx` | the specimen page: every primitive, every state |
| `kit.html` + `kit-entry.tsx` | standalone mount for the specimen page |

### Seeing the specimen page

```bash
npx vite --config vite.dashboard.config.ts --port 3943
# → http://localhost:3943/components/dev/rebuild-demo/kit.html
```

`DemoUiKit` is **not** wired into the demo's view switch — `RebuildDemo.tsx` and
`App.tsx` were off-limits to the pass that created it. A later agent that owns
those files should mount it behind a demo view (e.g. a "Design system" entry
beside "Row & panel catalog"); it needs no props.
