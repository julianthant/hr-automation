/**
 * DEV-ONLY — the WIRE SHAPES for the operator flows the demo was missing:
 * notifications, search, the parked-write fence, and the editable checkpoint.
 *
 * Same contract as `demo-wire.ts`: a fixture authors FACTS (instants, keys,
 * policy numbers) and the functions here play the mock server. Nothing renders
 * that a real backend could not serve —
 *
 *  - notifications are durable records (`docs/rebuild/03-tracker-dashboard.md`
 *    §10.4 / demo-feature-plan §1.6) with read/unread + snooze and Ping-vs-Inbox
 *    routing. A ping is a DELIVERY, never the record: a failed desktop delivery
 *    still leaves an unread inbox item, which is why `desktopDelivered` is a
 *    field and not an assumption.
 *  - search is fail-loud: a lookup that could not run renders an ERROR, never
 *    "no matches". Those two answers mean opposite things.
 *  - the write fence is doc 09 §4/§4.1: an unknown write resolves ONLY by
 *    confirmed-present (proof parsed through the completion proof schema, incl.
 *    the operator-attestation arm) or confirmed-absent (evidence note + the
 *    settle fence). Both bind the same subject key and the same intent
 *    generation — that pair is the "double fence".
 *  - the checkpoint is doc 06 §6: per-step outputs with a GENERATION token, an
 *    allowlist of editable paths, and a freshness limit owned by the node that
 *    would consume the value.
 */

import { agoSeconds, at, DEMO_NOW_MS, DEMO_OPERATOR, fmtElapsed, plusSeconds, secondsSince } from "./demo-wire";
import type { DemoDataPoint, DemoRow } from "./demo-data";
import { effectiveStatus } from "./demo-data";
import { ALL_DEMO_ROWS, dayOfRow } from "./demo-days";

// ===========================================================================
// 1. Notifications
// ===========================================================================

export type DemoNotificationTrigger =
  | "run-failed"
  | "gate-opened"
  | "write-parked"
  | "repeated-failure"
  | "storage-degraded"
  | "verified-done"
  | "backfill-failed";

/**
 * Ratified routing (§10.4): everything that means a human is blocking, or that
 * the system itself is unwell, PINGS. Only "it finished cleanly" is inbox-only.
 * Pings are silent — loud is the queue's job, not the operating system's.
 */
export type DemoNotificationDelivery = "ping" | "inbox";

export const NOTIFICATION_ROUTING: Record<DemoNotificationTrigger, DemoNotificationDelivery> = {
  "run-failed": "ping",
  "gate-opened": "ping",
  "write-parked": "ping",
  "repeated-failure": "ping",
  "storage-degraded": "ping",
  "backfill-failed": "ping",
  "verified-done": "inbox",
};

export const NOTIFICATION_TRIGGER_LABEL: Record<DemoNotificationTrigger, string> = {
  "run-failed": "Run failed",
  "gate-opened": "Gate opened",
  "write-parked": "Write parked",
  "repeated-failure": "Repeating failure",
  "storage-degraded": "Storage",
  "verified-done": "Finished",
  "backfill-failed": "Backfill failed",
};

export type DemoNotificationSeverity = "critical" | "attention" | "info";

export interface DemoNotificationLink {
  /** the Workflow Panel entry to switch to */
  workflow: string;
  /** the row to select once there */
  runId: string;
  label: string;
}

export interface DemoNotification {
  notificationId: string;
  /** repeat deliveries of the same fact collapse onto this key */
  dedupeKey: string;
  trigger: DemoNotificationTrigger;
  severity: DemoNotificationSeverity;
  title: string;
  body: string;
  /** how many times this dedupe key has fired — >1 renders "N more like this" */
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  read: boolean;
  /** actor-keyed from day one, even with one operator (the D75 seam) */
  actor: string;
  link?: DemoNotificationLink;
  /**
   * Whether the OS delivery succeeded. `false` is the load-bearing case: the
   * desktop notification never appeared and the record is STILL here unread.
   */
  desktopDelivered: boolean;
  /** backfill-failed only — the window that could not be reconstructed */
  gap?: { from: string; to: string; code: string; reason: string };
  /**
   * A push that arrives on the demo clock rather than at page load, so the ping
   * delivery itself is observable instead of only its inbox record.
   */
  arrivesAtTick?: number;
}

export function deliveryOf(n: DemoNotification): DemoNotificationDelivery {
  return NOTIFICATION_ROUTING[n.trigger];
}

/**
 * The inbox. One record per trigger class, plus the two that make the model
 * honest: a dedupe count above one, and a delivery that failed at the OS but
 * survived here.
 */
export const DEMO_NOTIFICATIONS: DemoNotification[] = [
  {
    notificationId: "n-park-rosa",
    dedupeKey: "write-parked:separations:10577201",
    trigger: "write-parked",
    severity: "critical",
    title: "Write parked — Rosa Delgado",
    body: "A termination was submitted and the confirmation never came back. Until you resolve it present or absent, nothing may retry this person.",
    count: 1,
    firstSeenAt: at("13:52:10"),
    lastSeenAt: at("13:52:10"),
    read: false,
    actor: DEMO_OPERATOR,
    desktopDelivered: true,
    link: { workflow: "Separations", runId: "sep-rosa", label: "Open the parked run" },
  },
  {
    notificationId: "n-gate-summer",
    dedupeKey: "gate-opened:ocr:Oath_Packet_Summer.pdf",
    trigger: "gate-opened",
    severity: "attention",
    title: "12 people are waiting for your approval",
    body: "Oath_Packet_Summer.pdf finished extracting. Nothing is written until you approve — the packet has been open for a while.",
    count: 1,
    firstSeenAt: at("14:08:12"),
    lastSeenAt: at("14:08:12"),
    read: false,
    actor: DEMO_OPERATOR,
    // The OS delivery FAILED here. The record is what matters; the desktop
    // toast is a convenience. This is why a notification is durable first.
    desktopDelivered: false,
    link: { workflow: "OCR", runId: "ocr-summer", label: "Open the review" },
  },
  {
    notificationId: "n-gate-maria",
    dedupeKey: "gate-opened:separations:10084412",
    trigger: "gate-opened",
    severity: "attention",
    title: "Identity gate — Maria Lopez-Garcia",
    body: "Two UCPath people match this name. The run stopped rather than guess which one to terminate.",
    count: 1,
    firstSeenAt: at("14:14:40"),
    lastSeenAt: at("14:14:40"),
    read: true,
    actor: DEMO_OPERATOR,
    desktopDelivered: true,
    link: { workflow: "Separations", runId: "sep-maria", label: "Open the gate" },
  },
  {
    notificationId: "n-repeat-onbase",
    dedupeKey: "fingerprint:onbase/doc-type-not-enabled",
    trigger: "repeated-failure",
    severity: "critical",
    title: "Same failure, 3rd time — OnBase rejected the document type",
    body: "“I-9 Supporting” is not enabled for queue SDCMP-HR. Three runs have now failed on the identical fingerprint; a fourth retry will fail the same way until the queue is changed.",
    count: 3,
    firstSeenAt: `2026-07-24T14:55:09`,
    lastSeenAt: at("14:26:02"),
    read: false,
    actor: DEMO_OPERATOR,
    desktopDelivered: true,
    link: { workflow: "OnBase", runId: "ob-packet", label: "Open the newest failure" },
    // arrives live, 3 seconds after load — the PING, not just its record
    arrivesAtTick: 3,
  },
  {
    notificationId: "n-storage",
    dedupeKey: "storage:backup-age",
    trigger: "storage-degraded",
    severity: "attention",
    title: "Backup is 31 hours old",
    body: "The last successful tracker backup was Thursday 7:12 AM. Runs keep working; a failure now would lose a day of receipts.",
    count: 2,
    firstSeenAt: `2026-07-24T19:12:00`,
    lastSeenAt: at("06:12:00"),
    read: false,
    actor: DEMO_OPERATOR,
    desktopDelivered: true,
  },
  {
    notificationId: "n-done-digest",
    dedupeKey: "verified-done:digest:2026-07-25",
    trigger: "verified-done",
    severity: "info",
    title: "6 runs finished cleanly today",
    body: "Inbox only — a clean finish never pings. Jordan Whitfield, Marcus Bell, Yara Ito, EC_Form_Ito.pdf, Oath_Packet_Spring.pdf and 1 more.",
    count: 6,
    firstSeenAt: at("11:48:44"),
    lastSeenAt: at("13:31:20"),
    read: true,
    actor: DEMO_OPERATOR,
    desktopDelivered: true,
    link: { workflow: "Onboarding", runId: "onb-jordan", label: "Open the newest" },
  },
  {
    notificationId: "n-backfill",
    dedupeKey: "backfill:2026-07-25T09:04",
    trigger: "backfill-failed",
    severity: "critical",
    title: "Notifications between 9:04 AM and 11:37 AM could not be reconstructed",
    body: "The dashboard was down for 2h 33m. On restart the backfill could not read the notification journal for that window, so we do not know what you missed. This record exists BECAUSE we cannot fill the gap — it is not a claim that nothing happened.",
    count: 1,
    firstSeenAt: at("11:37:41"),
    lastSeenAt: at("11:37:41"),
    read: false,
    actor: DEMO_OPERATOR,
    desktopDelivered: true,
    gap: {
      from: at("09:04:18"),
      to: at("11:37:41"),
      code: "notification-journal-unreadable",
      reason: "journal segment .tracker/notifications/2026-07-25.002.jsonl ended mid-record (truncated write during the crash)",
    },
  },
];

/** the filter chips over the inbox — every one of them is a real field */
export const NOTIFICATION_FILTERS = [
  { key: "all", label: "All" },
  { key: "unread", label: "Unread" },
  { key: "ping", label: "Pings" },
  { key: "inbox", label: "Inbox" },
  { key: "snoozed", label: "Snoozed" },
] as const;

export type NotificationFilterKey = (typeof NOTIFICATION_FILTERS)[number]["key"];

/** how long ago a notification last fired, against the ticking demo clock */
export function notificationAge(n: DemoNotification, tick = 0): string {
  return fmtElapsed(secondsSince(n.lastSeenAt, tick));
}

/** a snooze is an instant, not a boolean — it expires on its own */
export function snoozeUntil(minutes: number, tick = 0): string {
  return plusSeconds(agoSeconds(-tick), minutes * 60);
}

export function isSnoozed(until: string | undefined, tick = 0): boolean {
  if (!until) return false;
  return Date.parse(until) > DEMO_NOW_MS + tick * 1000;
}

export function snoozeRemaining(until: string, tick = 0): string {
  return fmtElapsed(Math.max(0, Math.round((Date.parse(until) - (DEMO_NOW_MS + tick * 1000)) / 1000)));
}

// ===========================================================================
// 2. Search — fail-loud
// ===========================================================================

export interface DemoSearchHit {
  rowId: string;
  title: string;
  subtitle: string;
  workflowLabel: string;
  trace: string;
  day: string;
  status: ReturnType<typeof effectiveStatus>;
  /** WHICH field matched, and what it held — never just "it matched" */
  matchedField: string;
  matchedValue: string;
}

export interface DemoSearchScan {
  rows: number;
  days: number;
}

export type DemoSearchOutcome =
  | { state: "idle" }
  | { state: "results"; query: string; hits: DemoSearchHit[]; scan: DemoSearchScan }
  | { state: "empty"; query: string; scan: DemoSearchScan }
  | { state: "failed"; query: string; code: string; headline: string; detail: string };

/** clickable starters, so every search state is reachable without guessing */
export const SEARCH_EXAMPLES: { label: string; query: string; note: string }[] = [
  { label: "Rosa", query: "Rosa", note: "a person, by name" },
  { label: "10633092", query: "10633092", note: "an EID" },
  { label: "onbase", query: "onbase", note: "a workflow, across days" },
  { label: "TXN-0884019", query: "TXN-0884019", note: "a confirmation number" },
  { label: "zzz", query: "zzz", note: "zero hits — a real answer" },
  { label: "rosa.delgado@ucsd.edu", query: "rosa.delgado@ucsd.edu", note: "an email — the lookup itself fails" },
];

interface SearchField {
  field: string;
  value: string | undefined;
}

function searchableFields(row: DemoRow): SearchField[] {
  return [
    { field: "name", value: row.displayName ?? row.title },
    { field: "EID", value: row.eid },
    { field: "trace id", value: row.trace },
    { field: "workflow", value: row.workflow.label },
    { field: "item id", value: row.itemId },
    { field: "confirmation", value: row.receipt.lines?.find((l) => /transaction|confirmation/i.test(l.label))?.value },
    { field: "data point", value: row.data.find((d) => /^TXN-/.test(d.value))?.value },
  ];
}

/**
 * The mock search service. Two things it deliberately does NOT do:
 *  - it never returns "no matches" when the lookup could not run, and
 *  - it never silently narrows the corpus. `scan` says exactly what was read.
 */
export function searchDemoRows(rawQuery: string): DemoSearchOutcome {
  const query = rawQuery.trim();
  if (query.length === 0) return { state: "idle" };

  // An email resolves through the CRM identity index, not the tracker's own
  // rows. That index is down — so this is a FAILED lookup, and saying "no
  // matches" here would be a lie that reads as "this person has no runs".
  if (query.includes("@")) {
    return {
      state: "failed",
      query,
      code: "identity-index-unavailable",
      headline: "Search failed — the identity index did not answer",
      detail: `“${query}” is an email, which resolves through the CRM identity index before the tracker is searched. That index returned no response (timeout after 8s). This is NOT “no matches”: runs for this person may well exist. Retry, or search by name, EID or trace id instead.`,
    };
  }

  const q = query.toLowerCase();
  const rows = Object.values(ALL_DEMO_ROWS);
  const hits: DemoSearchHit[] = [];
  for (const row of rows) {
    const match = searchableFields(row).find((f) => f.value && f.value.toLowerCase().includes(q));
    if (!match?.value) continue;
    hits.push({
      rowId: row.id,
      title: row.displayName ?? row.title,
      subtitle: row.subtitle,
      workflowLabel: row.workflow.label,
      trace: row.trace,
      day: dayOfRow(row),
      status: effectiveStatus(row),
      matchedField: match.field,
      matchedValue: match.value,
    });
  }
  const scan: DemoSearchScan = { rows: rows.length, days: 3 };
  if (hits.length === 0) return { state: "empty", query, scan };
  // newest day first, then by trace so the order is stable between renders
  hits.sort((a, b) => (a.day === b.day ? a.trace.localeCompare(b.trace) : b.day.localeCompare(a.day)));
  return { state: "results", query, hits: hits.slice(0, 40), scan };
}

// ===========================================================================
// 3. The write fence — what a parked resolution must bind
// ===========================================================================

export interface DemoWriteFence {
  /** the instant the write was fenced (submit posted) */
  fencedAt: string;
  /** the intent generation a resolution must carry — half of the double fence */
  intentGeneration: number;
  /** the subject key a resolution must bind — the other half */
  subjectEid: string;
  subjectName: string;
  /** doc 09 §4: the earliest an absence observation may COUNT */
  minSinceFenceMin: number;
  /** the gap two counted observations must be separated by */
  minBetweenReadsMin: number;
  requiredObservations: number;
  /** what a present-proof must look like, and one real example */
  proofPattern: RegExp;
  proofLabel: string;
  proofExample: string;
  /** the system to look in, named so the operator knows where to go */
  system: string;
  /**
   * The records a person search returns for this subject. The operator picks
   * the one they actually opened — which is how the subject-key half of the
   * fence gets something to check. Near-duplicate people are the normal case
   * in UCPath, not an invented hazard.
   */
  candidates: { eid: string; label: string }[];
}

export function writeFenceFor(row: DemoRow): DemoWriteFence | null {
  if (row.gate?.kind !== "parked") return null;
  return {
    fencedAt: at("13:50:31"),
    intentGeneration: 4,
    subjectEid: row.eid ?? "",
    subjectName: row.displayName ?? row.title,
    minSinceFenceMin: 30,
    minBetweenReadsMin: 10,
    requiredObservations: 2,
    proofPattern: /^TXN-\d{7}$/,
    proofLabel: "UCPath transaction number",
    proofExample: "TXN-0891245",
    system: "UCPath",
    candidates: [
      { eid: row.eid ?? "", label: `${row.displayName ?? row.title} · EID ${row.eid} · SDCMP · the parked subject` },
      { eid: "10577209", label: "Rosa M. Delgado · EID 10577209 · SDHEALTH · same name, different person" },
    ],
  };
}

/** when the first absence observation is allowed to count */
export function fenceClearsAt(fence: DemoWriteFence): string {
  return plusSeconds(fence.fencedAt, fence.minSinceFenceMin * 60);
}

export function fenceCleared(fence: DemoWriteFence, tick = 0): boolean {
  return secondsSince(fence.fencedAt, tick) >= fence.minSinceFenceMin * 60;
}

// ===========================================================================
// 4. The editable checkpoint — generation, allowlist, freshness
// ===========================================================================

export interface DemoCheckpoint {
  runId: string;
  /** the generation the surface the operator is holding was captured at */
  heldGeneration: number;
  /** what the server holds NOW — different means a save comes back `conflict` */
  serverGeneration: number;
  capturedAt: string;
  /** the node that would CONSUME these values decides how old they may be */
  maxAgeMin: number;
  consumingNode: string;
  /** the values the server now holds, for the fields that moved */
  freshValues: Record<string, string>;
  /** why the checkpoint moved — a conflict with no reason is unactionable */
  movedBecause?: string;
  /**
   * Fields an OPERATOR corrected and the server APPLIED, keyed by field label.
   * Kept apart from `freshValues` because they answer different questions: a
   * fresh value is "the source system moved underneath you", a corrected value
   * is "you changed this and it landed". Rendering one as the other would have
   * the surface tell the operator their own correction was somebody else's.
   */
  correctedValues: Record<string, string>;
}

/**
 * One applied correction patch, as the server holds it after a save.
 *
 * `observed` is the machine-read value each correction REPLACED. It is kept for
 * the same reason `RecordCorrectionWire.from` is kept on the review surface: a
 * correction never overwrites what was read, it sits beside it, and the receipt
 * prints both.
 */
export interface DemoAppliedCorrections {
  generation: number;
  values: Record<string, string>;
  observed: Record<string, string>;
  /**
   * A demo INSTANT (`<date>T<hh:mm:ss>`), never a formatted clock — it becomes
   * the checkpoint's `capturedAt`, which `checkpointAge` and `fmtClock` parse
   * and throw on. Handing them a display string takes the surface down.
   */
  savedAt: string;
  savedBy: string;
}

/**
 * The applied-correction store — the demo's stand-in for the checkpoint table.
 *
 * It exists because a save that shows "Checkpoint saved" and changes nothing is
 * success styling on something that did not happen, which is the one thing this
 * product's rules forbid outright. A save now MOVES the world: the field's base
 * value becomes the corrected one, the generation advances, and the surface
 * adopts the generation the server returned rather than guessing the next one.
 */
const APPLIED_CORRECTIONS = new Map<string, DemoAppliedCorrections>();

export function appliedCorrectionsFor(runId: string): DemoAppliedCorrections | undefined {
  return APPLIED_CORRECTIONS.get(runId);
}

/**
 * Apply a patch and return the checkpoint's NEW generation.
 *
 * The generation is the server's to mint — the client adopts what comes back
 * and never re-derives it, because a client that computes `held + 1` is a
 * client that silently disagrees with the server the first time anything else
 * touches the checkpoint.
 */
export function applyCheckpointCorrection(
  row: DemoRow,
  values: Record<string, string>,
  savedAt: string,
  savedBy: string = DEMO_OPERATOR,
): DemoAppliedCorrections {
  const previous = APPLIED_CORRECTIONS.get(row.runId);
  const baseline = checkpointFor(row);
  const observed = { ...(previous?.observed ?? {}) };
  for (const field of Object.keys(values)) {
    if (observed[field] !== undefined) continue;
    const point = row.data.find((d) => d.field === field);
    if (point) observed[field] = point.value;
  }
  const applied: DemoAppliedCorrections = {
    generation: baseline.serverGeneration + 1,
    values: { ...(previous?.values ?? {}), ...values },
    observed,
    savedAt,
    savedBy,
  };
  APPLIED_CORRECTIONS.set(row.runId, applied);
  return applied;
}

/** tests only — the store is module state, so a test that writes must clear */
export function resetAppliedCorrections(): void {
  APPLIED_CORRECTIONS.clear();
}

const CHECKPOINT_MAX_AGE_MIN: Partial<Record<string, number>> = {
  separations: 15,
  onboarding: 20,
  "work-study": 30,
  "emergency-contact": 60,
};

const CONSUMING_NODE: Partial<Record<string, string>> = {
  separations: "UCPath transaction",
  onboarding: "SmartHR transaction",
  "work-study": "Award update",
  "emergency-contact": "Contact form",
};

/**
 * The CAS-stale specimen. `onb-jordan`'s CRM record was corrected AFTER the run
 * finished, so the server's checkpoint moved from generation 4 to 5 while the
 * operator's tab still holds 4. Any save from that tab must be REFUSED and the
 * operator's patch re-offered against the fresh value — never merged blind and
 * never silently dropped.
 */
const STALE_CHECKPOINTS: Record<string, { server: number; fresh: Record<string, string>; because: string }> = {
  "onb-jordan": {
    server: 5,
    fresh: { Wage: "$18.75/hr" },
    because:
      "the CRM record was corrected at 2:19 PM (wage $18.50 → $18.75) and the checkpoint was re-captured from it",
  },
};

export function checkpointFor(row: DemoRow): DemoCheckpoint {
  const maxAgeMin = CHECKPOINT_MAX_AGE_MIN[row.workflow.id] ?? 60;
  const consumingNode = CONSUMING_NODE[row.workflow.id] ?? "the next write";

  // An applied correction SUPERSEDES the stale-checkpoint fixture: the operator
  // has since saved against the server's own generation, so the two are back in
  // agreement and there is no conflict left to re-offer.
  const applied = APPLIED_CORRECTIONS.get(row.runId);
  if (applied) {
    return {
      runId: row.runId,
      heldGeneration: applied.generation,
      serverGeneration: applied.generation,
      capturedAt: applied.savedAt,
      maxAgeMin,
      consumingNode,
      freshValues: {},
      correctedValues: applied.values,
    };
  }

  const stale = STALE_CHECKPOINTS[row.id];
  return {
    runId: row.runId,
    heldGeneration: 4,
    serverGeneration: stale?.server ?? 4,
    capturedAt: row.endedAt ?? row.startedAt ?? row.enqueuedAt,
    maxAgeMin,
    consumingNode,
    freshValues: stale?.fresh ?? {},
    movedBecause: stale?.because,
    correctedValues: {},
  };
}

/**
 * The value the SERVER holds for one field at the generation the surface is on
 * — an operator's applied correction first, then a value the source system
 * moved, then what the run observed.
 *
 * It is a function rather than a lookup because three things can be true about
 * one field and only one of them may be shown as "the value"; the other two are
 * kept beside it (`correctedValues` keeps the observed reading, `freshValues`
 * keeps what the run read before the source moved).
 */
export function checkpointBaseValue(cp: DemoCheckpoint, point: DemoDataPoint, held: number): string {
  const corrected = cp.correctedValues[point.field];
  if (corrected !== undefined) return corrected;
  if (held >= cp.serverGeneration) return cp.freshValues[point.field] ?? point.value;
  return point.value;
}

export function checkpointIsStale(cp: DemoCheckpoint): boolean {
  return cp.serverGeneration !== cp.heldGeneration;
}

// ---- freshness -------------------------------------------------------------

export interface DemoFreshness {
  ageMin: number;
  maxAgeMin: number;
  consumingNode: string;
  /** older than the consuming node accepts — a run from this data needs a call */
  stale: boolean;
}

export function freshnessOf(cp: DemoCheckpoint, tick = 0): DemoFreshness {
  const ageMin = Math.floor(secondsSince(cp.capturedAt, tick) / 60);
  return { ageMin, maxAgeMin: cp.maxAgeMin, consumingNode: cp.consumingNode, stale: ageMin > cp.maxAgeMin };
}

export function checkpointAge(cp: DemoCheckpoint, tick = 0): string {
  return fmtElapsed(secondsSince(cp.capturedAt, tick));
}

// ---- the edit allowlist ----------------------------------------------------

/**
 * `tag` is the one-word WHY that fits in a dense row; `reason` is the sentence
 * behind it. Both are shown — the tag in the row, the sentence in the row's
 * title and in the surface banner — so the explanation never lives only in a
 * tooltip.
 */
export type DemoEditLock = { editable: true } | { editable: false; tag: string; reason: string };

/**
 * Identity, input, idempotency, proof and provenance are STRUCTURALLY
 * read-only — not "disabled for now". Editing any of them would change which
 * person or which transaction a value belongs to, which is the one thing a
 * correction may never do.
 */
const STRUCTURAL_READONLY: { test: RegExp; tag: string; why: string }[] = [
  { test: /transaction number|confirmation/i, tag: "proof", why: "a confirmation number is proof, not a value you may set" },
  { test: /\(input\)/i, tag: "input", why: "the run's input is immutable — start a new run to change it" },
  { test: /\beid\b|employee id/i, tag: "identity", why: "identity is the idempotency key; changing it would file this work on a different person" },
  { test: /profile$/i, tag: "provenance", why: "an external record id is provenance, not an editable field" },
];

/**
 * The ONE place a data point's editability is decided. Rules by run state, then
 * by field class — and both reasons are shown, because a greyed-out box with no
 * explanation is how an operator learns to distrust the screen.
 */
export function editPolicyFor(row: DemoRow, point: DemoDataPoint): DemoEditLock {
  if (point.dir === "write") {
    return {
      editable: false,
      tag: "write",
      reason: "A write is a record of what happened, not a form. It is shown here and never edited.",
    };
  }
  const status = effectiveStatus(row);
  if (status === "running" || status === "queued") {
    return {
      editable: false,
      tag: "in flight",
      reason: "The run still owns this checkpoint — editing while it reads would race the run. Cancel it, or wait for it to stop.",
    };
  }
  if (status === "parked") {
    return {
      editable: false,
      tag: "parked",
      reason: "This run has a write whose outcome is unknown. Nothing may be edited until you resolve the park present or absent.",
    };
  }
  if (row.records) {
    return {
      editable: false,
      tag: "review only",
      reason: "Extracted values change on the Review tab, with the scanned page beside them — never here.",
    };
  }
  const structural = STRUCTURAL_READONLY.find((r) => r.test.test(point.field));
  if (structural) return { editable: false, tag: structural.tag, reason: `Structurally read-only — ${structural.why}.` };
  return { editable: true };
}

/**
 * WHY the ledger cannot be typed into right now — or an empty string when it
 * can be, which is most of the time.
 *
 * The default case used to return *"Writes are shown here, never edited — they
 * are a record of what happened."* That is a rule of the product, true of every
 * run in it, printed under every ledger: it taught nobody anything they could
 * not read off the rows (a locked value draws with a lock and no box) and it
 * put a sentence of prose on a 348px surface that is short of room. It lives in
 * the section's ⓘ now.
 *
 * What survives is only what a field's SHAPE cannot say: that this run's own
 * state is what is holding the values, and therefore that the lock will lift.
 * An empty string means there is nothing to say, and the caller renders nothing.
 */
export function editPolicySummary(row: DemoRow): string {
  const status = effectiveStatus(row);
  if (status === "running" || status === "queued") return "Locked while the run owns the checkpoint";
  if (status === "parked") return "Locked until the parked write is resolved";
  if (row.records) return "Edits happen on the Review tab, beside the page";
  return "";
}

