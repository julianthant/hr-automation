/**
 * DEV-ONLY — the WIRE CONTRACT the rebuild demo consumes.
 *
 * This file is the whole point of the demo's Tier-1 correction: the demo's
 * world model is no longer a hand-shaped view model, it is the shape the
 * production backend will actually serve (`QueueSurfaceWire` in
 * `docs/rebuild/03-tracker-dashboard.md` §2.2, reconciled with the 2026-07-24
 * decision sheet and `docs/rebuild/reviews/demo-feature-plan-2026-07-25.md` §1).
 *
 * Three rules keep it honest:
 *
 *  1. **Fixtures author FACTS, the projection derives PRESENTATION.** A fixture
 *     writes `enqueuedAt` / `startedAt` / `endedAt` / `gate.openedAt`; nothing
 *     writes `"18m"`, `"6m 41s"` or `"2:02 PM"`. Every duration, elapsed timer,
 *     gate age, trace id and timeline segment width is COMPUTED from those
 *     instants, so two surfaces cannot disagree and no width can be invented.
 *  2. **Controls come from `actions[]`.** `deriveActions` below is the mock
 *     server's action policy — the ONE place a status is turned into a set of
 *     offered commands. The React components never branch on status to decide
 *     what to render; they render what the surface sent. If a fixture does not
 *     send an action, its button does not exist.
 *  3. **Nothing is served that a real backend could not serve.** Anything a
 *     surface needs is a field here first.
 */

import type { ProposedStatus } from "./demo-status";
import type { DemoRow, DemoRowSpec } from "./demo-data";

// ---------------------------------------------------------------------------
// The demo clock — one instant, so every derived age agrees
// ---------------------------------------------------------------------------

/** the day the whole fixture corpus lives on (the queue is day-partitioned) */
export const DEMO_DAY = "2026-07-25";

/** "now" for the demo world. Fixed, so a screenshot taken next month still reads right. */
export const DEMO_NOW = `${DEMO_DAY}T14:26:00`;

export const DEMO_NOW_MS = Date.parse(DEMO_NOW);

/** the app build serving every row — the `appVersion` half of the archive key */
export const DEMO_APP_VERSION = "2026.07.3";

/** the actor every command records today (M1 — single local operator) */
export const DEMO_OPERATOR = "local-operator";

/** author a fixture instant: `at("14:02:11")` on the demo day */
export function at(clock: string): string {
  return `${DEMO_DAY}T${clock}`;
}

/** the demo's now, advanced by the shell's 1s heartbeat */
export function demoNowMs(tick = 0): number {
  return DEMO_NOW_MS + tick * 1000;
}

const CLOCK_RE = /T(\d{2}):(\d{2}):(\d{2})/;

/** `2026-07-25T14:02:11` → `2:02 PM`. Parsed, never locale-formatted, so it is stable. */
export function fmtClock(iso: string): string {
  const m = CLOCK_RE.exec(iso);
  if (!m) throw new Error(`demo wire: not a demo instant: ${iso}`);
  const h = Number(m[1]);
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m[2]} ${suffix}`;
}

/** `2026-07-25T14:02:11` → `2:02:11` — a log line's recorded clock */
export function fmtClockSec(iso: string): string {
  const m = CLOCK_RE.exec(iso);
  if (!m) throw new Error(`demo wire: not a demo instant: ${iso}`);
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]}:${m[3]}`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** move a demo instant forward (or back) — how a fixture states a recorded duration */
export function plusSeconds(iso: string, sec: number): string {
  const d = new Date(Date.parse(iso) + sec * 1000);
  return `${DEMO_DAY}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** an instant expressed as "N seconds before now" — how a live row states its age */
export function agoSeconds(sec: number): string {
  return plusSeconds(DEMO_NOW, -sec);
}

/** `2026-07-25T14:02:11` → `140211` — the trace id's time-of-day component */
export function traceClock(iso: string): string {
  const m = CLOCK_RE.exec(iso);
  if (!m) throw new Error(`demo wire: not a demo instant: ${iso}`);
  return `${m[1]}${m[2]}${m[3]}`;
}

export function secondsBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
}

/** how long ago `from` was, against the ticking demo clock */
export function secondsSince(from: string, tick = 0): number {
  return Math.max(0, Math.round((demoNowMs(tick) - Date.parse(from)) / 1000));
}

/** seconds → "14s" / "1m 4s" / "1h 3m" */
export function fmtElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** the Top Bar's date pill — derived from the same day the rows carry */
export function fmtDayLabel(iso: string): string {
  const d = new Date(Date.parse(iso));
  return `${WEEKDAY[d.getDay()]}, ${MONTH[d.getMonth()]} ${d.getDate()}`;
}

// ---------------------------------------------------------------------------
// Systems + the workflow registry (a mock of `/api/workflow-definitions`)
// ---------------------------------------------------------------------------

export type SystemKey = "kuali" | "ucpath" | "kronos" | "crm" | "servicenow" | "onbase" | "i9";

export type DemoWorkflowId =
  | "separations"
  | "onboarding"
  | "person-lookup"
  | "person-match"
  | "work-study"
  | "kronos-pay-rule"
  | "ocr"
  | "oath-signature"
  | "oath-upload"
  | "emergency-contact"
  | "onbase"
  | "i9-check"
  | "crm-doc-download"
  | "kronos-reports";

export type DemoWorkflowCategory = "People" | "Documents" | "Data";

export interface DemoWorkflowRef {
  id: DemoWorkflowId;
  /** the 2-char `defineWorkflow` code — the first component of every trace id */
  code: string;
  label: string;
  category: DemoWorkflowCategory;
  /** descriptor version currently serving runs — the archive key's other half */
  version: number;
  /** the systems this workflow drives; `resolvedInstance` is served per system */
  systems: SystemKey[];
}

/**
 * The client projection of `/api/workflow-definitions`. The Workflow Panel rail,
 * the row's workflow chip and the per-row `workflowVersion` all read THIS —
 * there is no second hand-written workflow list anywhere in the demo.
 */
export const DEMO_WORKFLOWS: Record<DemoWorkflowId, DemoWorkflowRef> = {
  separations: { id: "separations", code: "se", label: "Separations", category: "People", version: 7, systems: ["kuali", "ucpath", "kronos"] },
  onboarding: { id: "onboarding", code: "on", label: "Onboarding", category: "People", version: 11, systems: ["crm", "ucpath", "i9", "kuali"] },
  "person-lookup": { id: "person-lookup", code: "pl", label: "Person Lookup", category: "People", version: 4, systems: ["ucpath", "crm"] },
  "person-match": { id: "person-match", code: "pm", label: "Person Match", category: "People", version: 2, systems: ["ucpath"] },
  "work-study": { id: "work-study", code: "ws", label: "Work-Study", category: "People", version: 5, systems: ["ucpath"] },
  "kronos-pay-rule": { id: "kronos-pay-rule", code: "kp", label: "Kronos Pay Rule", category: "People", version: 3, systems: ["kronos"] },
  ocr: { id: "ocr", code: "oc", label: "OCR", category: "Documents", version: 9, systems: ["i9"] },
  "oath-signature": { id: "oath-signature", code: "os", label: "Oath Signature", category: "Documents", version: 6, systems: ["ucpath"] },
  "oath-upload": { id: "oath-upload", code: "ou", label: "Oath Upload", category: "Documents", version: 6, systems: ["ucpath", "servicenow"] },
  "emergency-contact": { id: "emergency-contact", code: "ec", label: "Emergency Contact", category: "Documents", version: 4, systems: ["ucpath"] },
  onbase: { id: "onbase", code: "ob", label: "OnBase", category: "Documents", version: 5, systems: ["onbase", "ucpath"] },
  "i9-check": { id: "i9-check", code: "ic", label: "I-9 Check", category: "Documents", version: 2, systems: ["ucpath", "i9"] },
  "crm-doc-download": { id: "crm-doc-download", code: "cd", label: "CRM Doc Download", category: "Data", version: 3, systems: ["crm"] },
  "kronos-reports": { id: "kronos-reports", code: "kr", label: "Kronos Reports", category: "Data", version: 4, systems: ["kronos"] },
};

export const DEMO_WORKFLOW_LIST: DemoWorkflowRef[] = Object.values(DEMO_WORKFLOWS);

// ---------------------------------------------------------------------------
// Detail routing — capability-driven tabs
// ---------------------------------------------------------------------------

export type DemoTab = "logs" | "data" | "review" | "receipt" | "people";

export type PanelKind = "run" | "review" | "group" | "member";

/** derived from shape + subject; nothing new is stamped to get one */
export function panelKindOf(row: Pick<DemoRow, "rowType" | "records">): PanelKind {
  if (row.rowType === "member") return "member";
  if (row.rowType === "group") return "group";
  return row.records ? "review" : "run";
}

/**
 * Tabs are a CAPABILITY of the panel kind, not a fixed five.
 *  - Review exists only on the row that owns records.
 *  - People exists only on a Group Row.
 *  - Screenshots is not a tab at all — evidence rides a bar above the tabs (D19).
 *  - Data and Edit Data are ONE surface (D19).
 */
export function tabsFor(row: Pick<DemoRow, "rowType" | "records">): DemoTab[] {
  const kind = panelKindOf(row);
  if (kind === "review") return ["review", "logs", "data", "receipt"];
  if (kind === "group") return ["people", "logs", "data", "receipt"];
  return ["logs", "data", "receipt"];
}

// ---------------------------------------------------------------------------
// Actions — the ONE protocol
// ---------------------------------------------------------------------------

export type DemoCommandKey =
  | "retry"
  | "cancel"
  | "cancel-tree"
  | "bump"
  | "hide"
  | "rename"
  | "resolve-gate"
  | "resolve-write-present"
  | "resolve-write-absent"
  | "rerun-with-different-input";

/** where a descriptor renders. One descriptor can appear in more than one place. */
export type ActionPlacement = "footer" | "banner" | "outcome" | "menu";

export type ActionIntent = "primary" | "neutral" | "destructive" | "violet" | "success" | "info" | "warning";

export type ActionIconKey = "retry" | "cancel" | "bump" | "delete" | "review" | "resolve" | "rename" | "external" | "drill";

/**
 * Confirmation copy is SERVER-authored, because only the server knows the blast
 * radius (how many members, how many staged writes, what is already written).
 * A descriptor with no `confirm` fires immediately — which is exactly how
 * ratified decision D16 (group cancel: no confirmation, no undo) is expressed:
 * the cancel-tree descriptor simply carries no confirm block.
 */
export interface ActionConfirmWire {
  title: string;
  /** names the casualties in the operator's own terms */
  body: string;
  confirmLabel: string;
  tone: "destructive" | "neutral";
}

export interface ActionDescriptorWire {
  /** stable within a row */
  key: string;
  kind: "command" | "navigation";
  /** command kind only */
  command?: DemoCommandKey;
  label: string;
  /** long-form copy — the two Write-parked resolutions render it under the label */
  detail?: string;
  intent: ActionIntent;
  icon?: ActionIconKey;
  placement: ActionPlacement[];
  /** CAS — the row version the surface the operator is holding was projected at */
  expectedVersion?: number;
  confirm?: ActionConfirmWire;
  /** the typed resolution this gate option records (`resolve-gate` only) */
  resolution?: string;
  /** navigation kind only */
  navigate?: { kind: "self" | "panel" | "drill"; workflow?: string; runId?: string };
}

/** a gate's typed answers, authored beside the copy that explains them */
export interface GateOptionSpec {
  key: string;
  label: string;
  detail?: string;
  intent: ActionIntent;
  command: DemoCommandKey;
  resolution?: string;
  confirm?: ActionConfirmWire;
  icon?: ActionIconKey;
}

export function actionsAt(actions: ActionDescriptorWire[], placement: ActionPlacement): ActionDescriptorWire[] {
  return actions.filter((a) => a.placement.includes(placement));
}

// ---------------------------------------------------------------------------
// The mock server's action policy — the ONE status→commands mapping
// ---------------------------------------------------------------------------

export interface ActionPolicyContext {
  /** the status every surface renders (a group's is its rollup) */
  status: ProposedStatus;
  /** the version the operator's surface was projected at — the CAS token */
  projectedVersion: number;
  memberCount: number;
  rejectedCount: number;
  title: string;
  workflow: DemoWorkflowRef;
  /** how many writes are staged but not submitted — cancel copy names them */
  stagedWrites: number;
}

const HIDE_CONFIRM = (what: string): ActionConfirmWire => ({
  title: "Remove this row from the queue?",
  body: `${what} The run's receipt, evidence and ledger entries stay in history — only the row stops being listed. Nothing is un-done in any system.`,
  confirmLabel: "Remove row",
  tone: "destructive",
});

/**
 * Turn a row's facts into the commands the operator may issue. This is the
 * SERVER's job, done once. The client renders `actions[]` and never re-derives
 * it — which is why an action a fixture does not send has no button anywhere.
 */
export function deriveActions(spec: DemoRowSpec, ctx: ActionPolicyContext): ActionDescriptorWire[] {
  const out: ActionDescriptorWire[] = [];
  const v = ctx.projectedVersion;
  const isGroup = spec.rowType === "group";

  // 1. Gate answers — the decision the row is sitting on, above the tabs.
  for (const opt of spec.gate?.options ?? []) {
    out.push({
      key: opt.key,
      kind: "command",
      command: opt.command,
      label: opt.label,
      detail: opt.detail,
      intent: opt.intent,
      icon: opt.icon,
      placement: ["banner"],
      expectedVersion: v,
      resolution: opt.resolution,
      confirm: opt.confirm,
    });
  }

  // 2. A rejected child never became work. Delete is the ONLY thing it offers —
  //    there is no task to retry, bump or cancel.
  if (spec.containment === "rejected") {
    out.push({
      key: "hide",
      kind: "command",
      command: "hide",
      label: "Delete",
      intent: "destructive",
      icon: "delete",
      placement: ["footer"],
      expectedVersion: v,
      confirm: HIDE_CONFIRM(`“${ctx.title}” never became a run — no task exists for it.`),
    });
    return out;
  }

  // 3. Lifecycle commands.
  const cancelTree: ActionDescriptorWire = {
    key: "cancel-tree",
    kind: "command",
    command: "cancel-tree",
    label: "Cancel group and everything under it",
    intent: "neutral",
    icon: "cancel",
    placement: ["footer"],
    expectedVersion: v,
    // D16: cancelling a group cancels the whole tree, with NO confirmation and
    // NO undo. Deliberately no `confirm` block — the tooltip carries the warning.
  };
  const cancelRun: ActionDescriptorWire = {
    key: "cancel",
    kind: "command",
    command: "cancel",
    label: "Cancel",
    intent: "neutral",
    icon: "cancel",
    placement: ["footer"],
    expectedVersion: v,
    confirm: {
      title: `Cancel ${ctx.title}?`,
      body:
        ctx.stagedWrites > 0
          ? `The run stops where it is. ${ctx.stagedWrites} staged write${ctx.stagedWrites === 1 ? "" : "s"} in the Data tab ${ctx.stagedWrites === 1 ? "is" : "are"} discarded unsubmitted; nothing already written to ${ctx.workflow.systems.join(" / ")} is reversed.`
          : `The run stops where it is. Nothing already written to ${ctx.workflow.systems.join(" / ")} is reversed — cancelling is not an undo.`,
      confirmLabel: "Cancel run",
      tone: "destructive",
    },
  };
  const retry: ActionDescriptorWire = {
    key: "retry",
    kind: "command",
    command: "retry",
    label: "Retry",
    intent: "primary",
    icon: "retry",
    placement: ["footer"],
    expectedVersion: v,
  };
  const hide: ActionDescriptorWire = {
    key: "hide",
    kind: "command",
    command: "hide",
    label: "Delete",
    intent: "destructive",
    icon: "delete",
    placement: ["footer"],
    expectedVersion: v,
    confirm: HIDE_CONFIRM(
      isGroup
        ? `“${ctx.title}” and its ${ctx.memberCount} member row${ctx.memberCount === 1 ? "" : "s"} stop being listed.`
        : `“${ctx.title}” stops being listed.`,
    ),
  };

  switch (ctx.status) {
    case "queued":
      out.push({
        key: "bump",
        kind: "command",
        command: "bump",
        label: "Bump",
        intent: "primary",
        icon: "bump",
        placement: ["footer"],
        expectedVersion: v,
      });
      out.push(isGroup ? cancelTree : cancelRun);
      break;
    case "running":
    case "waiting":
      out.push(isGroup ? cancelTree : cancelRun);
      break;
    case "parked":
      // No cancel, no retry, no resume. The only exits are the two typed
      // resolutions already pushed from `gate.options` — a blind retry on an
      // unknown write is how you terminate somebody twice.
      break;
    case "failed":
    case "cancelled":
      out.push(retry, hide);
      break;
    case "verifiedDone":
    case "doneWarnings":
      out.push(retry, hide);
      break;
  }

  // 4. The one thing to DO about this row — rendered in the queue subline and
  //    the log panel's outcome bar. Navigation, never a mutation.
  const outcomeAction = deriveOutcomeAction(spec, ctx);
  if (outcomeAction) out.push(outcomeAction);

  // 5. Menu-only commands.
  if (spec.rowType !== "member") {
    out.push({
      key: "rename",
      kind: "command",
      command: "rename",
      label: spec.displayName ? "Rename run…" : "Name this run…",
      intent: "neutral",
      icon: "rename",
      placement: ["menu"],
      expectedVersion: v,
    });
  }

  return out;
}

function deriveOutcomeAction(spec: DemoRowSpec, ctx: ActionPolicyContext): ActionDescriptorWire | null {
  if (spec.mirroredFrom) {
    return {
      key: "reupload",
      kind: "command",
      command: "rerun-with-different-input",
      label: "Re-upload",
      intent: "destructive",
      icon: "retry",
      placement: ["outcome"],
      expectedVersion: ctx.projectedVersion,
      confirm: {
        title: "Start a new run from a different file?",
        body: `This row stays failed and keeps its evidence. A NEW ${ctx.workflow.label} run is enqueued from the file you pick — the two are separate runs with separate receipts.`,
        confirmLabel: "Choose a file…",
        tone: "neutral",
      },
    };
  }
  switch (ctx.status) {
    case "waiting":
      return { key: "open-gate", kind: "navigation", label: "Review", intent: "info", icon: "review", placement: ["outcome"], navigate: { kind: "self" } };
    case "parked":
      return { key: "open-park", kind: "navigation", label: "Resolve", intent: "violet", icon: "resolve", placement: ["outcome"], navigate: { kind: "self" } };
    case "failed":
      return {
        key: "open-failure",
        kind: "navigation",
        label: "Open failure",
        intent: "destructive",
        icon: "external",
        placement: ["outcome"],
        navigate: { kind: "self" },
      };
    case "running":
      return ctx.memberCount >= 41
        ? { key: "drill-in", kind: "navigation", label: "Start review", intent: "info", icon: "drill", placement: ["outcome"], navigate: { kind: "drill" } }
        : null;
    default:
      return null;
  }
}
