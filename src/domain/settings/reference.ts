/**
 * Read-only SYSTEM REFERENCE content for the dashboard Settings page — the
 * "what exists in the system" panels (row archetypes, queue-row kinds, trace-id
 * format, OCR forms/steps, browser-health verdicts, daemon states, …).
 *
 * This module is the single home for that reference content. It is **client-safe**
 * (pure TypeScript + plain data; no `node:*`, no Playwright) so the Settings page
 * can render it directly. Crucially, the descriptors are keyed by the REAL domain
 * union types (`Record<RowArchetype, …>`, `Record<QueueRowKind, …>`, …), so
 * adding a new enum member anywhere fails to type-check here until it is
 * documented — the reference can't silently drift from the code it describes.
 *
 * The one server-only enumeration (the workflow registry — codes/labels/steps)
 * is NOT here; the Settings page reads it live from `/api/workflow-definitions`
 * via `useWorkflows()`. OCR form specs are described statically below (their
 * server registry pulls in providers, so it can't cross into the client bundle).
 */

import { archetypeRowTypeLabel, type RowArchetype, type WorkflowArchetype } from "../row-archetype.js";
import type { InputSubject, QueueRowKind } from "../queue-row-kind.js";
import { LOGIN_URL_PATTERNS, type BrowserHealthKind } from "../browser-health.js";
import { OCR_LIVE_STEPS, OCR_RETIRED_STEP_FOLD } from "../ocr-steps.js";
import { IDLE_REFRESH_SYSTEMS } from "../idle-refresh.js";

/** A generic reference row: a value/term, its display label, and what it means. */
export interface ReferenceItem {
  /** The literal value or term (rendered mono). */
  value: string;
  /** Short human label. */
  label: string;
  /** One-line explanation of what it is / when it applies. */
  description: string;
  /** Optional secondary chip (e.g. the kind a subject funnels onto). */
  tag?: string;
}

// ── Row archetypes (shape) ─────────────────────────────────────────────────────

/** Stamped on every tracker row as `data.archetype` — the canonical shape axis. */
const ROW_ARCHETYPE_DESCRIPTIONS: Record<RowArchetype, string> = {
  single: "One person/subject, one row. Flat in the queue.",
  preview: "One review/approval row with a preview surface (OCR prep).",
  operation:
    "Top-level coordinator for an input-run parent or an OCR-backed target workflow. Holds OCR status before approval; summarizes fanned-out children after.",
  "operation-member":
    "A peer person/subject row fanned out under an operation coordinator (nests inside the coordinator card).",
};

export const ROW_ARCHETYPES: ReferenceItem[] = (
  Object.keys(ROW_ARCHETYPE_DESCRIPTIONS) as RowArchetype[]
).map((value) => ({
  value,
  label: archetypeRowTypeLabel(value),
  description: ROW_ARCHETYPE_DESCRIPTIONS[value],
}));

/** Declared on every `defineWorkflow` — the kernel derives the row archetype from this + `parentRunId`. */
const WORKFLOW_ARCHETYPE_DESCRIPTIONS: Record<WorkflowArchetype, string> = {
  single: "Emits one person/subject row per input item.",
  preview: "Emits one preview/approval row (OCR).",
  operation: "Emits an operation coordinator row (input-run parent or OCR-backed coordinator).",
};

export const WORKFLOW_ARCHETYPES: ReferenceItem[] = (
  Object.keys(WORKFLOW_ARCHETYPE_DESCRIPTIONS) as WorkflowArchetype[]
).map((value) => ({
  value,
  label: archetypeRowTypeLabel(value as RowArchetype),
  description: WORKFLOW_ARCHETYPE_DESCRIPTIONS[value],
}));

/** Legacy JSONL archetype stamps still normalized on read. */
export const LEGACY_ARCHETYPE_ALIASES: ReferenceItem[] = [
  { value: "batch", label: "→ operation", description: "Old multi-subject coordinator stamp; normalized to `operation` on read." },
  { value: "batch-member", label: "→ operation-member", description: "Old fanned-out member stamp; normalized to `operation-member` on read." },
];

// ── Queue-row kind (title/subtitle axis) ───────────────────────────────────────

/** `data.queueRowKind` — drives ONLY the row title + subtitle (orthogonal to shape + scope). */
const QUEUE_ROW_KIND_DESCRIPTIONS: Record<QueueRowKind, string> = {
  person: "One human subject. Title: resolved name (pending: typed input). Subtitle: EID, else trace id.",
  file: "One uploaded document. Title: PDF filename. Subtitle: trace id.",
  catalog: "One named registry entry (roster/report/spec). Title: spec label. Subtitle: trace id.",
};

export const QUEUE_ROW_KINDS: ReferenceItem[] = (
  Object.keys(QUEUE_ROW_KIND_DESCRIPTIONS) as QueueRowKind[]
).map((value) => ({ value, label: value, description: QUEUE_ROW_KIND_DESCRIPTIONS[value] }));

/** `inputSubject` declared on each workflow; the kernel derives `queueRowKind` from it. */
const INPUT_SUBJECT_MAP: Record<InputSubject, { kind: QueueRowKind; description: string }> = {
  name: { kind: "person", description: "A person identified by name (emergency-contact, person-lookup name search)." },
  eid: { kind: "person", description: "A person identified by employee id (work-study, oath-signature, person-lookup EID)." },
  email: { kind: "person", description: "A person identified by email (onboarding, crm-doc-download)." },
  kualiId: { kind: "person", description: "A person identified by a Kuali document id (separations input)." },
  pdf: { kind: "file", description: "An uploaded document (ocr, oath-upload, oath-signature PDF)." },
  selector: { kind: "catalog", description: "A catalog/registry selection with no person/file id (sharepoint-download)." },
};

export const INPUT_SUBJECTS: ReferenceItem[] = (
  Object.keys(INPUT_SUBJECT_MAP) as InputSubject[]
).map((value) => ({
  value,
  label: value,
  description: INPUT_SUBJECT_MAP[value].description,
  tag: `→ ${INPUT_SUBJECT_MAP[value].kind}`,
}));

// ── Queue-row status (the 4th, optional axis) ──────────────────────────────────

/** Universal tracker statuses + the workflow-specific derived statuses + the cancelled override. */
export const QUEUE_STATUSES: ReferenceItem[] = [
  { value: "pending", label: "Pending", description: "Queued, not yet claimed by a worker." },
  { value: "running", label: "Running", description: "In flight — handler active or parked on an approval/signal." },
  { value: "done", label: "Done", description: "Completed successfully." },
  { value: "failed", label: "Failed", description: "Terminal error (red). Retryable." },
  { value: "skipped", label: "Skipped", description: "Not run — a pre-flight gate or preset skipped it." },
  { value: "cancelled", label: "Cancelled", description: "`failed` + `step: cancelled` — a deliberate operator cancel (orange), not a failure.", tag: "override" },
  { value: "needsReview", label: "Needs review", description: "Delegated OCR awaiting operator approval (derived; ocr).", tag: "derived" },
  { value: "notFound", label: "Not found", description: "Person Lookup: UCPath had no matching row (derived; status still done).", tag: "derived" },
  { value: "awaitingApproval", label: "Awaiting approval", description: "Separations: identity-check resolved a different EID; paused for operator (derived).", tag: "derived" },
  { value: "dismissed", label: "Dismissed", description: "Separations: operator reviewed an awaiting-approval row and declined to re-queue (derived).", tag: "derived" },
];

// ── Trace id ───────────────────────────────────────────────────────────────────

export const TRACE_ID_FORMAT = "<code>-<HHMMSS>-<runId4>";
export const TRACE_ID_PARTS: ReferenceItem[] = [
  { value: "<code>", label: "Workflow code", description: "The workflow's 2-char `defineWorkflow` code (e.g. ou, os, ec, pl, oc, sp). The root run's code for delegated children." },
  { value: "<HHMMSS>", label: "Time of day", description: "Local time-of-day of the run start (date omitted — tracker files are date-partitioned)." },
  { value: "<runId4>", label: "Run id (4)", description: "First 4 chars of the run UUID — log-greppable per row. Operation children share the <code>-<HHMMSS> prefix." },
];

// ── OCR form specs ─────────────────────────────────────────────────────────────

/** The registered OCR form types (server `forms/registry.ts`) and their approve fan-out. */
export const OCR_FORM_SPECS: ReferenceItem[] = [
  { value: "oath", label: "Oath", description: "Paper oath roster. Approve fans out one oath-signature signer per record; one oath-upload ticket per document." },
  { value: "emergency-contact", label: "Emergency contact", description: "Paper EC form. Approve fans out one emergency-contact daemon row per person." },
  { value: "onbase-emergency-contact", label: "OnBase EC", description: "OnBase-branded EC form. Approve fans out one per-person OnBase import." },
  { value: "verify", label: "Verify", description: "Read-only completeness report for a mixed oath+EC PDF. No approve flow — enrichment via person-lookup + i9-lookup." },
];

// ── OCR steps ──────────────────────────────────────────────────────────────────

const OCR_STEP_DESCRIPTIONS: Record<string, string> = {
  "loading-roster": "Load / download the roster (if a fresh copy is needed).",
  ocr: "LLM extraction + per-form record matching (folds in matching/disambiguating).",
  "person-lookup": "Name/EID enrichment + active-status lookup.",
  "awaiting-approval": "Delegated OCR parked for operator review (a standalone run completes at person-lookup).",
};

export const OCR_STEPS_LIVE: ReferenceItem[] = OCR_LIVE_STEPS.map((value) => ({
  value,
  label: value,
  description: OCR_STEP_DESCRIPTIONS[value] ?? "",
}));

export const OCR_STEPS_RETIRED: ReferenceItem[] = Object.entries(OCR_RETIRED_STEP_FOLD).map(
  ([value, fold]) => ({
    value,
    label: `→ ${fold}`,
    description: `Legacy sub-phase; folded onto the \`${fold}\` step for display.`,
  }),
);

// ── Browser health verdicts ────────────────────────────────────────────────────

const BROWSER_HEALTH_MAP: Record<BrowserHealthKind, { recovery: string; description: string }> = {
  ok: { recovery: "—", description: "Usable; nothing to do." },
  soft: { recovery: "Refresh", description: "Transient navigation/render fault (chrome-error page). A page reload usually clears it." },
  wedged: { recovery: "Reopen", description: "Broken page but the server session is still valid (dead iframe context / stalled about:blank). A fresh tab fixes it — no Duo." },
  expired: { recovery: "Re-auth", description: "Page sits on an SSO/login host — the session is gone. Surfaced for full re-auth; never auto-fixed." },
  closed: { recovery: "Reopen", description: "The page object is closed but the browser is alive. A new tab recovers it." },
  dead: { recovery: "—", description: "No browser slot at all (worker teardown / never launched)." },
};

export const BROWSER_HEALTH_VERDICTS: ReferenceItem[] = (
  Object.keys(BROWSER_HEALTH_MAP) as BrowserHealthKind[]
).map((value) => ({
  value,
  label: value,
  description: BROWSER_HEALTH_MAP[value].description,
  tag: BROWSER_HEALTH_MAP[value].recovery,
}));

/** URL fragments that mark a page as "on an SSO/login surface" (session expired). */
export const LOGIN_URL_FRAGMENTS: readonly string[] = LOGIN_URL_PATTERNS;

// ── Daemon states & phases ─────────────────────────────────────────────────────

export const DAEMON_PHASES: ReferenceItem[] = [
  { value: "authenticating", label: "Authenticating", description: "Alive but pre-claim-loop — logging in (Duo, browser launch)." },
  { value: "idle", label: "Idle", description: "Claim loop parked, waiting for queued work." },
  { value: "keepalive", label: "Keepalive", description: "Running periodic health checks on a long-lived session." },
];

export const DAEMON_HEALTH_BUCKETS: ReferenceItem[] = [
  { value: "running", label: "Running", description: "A daemon with an item in flight." },
  { value: "idle", label: "Idle", description: "Alive, claim loop parked (daemonPhase idle/keepalive)." },
  { value: "authenticating", label: "Authenticating", description: "Alive but has not yet emitted a daemon_phase (still in the auth chain)." },
  { value: "failed", label: "Failed", description: "Crashed on launch or ended failed." },
];

// ── Idle-refresh systems ───────────────────────────────────────────────────────

/** Systems opted into periodic idle page reloads (server-side session timeouts). */
export const IDLE_REFRESH_SYSTEM_IDS: readonly string[] = Object.keys(IDLE_REFRESH_SYSTEMS);

// ── Keyboard shortcuts ─────────────────────────────────────────────────────────

/** A dashboard keyboard shortcut: one or more key tokens and what it does. */
export interface KeyboardShortcut {
  keys: string[];
  description: string;
}

/** Ordered reference of every dashboard keyboard shortcut (App + QueuePanel). */
export const KEYBOARD_SHORTCUTS: KeyboardShortcut[] = [
  { keys: ["↑", "↓"], description: "Move selection between queue rows" },
  { keys: ["Ctrl", "Shift", "R"], description: "Retry the selected row" },
  { keys: ["x"], description: "Cancel the selected row" },
  { keys: ["/"], description: "Focus the search bar" },
  { keys: ["[", "]"], description: "Previous / next workflow" },
  { keys: ["g", "t"], description: "Go to today" },
  { keys: ["?"], description: "Toggle the shortcuts guide" },
  { keys: ["Esc"], description: "Close dialogs / deselect" },
  { keys: ["⌘/Ctrl", "J"], description: "Toggle the session drawer" },
];
