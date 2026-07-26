import "./tokens.css";

/**
 * DEV-ONLY — the token layer's TypeScript face.
 *
 * `tokens.css` owns the values; this file owns the *names builders type*. Every
 * constant here is a literal Tailwind class string (so Tailwind's scanner sees
 * it) that reads a `--ds-*` custom property. Nothing in the demo should write a
 * raw size, color, radius, shadow or duration — it should reference one of
 * these, or better, use a primitive from `demo-ui.tsx` that already does.
 *
 * Import path for builders: `import { dsText, dsSurface, … } from "./ds/tokens"`
 * (or just use the primitives — they are the real API).
 */

/* -------------------------------------------------------------------------
 * TYPE — the seven-step scale. `ds-text-*` are real CSS classes (see
 * tokens.css) so a stray `text-[11.5px]` cannot silently win over them.
 * ---------------------------------------------------------------------- */
export const dsText = {
  /** 10px — count badges, kbd, tile captions */
  micro: "ds-text-micro",
  /** 11px — timestamps, trace ids, chips, footers */
  meta: "ds-text-meta",
  /** 12px — the dense default: table cells, log lines, descriptions */
  body: "ds-text-body",
  /** 13px — control labels, row titles, nav entries */
  ui: "ds-text-ui",
  /** 14px — panel and card titles */
  title: "ds-text-title",
  /** 16px — dialog titles, page section heads */
  section: "ds-text-section",
  /** 20px — the single big number on a summary surface */
  display: "ds-text-display",
  /** 10px uppercase 600 — group headers, column heads. Never for sentences. */
  caps: "ds-text-caps",
  /** tabular monospace — every number that can change while you look at it */
  nums: "ds-nums",
} as const;

/* -------------------------------------------------------------------------
 * COLOR
 * ---------------------------------------------------------------------- */
export const dsSurface = {
  page: "bg-[var(--ds-surface-page)]",
  /** the default plane: panels, cards, bars */
  card: "bg-[var(--ds-surface-1)]",
  /** inset wells, table headers, code blocks */
  inset: "bg-[var(--ds-surface-2)]",
  /** hover / pressed / selected fill */
  raised: "bg-[var(--ds-surface-3)]",
  overlay: "bg-[var(--ds-surface-overlay)]",
  scrim: "bg-[var(--ds-surface-scrim)]",
  selected: "bg-[var(--ds-surface-selected)]",
} as const;

export const dsFg = {
  base: "text-[color:var(--ds-fg)]",
  secondary: "text-[color:var(--ds-fg-secondary)]",
  muted: "text-[color:var(--ds-fg-muted)]",
  faint: "text-[color:var(--ds-fg-faint)]",
  inverse: "text-[color:var(--ds-fg-inverse)]",
  link: "text-[color:var(--ds-fg-link)]",
  danger: "text-[color:var(--ds-danger)]",
} as const;

export const dsBorder = {
  subtle: "border-[color:var(--ds-border-subtle)]",
  base: "border-[color:var(--ds-border)]",
  strong: "border-[color:var(--ds-border-strong)]",
  loud: "border-[color:var(--ds-border-loud)]",
} as const;

/* -------------------------------------------------------------------------
 * SHAPE + DEPTH
 * ---------------------------------------------------------------------- */
export const dsRadius = {
  xs: "rounded-[var(--ds-radius-xs)]",
  sm: "rounded-[var(--ds-radius-sm)]",
  md: "rounded-[var(--ds-radius-md)]",
  lg: "rounded-[var(--ds-radius-lg)]",
  xl: "rounded-[var(--ds-radius-xl)]",
  pill: "rounded-[var(--ds-radius-pill)]",
} as const;

/** Elevation 0 is the default. Only things that float get 1–3. */
export const dsElev = {
  /** resting cards that need separation from a busy background */
  low: "ds-elev-1",
  /** menus, popovers, tooltips */
  mid: "ds-elev-2",
  /** dialogs and drawers */
  high: "ds-elev-3",
} as const;

/* -------------------------------------------------------------------------
 * FOCUS + MOTION
 * ---------------------------------------------------------------------- */
/** Every interactive element gets this. There is no opt-out. */
export const dsFocus = "outline-none ds-focus";
export const dsFocusWithin = "ds-focus-within";

export const dsMotion = {
  /** default: color / background / border / opacity, 140ms */
  base: "ds-motion",
  /** press + hover feedback, 90ms */
  fast: "ds-motion-fast",
  /** an element arriving on screen, 200ms */
  enter: "ds-motion-enter",
} as const;

/* -------------------------------------------------------------------------
 * LAYERING — arbitrary z-index values are banned by the architecture guard,
 * so the demo uses Tailwind's own scale. These five names are the whole
 * stack; anything not listed sits at auto.
 * ---------------------------------------------------------------------- */
export const dsLayer = {
  /** sticky table headers, panel toolbars, the row action bar */
  sticky: "z-10",
  /** dropdowns, popovers, context menus */
  menu: "z-20",
  /** drawers and their scrim */
  drawer: "z-30",
  /** modal dialogs and their scrim */
  modal: "z-40",
  /** toasts — always above everything, including a modal */
  toast: "z-50",
} as const;

/* -------------------------------------------------------------------------
 * DENSITY — heights and gaps builders reach for by name.
 * ---------------------------------------------------------------------- */
export const dsSize = {
  hXs: "h-[var(--ds-h-xs)]",
  hSm: "h-[var(--ds-h-sm)]",
  hMd: "h-[var(--ds-h-md)]",
  hLg: "h-[var(--ds-h-lg)]",
  hRow: "h-[var(--ds-h-row)]",
  hBar: "h-[var(--ds-h-bar)]",
  hTopbar: "h-[var(--ds-h-topbar)]",
  wRail: "w-[var(--ds-w-rail)]",
} as const;

export const dsGap = {
  /** inside a control: icon → label */
  hair: "gap-[var(--ds-space-hair)]",
  tight: "gap-[var(--ds-space-tight)]",
  snug: "gap-[var(--ds-space-snug)]",
  /** between controls */
  base: "gap-[var(--ds-space-base)]",
  /** between groups inside a panel */
  cozy: "gap-[var(--ds-space-cozy)]",
  loose: "gap-[var(--ds-space-loose)]",
  /** between sections of a page */
  section: "gap-[var(--ds-space-section)]",
} as const;

export const dsPad = {
  /** a dense row or chip interior */
  tight: "px-[var(--ds-space-snug)] py-[var(--ds-space-hair)]",
  /** the default control interior */
  base: "px-[var(--ds-space-base)] py-[var(--ds-space-tight)]",
  /** a card / panel body */
  card: "p-[var(--ds-space-cozy)]",
  /** a dialog body or an empty state */
  roomy: "p-[var(--ds-space-loose)]",
} as const;

/**
 * The one icon size language. Icons never scale independently of the text
 * they sit beside — 12px icon with meta text, 14px with UI text.
 */
export const dsIcon = {
  /** 12px — beside micro/meta text */
  sm: "size-3",
  /** 14px — beside body/UI text (the default) */
  md: "size-3.5",
  /** 16px — beside title text, empty states, banners */
  lg: "size-4",
} as const;
