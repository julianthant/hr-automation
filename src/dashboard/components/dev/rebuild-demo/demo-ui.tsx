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
  CardFooter,
  SectionLabel,
  PageHeader,
  Banner,
  MetaLine,
  Refusal,
  BulletList,
  EmptyState,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  Well,
  FloatingSurface,
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
  Tooltip,
  TooltipProvider,
  ToastProvider,
  useToasts,
  useDsModalPresence,
} from "./ds/primitives-overlay";
export type {
  DsDialogSize,
  DsDrawerSide,
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
