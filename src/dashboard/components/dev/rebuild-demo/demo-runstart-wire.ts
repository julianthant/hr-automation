/**
 * DEV-ONLY — the WIRE CONTRACT for the run-START half of the product.
 *
 * The demo could show every state a run reaches and no way to create one. This
 * file is the missing half of `demo-wire.ts`: the **Enqueue** command family
 * (`docs/rebuild/reviews/demo-feature-plan-2026-07-25.md` §1.3 — "typed
 * input-run / upload-run starts; policies `reject-active` | `supersede-active` |
 * `allow-parallel`; instance prod/test request; dry-run flag") plus the two
 * descriptor surfaces a run is started FROM (`surfaces.uploadRun`,
 * `surfaces.inputRun`, doc 02 §1.1).
 *
 * Three rules, the same three that keep `demo-wire.ts` honest:
 *
 *  1. **The plan is SERVER-derived, not client-guessed.** `deriveEnqueuePlan`
 *     is the mock server answering "what will this create?" from the target
 *     descriptor's own shape. The Run Modal renders that answer; it never
 *     branches on a workflow id to decide what a packet looks like. That is
 *     what makes ratified decision **D6** mechanical rather than decorative:
 *     `oath-upload` declares `coordinator: "single-run"` + `linkedPanel`, so it
 *     structurally CANNOT be drawn as a member fan-out.
 *  2. **Enqueue is a command, so it has three outcomes.** `submitDemoEnqueue`
 *     returns the same `applied | conflict | rejected` union every other
 *     command returns (the type is imported from `demo-commands.ts` — there is
 *     one union in the demo, not two). A start button that can only succeed
 *     teaches the operator that starting works.
 *  3. **Nothing is previewed that a real backend could not serve.** A trace id
 *     is stamped at enqueue, so the plan says "assigned at enqueue" rather than
 *     inventing one.
 */

import type { ProposedStatus } from "./demo-status";
import type { DemoCommandResultState } from "./demo-commands";
import {
  DEMO_OPERATOR,
  DEMO_WORKFLOWS,
  agoSeconds,
  fmtClockSec,
  type DemoWorkflowId,
  type DemoWorkflowRef,
  type SystemKey,
} from "./demo-wire";

// ---------------------------------------------------------------------------
// Instance resolution — prod vs test, per system (doc 11 §4)
// ---------------------------------------------------------------------------

export type SystemInstance = "prod" | "test";

export type InstanceChoice = Partial<Record<SystemKey, SystemInstance>>;

export const SYSTEM_LABEL: Record<SystemKey, string> = {
  kuali: "Kuali",
  ucpath: "UCPath",
  kronos: "Kronos",
  crm: "CRM",
  servicenow: "ServiceNow",
  onbase: "OnBase",
  i9: "I-9",
};

/**
 * What a system's URL resolves to today. A system with no test instance
 * configured cannot be pointed at one — the Settings "System URLs" section is
 * the only place that changes, so the selector says so instead of offering a
 * choice that would silently fall back to production.
 */
export const SYSTEM_HAS_TEST: Record<SystemKey, boolean> = {
  kuali: true,
  ucpath: true,
  kronos: false,
  crm: true,
  servicenow: true,
  onbase: false,
  i9: false,
};

/** every system the target drives, resolved — a system left unset is `prod` */
export function resolveInstances(workflow: DemoWorkflowRef, choice: InstanceChoice): Record<string, SystemInstance> {
  const out: Record<string, SystemInstance> = {};
  for (const system of workflow.systems) {
    out[system] = SYSTEM_HAS_TEST[system] ? (choice[system] ?? "prod") : "prod";
  }
  return out;
}

export function testSystems(workflow: DemoWorkflowRef, choice: InstanceChoice): SystemKey[] {
  return workflow.systems.filter((s) => SYSTEM_HAS_TEST[s] && choice[s] === "test");
}

// ---------------------------------------------------------------------------
// `surfaces.uploadRun` — what a file-backed start offers (doc 02 §1.1)
// ---------------------------------------------------------------------------

export type UploadAccepts = "pdf" | "spreadsheet";

/**
 * `coordinator` is the whole of ratified decision D6, expressed as a served
 * field instead of a UI branch:
 *
 *  - `packet-group`  one Group Row (the packet) + a DELEGATED OCR Review Run
 *                    (`linked`, keeps its own row in the OCR panel per D4).
 *                    Members exist only after approval.
 *  - `single-run`    ONE Run Row that does the filing itself. Its children are
 *                    `linked` runs in ANOTHER panel — never members, never
 *                    nested, never delisted from their own panel (D6).
 *  - `review-only`   a standalone OCR Review Run. Approval ≡ delegation, so a
 *                    standalone run has no approve target and no fan-out.
 */
export type CoordinatorShape = "packet-group" | "single-run" | "review-only";

export interface UploadRunSpec {
  workflow: DemoWorkflowId;
  accepts: UploadAccepts[];
  coordinator: CoordinatorShape;
  /** the noun the operator uses for the thing being uploaded */
  documentNoun: string;
  /** `single-run` only — the panel its `linked` children live in */
  linkedPanel?: DemoWorkflowId;
  /** `single-run` only — what those linked children are called */
  linkedNoun?: string;
  /** the one line explaining what this target does with the document */
  note: string;
}

export const UPLOAD_RUN_SPECS: UploadRunSpec[] = [
  {
    workflow: "oath-signature",
    accepts: ["pdf"],
    coordinator: "packet-group",
    documentNoun: "oath packet",
    note: "Reads every signer off the packet, then signs each oath in UCPath. No ServiceNow ticket — signing only.",
  },
  {
    workflow: "emergency-contact",
    accepts: ["pdf"],
    coordinator: "packet-group",
    documentNoun: "contact form packet",
    note: "Reads each employee's emergency contact off the form, then fills it in UCPath.",
  },
  {
    workflow: "onbase",
    accepts: ["pdf"],
    coordinator: "packet-group",
    documentNoun: "document packet",
    note: "Reads each person off the packet, then files the document under their record in OnBase.",
  },
  {
    workflow: "i9-check",
    accepts: ["pdf"],
    coordinator: "packet-group",
    documentNoun: "I-9 roster scan",
    note: "Reads each person off the scan, searches UCPath for them, and appends the retention tracker. The review completes itself — there is nothing to approve.",
  },
  {
    workflow: "oath-upload",
    accepts: ["pdf"],
    coordinator: "single-run",
    documentNoun: "signed oath document",
    linkedPanel: "oath-signature",
    linkedNoun: "signers",
    note: "One row for the document: OCR prep → your approval → wait for the signers → file the ServiceNow ticket.",
  },
  {
    workflow: "ocr",
    accepts: ["pdf"],
    coordinator: "review-only",
    documentNoun: "document",
    note: "Reads the document and stops. Nothing is approved and nothing runs afterwards — a standalone review has no target workflow.",
  },
];

export const UPLOAD_RUN_BY_WORKFLOW = new Map(UPLOAD_RUN_SPECS.map((s) => [s.workflow, s]));

// ---------------------------------------------------------------------------
// `surfaces.inputRun` — what a typed start offers (doc 02 §1.1)
// ---------------------------------------------------------------------------

export type InputSubject = "eid" | "name" | "email";

export interface InputRunSpec {
  workflow: DemoWorkflowId;
  subject: InputSubject;
  placeholder: string;
  /** how the server describes its own parser — the client never invents one */
  parserLabel: string;
  supportsDryRun: boolean;
  /** an empty typed run opens the upload modal instead of erroring */
  emptyOpensUpload: boolean;
  presets: { key: string; label: string; values: string[]; note: string }[];
}

export const INPUT_RUN_SPECS: InputRunSpec[] = [
  {
    workflow: "separations",
    subject: "eid",
    placeholder: "10084412",
    parserLabel: "One UCPath EID per line — 10 followed by 6 digits",
    supportsDryRun: true,
    emptyOpensUpload: false,
    presets: [
      { key: "five", label: "Five separations", values: ["10084412", "10091755", "10077300", "10102846", "10066519"], note: "the S5 group — five typed EIDs under one Group Row" },
      { key: "bad", label: "With a bad EID", values: ["10084412", "10-4567", "10091755"], note: "entry validation refuses the line before anything is enqueued" },
      { key: "dupe", label: "Already running", values: ["10084412", "10055501"], note: "10055501 already has an active separations run — the server rejects it" },
    ],
  },
  {
    workflow: "person-lookup",
    subject: "email",
    placeholder: "mdelgado@ucsd.edu",
    parserLabel: "One campus email per line",
    supportsDryRun: false,
    emptyOpensUpload: true,
    presets: [{ key: "two", label: "Two lookups", values: ["mdelgado@ucsd.edu", "rtorres@ucsd.edu"], note: "a two-member group" }],
  },
  {
    workflow: "work-study",
    subject: "eid",
    placeholder: "10084412",
    parserLabel: "One UCPath EID per line — 10 followed by 6 digits",
    supportsDryRun: true,
    emptyOpensUpload: true,
    presets: [{ key: "one", label: "A single person", values: ["10084412"], note: "N = 1 mints a Run Row, not a group" }],
  },
  {
    workflow: "kronos-pay-rule",
    subject: "eid",
    placeholder: "10084412",
    parserLabel: "One UCPath EID per line — 10 followed by 6 digits",
    supportsDryRun: true,
    emptyOpensUpload: false,
    presets: [{ key: "three", label: "Three pay rules", values: ["10084412", "10091755", "10077300"], note: "a three-member group" }],
  },
  {
    workflow: "onboarding",
    subject: "name",
    placeholder: "Maria Delgado",
    parserLabel: "One full name per line — first and last",
    supportsDryRun: true,
    emptyOpensUpload: true,
    presets: [{ key: "two", label: "Two hires", values: ["Maria Delgado", "Rosa Iglesias"], note: "titles stay as typed until CRM resolves them" }],
  },
];

export const INPUT_RUN_BY_WORKFLOW = new Map(INPUT_RUN_SPECS.map((s) => [s.workflow, s]));

// ---------------------------------------------------------------------------
// Entry validation — LOUD, per line, before anything is enqueued
// ---------------------------------------------------------------------------

export type EntryProblem =
  | { code: "not-an-eid"; message: string }
  | { code: "not-an-email"; message: string }
  | { code: "not-a-name"; message: string }
  | { code: "duplicate-entry"; message: string };

export interface ParsedEntry {
  /** 1-based line number in the typed box — a message always names the line */
  line: number;
  raw: string;
  problem?: EntryProblem;
  /** the value as the parser normalized it (trimmed, EID stripped of spaces) */
  value: string;
}

const EID_RE = /^10\d{6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/**
 * Parse the typed box. Every line is either a valid entry or a NAMED problem —
 * a line is never silently dropped, never trimmed into validity, never
 * "best-effort" coerced. Blank lines are not entries at all (the operator's
 * trailing newline is not a rejection).
 */
export function parseEntries(text: string, subject: InputSubject): ParsedEntry[] {
  const seen = new Set<string>();
  const out: ParsedEntry[] = [];
  text.split("\n").forEach((rawLine, index) => {
    const raw = rawLine.trim();
    if (raw === "") return;
    const line = index + 1;
    const value = subject === "eid" ? raw.replace(/\s+/g, "") : raw;
    const key = value.toLowerCase();

    if (seen.has(key)) {
      out.push({ line, raw, value, problem: { code: "duplicate-entry", message: `“${raw}” is already on this list — one run per person.` } });
      return;
    }
    seen.add(key);

    if (subject === "eid" && !EID_RE.test(value)) {
      out.push({
        line,
        raw,
        value,
        problem: { code: "not-an-eid", message: `“${raw}” is not a UCPath EID (must be 10xxxxxx — 10 followed by 6 digits).` },
      });
      return;
    }
    if (subject === "email" && !EMAIL_RE.test(value)) {
      out.push({ line, raw, value, problem: { code: "not-an-email", message: `“${raw}” is not a campus email address.` } });
      return;
    }
    if (subject === "name" && value.split(/\s+/).length < 2) {
      out.push({ line, raw, value, problem: { code: "not-a-name", message: `“${raw}” is not a full name — first and last are both required.` } });
      return;
    }
    out.push({ line, raw, value });
  });
  return out;
}

/**
 * The resolved display name for a subject the backend already knows. This is a
 * MOCK of the roster/CRM resolution the real backend performs after the run
 * starts — it exists so the demo can show the pending→resolved title phase.
 * A subject that is not here stays in its pending phase, which is the honest
 * outcome for a person nobody has looked up yet.
 */
export const RESOLVED_SUBJECTS: Record<string, { name: string; eid: string }> = {
  "10084412": { name: "Maria Delgado", eid: "10084412" },
  "10091755": { name: "Rosa Iglesias", eid: "10091755" },
  "10077300": { name: "Daniel Okafor", eid: "10077300" },
  "10102846": { name: "Priya Raman", eid: "10102846" },
  "10055501": { name: "Tomás Rivera", eid: "10055501" },
  "mdelgado@ucsd.edu": { name: "Maria Delgado", eid: "10084412" },
  "rtorres@ucsd.edu": { name: "Rita Torres", eid: "10068220" },
};

// ---------------------------------------------------------------------------
// The file corpus a start can pick from
// ---------------------------------------------------------------------------

export interface UploadFileFixture {
  id: string;
  fileName: string;
  kind: UploadAccepts;
  sizeLabel: string;
  /** the ONE thing a parser knows before reading: how many pages. Never people. */
  pageCount: number;
  /** the server already has a live run for this document */
  activeRun?: { workflow: DemoWorkflowId; note: string };
  /** spreadsheets are not started here — they go through the intake pipeline */
  intakeSheetId?: string;
}

export const UPLOAD_FILES: UploadFileFixture[] = [
  { id: "oath-summer", fileName: "Oath_Packet_Summer.pdf", kind: "pdf", sizeLabel: "1.9 MB", pageCount: 12 },
  {
    id: "oath-spring",
    fileName: "Oath_Packet_Spring.pdf",
    kind: "pdf",
    sizeLabel: "1.8 MB",
    pageCount: 12,
    activeRun: { workflow: "oath-signature", note: "an Oath Signature packet for this file is running now" },
  },
  { id: "ec-jul", fileName: "EC_Forms_Jul25.pdf", kind: "pdf", sizeLabel: "740 KB", pageCount: 6 },
  { id: "signed-oath", fileName: "Signed_Oath_Delgado.pdf", kind: "pdf", sizeLabel: "212 KB", pageCount: 1 },
  { id: "i9-scan", fileName: "I9_Retention_Scan.pdf", kind: "pdf", sizeLabel: "3.1 MB", pageCount: 9 },
  {
    id: "ws-sheet",
    fileName: "work-study-week-30.xlsx",
    kind: "spreadsheet",
    sizeLabel: "18 KB",
    pageCount: 1,
    intakeSheetId: "ws-week-30",
  },
];

// ---------------------------------------------------------------------------
// The plan — what this start WILL create, before anything is committed
// ---------------------------------------------------------------------------

export type PlanRole = "group" | "run" | "review" | "member" | "linked";

export interface EnqueuePlanRow {
  key: string;
  role: PlanRole;
  rowType: "run" | "group" | "member";
  containment?: "member" | "linked" | "rejected";
  title: string;
  /** the "EID if present, else the trace id" rule — pre-enqueue there is no id */
  subtitle: string;
  /** the Workflow Panel entry this row will live in */
  panel: string;
  bornAs: ProposedStatus | "not yet created";
  note?: string;
}

export interface EnqueuePlan {
  headline: string;
  rows: EnqueuePlanRow[];
  /** the ratified decisions this shape obeys, in the operator's own words */
  decisions: string[];
  warnings: string[];
}

const TRACE_PENDING = "trace id assigned at enqueue";

/**
 * The mock server's answer to "what will this create?", derived from the target
 * descriptor's `coordinator` shape. The Run Modal renders this and nothing
 * else, so the preview cannot drift from what enqueue actually does.
 */
export function deriveUploadPlan(spec: UploadRunSpec, fileName: string, pageCount: number): EnqueuePlan {
  const workflow = DEMO_WORKFLOWS[spec.workflow];
  const ocr = DEMO_WORKFLOWS.ocr;
  const pages = `${pageCount} page${pageCount === 1 ? "" : "s"}`;

  if (spec.coordinator === "review-only") {
    return {
      headline: "1 Review Run Row",
      rows: [
        {
          key: "review",
          role: "review",
          rowType: "run",
          title: fileName,
          subtitle: TRACE_PENDING,
          panel: ocr.label,
          bornAs: "queued",
          note: "Reads the document and stops at a read-only review.",
        },
      ],
      decisions: ["A standalone review has no approve flow — approval is delegation, and nothing delegated this run."],
      warnings: [],
    };
  }

  if (spec.coordinator === "single-run") {
    const linkedPanel = spec.linkedPanel ? DEMO_WORKFLOWS[spec.linkedPanel].label : workflow.label;
    return {
      headline: `1 Run Row · ${pages}`,
      rows: [
        {
          key: "run",
          role: "run",
          rowType: "run",
          title: fileName,
          subtitle: TRACE_PENDING,
          panel: workflow.label,
          bornAs: "queued",
          note: "One row walks the whole document: OCR prep → your approval → wait for signatures → file the ticket.",
        },
        {
          key: "linked",
          role: "linked",
          rowType: "run",
          containment: "linked",
          title: spec.linkedNoun ?? "linked children",
          subtitle: "each keeps its own row and its own trace id",
          panel: linkedPanel,
          bornAs: "not yet created",
          note: `Created at approval, in the ${linkedPanel} panel — how many depends on what the review reads off the document. The row above shows a chip that jumps there; it never nests them and never counts them as members.`,
        },
      ],
      decisions: [
        "D6 — Oath Upload stays ONE Run Row. Its signers are `linked`, not members: they live in the Oath Signature panel, are never nested under this row, and are never removed from their own panel.",
      ],
      warnings: [],
    };
  }

  return {
    headline: `1 Group Row · ${pages}`,
    rows: [
      {
        key: "group",
        role: "group",
        rowType: "group",
        title: fileName,
        subtitle: TRACE_PENDING,
        panel: workflow.label,
        bornAs: "running",
        note: "The packet. Its count badge stays empty until the review reads the document — then it shows “N people extracted”, and flips to “N people” when the members are fanned out. Nobody knows N before the pages are read.",
      },
      {
        key: "review",
        role: "review",
        rowType: "run",
        containment: "linked",
        title: `Review — ${fileName}`,
        subtitle: TRACE_PENDING,
        panel: ocr.label,
        bornAs: "queued",
        note: "The delegated review keeps its OWN row in the OCR panel; the packet carries a link to it, never a copy.",
      },
      {
        key: "members",
        role: "member",
        rowType: "member",
        containment: "member",
        title: "member rows",
        subtitle: "one per approved person",
        panel: workflow.label,
        bornAs: "not yet created",
        note:
          spec.workflow === "i9-check"
            ? "Created when the review completes — an I-9 check has nothing to approve, so the review finishes itself and fans out."
            : "Created when you approve the review. Nothing is fanned out before then.",
      },
    ],
    decisions: [
      "A PDF upload is always a Group Row, even for one person (D2/D14) — a group of one that looked like a Run Row would make the next fan-out look like a new object.",
      "The delegated review keeps its own Run Row in the OCR panel (D4); the packet links to it rather than duplicating it.",
    ],
    warnings: [],
  };
}

export function deriveInputPlan(spec: InputRunSpec, entries: ParsedEntry[]): EnqueuePlan {
  const workflow = DEMO_WORKFLOWS[spec.workflow];
  const valid = entries.filter((e) => !e.problem);
  const rows: EnqueuePlanRow[] = [];

  if (valid.length > 1) {
    rows.push({
      key: "group",
      role: "group",
      rowType: "group",
      title: `${valid.length} ${workflow.label.toLowerCase()} runs`,
      subtitle: TRACE_PENDING,
      panel: workflow.label,
      bornAs: "queued",
      note: "A typed list of more than one mints a Group Row; the anchor carries the count, not a title.",
    });
  }

  for (const entry of valid) {
    const resolved = RESOLVED_SUBJECTS[entry.value.toLowerCase()] ?? RESOLVED_SUBJECTS[entry.value];
    rows.push({
      key: `entry-${entry.line}`,
      role: valid.length > 1 ? "member" : "run",
      rowType: valid.length > 1 ? "member" : "run",
      containment: valid.length > 1 ? "member" : undefined,
      title: entry.value,
      subtitle: spec.subject === "eid" ? `EID ${entry.value}` : TRACE_PENDING,
      panel: workflow.label,
      bornAs: "queued",
      note: resolved ? `Resolves to ${resolved.name}` : "Nobody has looked this person up yet — the title stays as typed.",
    });
  }

  return {
    headline: valid.length > 1 ? `1 Group Row · ${valid.length} members` : valid.length === 1 ? "1 Run Row" : "Nothing — no valid entry",
    rows,
    decisions:
      valid.length > 1
        ? ["More than one typed value mints a Group Row (S5); each value becomes a Member Row under it."]
        : ["A single typed value mints a Run Row — no group, no anchor."],
    warnings: entries.some((e) => e.problem) ? [`${entries.filter((e) => e.problem).length} typed line(s) will not be enqueued — fix or remove them first.`] : [],
  };
}

/**
 * The pending→resolved title phase, as the queue will render it. `pending` is
 * what the row shows the moment it is enqueued; `resolved` is what it shows
 * once the subject has actually been looked up. Nothing here guesses: a subject
 * the backend does not know STAYS pending, which is the honest state.
 */
export function titlePhases(entry: ParsedEntry, subject: InputSubject): { pending: { title: string; subtitle: string }; resolved: { title: string; subtitle: string } | null } {
  const hit = RESOLVED_SUBJECTS[entry.value.toLowerCase()] ?? RESOLVED_SUBJECTS[entry.value];
  const pending = {
    title: entry.value,
    subtitle: subject === "eid" ? `EID ${entry.value}` : TRACE_PENDING,
  };
  return {
    pending,
    resolved: hit ? { title: hit.name, subtitle: `EID ${hit.eid}` } : null,
  };
}

// ---------------------------------------------------------------------------
// The Enqueue command — applied | conflict | rejected, same union as the rest
// ---------------------------------------------------------------------------

/** doc 03 §2.4 — what to do when the same subject/document is already running */
export type EnqueuePolicy = "reject-active" | "supersede-active" | "allow-parallel";

export const ENQUEUE_POLICY_LABEL: Record<EnqueuePolicy, string> = {
  "reject-active": "Refuse if one is already running",
  "supersede-active": "Supersede the one already running",
  "allow-parallel": "Run alongside it",
};

export interface DemoEnqueueResult {
  id: string;
  state: DemoCommandResultState;
  headline: string;
  detail: string;
  /** rejected only — a typed code, never a bare string */
  code?: string;
  /** conflict only — the contract the form was built against vs the server's */
  expectedVersion?: number;
  serverVersion?: number;
  /** applied only — what was actually created */
  created?: EnqueuePlanRow[];
  clock: string;
  requestedBy: string;
  dryRun: boolean;
  testSystems: SystemKey[];
}

export interface EnqueueRequest {
  workflow: DemoWorkflowId;
  /** the descriptor version the form was BUILT against — the CAS token */
  expectedWorkflowVersion: number;
  plan: EnqueuePlan;
  policy: EnqueuePolicy;
  dryRun: boolean;
  instances: InstanceChoice;
  /** upload starts only */
  fileName?: string;
  /** a subject/document the server already has an active run for */
  activeConflictSubject?: string;
  tick?: number;
}

/**
 * The server's CURRENT descriptor version. `i9-check` is deliberately one ahead
 * of the registry the demo's forms are built from, so a start submitted against
 * the stale contract comes back `conflict` — the CAS path is reachable by
 * clicking, not just describable.
 */
export const SERVER_WORKFLOW_VERSION: Partial<Record<DemoWorkflowId, number>> = {
  "i9-check": DEMO_WORKFLOWS["i9-check"].version + 1,
};

let sequence = 0;

/**
 * Submit one start. Pure and deterministic — same request in, same result out.
 * The point is that all three outcomes are REACHABLE, not that a database is
 * simulated.
 */
export function submitDemoEnqueue(req: EnqueueRequest): DemoEnqueueResult {
  const workflow = DEMO_WORKFLOWS[req.workflow];
  sequence += 1;
  const test = testSystems(workflow, req.instances);
  const base = {
    id: `enq-${sequence}`,
    clock: fmtClockSec(agoSeconds(-(req.tick ?? 0))),
    requestedBy: DEMO_OPERATOR,
    dryRun: req.dryRun,
    testSystems: test,
  };

  // 1. CAS first. A form built against a retired contract can never be allowed
  //    to enqueue, whatever it asks for.
  const serverVersion = SERVER_WORKFLOW_VERSION[req.workflow] ?? workflow.version;
  if (serverVersion !== req.expectedWorkflowVersion) {
    return {
      ...base,
      state: "conflict",
      expectedVersion: req.expectedWorkflowVersion,
      serverVersion,
      headline: "Conflict — this form was built against an older contract",
      detail: `You filled in the ${workflow.label} v${req.expectedWorkflowVersion} form; the server serves v${serverVersion}. NOTHING was enqueued. Reload the form and check every field again — the change you could not see may be the reason this start is wrong.`,
    };
  }

  // 2. The policy refusal — a fact the form cannot know, which is exactly why
  //    `rejected` exists in the protocol.
  if (req.activeConflictSubject && req.policy === "reject-active") {
    return {
      ...base,
      state: "rejected",
      code: "active-run-exists",
      headline: "Rejected — something is already running for this subject",
      detail: `${req.activeConflictSubject} already has an active ${workflow.label} run. Under “${ENQUEUE_POLICY_LABEL["reject-active"]}” nothing was enqueued. Open the active run, or switch the policy to supersede it — but a second parallel run against the same person is how one gets filed twice.`,
    };
  }

  const superseded = req.activeConflictSubject && req.policy === "supersede-active";
  const parallel = req.activeConflictSubject && req.policy === "allow-parallel";

  const scope = req.fileName ? `“${req.fileName}”` : `${req.plan.rows.filter((r) => r.role === "member" || r.role === "run").length} typed value(s)`;
  const dryNote = req.dryRun
    ? " This is a DRY RUN: every read happens for real, nothing is written to any system, and the row carries a dry-run chip so it can never be mistaken for a filing."
    : "";
  const testNote = test.length ? ` Targeting the TEST instance of ${test.map((s) => SYSTEM_LABEL[s]).join(", ")} — the row carries a test badge.` : "";
  const policyNote = superseded
    ? ` The active run for ${req.activeConflictSubject} was superseded and left the queue; it keeps its receipt.`
    : parallel
      ? ` A second run for ${req.activeConflictSubject} is now running alongside the first — both will write.`
      : "";

  return {
    ...base,
    state: "applied",
    headline: req.dryRun ? "Dry run enqueued" : "Run enqueued",
    detail: `${req.plan.headline} for ${scope}.${policyNote}${dryNote}${testNote}`,
    created: req.plan.rows.filter((r) => r.bornAs !== "not yet created"),
  };
}
