/**
 * DEV-ONLY — the SETTINGS half of the wire contract the rebuild demo consumes.
 *
 * `docs/rebuild/reviews/demo-feature-plan-2026-07-25.md` §1.6 "Settings":
 * effective value + **source (env > settings > default)** per leaf; System URLs
 * prod/test split; Performance (lanes, per-system pool modes read-only + budget
 * caps, OCR concurrency, timeouts); preflight/doctor results (`pass|warning|fail`
 * + blocks + remediation — advisory-only); storage health (backup age, authority
 * generation, integrity, read-only degraded mode).
 *
 * Two rules, same as the rest of the demo's wire files:
 *
 *  1. **A leaf never states its own provenance in prose.** It carries the three
 *     LAYERS and the server says which one won (`source`), so "which is winning
 *     and where did it come from" is a computed fact, not a caption. A leaf the
 *     environment owns is `editable: false` — the dashboard cannot out-vote an
 *     env var, and pretending otherwise would be a Save button that silently
 *     does nothing.
 *  2. **Storage health is a SNAPSHOT the server serves, not a UI mood.** The
 *     degraded state is a second authored snapshot, so the banner renders from
 *     served facts (what still works, what does not) rather than from a boolean
 *     the client invented.
 */

import type { SystemKey } from "./demo-wire";
import type { DemoCommandResultState } from "./demo-commands";
import { DEMO_OPERATOR } from "./demo-wire";

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

export type SettingGroupKey =
  | "general"
  | "display"
  | "performance"
  | "recovery"
  | "capture"
  | "paths";

export interface SettingGroupSpec {
  key: SettingGroupKey;
  label: string;
  blurb: string;
}

export const SETTING_GROUPS: SettingGroupSpec[] = [
  { key: "general", label: "General", blurb: "Operator identity and the dates that roll over each fiscal year." },
  { key: "display", label: "Display", blurb: "How the queue is presented. Nothing here changes what a run does." },
  {
    key: "performance",
    label: "Performance",
    blurb: "How hard the executor is allowed to push. Every value here is a budget, not a target.",
  },
  { key: "recovery", label: "Recovery & daemon", blurb: "When a browser is refreshed, reopened, or given up on." },
  { key: "capture", label: "Audit capture", blurb: "Geometry of the screenshots filed as evidence." },
  { key: "paths", label: "Paths", blurb: "Where the tracker, artifacts and reports are written." },
];

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
  /** what the value does — one line, never a paragraph */
  note: string;
  /**
   * `false` when the leaf cannot be written from the dashboard. A control that
   * cannot win is shown disabled with the reason, never hidden — a setting you
   * cannot find is a setting you think is missing.
   */
  editable: boolean;
  /** required when `editable` is false — the reason, in the operator's terms */
  lockedReason?: string;
}

/** the reason a leaf is locked, defaulting to the env-precedence explanation */
export function settingLockReason(leaf: SettingLeafWire): string {
  return leaf.lockedReason ?? SETTING_SOURCE_NOTE.env;
}

/**
 * Deliberately mixed provenance: two leaves are won by the environment (and are
 * therefore read-only here), several by `settings.json`, the rest by the code.
 * All three source states are visible without scrolling.
 */
export const DEMO_SETTINGS: SettingLeafWire[] = [
  {
    key: "operator.timekeeperName",
    label: "Timekeeper name",
    group: "general",
    effective: "J. Hein",
    source: "env",
    layers: { env: { name: "TIMEKEEPER_NAME", value: "J. Hein" }, default: "" },
    note: "Filled into the Kuali separation timekeeper field. Startup throws if it is unset anywhere.",
    editable: false,
  },
  {
    key: "operator.actor",
    label: "Actor recorded on every command",
    group: "general",
    effective: DEMO_OPERATOR,
    source: "default",
    layers: { default: DEMO_OPERATOR },
    note: "Stamped on every run, command and notification. One actor today; the field exists so multi-user needs no migration.",
    editable: false,
    lockedReason:
      "Identity is not a preference. There is exactly one actor until an auth seam exists, and letting it be typed here would make attribution a claim rather than a fact.",
  },
  {
    key: "annual.fiscalYearStart",
    label: "Fiscal year start",
    group: "general",
    effective: "2026-07-01",
    source: "settings",
    layers: { settings: "2026-07-01", default: "2025-07-01" },
    note: "Rolls the work-study and pay-rule date defaults. Update it once a year.",
    editable: true,
  },
  {
    key: "annual.oathEffectiveDate",
    label: "Oath effective date",
    group: "general",
    effective: "2026-07-01",
    source: "default",
    layers: { default: "2026-07-01" },
    note: "The effective date stamped on oath submissions when the document does not carry one.",
    editable: true,
  },
  {
    key: "display.defaultSort",
    label: "Default queue sort",
    group: "display",
    effective: "attention",
    source: "settings",
    layers: { settings: "attention", default: "newest" },
    note: "Which sort the Queue Panel opens on. Sorting never filters, so no count moves with it.",
    editable: true,
  },
  {
    key: "display.groupAutoExpand",
    label: "Auto-expand a group that needs you",
    group: "display",
    effective: "on",
    source: "default",
    layers: { default: "on" },
    note: "A group with a member Waiting on you or Failed opens itself (row-model D5).",
    editable: true,
  },
  {
    key: "performance.defaultWorkers",
    label: "Default workers per workflow",
    group: "performance",
    effective: "2",
    source: "settings",
    layers: { settings: "2", default: "1" },
    unit: "workers",
    note: "How many executor processes a workflow starts with. Add more from the Session Panel at runtime.",
    editable: true,
  },
  {
    key: "performance.navRetries",
    label: "Navigation retries",
    group: "performance",
    effective: "4",
    source: "env",
    layers: { env: { name: "HRAUTO_NAV_RETRIES", value: "4" }, settings: "3", default: "2" },
    unit: "attempts",
    note: "Retries of the SAME navigation on a transient error. Retrying a navigation is not a fallback — it re-runs the operation.",
    editable: false,
  },
  {
    key: "performance.ocrConcurrency",
    label: "OCR concurrency",
    group: "performance",
    effective: "3",
    source: "settings",
    layers: { settings: "3", default: "2" },
    unit: "pages in flight",
    note: "Pages read in parallel. Raising it past the model's tier-1 patience window is what starts fabricating handwriting.",
    editable: true,
  },
  {
    key: "performance.ocrValidationRetries",
    label: "OCR validation retries",
    group: "performance",
    effective: "2",
    source: "default",
    layers: { default: "2" },
    unit: "attempts",
    note: "Re-reads of a page whose extraction failed its own schema. A third disagreement flags the record instead of guessing.",
    editable: true,
  },
  {
    key: "performance.duoTimeoutSec",
    label: "Duo approval timeout",
    group: "performance",
    effective: "180",
    source: "default",
    layers: { default: "180" },
    unit: "seconds",
    note: "How long a production run waits on your phone before the run fails loud rather than sitting forever.",
    editable: true,
  },
  {
    key: "performance.ukgTimeoutSec",
    label: "UKG report timeout",
    group: "performance",
    effective: "420",
    source: "settings",
    layers: { settings: "420", default: "240" },
    unit: "seconds",
    note: "The report builder is slow on a full-quarter span; the default was tripping on legitimate work.",
    editable: true,
  },
  {
    key: "recovery.browserRefreshAfterSec",
    label: "Refresh a browser after",
    group: "recovery",
    effective: "900",
    source: "default",
    layers: { default: "900" },
    unit: "seconds idle",
    note: "First rung of the recovery ladder — a page reload, no session loss.",
    editable: true,
  },
  {
    key: "recovery.reopenAfterFailures",
    label: "Reopen a tab after",
    group: "recovery",
    effective: "2",
    source: "default",
    layers: { default: "2" },
    unit: "failed probes",
    note: "Second rung. A reopen loses page state, so it is never the first thing tried.",
    editable: true,
  },
  {
    key: "daemon.idleSec",
    label: "Daemon idle before keep-alive",
    group: "recovery",
    effective: "120",
    source: "settings",
    layers: { settings: "120", default: "300" },
    unit: "seconds",
    note: "How long a worker sits with no work before it starts keeping its sessions warm instead of holding them idle.",
    editable: true,
  },
  {
    key: "capture.width",
    label: "Capture width",
    group: "capture",
    effective: "1600",
    source: "default",
    layers: { default: "1600" },
    unit: "px",
    note: "Evidence screenshots are filed at this width. Changing it does not re-render past evidence.",
    editable: true,
  },
  {
    key: "capture.height",
    label: "Capture height",
    group: "capture",
    effective: "1000",
    source: "default",
    layers: { default: "1000" },
    unit: "px",
    note: "Tall enough to hold a UCPath confirmation panel without scrolling it out of frame.",
    editable: true,
  },
  {
    key: "paths.trackerDir",
    label: "Tracker directory",
    group: "paths",
    effective: "~/hr-automation/.tracker",
    source: "env",
    layers: { env: { name: "HRAUTO_TRACKER_DIR", value: "~/hr-automation/.tracker" }, default: "<repo>/.tracker" },
    note: "Rows, logs, sessions and evidence. Pointed elsewhere by the env var so a preview never writes into real history.",
    editable: false,
  },
  {
    key: "paths.reportsDir",
    label: "Reports directory",
    group: "paths",
    effective: "~/Documents/HR reports",
    source: "settings",
    layers: { settings: "~/Documents/HR reports", default: "<repo>/generated/reports" },
    note: "Where downloaded UKG/Kronos reports land.",
    editable: true,
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
// System URLs — empty means production; a value means a test instance
// ---------------------------------------------------------------------------

export interface SystemUrlWire {
  system: SystemKey;
  label: string;
  /** the production entry URL compiled into the code */
  productionUrl: string;
  /** operator override; empty = production */
  override: string;
  /** derived — what a run enqueued right now would resolve to */
  resolved: "prod" | "test";
  /** why a test instance exists for this system, or why one does not */
  note: string;
}

export const DEMO_SYSTEM_URLS: SystemUrlWire[] = [
  {
    system: "ucpath",
    label: "UCPath",
    productionUrl: "https://ucpath.universityofcalifornia.edu",
    override: "",
    resolved: "prod",
    note: "Production. Every UCPath write in the queue lands here.",
  },
  {
    system: "kuali",
    label: "Kuali",
    productionUrl: "https://kuali.ucsd.edu/space/HR",
    override: "https://kuali-stg.ucsd.edu/space/HR",
    resolved: "test",
    note: "Pointed at staging. Rows that touch Kuali carry a test chip so a staging run can never be mistaken for a filing.",
  },
  {
    system: "kronos",
    label: "Kronos",
    productionUrl: "https://kronos.ucsd.edu/timekeeping",
    override: "",
    resolved: "prod",
    note: "Production.",
  },
  {
    system: "crm",
    label: "CRM",
    productionUrl: "https://crm.ucsd.edu",
    override: "",
    resolved: "prod",
    note: "Production. Read-only for the download workflow.",
  },
  {
    system: "servicenow",
    label: "ServiceNow",
    productionUrl: "https://ucsd.service-now.com",
    override: "",
    resolved: "prod",
    note: "Production. Oath Upload files its ticket here.",
  },
  {
    system: "onbase",
    label: "OnBase",
    productionUrl: "https://onbase.ucsd.edu",
    override: "",
    resolved: "prod",
    note: "Production. No test instance is provisioned — a test run here would be refused at enqueue.",
  },
  {
    system: "i9",
    label: "I-9",
    productionUrl: "https://i9.ucsd.edu",
    override: "",
    resolved: "prod",
    note: "Production.",
  },
];

// ---------------------------------------------------------------------------
// Performance budgets — caps the executor is held to
// ---------------------------------------------------------------------------

export interface BudgetCapWire {
  system: SystemKey;
  label: string;
  /** how many concurrent leases this system allows */
  cap: number;
  /** in use at the instant this payload was projected */
  inUse: number;
  /** `single` = one browser, ever. Read-only: it is a property of the system. */
  poolMode: "single" | "pooled";
  reason: string;
}

export const DEMO_BUDGETS: BudgetCapWire[] = [
  {
    system: "ucpath",
    label: "UCPath",
    cap: 1,
    inUse: 1,
    poolMode: "single",
    reason: "PeopleSoft invalidates the older session when a second one authenticates. One browser is not a tuning choice.",
  },
  {
    system: "kuali",
    label: "Kuali",
    cap: 2,
    inUse: 1,
    poolMode: "pooled",
    reason: "Two concurrent sessions verified stable.",
  },
  { system: "kronos", label: "Kronos", cap: 2, inUse: 0, poolMode: "pooled", reason: "Two concurrent sessions verified stable." },
  { system: "crm", label: "CRM", cap: 2, inUse: 1, poolMode: "pooled", reason: "Two concurrent sessions verified stable." },
  { system: "i9", label: "I-9", cap: 1, inUse: 1, poolMode: "single", reason: "Single-session by the same rule as UCPath." },
  { system: "onbase", label: "OnBase", cap: 1, inUse: 0, poolMode: "single", reason: "Single-session; verified 2026-06-30." },
  {
    system: "servicenow",
    label: "ServiceNow",
    cap: 2,
    inUse: 0,
    poolMode: "pooled",
    reason: "Ticket filing is short and stateless.",
  },
];

/** executor lanes — the global ceiling every per-system cap sits under */
export const DEMO_LANE_BUDGET = {
  cap: 4,
  inUse: 3,
  note: "A lane is one item in flight. A workflow can hold several system leases inside one lane.",
} as const;

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

export const DEMO_PREFLIGHT: PreflightCheckWire[] = [
  {
    id: "credentials",
    label: "SSO credentials present",
    verdict: "pass",
    detail: "UCPATH_USER_ID and UCPATH_PASSWORD are both set in the environment.",
    blocks: [],
    checkedAt: "2:24 PM",
  },
  {
    id: "timekeeper",
    label: "Timekeeper name set",
    verdict: "pass",
    detail: "TIMEKEEPER_NAME = J. Hein.",
    blocks: [],
    checkedAt: "2:24 PM",
  },
  {
    id: "chromium",
    label: "Chromium installed",
    verdict: "pass",
    detail: "Full Chromium 141 present — extensions can load, so Duo Autopilot can clear MFA unattended.",
    blocks: [],
    checkedAt: "2:24 PM",
  },
  {
    id: "disk",
    label: "Tracker volume free space",
    verdict: "warning",
    detail: "4.2 GB free. Evidence capture is sized at roughly 300 MB a week, so this is about 14 weeks of headroom.",
    blocks: [],
    remediation: "Run the tracker prune (7-day default) or point paths.trackerDir at a larger volume.",
    checkedAt: "2:24 PM",
  },
  {
    id: "i9-test",
    label: "I-9 test instance reachable",
    verdict: "fail",
    detail: "https://i9-test.ucsd.edu did not resolve. No test instance is configured for I-9 in System URLs, which matches this result.",
    blocks: ["I-9 Check on a test instance", "Onboarding dry-runs that touch I-9"],
    remediation: "Either leave I-9 on production (the current setting) or ask IT to provision a test host, then set it in System URLs.",
    checkedAt: "2:24 PM",
  },
];

export const PREFLIGHT_ADVISORY_NOTE =
  "Doctor never blocks a run. It tells you what will fail before you spend a Duo prompt finding out — a failing check beside a workflow you are not running today is information, not an error.";

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
// Settings writes — the same three-state result union as every other command
// ---------------------------------------------------------------------------

export interface SettingChangeResult {
  state: DemoCommandResultState;
  headline: string;
  detail: string;
  code?: string;
}

/**
 * The mock server's settings write. Two refusals are reachable: a leaf the
 * environment owns cannot be changed from here, and no setting can be written
 * at all while storage is degraded.
 */
export function submitSettingChange(leaf: SettingLeafWire, value: string, storage: StorageMode): SettingChangeResult {
  if (storage === "read-only-degraded") {
    return {
      state: "rejected",
      code: "storage-read-only",
      headline: "Rejected — storage is read-only",
      detail:
        "config/settings.json is on the volume that went read-only at 2:11 PM. NOTHING was written. Fix the volume, then set it again — a setting that appears to save and does not is worse than one that refuses.",
    };
  }
  if (!leaf.editable && leaf.source === "env") {
    return {
      state: "rejected",
      code: "env-owns-this-leaf",
      headline: `Rejected — ${leaf.layers.env?.name} owns this value`,
      detail: `Precedence is environment > settings.json > code default, so writing “${value}” to settings.json would change nothing you can see. NOTHING was written. Unset ${leaf.layers.env?.name} first, then set it here.`,
    };
  }
  if (!leaf.editable) {
    return {
      state: "rejected",
      code: "not-operator-settable",
      headline: `Rejected — ${leaf.label} is not an operator setting`,
      detail: `${settingLockReason(leaf)} NOTHING was written.`,
    };
  }
  return {
    state: "applied",
    headline: `${leaf.label} saved`,
    detail: `config/settings.json now holds ${leaf.key} = “${value}”, attributed to ${DEMO_OPERATOR}. The code default (${leaf.layers.default}) is kept underneath — clearing the override restores it.`,
  };
}
