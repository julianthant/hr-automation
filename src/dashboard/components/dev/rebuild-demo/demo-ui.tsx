/**
 * DEV-ONLY — the rebuild demo's design system, in one import.
 *
 *   import { Button, Panel, StatusPill, … } from "../demo-ui";
 *
 * READ `DESIGN.md` (same folder) BEFORE building a surface on top of this.
 * It is short and it is binding: token names, the status mapping, layout and
 * motion rules, the accessibility floor, and the list of things never to do.
 *
 * Rules of engagement for builder agents:
 *   1. Compose these primitives. Do not fork one to add a variant — add the
 *      variant here, so every surface gets it.
 *   2. Never write a raw colour, size, radius, shadow or duration in a
 *      component. If a value is missing, add a token in `ds/tokens.css`.
 *   3. Never render a status any way except `<StatusPill>` / `<StatusDot>`.
 *   4. Every interactive element is keyboard-reachable and shows the one
 *      focus ring. This demo is asserted through the accessibility tree, so a
 *      missing label is a broken build, not a polish item.
 */

import "./ds/tokens.css";

export {
  dsText,
  dsSurface,
  /**
   * The one truncation vocabulary — `dsClip.token` on a single-line token's
   * shell, `dsClip.text` on the child that may be too long. Reach for the PAIR:
   * either half on its own is the defect (overflow with no ellipsis, or a
   * `truncate` that can never shrink because its flex parent said `min-w:auto`).
   */
  dsClip,
  dsFg,
  dsBorder,
  dsRadius,
  dsElev,
  dsFocus,
  dsFocusWithin,
  dsMotion,
  dsLayer,
  dsSize,
  dsGap,
  dsPad,
  dsIcon,
} from "./ds/tokens";

export { useDemoTheme, DEMO_THEME_ATTR, DEMO_THEME_LABEL } from "./ds/theme";
export type { DemoTheme } from "./ds/theme";

export {
  Button,
  IconButton,
  Badge,
  CountBadge,
  Chip,
  Kbd,
  Spinner,
  Skeleton,
  Separator,
  VisuallyHidden,
} from "./ds/primitives-core";
export type {
  DsButtonProps,
  DsButtonVariant,
  DsIconButtonProps,
  DsBadgeProps,
  DsChipProps,
} from "./ds/primitives-core";

export {
  DS_STATUS,
  DS_STATUS_ORDER,
  DS_ATTENTION_STATUSES,
  dsStatusText,
  StatusPill,
  StatusDot,
  StatusIcon,
} from "./ds/primitives-status";
export type {
  DsStatus,
  DsStatusSpec,
  DsStatusTier,
  DsStatusPillSize,
} from "./ds/primitives-status";

export {
  Panel,
  PanelHeader,
  PanelToolbar,
  PanelBody,
  PanelFooter,
  Card,
  CardHeader,
  CardBody,
  /**
   * The bottom edge of a card. Reach for it whenever cards sit side by side and
   * something trailing — a button, a caveat, a pair of compared facts — has to
   * land on ONE line across the row instead of wherever each card's own content
   * happened to stop. Needs `<CardBody grow>` (or a flex-column card) above it.
   */
  CardBase,
  CardFooter,
  SectionLabel,
  PageHeader,
  Banner,
  MetaLine,
  /**
   * A wrapping row of PEER facts. Reach for it instead of `flex flex-wrap`
   * whenever a set of chips can wrap — it is what gives every line the same
   * ending edge, so a four-fact row never reads as three plus an orphan.
   */
  ChipRow,
  Refusal,
  BulletList,
  EmptyState,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  Well,
  FloatingSurface,
  /**
   * Make a surface that has just MOUNTED arrive instead of appear. Spread it
   * onto the element and describe where it comes from with
   * `data-[demo-enter=from]:` classes — the house mechanism for anything Radix
   * does not already give a `data-state` to.
   */
  useDsEnterTransition,
} from "./ds/primitives-layout";
export type { DsBannerTone } from "./ds/primitives-layout";

export {
  Field,
  useFieldControl,
  Input,
  Textarea,
  Select,
  Checkbox,
  RadioGroup,
  Switch,
  SearchInput,
  /**
   * The correctable/locked value pair. Reach for these anywhere a surface shows
   * a value the run OBSERVED — never re-draw a bare `<input>` for one, or it
   * ends up invisible at rest the way the Data ledger and the OCR review both
   * did before they shared this.
   */
  ValueField,
  LockedValue,
} from "./ds/primitives-form";

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogBody,
  DialogFooter,
  Drawer,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  Popover,
  PopoverTrigger,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  /**
   * An object's own commands, on the object. Right-click (or the platform's
   * context-menu key, or the shortcut a shell binds through
   * `openContextMenuFor`) — never a `⋯` button, which is a control whose only
   * job is to admit there are more controls.
   */
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  openContextMenuFor,
  Tooltip,
  TooltipProvider,
  ToastProvider,
  useToasts,
  useDsModalPresence,
  useDsModalOpen,
  /**
   * Is a toast occupying the viewport's bottom-right right now? Read it from
   * any surface that would otherwise be drawn there and anchor somewhere else
   * while it is true — the corner belongs to the alert, and the reminder is the
   * one that yields.
   */
  useDsToastCornerBusy,
} from "./ds/primitives-overlay";
export type {
  DsDialogSize,
  DsDrawerSide,
  DsPopoverSide,
  DsPopoverWidth,
  DsToast,
  DsToastTone,
} from "./ds/primitives-overlay";

export {
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  ProgressBar,
  TimelineSteps,
  KeyValueList,
} from "./ds/primitives-data";
export type { DsSortDirection, DsStep, DsStepState } from "./ds/primitives-data";
