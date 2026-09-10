# Workflow Graph Editor — n8n-style modular editor + design-intent scaffold

**Status:** design complete, ready to build. **Owner of next step:** a fresh implementation session.
**Date:** 2026-06-25.

> This is a self-contained handoff. A new session should be able to build the whole
> thing from this document alone. Read it top to bottom before writing code. A
> ready-to-paste kickoff prompt is at the very bottom (§14).

---

## 1. What we're building & why

The dashboard's **Workflow Modifier** page (`src/dashboard/components/workflow-modifier/`)
currently renders as a "Live Blueprint" — three stacked plates (Row naming / Step
pipeline / Delegation) edited via popovers. The operator wants this replaced with a
true **n8n-style node-graph editor**: a pannable/zoomable canvas of modular nodes wired
together, fully custom-looking, smooth, where the nodes model how the real workflow
actually functions.

Two hard requirements beyond "make it a graph":

1. **Smooth & responsive.** The current build feels laggy (root cause + fix in §9).
2. **Dual output (option "c").** Editing the graph produces **two** artifacts:
   - **Live config** — the parts the runtime already understands
     (`naming`/`steps`/`delegation`) write to the existing override file and apply hot,
     exactly as today.
   - **Design-intent scaffold** — a structured spec file capturing design intent that
     goes *beyond* today's schema (new node kinds, custom layouts, behaviors, freeform
     annotations) **plus** an auto-generated markdown brief. The operator edits the
     graph instead of describing UI in chat; a future Claude session reads the scaffold
     and implements exactly what was drawn.

The design-intent scaffold is the novel core. Treat it as the headline feature, not a
side export.

---

## 2. What exists today (reuse map — do NOT rebuild these)

### Data model — `src/domain/workflow-presentation/types.ts`
```ts
WorkflowOverride { label?, category?, iconName?, detailFields?, presets?, presentation? }
WorkflowPresentationConfig { naming?, steps?, delegation? }
NamingConfig { title?: NamingPartTitle, subtitle?: NamingPartSubtitle, trace?: NamingPartTrace }
  NamingPartTitle    { scheme: TitleSchemeId,    template? }
  NamingPartSubtitle { scheme: SubtitleSchemeId, template? }
  NamingPartTrace    { scheme: TraceSchemeId,    template? }
  TitleSchemeId    = person-name | pdf-filename | catalog-label | batch-anchor | custom-template
  SubtitleSchemeId = eid-else-trace | trace-only | eid-only | email | custom-template
  TraceSchemeId    = code-time-runid | custom-template
StepDisplayConfig { order?: string[], rules?: StepDisplayRule[] }
  StepDisplayRule { step, hidden?, label?, foldInto? }
DelegationDisplayConfig { memberTitle?, memberSubtitle?, prepTitle?, coordinatorLabelSuffix? }
```

### Resolvers — `src/domain/workflow-presentation/schemes.ts` (CLIENT-SAFE, pure)
`resolveTitle(vars, part)`, `resolveSubtitle(vars, part)`, `resolveTrace(vars, part)`,
`SCHEME_LIBRARY {title, subtitle, trace: SchemeMeta[]}` (`SchemeMeta {id,label,description}`).
Templates: `renderTemplate(tpl, vars)` + `KNOWN_TOKENS` in `template.ts`. Step display
resolution: `applyStepDisplay(steps, cfg, formatStepName)` → `DisplayStep[]` in
`step-display.ts`. **The graph must preview via these same functions** so what's drawn
equals what runs.

### Data hook & API — `useWorkflowPresentation.ts` (KEEP)
Exposes `list` (`{name,label,hasOverride}[]`), `selected`, `load(name)`, `data`
(`{base, effective, override, schemeLibrary}`), `saving`, `save(ov)`, `revert()`,
`preview(ov)`/`previewResult` (currently unused — graph resolves client-side).
Endpoints: `GET /api/workflow-presentation`, `GET|POST|DELETE /api/workflow-presentation/:wf`,
`POST .../preview`. Backend lives under `src/tracker/dashboard/hono/`.

### Current blueprint components (REUSE the logic, REPLACE the rendering)
`blueprint-helpers.ts` is gold — keep it nearly verbatim: `buildSampleVars`,
`buildSecondMemberVars`, the **sparse-prune setters** (`setNamingPart`,
`setDelegationField`, `setStepOrder`, `updateStepRule`, `resetStepRule`, `prune`,
`moveInOrder`), `previewTitle/Subtitle/Trace`, `schemeLabel`, count helpers,
`isDelegatingWorkflow`, `DEFAULT_*_SCHEME`, `TOKEN_PALETTE`. The popover editors
(`SchemeHotspot`, `TokenTemplateInput`) can be reused **inside node inspectors**.
`RowNamingPlate`/`StepPipelinePlate`/`StepChip`/`DelegationPlate`/`Plate`/`WorkflowPicker`
get superseded by the graph but are a reference for behavior.

### Mount point — `src/dashboard/App.tsx`
`showWorkflowModifier` boolean toggles `<WorkflowModifierPage />` (top-bar button
"Workflow configuration", ref e30 in snapshots). Keep the same named export
`WorkflowModifierPage` so App.tsx is untouched.

### Non-negotiable constraints (guarded by `tests/unit/architecture/frontend-tailwind-compliance.test.ts`)
- **Color = design tokens only** in `.tsx`: no Tailwind palette classes
  (`text-sky-500` …) and no raw hex/rgb/hsl. Use `primary, secondary, muted, accent,
  destructive, info, success, warning, border, ring, foreground/background` +
  `log-cyan|teal|violet|slate`. New color → add a token in `index.css`
  (`:root` + `.dark` + `@theme inline`). `--primary` is neutral near-white in dark
  (monochrome). The guard's color rule scans **.tsx only**; the animation rule
  (`@keyframes`, `animate-[...]`, `animation:`) scans **.ts/.tsx/.css** — never put
  those strings anywhere, including comments.
- **Icons = lucide-react only**, never emoji/unicode glyphs. Icon-only button → `aria-label`.
- **Interactive = real `<button>/<a>`**; non-submit buttons get `type="button"`.
- **Focus visible**; `aria-live` for async/live regions; labels on every control.
- **Motion**: Tailwind utilities with `motion-safe:`/`motion-reduce:animate-none`;
  z-index on the `z-*` scale (no `z-[...]`); `shrink-0` not `flex-shrink-0`.
- **No default exports** in `src/`. Fonts: IBM Plex Sans + IBM Plex Mono.
- Stack: React 19, Vite 8, Tailwind v4, shadcn/ui (Popover, Tooltip under
  `components/ui/`), lucide, sonner. Dashboard is a single-file build (`build:dashboard`).
- Verify with: `npm run typecheck:all`, `npm run test:architecture`,
  `npm run build:dashboard`, `npm run lint`, `npm run test`.

---

## 3. The one new dependency: `@xyflow/react` (React Flow v12)

Hand-rolling a smooth pan/zoom/wire canvas is a trap — React Flow is the n8n-class
engine and the way to get smoothness for free. MIT, React-only, ~130KB gz into the
single-file bundle (acceptable for an internal operator tool).

```bash
npm i @xyflow/react
```
- Import its CSS once (`@xyflow/react/dist/style.css`) in `index.css` or the page, then
  **override every visual** with custom node/edge/handle components + tokens (§8) — do
  not ship the default React Flow look.
- All node/edge components must still obey the token/lucide/a11y guards above.
- Confirm the single-file Vite build inlines it cleanly (run `build:dashboard` early in
  Phase 1 as a smoke test).

---

## 4. Node taxonomy — "moving parts linked to real components"

Each node maps to something real. Two families:

### A. Config-backed nodes (round-trip to `WorkflowOverride`)
| Node | Represents | Edits (live config) |
|---|---|---|
| `rowNode` | the queue row | `naming.title/subtitle/trace` (reuse SchemeHotspot in its inspector); live-previews via resolvers + `buildSampleVars` |
| `stepNode` | one `WorkflowConfig.steps[]` entry / `auth:*` step | `steps.rules[]` (hidden/label/foldInto); **order = node sequence** via edges |
| `delegationCoordinatorNode` | operation coordinator | `delegation.coordinatorLabelSuffix` |
| `prepNode` | OCR prep row | `delegation.prepTitle` |
| `memberNode` | fanned-out member template | `delegation.memberTitle/memberSubtitle` |

Step **order** is expressed by the wire sequence between `stepNode`s (drag a wire to
reorder; `foldInto` = a fold-edge into a host step). Delegation is a real fan-out branch:
coordinator → prep + member. The row node sits at the head as the "what this row reads"
summary.

### B. Design-intent-only nodes (NO runtime meaning — they feed the scaffold)
| Node | Purpose |
|---|---|
| `customNode` | a UI element/behavior the operator wants that the schema can't express yet — carries freeform `intent` (desired look, behavior, references, example data) |
| `noteNode` | a sticky annotation / design comment anchored on the canvas |
| `groupNode` | a labeled frame grouping nodes into a "section/screen" intent |

These never touch `WorkflowOverride`; they exist **only** in the design-intent scaffold
(§6) for a future Claude session to implement.

### Edges
`sequence` (step order), `delegation` (fan-out), `fold` (step folded into host),
`custom` (operator-drawn intent link). Edge `type` drives both semantics and styling.

---

## 5. Architecture & component tree

```
WorkflowModifierPage                       (shell: picker + canvas + action bar + mode)
├── WorkflowPicker                         (KEEP from today — icon+label+count pill)
├── GraphCanvas                            (ReactFlowProvider + ReactFlow)
│   ├── nodeTypes: { rowNode, stepNode, authNode?, delegationCoordinatorNode,
│   │                prepNode, memberNode, customNode, noteNode, groupNode }
│   ├── edgeTypes: { sequenceEdge, delegationEdge, foldEdge, customEdge }
│   ├── <Background/> (custom dotted, token color)  <Controls/> (custom)  <MiniMap/> (custom, optional)
│   ├── NodePalette                        (left/floating: drag-to-add nodes, incl. custom/note/group)
│   └── NodeInspector (per selected node)  (right drawer/panel: reuses SchemeHotspot etc.)
├── ScaffoldBar                            ("Generate scaffold" + "Save config" + dirty/status)
└── (state) useWorkflowGraph               (graph <-> override <-> design-intent; perf-localized)
```

### State & data flow (the heart of "c")
- **Single source of truth while editing:** the **graph** (`nodes`, `edges` in React
  Flow state) + a parallel `designMeta` map (per-node `intent`, positions, group/note
  content).
- Two pure projections off the graph:
  - `graphToOverride(graph) → WorkflowOverride` — extracts config-backed nodes/edges into
    the existing sparse override (route through the existing `prune` setters so it stays
    sparse). This is what `save()` persists + applies hot.
  - `graphToDesignSpec(graph, workflow) → WorkflowDesignSpec` (§6) — the full scaffold.
- Two inverse builders to seed the graph on load:
  - `overrideToGraph(data) → graph` — build config-backed nodes from `data.base`/`effective`/`override`.
  - `designSpecToGraph(spec) → graph` — overlay any saved design-intent nodes/positions.
- On load: fetch override (existing API) → `overrideToGraph`; fetch design spec (new API
  §7) → merge `designSpecToGraph`. On "Save config": `graphToOverride` → existing POST.
  On "Generate scaffold": `graphToDesignSpec` → new POST that writes JSON + generated .md.

Keep all four projections **pure and unit-tested** (pure projections are the dashboard's
testable seam — there's no component harness; see §10).

---

## 6. The design-intent scaffold — format (THE core deliverable)

Persist as `config/workflow-design/<workflow>.json` (machine spec) + a generated
`config/workflow-design/<workflow>.md` (human/Claude brief). Define the types in a new
`src/domain/workflow-design/types.ts`:

```ts
export interface WorkflowDesignSpec {
  schemaVersion: 1;
  workflow: string;            // e.g. "oath-signature"
  generatedAt: string;         // ISO; stamped server-side (Date is fine in backend)
  summary?: string;            // operator's one-line intent for the whole screen
  canvas?: { zoom: number; x: number; y: number };
  nodes: DesignNode[];
  edges: DesignEdge[];
  /** Theme/style intent the operator expressed (optional, beyond-schema look). */
  style?: DesignStyleIntent;
  notes?: string[];            // free-floating design notes
}

export type DesignNodeType =
  | "row" | "step" | "delegationCoordinator" | "prep" | "member"   // config-backed
  | "custom" | "note" | "group";                                   // intent-only

export interface DesignNode {
  id: string;
  type: DesignNodeType;
  position: { x: number; y: number };
  /** Config-backed nodes mirror the override slice they own (round-trips to runtime). */
  config?: Record<string, unknown>;     // e.g. { title:{scheme,template}, ... } | { step, hidden, label, foldInto }
  /** Design intent beyond the schema — what makes the scaffold actionable. */
  intent?: {
    label?: string;            // operator's name for this element
    description?: string;      // what it should do / look like, in plain words
    look?: string;             // visual direction ("compact card, status dot left, mono id")
    behavior?: string;         // interactions ("click expands members", "hover shows trace")
    references?: string[];     // file paths / component names / URLs to mimic
    exampleData?: Record<string, string>;  // sample values to render against
  };
  parentGroup?: string;        // id of a group node, for sectioning
}

export interface DesignEdge {
  id: string;
  source: string;
  target: string;
  type: "sequence" | "delegation" | "fold" | "custom";
  label?: string;
}

export interface DesignStyleIntent {
  density?: "compact" | "comfortable";
  accent?: string;             // a token NAME (e.g. "info"), never a hex
  notes?: string;
}
```

### The generated markdown brief (`<workflow>.md`)
Auto-rendered from the spec by a pure `renderDesignBrief(spec): string`. It is the thing
a future Claude reads. Required sections:
1. **Header:** workflow, generatedAt, one-line summary.
2. **Live config applied:** the naming/steps/delegation that already took effect (so the
   reader knows what NOT to re-implement).
3. **Design intent to build:** for each `custom`/`note`/`group` node and any annotated
   config node — its label, description, look, behavior, references, example data, and
   its connections (in prose: "Custom node 'Member chip' connects to coordinator,
   should…"). Group nodes become subsections.
4. **Constraints reminder:** a short, fixed block restating the token/lucide/a11y/guard
   rules (so the new session inherits them even without this spec doc).
5. **Open questions:** any node the operator flagged as undecided.

The brief must be **deterministic** from the spec (pure render), so re-generating after
edits produces a clean diff.

### Consumption contract (how a new session uses it)
- The "Generate scaffold" action writes both files and toasts the paths.
- A new session is pointed at `config/workflow-design/<workflow>.md` (read first) +
  `<workflow>.json` (exact data). The `.md` is prose intent; the `.json` is the precise
  graph. Together they replace "describing it in chat."
- Add a one-line pointer in `src/dashboard/CLAUDE.md` documenting the location + that the
  `.md` is generated (never hand-edit; edit the graph and re-generate).

---

## 7. Backend (Hono, `src/tracker/dashboard/hono/`)

Add a small route group `workflow-design` mirroring `workflow-presentation`:
- `GET  /api/workflow-design/:workflow` → `{ ok, spec: WorkflowDesignSpec | null }`
  (read `config/workflow-design/<workflow>.json`, null if absent).
- `POST /api/workflow-design/:workflow` → body `WorkflowDesignSpec`; stamps
  `generatedAt`, writes `<workflow>.json`, renders + writes `<workflow>.md` via
  `renderDesignBrief`. Returns `{ ok, jsonPath, mdPath }`.
- `DELETE /api/workflow-design/:workflow` → remove both files.
- Reuse the existing path/IO helpers used by `workflow-presentation` writes; validate the
  body with a zod schema mirroring §6 (fail loud on bad shape — house rule: no silent
  fallback). Register the routes in the Hono manifest. **Backend changes need a full
  `npm run dashboard` restart** (no hot reload) — note this in testing.

`config/workflow-design/` is git-tracked (like `config/workflow-presentation/`) so the
scaffold lives with the repo and a new session sees it.

---

## 8. Visual design — "fully custom" n8n in the dark monochrome theme

Kill the default React Flow skin entirely. Direction = **engineering schematic**, the
"print vs ink" language carried from the blueprint:

- **Canvas:** near-black (`background`), custom `<Background variant="dots">` using the
  `--border` token (reuse the `.blueprint-grid` feel). Subtle vignette via tokens only.
- **Nodes:** `rounded-xl border border-border bg-card/80 shadow-sm`, a typed **header
  strip** (lucide icon + node-kind label, mono for ids), a compact body. Config-backed
  nodes show their live-resolved preview text (IBM Plex Mono for ids/trace). Selected =
  `ring-2 ring-ring`. **Modified** (differs from default) = the existing language: 2px
  `border-primary` left rail + `CircleDot` + count.
- **Handles/ports:** small circular token-colored handles; type-colored by edge family
  (`sequence` → muted/foreground, `delegation` → `info`, `fold` → `warning`,
  `custom` → `log-violet`). Never raw hex — tokens only.
- **Edges:** custom bezier; `sequence` solid muted, `delegation` solid info, `fold`
  dashed warning, `custom` dashed violet. Animated dash **only** via Tailwind/SVG
  `stroke-dashoffset` transitions with `motion-safe:` (no `@keyframes`; if a flowing
  edge is wanted, prefer React Flow's built-in `animated` edge which uses inline SVG
  — verify it doesn't trip the `animation:`/`@keyframes` guard; if it does, use a
  static dashed edge).
- **Custom/note/group nodes:** visually distinct (dashed border, `log-violet` accent for
  custom, `muted` for notes, a translucent labeled frame for groups) so intent-only nodes
  read as "design, not config."
- **Controls/minimap:** restyle to token surfaces; minimap optional (only if cheap).
- **Palette & inspector:** shadcn panels; inspector reuses `SchemeHotspot` +
  `TokenTemplateInput` for config nodes, and plain token-styled inputs for `intent`
  fields on custom nodes.

Motion: 150–300ms token transitions, `motion-safe:`. No layout-shifting hover scales.

---

## 9. Performance plan (fix the lag — root cause known)

The lag today: **all draft state is lifted to the page root**, so every keystroke
re-renders all plates, re-resolves every preview, and re-fires pulse timers.

- **Localize editing state.** Node inspector inputs hold local state and **commit on
  blur / debounced (~150ms)**, not per keystroke. Template typing must not re-render the
  canvas each character.
- **Memoize nodes.** Each custom node component wrapped in `React.memo`; React Flow only
  re-renders changed nodes. Keep node `data` referentially stable (don't recreate
  objects every render).
- **Stable callbacks.** `useCallback` for node/edge change handlers; selector-style reads
  so unrelated nodes don't re-render.
- **Canvas = GPU transforms** (React Flow already uses `transform` for pan/zoom — don't
  fight it; avoid `top/left` animations).
- **Derive previews lazily & memo** (`useMemo` keyed on the specific node's config, not
  the whole graph). Resolvers are cheap but called O(nodes) — memo per node.
- **Pulse/highlight** on value change: cap to the changed node; no global effect.
- Smoke-test with ~30 nodes; it must stay 60fps on pan/zoom/drag.

---

## 10. Testing (no component harness — test the seams)

The dashboard has **no browser/component test harness**; pure logic is unit-tested.
Write `vitest` units for the four projections + the brief renderer:
- `graphToOverride` round-trips (graph → override → graph) and stays sparse (defaults
  collapse to `undefined`, mirroring `prune`).
- `overrideToGraph` builds expected nodes from `base/effective/override`.
- `graphToDesignSpec` / `designSpecToGraph` round-trip incl. positions + intent.
- `renderDesignBrief` is deterministic & includes every intent node (snapshot test ok).
- Backend zod-validation rejects malformed specs (fail loud).
Place under `tests/unit/dashboard/workflow-graph/` and `tests/unit/domain/workflow-design/`.
Visual verification = `build:dashboard` + Playwright CLI screenshots (headless), per the
existing workflow-modifier verification pattern.

---

## 11. Build sequence (phased — each phase ends green on all gates)

**Phase 1 — Canvas shell + config nodes (read-only).**
`npm i @xyflow/react`; `GraphCanvas` with custom `Background`; `overrideToGraph`;
custom `rowNode`/`stepNode`/`delegation*` nodes rendering live-resolved previews;
sequence/delegation edges. No editing yet. Gate: `build:dashboard` inlines React Flow,
graph renders for a selected workflow. (Run all 5 verification commands.)

**Phase 2 — Editing → live config.** Node inspector (reuse `SchemeHotspot`); wire
reorder → `setStepOrder`; fold edges → `updateStepRule`; delegation node edits;
`graphToOverride` + existing `save()`/`revert()`; perf localization (§9). Gate: editing a
node changes the live preview and persists to the override file; unit tests for
`graphToOverride`/`overrideToGraph`.

**Phase 3 — Design-intent layer + scaffold.** `customNode`/`noteNode`/`groupNode`;
NodePalette drag-to-add; `intent` editing; `src/domain/workflow-design/types.ts`;
`graphToDesignSpec`/`designSpecToGraph`/`renderDesignBrief`; backend routes (§7);
"Generate scaffold" action writing JSON + .md. Gate: drawing custom nodes + generating
produces a correct `config/workflow-design/<wf>.{json,md}`; unit tests for the projections
+ brief.

**Phase 4 — Custom look + polish.** Full §8 styling, custom edges/handles/controls,
optional minimap, motion, empty/inert states (non-delegating workflows), keyboard a11y
(canvas is mouse-first — provide the chevron/keyboard fallbacks for reorder like today),
CLAUDE.md updates. Gate: all 5 commands green + Playwright screenshots; architecture guard
(token/animation/z/flex) passes.

---

## 12. Constraints checklist (paste into the build session's todo)
- [ ] Tokens-only color in `.tsx`; new colors → `index.css` (`:root`+`.dark`+`@theme inline`).
- [ ] No `@keyframes`/`animate-[...]`/`animation:` strings anywhere (incl. comments, incl. .css).
- [ ] lucide icons only; `aria-label` on icon-only buttons; real `<button type="button">`.
- [ ] Focus-visible rings; `aria-live` on async/status; labels on every input.
- [ ] `shrink-0` (not `flex-shrink-0`); z on `z-*` scale; `<img>` srcSet+sizes+loading.
- [ ] No default exports in `src/`.
- [ ] Pure projections unit-tested; sparse override preserved (`prune`).
- [ ] All 5 gates green: `typecheck:all`, `test:architecture`, `build:dashboard`, `lint`, `test`.
- [ ] `config/workflow-design/` git-tracked; `.md` is generated, never hand-edited.
- [ ] Backend route changes → full `npm run dashboard` restart to verify.

## 13. Open decisions (next session may confirm with the operator)
- Minimap on/off (perf vs orientation) — default off, add if cheap.
- Whether step order is edited by **wires** (n8n-pure) or a hybrid with keep-the-chevrons
  for keyboard a11y — recommend hybrid (wires + chevron fallback) so it stays accessible.
- Exact `config/workflow-design/` vs `docs/` location for the generated `.md` — default
  `config/` (co-located with the JSON, git-tracked).
- How much of React Flow's default CSS to keep vs fully replace — default: import its base
  CSS for layout math, override all visuals.

---

## 14. Kickoff prompt for the new session

> Build the Workflow Graph Editor described in
> `docs/superpowers/specs/2026-06-25-workflow-graph-editor-design.md`. Read that spec
> top to bottom first — it is self-contained. Reuse the existing
> `src/dashboard/components/workflow-modifier/` logic (`blueprint-helpers.ts`,
> `SchemeHotspot`, `TokenTemplateInput`, `useWorkflowPresentation`) and the
> `src/domain/workflow-presentation/` resolvers; replace the plate rendering with an
> `@xyflow/react` node canvas. Implement option "c": edits write the live override
> (existing API) AND a design-intent scaffold (`config/workflow-design/<wf>.{json,md}`,
> new API + `src/domain/workflow-design/types.ts` + `renderDesignBrief`). Obey the
> architecture guard (tokens-only, lucide-only, no @keyframes, motion-safe, no default
> exports). Work the four phases in §11; end each phase green on `typecheck:all`,
> `test:architecture`, `build:dashboard`, `lint`, `test`. Keep the four graph↔config↔spec
> projections pure and unit-tested. If the current "Live Blueprint" components are fully
> superseded, delete them and update `src/dashboard/CLAUDE.md`.
