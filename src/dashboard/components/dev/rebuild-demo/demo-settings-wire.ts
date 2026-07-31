/**
 * DEV-ONLY — the SETTINGS half of the wire contract the rebuild demo consumes.
 *
 * `docs/rebuild/reviews/demo-feature-plan-2026-07-25.md` §1.6 "Settings".
 *
 * **What changed in wave 12, and why it is a reduction rather than a redesign.**
 * The surface carried 26 leaves. An audit asked one question of each — *can the
 * operator answer this?* — and only eight survived:
 *
 *  - Four were **status, not settings** (`operator.timekeeperName`,
 *    `operator.actor`, `performance.navRetries`, `paths.trackerDir`): the
 *    environment owns them, so the control was disabled and the only live
 *    affordance beside it was a button whose whole job was to return a refusal.
 *    They are still VISIBLE — as `DEMO_ENVIRONMENT_FACTS` on the read-only
 *    status surface, where being unchangeable is the point instead of a
 *    disabled input pretending otherwise.
 *  - Five asked a question **nobody can answer**: the recovery ladder
 *    (`browserRefreshAfterSec`, `reopenAfterFailures`, `daemon.idleSec` — two
 *    idle timers tuned independently with no stated relationship) and capture
 *    geometry (`width`, `height`, whose own note admitted changing it does not
 *    re-render the evidence you are looking at). No operator-visible signal
 *    tells you the default is wrong, so they are `DEMO_SYSTEM_BEHAVIOUR` —
 *    engineering constants, stated, not offered.
 *  - Two were the **same value twice** (`annual.fiscalYearStart` and
 *    `annual.oathEffectiveDate` held one date and rolled on one event). Merged.
 *  - Eight moved to the **run modal**, where the question is actually asked: the
 *    seven System URL overrides (a global flip with no expiry that silently
 *    redirects every future run — now `DEMO_SYSTEM_INSTANCES`, chosen per run)
 *    and `performance.ukgTimeoutSec` (a quarter-span report is not a slow
 *    one-week report — now Old Kronos Reports' own `reportPatience` choice).
 *
 * Three rules survive the cut unchanged:
 *
 *  1. **A leaf never states its own provenance in prose.** It carries the three
 *     LAYERS and the server says which one won (`source`), so "which is winning
 *     and where did it come from" is a computed fact, not a caption.
 *  2. **A save is a TRANSACTION over every dirty leaf**, and it answers per
 *     leaf. A form that says "3 unsaved changes" and submits one of them is
 *     worse than one that refuses all three.
 *  3. **Storage health is a SNAPSHOT the server serves, not a UI mood.**
 */

import type { SystemKey } from "./demo-wire";
import type { DemoCommandResultState } from "./demo-commands";
import { DEMO_OPERATOR } from "./demo-wire";
import { DEMO_SYSTEM_INSTANCES } from "./demo-runstart-wire";

// ---------------------------------------------------------------------------
// Provenance — env var > settings.json > code default
// ---------------------------------------------------------------------------

/** which layer supplied the value in effect */
export type SettingSource = "env" | "settings" | "default";

export const SETTING_SOURCE_LABEL: Record<SettingSource, string> = {
  env: "Environment",
  settings: "settings.json",
  default: "Code default",
};

export const SETTING_SOURCE_NOTE: Record<SettingSource, string> = {
  env: "An environment variable is set, so it wins over everything. The dashboard cannot change this value — unset the variable first.",
  settings: "You set this in the dashboard. It is stored in config/settings.json and overrides the code default.",
  default: "Nothing overrides it, so the value compiled into the code is in effect.",
};

export type SettingGroupKey = "general" | "display" | "performance" | "paths";

export interface SettingGroupSpec {
  key: SettingGroupKey;
  label: string;
  blurb: string;
}

export const SETTING_GROUPS: SettingGroupSpec[] = [
  { key: "general", label: "General", blurb: "The dates that roll over each fiscal year." },
  { key: "display", label: "Display", blurb: "How the queue is presented. Nothing here changes what a run does." },
  { key: "performance", label: "Performance", blurb: "How hard the executor is allowed to push. Every value here is a budget, not a target." },
  { key: "paths", label: "Paths", blurb: "Where downloaded reports are written." },
];

/**
 * How a leaf is edited. It is a served fact, not a UI guess: `min`/`max` are
 * the SERVER's accepted range and the same numbers it refuses against, so a
 * value the control will not let you type is also a value the server would not
 * have taken.
 */
export type SettingControlWire =
  | { kind: "text" }
  | { kind: "date" }
  | { kind: "number"; min: number; max: number; step?: number }
  | { kind: "enum"; options: { value: string; label: string }[] };

/**
 * A setting that can push the product into a state it cannot detect for itself.
 *
 * This exists because the caution vocabulary was spent entirely on things the
 * operator could NOT change: a locked leaf got a shield and an amber reason,
 * while `ocrConcurrency` — whose own note says raising it "starts fabricating
 * handwriting" — rendered as body text at the same weight as "which sort the
 * queue opens on". A hazard is not explanation, so it is exempt from the
 * no-prose rule; it is an outcome, stated before it happens.
 */
export interface SettingHazardWire {
  /** the highest value that is known-safe — above it the warning escalates */
  safeMax: number;
  /** what goes wrong, in the operator's terms — never "may degrade performance" */
  consequence: string;
  /** how you would find out, if you shipped it wrong */
  detection: string;
}

export interface SettingLeafWire {
  /** dotted path — the same key `config/settings.json` stores */
  key: string;
  label: string;
  group: SettingGroupKey;
  /** the value in effect right now */
  effective: string;
  /** which layer won */
  source: SettingSource;
  /**
   * What each layer holds. `undefined` means the layer does not set it at all —
   * which is different from setting it to the empty string.
   */
  layers: { env?: { name: string; value: string }; settings?: string; default: string };
  unit?: string;
  control: SettingControlWire;
  /**
   * What the value does. It lives behind the row's **ⓘ** — a sentence that
   * would be equally true of every operator is a rule of the product, and a
   * rule of the product costs the same pixels every time it is drawn whether or
   * not anyone needed it.
   */
  note: string;
  /** present only when getting this wrong is dangerous */
  hazard?: SettingHazardWire;
}

/**
 * The eight leaves that survived the audit. Every one of them is a question the
 * operator can answer from something they can see.
 */
export const DEMO_SETTINGS: SettingLeafWire[] = [
  {
    key: "annual.fiscalYearStart",
    label: "Fiscal year start",
    group: "general",
    effective: "2026-07-01",
    source: "settings",
    layers: { settings: "2026-07-01", default: "2025-07-01" },
    control: { kind: "date" },
    note: "Rolls the work-study and pay-rule date defaults, and the oath effective date stamped on a submission whose document does not carry one. These were two leaves holding one date and rolling on one event; they are one leaf.",
  },
  {
    key: "display.defaultSort",
    label: "Default queue sort",
    group: "display",
    effective: "attention",
    source: "settings",
    layers: { settings: "attention", default: "newest" },
    control: {
      kind: "enum",
      options: [
        { value: "attention", label: "Attention first" },
        { value: "newest", label: "Newest first" },
        { value: "oldest", label: "Oldest first" },
      ],
    },
    note: "Which sort the Queue Panel opens on. Sorting never filters, so no count moves with it.",
  },
  {
    key: "display.groupAutoExpand",
    label: "Auto-expand a group that needs you",
    group: "display",
    effective: "on",
    source: "default",
    layers: { default: "on" },
    control: {
      kind: "enum",
      options: [
        { value: "on", label: "On" },
        { value: "off", label: "Off" },
      ],
    },
    note: "A group with a member Waiting on you or Failed opens itself, so you never have to open a row to find that out (row-model D5).",
  },
  {
    key: "performance.ocrConcurrency",
    label: "OCR concurrency",
    group: "performance",
    effective: "3",
    source: "settings",
    layers: { settings: "3", default: "2" },
    unit: "pages in flight",
    control: { kind: "number", min: 1, max: 8 },
    note: "How many pages the vision model reads in parallel.",
    hazard: {
      safeMax: 4,
      consequence:
        "Past four pages in flight the model drops off its tier-1 patience window mid-batch, and a weak tier does not read a handwritten SSN badly — it INVENTS one. That value then reaches a real UCPath record with a normal-looking confidence beside it.",
      detection:
        "Nothing on this page will tell you. It shows up as a record whose SSN matches no paper, weeks later, on a batch you cannot re-read.",
    },
  },
  {
    key: "performance.ocrValidationRetries",
    label: "OCR validation retries",
    group: "performance",
    effective: "2",
    source: "default",
    layers: { default: "2" },
    unit: "attempts",
    control: { kind: "number", min: 0, max: 5 },
    note: "Re-reads of a page whose extraction failed its own schema. A third disagreement flags the record instead of guessing.",
  },
  {
    key: "performance.duoTimeoutSec",
    label: "Duo approval timeout",
    group: "performance",
    effective: "180",
    source: "default",
    layers: { default: "180" },
    unit: "seconds",
    control: { kind: "number", min: 30, max: 600, step: 30 },
    note: "How long a production run waits on your phone before it fails loud rather than sitting forever. You can see whether this is too short: a run that failed at Duo says so.",
  },
  {
    key: "performance.defaultWorkers",
    label: "Default workers per workflow",
    group: "performance",
    effective: "2",
    source: "settings",
    layers: { settings: "2", default: "1" },
    unit: "workers",
    control: { kind: "number", min: 1, max: 8 },
    note: "The value the run modal's worker stepper OPENS on. It stays global because it is a property of the machine — how many authenticated browsers this laptop can hold — not of the run, and almost every start is made without touching the stepper.",
  },
  {
    key: "paths.reportsDir",
    label: "Reports directory",
    group: "paths",
    effective: "~/Documents/HR reports",
    source: "settings",
    layers: { settings: "~/Documents/HR reports", default: "<repo>/generated/reports" },
    control: { kind: "text" },
    note: "Where downloaded UKG/Kronos reports land. You can see whether this is right — the file either appears where you look for it or it does not.",
  },
];

export function settingsInGroup(group: SettingGroupKey): SettingLeafWire[] {
  return DEMO_SETTINGS.filter((leaf) => leaf.group === group);
}

/** the literal place the winning value came from — shown beside every leaf */
export function settingOrigin(leaf: SettingLeafWire): string {
  if (leaf.source === "env") return `${leaf.layers.env?.name ?? "environment"} · process environment`;
  if (leaf.source === "settings") return `config/settings.json → ${leaf.key}`;
  return `src/config.ts → ${leaf.key}`;
}

// ---------------------------------------------------------------------------
// Status: what the environment owns
// ---------------------------------------------------------------------------

/**
 * Values the operator can SEE and cannot SET.
 *
 * These were settings leaves with a disabled input and an "override anyway"
 * button whose only function was to return a refusal. A disabled control claims
 * "this could be editable and today is not"; these are not that. They are
 * facts, so they are drawn as facts — and the refusal is still one press away,
 * because a rule you cannot make the product state is a rule you end up
 * arguing with.
 */
export interface EnvironmentFactWire {
  key: string;
  label: string;
  effective: string;
  source: SettingSource;
  layers: { env?: { name: string; value: string }; settings?: string; default: string };
  /** why this is not an operator setting, in the operator's terms */
  reason: string;
  /** what would have to change for it to move */
  toChangeIt: string;
}

export const DEMO_ENVIRONMENT_FACTS: EnvironmentFactWire[] = [
  {
    key: "operator.timekeeperName",
    label: "Timekeeper name",
    effective: "J. Hein",
    source: "env",
    layers: { env: { name: "TIMEKEEPER_NAME", value: "J. Hein" }, default: "" },
    reason:
      "The environment owns it, and startup throws if it is unset anywhere — so there is no state in which the dashboard could usefully supply it.",
    toChangeIt: "Set TIMEKEEPER_NAME in .env and restart. The value is filled into the Kuali separation timekeeper field.",
  },
  {
    key: "operator.actor",
    label: "Actor recorded on every command",
    effective: DEMO_OPERATOR,
    source: "default",
    layers: { default: DEMO_OPERATOR },
    reason:
      "Identity is not a preference. There is exactly one actor until an auth seam exists, and letting it be typed here would make attribution a claim rather than a fact.",
    toChangeIt: "An authentication seam. The field already exists on every row and command, so multi-user needs no migration.",
  },
  {
    key: "performance.navRetries",
    label: "Navigation retries",
    effective: "4",
    source: "env",
    layers: { env: { name: "HRAUTO_NAV_RETRIES", value: "4" }, settings: "3", default: "2" },
    reason:
      "HRAUTO_NAV_RETRIES is set, so settings.json loses. Note that it holds 3 — somebody set it here and it has never been in effect.",
    toChangeIt: "Unset HRAUTO_NAV_RETRIES. Retrying the SAME navigation is not a fallback — it re-runs the operation, it does not substitute a value.",
  },
  {
    key: "paths.trackerDir",
    label: "Tracker directory",
    effective: "~/hr-automation/.tracker",
    source: "env",
    layers: { env: { name: "HRAUTO_TRACKER_DIR", value: "~/hr-automation/.tracker" }, default: "<repo>/.tracker" },
    reason:
      "Pointed by the environment on purpose, so a preview or a test lane can never write into real history. A dashboard that could repoint it mid-session would split one day's rows across two volumes.",
    toChangeIt: "Set HRAUTO_TRACKER_DIR and restart. It holds rows, logs, sessions and evidence.",
  },
];

// ---------------------------------------------------------------------------
// Status: engineering constants the product behaves by
// ---------------------------------------------------------------------------

/**
 * Values that are real, load-bearing, and not decisions the operator is in a
 * position to make. Each one states the value AND the reason it is not offered
 * — because "where did the recovery ladder go" deserves an answer, and the
 * answer is not "we hid it".
 */
export interface SystemBehaviourWire {
  group: string;
  label: string;
  value: string;
  /** why the operator is not asked */
  notYours: string;
}

export const DEMO_SYSTEM_BEHAVIOUR: SystemBehaviourWire[] = [
  {
    group: "Recovery ladder",
    label: "Refresh an idle browser after",
    value: "900s idle",
    notYours:
      "Rung one — a page reload, no session loss. Nothing on any surface would tell you 900 is wrong, so tuning it is guessing with a number box.",
  },
  {
    group: "Recovery ladder",
    label: "Reopen the tab after",
    value: "2 failed probes",
    notYours: "Rung two. A reopen loses page state, so it is never the first thing tried.",
  },
  {
    group: "Recovery ladder",
    label: "Daemon idle before keep-alive",
    value: "120s",
    notYours:
      "The second idle timer, and it is not independent of the first — a keep-alive touch resets the refresh clock. Two boxes that quietly interact is how a tuning surface produces a state nobody meant.",
  },
  {
    group: "Audit capture",
    label: "Capture geometry",
    value: "1600 × 1000 px",
    notYours:
      "Tall enough to hold a UCPath confirmation panel without scrolling it out of frame. Changing it cannot fix the evidence you are looking at — past captures are not re-rendered — so the only thing it can do is make the next one different from the last.",
  },
];

// ---------------------------------------------------------------------------
// System URLs — READ-ONLY reference; the choice itself is per-run
// ---------------------------------------------------------------------------

export interface SystemUrlReferenceWire {
  system: SystemKey;
  label: string;
  productionUrl: string;
  testUrl?: string;
  note: string;
}

/**
 * The hosts, as a reference. There is deliberately no override box: pointing a
 * system at staging is a question about ONE RUN, and it is asked in the run
 * modal's instance selector, which prints the host each choice resolves to.
 */
export const DEMO_SYSTEM_URLS: SystemUrlReferenceWire[] = (
  Object.keys(DEMO_SYSTEM_INSTANCES) as SystemKey[]
).map((system) => ({
  system,
  label: DEMO_SYSTEM_INSTANCES[system].label,
  productionUrl: DEMO_SYSTEM_INSTANCES[system].hosts.prod,
  testUrl: DEMO_SYSTEM_INSTANCES[system].hosts.test,
  note: DEMO_SYSTEM_INSTANCES[system].note,
}));

// ---------------------------------------------------------------------------
// Preflight / doctor — advisory only, never a gate
// ---------------------------------------------------------------------------

export type PreflightVerdict = "pass" | "warning" | "fail";

export interface PreflightCheckWire {
  id: string;
  label: string;
  verdict: PreflightVerdict;
  detail: string;
  /** what this check's failure would break — named, never "some workflows" */
  blocks: string[];
  remediation?: string;
  checkedAt: string;
}

const PREFLIGHT_CHECKS: Omit<PreflightCheckWire, "checkedAt">[] = [
  {
    id: "credentials",
    label: "SSO credentials present",
    verdict: "pass",
    detail: "UCPATH_USER_ID and UCPATH_PASSWORD are both set in the environment.",
    blocks: [],
  },
  {
    id: "timekeeper",
    label: "Timekeeper name set",
    verdict: "pass",
    detail: "TIMEKEEPER_NAME = J. Hein.",
    blocks: [],
  },
  {
    id: "chromium",
    label: "Chromium installed",
    verdict: "pass",
    detail: "Full Chromium 141 present — extensions can load, so Duo Autopilot can clear MFA unattended.",
    blocks: [],
  },
  {
    id: "disk",
    label: "Tracker volume free space",
    verdict: "warning",
    detail: "4.2 GB free. Evidence capture is sized at roughly 300 MB a week, so this is about 14 weeks of headroom.",
    blocks: [],
    remediation: "Run the tracker prune (7-day default) or point HRAUTO_TRACKER_DIR at a larger volume.",
  },
  {
    id: "i9-test",
    label: "I-9 test instance reachable",
    verdict: "fail",
    detail: "No test host is provisioned for I-9, so a start can only ever target production there.",
    blocks: ["I-9 Check against a test instance", "Onboarding dry-runs that touch I-9"],
    remediation: "Either leave I-9 on production (what the run modal offers today) or ask IT to provision a test host.",
  },
];

/**
 * Run the doctor. It reads local state only — no browser, no Duo prompt — which
 * is why re-running it is a real command with a real answer rather than a
 * button that was never wired.
 */
export function runPreflight(checkedAt: string): PreflightCheckWire[] {
  return PREFLIGHT_CHECKS.map((check) => ({ ...check, checkedAt }));
}

export const DEMO_PREFLIGHT: PreflightCheckWire[] = runPreflight("2:24 PM");

export const PREFLIGHT_ADVISORY_NOTE =
  "Doctor never blocks a run. It tells you what will fail before you spend a Duo prompt finding out — a failing check beside a workflow you are not running today is information, not an error.";

/** how loud the doctor's standing indicator should be */
export function preflightVerdict(checks: PreflightCheckWire[]): PreflightVerdict {
  if (checks.some((c) => c.verdict === "fail")) return "fail";
  if (checks.some((c) => c.verdict === "warning")) return "warning";
  return "pass";
}

// ---------------------------------------------------------------------------
// Storage health — including the read-only degraded mode
// ---------------------------------------------------------------------------

export type StorageMode = "read-write" | "read-only-degraded";

export interface StorageBackupWire {
  id: string;
  takenAt: string;
  ageLabel: string;
  sizeLabel: string;
  verdict: "verified" | "stale" | "failed";
  note: string;
}

export interface StorageHealthWire {
  mode: StorageMode;
  /** the authority generation of the task store — the CAS root of everything */
  authorityGeneration: number;
  integrity: string;
  integrityCheckedAt: string;
  rowsOnDisk: number;
  /** why the mode is what it is — required when degraded */
  reason?: string;
  backups: StorageBackupWire[];
  /** what the dashboard can still do in this mode */
  stillWorks: string[];
  /** what it cannot */
  blocked: string[];
}

export const STORAGE_HEALTHY: StorageHealthWire = {
  mode: "read-write",
  authorityGeneration: 41,
  integrity: "Verified — every row on disk parses, and the SQLite authority agrees with the JSONL projection.",
  integrityCheckedAt: "2:23 PM",
  rowsOnDisk: 1_284,
  backups: [
    {
      id: "bk-3",
      takenAt: "2:14 PM",
      ageLabel: "12m ago",
      sizeLabel: "38 MB",
      verdict: "verified",
      note: "Restore-tested — the backup was opened and its generation read back.",
    },
    {
      id: "bk-2",
      takenAt: "8:14 AM",
      ageLabel: "6h ago",
      sizeLabel: "37 MB",
      verdict: "verified",
      note: "Restore-tested.",
    },
    {
      id: "bk-1",
      takenAt: "Jul 24, 12:14 PM",
      ageLabel: "26h ago",
      sizeLabel: "36 MB",
      verdict: "stale",
      note: "Older than the 24h retention floor. Kept until the next prune, but it is not the one a restore would use.",
    },
  ],
  stillWorks: [],
  blocked: [],
};

export const STORAGE_DEGRADED: StorageHealthWire = {
  mode: "read-only-degraded",
  authorityGeneration: 41,
  integrity: "Last verified before the volume went read-only. Nothing is known to be corrupt — nothing new can be written either.",
  integrityCheckedAt: "2:09 PM",
  rowsOnDisk: 1_284,
  reason:
    "Two consecutive projection writes to the tracker volume failed with EACCES at 2:11 PM. The dashboard stopped writing rather than losing rows silently, and dropped to read-only.",
  backups: STORAGE_HEALTHY.backups,
  stillWorks: [
    "Every row, receipt, log line and piece of evidence already on disk still opens.",
    "Search, the date navigator, the archive and the activity report all read from what is there.",
    "Runs already in flight keep running — the executor writes through the SQLite authority, which is on a different volume.",
  ],
  blocked: [
    "Starting a run. Nothing new is enqueued while the projection cannot be written.",
    "Every command: retry, cancel, bump, hide, rename, and both write-park resolutions.",
    "Resolving a gate. A decision that cannot be recorded is a decision that did not happen.",
  ],
};

export function storageSnapshot(mode: StorageMode): StorageHealthWire {
  return mode === "read-write" ? STORAGE_HEALTHY : STORAGE_DEGRADED;
}

// ---------------------------------------------------------------------------
// Settings writes — one transaction, one answer per leaf
// ---------------------------------------------------------------------------

/** one leaf's fate inside a save */
export interface SettingLeafOutcome {
  key: string;
  label: string;
  value: string;
  state: "applied" | "refused";
  code?: string;
  detail: string;
}

export interface SettingSaveResult {
  state: DemoCommandResultState;
  headline: string;
  detail: string;
  /** rejected only — the code for the whole transaction */
  code?: string;
  /** per leaf, always — a save that touched three leaves answers about three */
  outcomes: SettingLeafOutcome[];
}

export interface SettingEdit {
  leaf: SettingLeafWire;
  value: string;
}

/** the server's per-leaf validation, quotable and identical to the control's bounds */
function validateLeaf(leaf: SettingLeafWire, value: string): { code: string; detail: string } | null {
  const trimmed = value.trim();
  if (trimmed === "") {
    return { code: "empty-value", detail: `${leaf.label} cannot be empty. Clear the override instead if you want the default back.` };
  }
  if (leaf.control.kind === "number") {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return { code: "not-a-number", detail: `“${value}” is not a number. ${leaf.label} takes ${leaf.control.min}–${leaf.control.max}.` };
    }
    if (parsed < leaf.control.min || parsed > leaf.control.max) {
      return {
        code: "out-of-bounds",
        detail: `${leaf.label} accepts ${leaf.control.min}–${leaf.control.max}${leaf.unit ? ` ${leaf.unit}` : ""}; you sent ${parsed}. The bound is the server's, not the box's.`,
      };
    }
  }
  if (leaf.control.kind === "enum" && !leaf.control.options.some((o) => o.value === trimmed)) {
    return {
      code: "not-an-option",
      detail: `“${value}” is not one of ${leaf.control.options.map((o) => o.value).join(", ")}.`,
    };
  }
  if (leaf.control.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return { code: "not-a-date", detail: `${leaf.label} takes YYYY-MM-DD; you sent “${value}”.` };
  }
  return null;
}

/**
 * The mock server's settings write, over EVERY dirty leaf at once.
 *
 * The previous version took one leaf, and the page called it with `dirty[0]`
 * and then cleared the draft — so a footer reading "3 unsaved changes" saved one
 * and silently dropped two. A settings save is a transaction: it is all-or-
 * nothing on a storage refusal, and per-leaf on a validation refusal, and it
 * says which of the two happened.
 */
export function submitSettingChanges(edits: SettingEdit[], storage: StorageMode): SettingSaveResult {
  if (edits.length === 0) {
    return { state: "applied", headline: "Nothing to save", detail: "No value differs from what is in effect.", outcomes: [] };
  }

  if (storage === "read-only-degraded") {
    return {
      state: "rejected",
      code: "storage-read-only",
      headline: `Rejected — storage is read-only, so none of the ${edits.length} changes were written`,
      detail:
        "config/settings.json is on the volume that went read-only at 2:11 PM. NOTHING was written — not one of them, not partially. Fix the volume, then save again; a setting that appears to save and does not is worse than one that refuses.",
      outcomes: edits.map((edit) => ({
        key: edit.leaf.key,
        label: edit.leaf.label,
        value: edit.value,
        state: "refused",
        code: "storage-read-only",
        detail: "Held in the form, not written.",
      })),
    };
  }

  const outcomes: SettingLeafOutcome[] = edits.map((edit) => {
    const problem = validateLeaf(edit.leaf, edit.value);
    if (problem) {
      return { key: edit.leaf.key, label: edit.leaf.label, value: edit.value, state: "refused", ...problem };
    }
    return {
      key: edit.leaf.key,
      label: edit.leaf.label,
      value: edit.value,
      state: "applied",
      detail: `config/settings.json now holds ${edit.leaf.key} = “${edit.value.trim()}”. The code default (${edit.leaf.layers.default}) is kept underneath — clearing the override restores it.`,
    };
  });

  const applied = outcomes.filter((o) => o.state === "applied");
  const refused = outcomes.filter((o) => o.state === "refused");

  if (refused.length > 0 && applied.length === 0) {
    return {
      state: "rejected",
      code: refused[0].code,
      headline: `Refused — ${refused.length === 1 ? "the change was" : `all ${refused.length} changes were`} rejected`,
      detail: "NOTHING was written. Each refusal is listed with its own code below.",
      outcomes,
    };
  }

  return {
    state: "applied",
    headline:
      refused.length === 0
        ? `Saved — ${applied.length} change${applied.length === 1 ? "" : "s"}`
        : `Saved ${applied.length} of ${applied.length + refused.length} — ${refused.length} refused`,
    detail:
      refused.length === 0
        ? `Attributed to ${DEMO_OPERATOR}. Every one of them is listed below with the layer it now sits in.`
        : `Attributed to ${DEMO_OPERATOR}. The refused values are still in the form so you can fix them — they were not silently dropped.`,
    outcomes,
  };
}

/**
 * The refusal an environment-owned fact returns when the operator presses
 * "override anyway". It lives on the STATUS surface now: the refusal is the
 * only thing that button ever did, and it belongs where being unchangeable is
 * the point.
 */
export function submitEnvironmentOverride(fact: EnvironmentFactWire, storage: StorageMode): SettingSaveResult {
  if (storage === "read-only-degraded") {
    return {
      state: "rejected",
      code: "storage-read-only",
      headline: "Rejected — storage is read-only",
      detail: "config/settings.json is on the volume that went read-only at 2:11 PM. NOTHING was written.",
      outcomes: [],
    };
  }
  if (fact.source === "env") {
    return {
      state: "rejected",
      code: "env-owns-this-value",
      headline: `Rejected — ${fact.layers.env?.name} owns this value`,
      detail: `Precedence is environment > settings.json > code default, so writing to settings.json would change nothing you can see. NOTHING was written. ${fact.toChangeIt}`,
      outcomes: [],
    };
  }
  return {
    state: "rejected",
    code: "not-operator-settable",
    headline: `Rejected — ${fact.label} is not an operator setting`,
    detail: `${fact.reason} NOTHING was written. ${fact.toChangeIt}`,
    outcomes: [],
  };
}
