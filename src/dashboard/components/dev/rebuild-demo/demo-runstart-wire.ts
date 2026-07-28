/**
 * DEV-ONLY — the WIRE CONTRACT for the run-START half of the product.
 *
 * The demo could show every state a run reaches and no way to create one. This
 * file is the missing half of `demo-wire.ts`: the **Enqueue** command family
 * (`docs/rebuild/reviews/demo-feature-plan-2026-07-25.md` §1.3 — "typed
 * input-run / upload-run starts; policies `reject-active` | `supersede-active` |
 * `allow-parallel`; instance prod/test request; dry-run flag") plus the corpora
 * a start picks from.
 *
 * **What it deliberately no longer holds: a per-workflow spec table.** Wave 10
 * moved every "what does this workflow accept, and what sub-selections does it
 * offer" fact onto the workflow's own descriptor (`DemoWorkflowRef.start`,
 * `demo-wire.ts`), the same move wave 7 made for rail categories. This file
 * consumes that capability; it never restates it, so a workflow registered
 * tomorrow gets a correct modal with no edit here.
 *
 * Three rules, the same three that keep `demo-wire.ts` honest:
 *
 *  1. **The plan is SERVER-derived, not client-guessed.** `deriveStartPlan` is
 *     the mock server answering "what will this create?" from the chosen
 *     method's own `coordinator` shape. The Run Modal renders that answer; it
 *     never branches on a workflow id to decide what a packet looks like. That
 *     is what makes ratified decision **D6** mechanical rather than decorative:
 *     `oath-upload` declares `coordinator: "single-run"` + `linkedPanel`, so it
 *     structurally CANNOT be drawn as a member fan-out.
 *  2. **Enqueue is a command, so it has three outcomes.** `submitDemoEnqueue`
 *     returns the same `applied | conflict | rejected` union every other
 *     command returns (the type is imported from `demo-commands.ts` — there is
 *     one union in the demo, not two). A start button that can only succeed
 *     teaches the operator that starting works.
 *  3. **Nothing is previewed that a real backend could not serve.** A trace id
 *     is stamped at enqueue, so the plan says "assigned at enqueue" rather than
 *     inventing one — and a PDF's plan counts PAGES, never people, because
 *     before the review reads the document nobody knows how many people are in
 *     it.
 */

import type { ProposedStatus } from "./demo-status";
import type { DemoCommandResultState } from "./demo-commands";
import {
  DEMO_OPERATOR,
  DEMO_WORKFLOWS,
  agoSeconds,
  at,
  fmtClockSec,
  startContractToken,
  type CoordinatorShape,
  type DemoWorkflowId,
  type DemoWorkflowRef,
  type StartCapabilityWire,
  type StartMethodKind,
  type StartMethodWire,
  type StartSeparator,
  type StartValueKind,
  type SystemKey,
} from "./demo-wire";

// ---------------------------------------------------------------------------
// Instance resolution — prod vs test, per system (doc 11 §4)
// ---------------------------------------------------------------------------

export type SystemInstance = "prod" | "test";

export type InstanceChoice = Partial<Record<SystemKey, SystemInstance>>;

/**
 * Every system's entry hosts, keyed by instance.
 *
 * This used to be a Settings section of seven editable override boxes, and it
 * was the wrong shape twice over: an override is a GLOBAL flip with no expiry
 * that silently redirects every future run, and there is nothing an operator
 * types here that the deployment does not already know. What an operator
 * actually asks is *"am I testing against staging on THIS run?"* — a per-run
 * question, answered by the run modal's instance selector, which now prints the
 * host each choice resolves to so the answer is a fact and not a promise.
 *
 * A system with no `test` host cannot be pointed at one; the selector says so
 * rather than offering a choice that would silently fall back to production.
 */
export interface SystemInstanceWire {
  label: string;
  hosts: { prod: string; test?: string };
  /** why a test instance exists for this system, or why one does not */
  note: string;
}

export const DEMO_SYSTEM_INSTANCES: Record<SystemKey, SystemInstanceWire> = {
  ucpath: {
    label: "UCPath",
    hosts: { prod: "ucpath.universityofcalifornia.edu", test: "ucpath-test.universityofcalifornia.edu" },
    note: "A UCPath write on the test host files nothing real and reads a stale copy of the roster.",
  },
  kuali: {
    label: "Kuali",
    hosts: { prod: "kuali.ucsd.edu/space/HR", test: "kuali-stg.ucsd.edu/space/HR" },
    note: "Staging holds its own documents — a doc ID from production will not resolve there.",
  },
  kronos: {
    label: "Kronos",
    hosts: { prod: "kronos.ucsd.edu/timekeeping" },
    note: "No test host is provisioned.",
  },
  crm: {
    label: "CRM",
    hosts: { prod: "crm.ucsd.edu", test: "crm-uat.ucsd.edu" },
    note: "Read-only for the download workflow, so the risk of the wrong host here is a wrong answer, not a wrong write.",
  },
  servicenow: {
    label: "ServiceNow",
    hosts: { prod: "ucsd.service-now.com", test: "ucsddev.service-now.com" },
    note: "A ticket filed on the dev host is real and visible — it just goes to nobody.",
  },
  onbase: {
    label: "OnBase",
    hosts: { prod: "onbase.ucsd.edu" },
    note: "No test host is provisioned — a test run here is refused at enqueue rather than silently sent to production.",
  },
  i9: {
    label: "I-9",
    hosts: { prod: "i9.ucsd.edu" },
    note: "No test host is provisioned. The doctor's I-9 test-instance check reports the same thing.",
  },
};

export const SYSTEM_LABEL: Record<SystemKey, string> = Object.fromEntries(
  (Object.keys(DEMO_SYSTEM_INSTANCES) as SystemKey[]).map((s) => [s, DEMO_SYSTEM_INSTANCES[s].label]),
) as Record<SystemKey, string>;

/** whether this system CAN be pointed at a test host at all */
export function systemHasTestInstance(system: SystemKey): boolean {
  return DEMO_SYSTEM_INSTANCES[system].hosts.test !== undefined;
}

/**
 * The host a choice resolves to. FAILS LOUD rather than falling back to
 * production for a `test` choice on a system with no test host — a silent
 * substitution here is a real write on the real system.
 */
export function systemHost(system: SystemKey, instance: SystemInstance): string {
  const spec = DEMO_SYSTEM_INSTANCES[system];
  if (instance === "prod") return spec.hosts.prod;
  const test = spec.hosts.test;
  if (!test) throw new Error(`demo wire: ${spec.label} has no test host — a test instance may not resolve to production`);
  return test;
}

/** every system the target drives, resolved — a system left unset is `prod` */
export function resolveInstances(workflow: DemoWorkflowRef, choice: InstanceChoice): Record<string, SystemInstance> {
  const out: Record<string, SystemInstance> = {};
  for (const system of workflow.systems) {
    out[system] = systemHasTestInstance(system) ? (choice[system] ?? "prod") : "prod";
  }
  return out;
}

export function testSystems(workflow: DemoWorkflowRef, choice: InstanceChoice): SystemKey[] {
  return workflow.systems.filter((s) => systemHasTestInstance(s) && choice[s] === "test");
}

// ---------------------------------------------------------------------------
// Entry validation — LOUD, per value, before anything is enqueued
// ---------------------------------------------------------------------------

export type EntryProblemCode =
  | "not-an-eid"
  | "not-an-email"
  | "not-a-name"
  | "not-a-doc-id"
  | "not-a-recognized-value"
  | "duplicate-entry";

export interface EntryProblem {
  code: EntryProblemCode;
  message: string;
}

export interface ParsedEntry {
  /** 1-based position in the typed list — a message always names the value */
  position: number;
  raw: string;
  /** which of the accepted kinds this value was read as */
  kind?: StartValueKind;
  problem?: EntryProblem;
  /** the value as the parser normalized it (trimmed, digits stripped of spaces) */
  value: string;
}

const EID_RE = /^\d{8}$/;
const DOC_ID_RE = /^\d{3,6}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const NAME_RE = /^[^\d@]{2,}$/;

/**
 * The order kinds are TESTED in, which is not the order they are declared in.
 * An address is unambiguous, then a fixed-width id, then a shorter id, and a
 * name is only ever the fallback — so a token is classified by what it IS
 * rather than by which kind the workflow happened to list first.
 */
const KIND_TEST_ORDER: StartValueKind[] = ["email", "eid", "docId", "name"];

const KIND_MATCH: Record<StartValueKind, (value: string) => boolean> = {
  email: (v) => EMAIL_RE.test(v),
  eid: (v) => EID_RE.test(v),
  docId: (v) => DOC_ID_RE.test(v),
  name: (v) => NAME_RE.test(v) && v.split(/[\s,]+/).filter(Boolean).length >= 2,
};

const KIND_RULE: Record<StartValueKind, { code: EntryProblemCode; rule: string }> = {
  eid: { code: "not-an-eid", rule: "a UCPath EID is 8 digits" },
  docId: { code: "not-a-doc-id", rule: "a Kuali document ID is 3 to 6 digits" },
  email: { code: "not-an-email", rule: "a campus email looks like name@ucsd.edu" },
  name: { code: "not-a-name", rule: "a name needs a first and a last part" },
};

function classify(value: string, accepts: readonly StartValueKind[]): StartValueKind | undefined {
  for (const kind of KIND_TEST_ORDER) {
    if (!accepts.includes(kind)) continue;
    if (KIND_MATCH[kind](value)) return kind;
  }
  return undefined;
}

/**
 * Parse the typed box against what this workflow's typed method ACCEPTS.
 *
 * Every value is either a recognized entry or a NAMED problem — a value is
 * never silently dropped, never trimmed into validity, never "best-effort"
 * coerced. The separator is served (a person-lookup list holds
 * `Battistessa, Johnnie`, so its separator is a semicolon); a newline always
 * separates too, because a pasted column is a list in every reading of it.
 */
export function parseEntries(
  text: string,
  accepts: readonly StartValueKind[],
  separator: StartSeparator,
): ParsedEntry[] {
  const splitter = separator === "semicolon" ? /[;\n]/ : /[,\n]/;
  const seen = new Set<string>();
  const out: ParsedEntry[] = [];

  text.split(splitter).forEach((rawToken) => {
    const raw = rawToken.trim();
    if (raw === "") return;
    const position = out.length + 1;
    // Whitespace inside a pure-digit id is a typo, not a separator.
    const value = /^[\d\s]+$/.test(raw) ? raw.replace(/\s+/g, "") : raw.replace(/\s+/g, " ");
    const key = value.toLowerCase();

    if (seen.has(key)) {
      out.push({
        position,
        raw,
        value,
        problem: { code: "duplicate-entry", message: `“${raw}” is already on this list — one run per subject.` },
      });
      return;
    }
    seen.add(key);

    const kind = classify(value, accepts);
    if (!kind) {
      if (accepts.length === 1) {
        const only = KIND_RULE[accepts[0]];
        out.push({ position, raw, value, problem: { code: only.code, message: `“${raw}” is not valid here — ${only.rule}.` } });
        return;
      }
      out.push({
        position,
        raw,
        value,
        problem: {
          code: "not-a-recognized-value",
          message: `“${raw}” is neither ${accepts.map((k) => KIND_RULE[k].rule).join(" nor ")}.`,
        },
      });
      return;
    }
    out.push({ position, raw, value, kind });
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
  "10312007": { name: "Marcus Bell", eid: "10312007" },
  "10601188": { name: "Priya Natarajan", eid: "10601188" },
  "3930": { name: "Dana Whitmore", eid: "10233470" },
  "3928": { name: "Nathan Cole", eid: "10233912" },
  "mdelgado@ucsd.edu": { name: "Maria Delgado", eid: "10084412" },
  "riglesias@ucsd.edu": { name: "Rosa Iglesias", eid: "10091755" },
  "samuel.ortiz@ucsd.edu": { name: "Samuel Ortiz", eid: "10517722" },
  "battistessa, johnnie": { name: "Johnnie Battistessa", eid: "10873698" },
};

/**
 * The pending→resolved title phase, as the queue will render it. `pending` is
 * what the row shows the moment it is enqueued; `resolved` is what it shows
 * once the subject has actually been looked up. Nothing here guesses: a subject
 * the backend does not know STAYS pending, which is the honest state.
 */
export function titlePhases(entry: ParsedEntry): {
  pending: { title: string; subtitle: string };
  resolved: { title: string; subtitle: string } | null;
} {
  const hit = RESOLVED_SUBJECTS[entry.value.toLowerCase()] ?? RESOLVED_SUBJECTS[entry.value];
  return {
    pending: { title: entry.value, subtitle: entry.kind === "eid" ? `EID ${entry.value}` : TRACE_PENDING },
    resolved: hit ? { title: hit.name, subtitle: `EID ${hit.eid}` } : null,
  };
}

// ---------------------------------------------------------------------------
// The corpora a start picks FROM — documents, capture sessions, active runs
// ---------------------------------------------------------------------------

export type UploadAccepts = "pdf" | "spreadsheet";

export interface UploadFileFixture {
  id: string;
  fileName: string;
  kind: UploadAccepts;
  sizeLabel: string;
  /** the ONE thing a parser knows before reading: how many pages. Never people. */
  pageCount: number;
}

export const UPLOAD_FILES: UploadFileFixture[] = [
  { id: "oath-summer", fileName: "Oath_Packet_Summer.pdf", kind: "pdf", sizeLabel: "1.9 MB", pageCount: 12 },
  { id: "oath-spring", fileName: "Oath_Packet_Spring.pdf", kind: "pdf", sizeLabel: "1.8 MB", pageCount: 12 },
  { id: "ec-jul", fileName: "EC_Forms_Jul25.pdf", kind: "pdf", sizeLabel: "740 KB", pageCount: 6 },
  { id: "ec-ruiz-1", fileName: "EC_Ruiz_page1.pdf", kind: "pdf", sizeLabel: "88 KB", pageCount: 1 },
  { id: "ec-ruiz-2", fileName: "EC_Ruiz_page2.pdf", kind: "pdf", sizeLabel: "84 KB", pageCount: 1 },
  { id: "signed-oath", fileName: "Signed_Oath_Delgado.pdf", kind: "pdf", sizeLabel: "212 KB", pageCount: 1 },
  { id: "i9-scan", fileName: "I9_Retention_Scan.pdf", kind: "pdf", sizeLabel: "3.1 MB", pageCount: 9 },
];

/**
 * A phone capture session, as the server would serve it back to the desktop.
 *
 * The demo runs no capture server, so these are fixtures of sessions the phone
 * has already pushed pages into — which is exactly what the desktop sees either
 * way, since the desktop never touches the phone. Two things the demo will not
 * do: draw a QR code that scans to nothing, and draw a stand-in of a page it
 * does not hold the bytes of.
 */

/** why a page cannot be used — the flag the reader raised, and what it saw */
export interface CapturePhotoDefect {
  /** one line the operator can act on */
  reason: string;
  /** the focus score the phone reported — the number the flag was raised on */
  focusScore: number;
}

export interface CapturePhotoFixture {
  /**
   * 1-based, in the ORDER THE PHONE PUSHED IT. Nothing has read the page yet,
   * so it is a page and never a person — the same discipline the plan keeps.
   */
  page: number;
  filename: string;
  mime: string;
  /** the instant the desktop was told about it */
  arrivedAt: string;
  sizeLabel: string;
  /** the served pixel size — the placeholder's SHAPE comes from this, never a guess */
  width: number;
  height: number;
  /** the reader could not use it. A page that cannot be read is not a page. */
  unreadable?: CapturePhotoDefect;
}

export interface CaptureSessionFixture {
  id: string;
  workflow: DemoWorkflowId;
  /** the code the phone types. This demo serves no QR — see the panel's ⓘ. */
  pairingCode: string;
  openedAt: string;
  /** the idle expiry the server stamped */
  expiresAt: string;
  /** unset until the phone first asks the server for the manifest */
  connectedAt?: string;
  deviceLabel?: string;
  /** the phone has not stopped — more pages may still land on this session */
  stillUploading: boolean;
  photos: CapturePhotoFixture[];
}

/** 200 dpi US Letter — the shape every page in the corpus was photographed at */
const LETTER_200 = { width: 1700, height: 2200 } as const;
/** 300 dpi US Letter — the same page, one phone held closer */
const LETTER_300 = { width: 2550, height: 3300 } as const;

export const CAPTURE_SESSIONS: CaptureSessionFixture[] = [
  {
    // READY — eight pages in, nothing wrong with any of them.
    id: "cap-os-3f21",
    workflow: "oath-signature",
    pairingCode: "QK2-841",
    openedAt: at("14:18:40"),
    connectedAt: at("14:19:06"),
    expiresAt: at("14:37:58"),
    deviceLabel: "iPhone 15 · operator",
    stillUploading: false,
    photos: [
      { page: 1, filename: "page-01.jpg", mime: "image/jpeg", arrivedAt: at("14:19:22"), sizeLabel: "1.4 MB", ...LETTER_200 },
      { page: 2, filename: "page-02.jpg", mime: "image/jpeg", arrivedAt: at("14:19:51"), sizeLabel: "1.3 MB", ...LETTER_200 },
      { page: 3, filename: "page-03.jpg", mime: "image/jpeg", arrivedAt: at("14:20:18"), sizeLabel: "1.5 MB", ...LETTER_200 },
      { page: 4, filename: "page-04.jpg", mime: "image/jpeg", arrivedAt: at("14:20:47"), sizeLabel: "2.6 MB", ...LETTER_300 },
      { page: 5, filename: "page-05.jpg", mime: "image/jpeg", arrivedAt: at("14:21:15"), sizeLabel: "1.2 MB", ...LETTER_200 },
      { page: 6, filename: "page-06.jpg", mime: "image/jpeg", arrivedAt: at("14:21:44"), sizeLabel: "1.4 MB", ...LETTER_200 },
      { page: 7, filename: "page-07.jpg", mime: "image/jpeg", arrivedAt: at("14:22:20"), sizeLabel: "1.3 MB", ...LETTER_200 },
      { page: 8, filename: "page-08.jpg", mime: "image/jpeg", arrivedAt: at("14:22:58"), sizeLabel: "1.1 MB", ...LETTER_200 },
    ],
  },
  {
    // BLOCKED — five pages in, and one of them cannot be read.
    id: "cap-os-8b17",
    workflow: "oath-signature",
    pairingCode: "TR9-330",
    openedAt: at("14:23:10"),
    connectedAt: at("14:23:31"),
    expiresAt: at("14:40:12"),
    deviceLabel: "iPhone 15 · operator",
    stillUploading: false,
    photos: [
      { page: 1, filename: "page-01.jpg", mime: "image/jpeg", arrivedAt: at("14:23:44"), sizeLabel: "1.2 MB", ...LETTER_200 },
      { page: 2, filename: "page-02.jpg", mime: "image/jpeg", arrivedAt: at("14:24:09"), sizeLabel: "1.3 MB", ...LETTER_200 },
      { page: 3, filename: "page-03.jpg", mime: "image/jpeg", arrivedAt: at("14:24:35"), sizeLabel: "1.1 MB", ...LETTER_200 },
      {
        page: 4,
        filename: "page-04.jpg",
        mime: "image/jpeg",
        arrivedAt: at("14:24:58"),
        sizeLabel: "640 KB",
        ...LETTER_200,
        unreadable: { reason: "Out of focus — the reader could not lift a line off it.", focusScore: 0.28 },
      },
      { page: 5, filename: "page-05.jpg", mime: "image/jpeg", arrivedAt: at("14:25:12"), sizeLabel: "1.4 MB", ...LETTER_200 },
    ],
  },
  {
    // RECEIVING — three pages in and the phone has not stopped.
    id: "cap-ec-9b04",
    workflow: "emergency-contact",
    pairingCode: "MP6-118",
    openedAt: at("14:24:02"),
    connectedAt: at("14:24:20"),
    expiresAt: at("14:40:54"),
    deviceLabel: "iPhone 13 · operator",
    stillUploading: true,
    photos: [
      { page: 1, filename: "page-01.jpg", mime: "image/jpeg", arrivedAt: at("14:24:35"), sizeLabel: "980 KB", ...LETTER_200 },
      { page: 2, filename: "page-02.jpg", mime: "image/jpeg", arrivedAt: at("14:25:11"), sizeLabel: "1.1 MB", ...LETTER_200 },
      { page: 3, filename: "page-03.jpg", mime: "image/jpeg", arrivedAt: at("14:25:54"), sizeLabel: "1.0 MB", ...LETTER_200 },
    ],
  },
  {
    // AWAITING THE PHONE — opened on the desktop, never picked up.
    id: "cap-ec-4d52",
    workflow: "emergency-contact",
    pairingCode: "HJ4-207",
    openedAt: at("14:25:48"),
    expiresAt: at("14:40:48"),
    stillUploading: false,
    photos: [],
  },
];

export type CaptureSessionPhase =
  | "awaiting-phone"
  | "awaiting-pages"
  | "receiving"
  | "blocked"
  | "ready";

export interface CaptureSessionSummary {
  phase: CaptureSessionPhase;
  received: number;
  unreadable: number;
  /** what stops a start, in the operator's words. Empty means it may start. */
  blockers: string[];
  /** the last page's arrival — what makes "still landing" a fact, not a mood */
  lastArrivedAt?: string;
}

/**
 * The state of a session, DERIVED from what the server serves about it rather
 * than stamped alongside it — a stamped phase and a photo list can disagree,
 * and the one that would be believed is the stamp.
 */
export function summarizeCaptureSession(session: CaptureSessionFixture): CaptureSessionSummary {
  const received = session.photos.length;
  const unreadable = session.photos.filter((p) => p.unreadable);
  const blockers: string[] = [];
  if (received === 0) blockers.push("No page has arrived yet.");
  for (const photo of unreadable) blockers.push(`Page ${photo.page} could not be read.`);

  const phase: CaptureSessionPhase = !session.connectedAt
    ? "awaiting-phone"
    : received === 0
      ? "awaiting-pages"
      : unreadable.length > 0
        ? "blocked"
        : session.stillUploading
          ? "receiving"
          : "ready";

  return {
    phase,
    received,
    unreadable: unreadable.length,
    blockers,
    lastArrivedAt: session.photos[received - 1]?.arrivedAt,
  };
}

/** every session the phone has open against this workflow, oldest first */
export function captureSessionsFor(workflow: DemoWorkflowId): CaptureSessionFixture[] {
  return CAPTURE_SESSIONS.filter((s) => s.workflow === workflow);
}

/** the session a start defaults to — the first one open for the workflow */
export function captureSessionFor(workflow: DemoWorkflowId): CaptureSessionFixture | undefined {
  return captureSessionsFor(workflow)[0];
}

/**
 * What the server already has a live run for. This is a fact the FORM cannot
 * know, which is exactly why `rejected` exists in the protocol — the modal
 * shows it up front so the refusal is never a surprise, and the server refuses
 * it again anyway.
 */
export interface ActiveStartFixture {
  workflow: DemoWorkflowId;
  /** the normalized subject or file name the active run holds */
  subject: string;
  label: string;
  note: string;
}

export const ACTIVE_STARTS: ActiveStartFixture[] = [
  {
    workflow: "separations",
    subject: "3929",
    label: "Doc 3929",
    note: "a Separations run for this document is running now",
  },
  {
    workflow: "work-study",
    subject: "10601188",
    label: "EID 10601188",
    note: "Priya Natarajan is queued in the Work-Study panel right now",
  },
  {
    workflow: "oath-signature",
    subject: "Oath_Packet_Spring.pdf",
    label: "Oath_Packet_Spring.pdf",
    note: "an Oath Signature packet for this file is running now",
  },
];

/** the first subject in this start that the server already has a run for */
export function activeConflictFor(workflow: DemoWorkflowId, subjects: readonly string[]): ActiveStartFixture | undefined {
  return ACTIVE_STARTS.find((a) => a.workflow === workflow && subjects.some((s) => s === a.subject));
}

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

const pages = (n: number) => `${n} page${n === 1 ? "" : "s"}`;

/** what the operator is starting FROM — the method plus whatever it collected */
export interface StartSubject {
  workflow: DemoWorkflowRef;
  method: StartMethodWire;
  /** typed only */
  entries?: ParsedEntry[];
  /** upload only — every file picked, in pick order */
  files?: UploadFileFixture[];
  /** capture only */
  capture?: CaptureSessionFixture;
}

/**
 * The mock server's answer to "what will this create?", derived from the chosen
 * method's own `coordinator` shape. The Run Modal renders this and nothing
 * else, so the preview cannot drift from what enqueue actually does.
 */
export function deriveStartPlan(subject: StartSubject): EnqueuePlan {
  switch (subject.method.kind) {
    case "typed":
      return deriveTypedPlan(subject.workflow, subject.entries ?? []);
    case "bare":
      return deriveBarePlan(subject.workflow);
    case "spreadsheet":
      // Deliberately no rows. A sheet has no plan until it has a header row and
      // a column mapping, and a preview that guessed one would be guessing the
      // very thing the intake exists to make an operator decide.
      return {
        headline: "The intake derives this plan, not the modal",
        rows: [],
        decisions: [
          "A spreadsheet becomes N runs only after a header row, an operator-built column mapping and a per-cell accept-or-reject on every row. Nothing about the shape of that is knowable from the grid alone.",
        ],
        warnings: [],
      };
    case "capture": {
      const session = subject.capture;
      if (!session) return emptyPlan("No capture session — nothing to start");
      const received = session.photos.length;
      return deriveDocumentPlan(subject.workflow, subject.method.coordinator, {
        title: `${received} captured page${received === 1 ? "" : "s"}`,
        pageCount: received,
        documentNoun: subject.method.documentNoun,
        source: `Capture session ${session.id}`,
      });
    }
    case "upload": {
      const files = subject.files ?? [];
      if (files.length === 0) return emptyPlan("No document picked — nothing to start");
      const method = subject.method;
      if (method.merge) {
        const total = files.reduce((n, f) => n + f.pageCount, 0);
        const merged = deriveDocumentPlan(subject.workflow, method.coordinator, {
          title: files.length === 1 ? files[0].fileName : `${files.length} files merged`,
          pageCount: total,
          documentNoun: method.documentNoun,
          source: files.length === 1 ? undefined : files.map((f) => f.fileName).join(" + "),
          linkedPanel: method.linkedPanel,
          linkedNoun: method.linkedNoun,
        });
        if (files.length > 1) {
          merged.decisions = [
            `OnBase imports ONE file, so these ${files.length} PDFs are merged into a single ${pages(total)} document before anything is read. That is one run, not ${files.length}.`,
            ...merged.decisions,
          ];
        }
        return merged;
      }
      const perFile = files.map((file) =>
        deriveDocumentPlan(subject.workflow, method.coordinator, {
          title: file.fileName,
          pageCount: file.pageCount,
          documentNoun: method.documentNoun,
          keyPrefix: file.id,
          linkedPanel: method.linkedPanel,
          linkedNoun: method.linkedNoun,
        }),
      );
      if (perFile.length === 1) return perFile[0];
      return {
        headline: `${perFile.length} independent starts · ${pages(files.reduce((n, f) => n + f.pageCount, 0))} in total`,
        rows: perFile.flatMap((p) => p.rows),
        decisions: [
          `Each file is its own run. Nothing merges them and nothing groups them together — ${files.length} documents are ${files.length} separate pieces of work with ${files.length} separate receipts.`,
          ...perFile[0].decisions,
        ],
        warnings: [],
      };
    }
  }
}

function emptyPlan(headline: string): EnqueuePlan {
  return { headline, rows: [], decisions: [], warnings: [] };
}

function deriveBarePlan(workflow: DemoWorkflowRef): EnqueuePlan {
  return {
    headline: "1 Run Row",
    rows: [
      {
        key: "run",
        role: "run",
        rowType: "run",
        title: workflow.label,
        subtitle: TRACE_PENDING,
        panel: workflow.label,
        bornAs: "queued",
        note: "One row, no subject. It is titled with the workflow because there is nothing else true to title it with.",
      },
    ],
    decisions: ["A start with no subject is still a run: it gets its own row, its own trace id and its own receipt, like everything else."],
    warnings: [],
  };
}

interface DocumentPlanInput {
  title: string;
  pageCount: number;
  documentNoun: string;
  /** where the pages came from, when it is not the title itself */
  source?: string;
  keyPrefix?: string;
  /** `single-run` only — where its `linked` children live, and what they are called */
  linkedPanel?: DemoWorkflowId;
  linkedNoun?: string;
}

function deriveDocumentPlan(
  workflow: DemoWorkflowRef,
  coordinator: CoordinatorShape,
  input: DocumentPlanInput,
): EnqueuePlan {
  const ocr = DEMO_WORKFLOWS.ocr;
  const k = (name: string) => (input.keyPrefix ? `${input.keyPrefix}-${name}` : name);
  const linkedPanel = input.linkedPanel ? DEMO_WORKFLOWS[input.linkedPanel].label : workflow.label;
  const linkedNoun = input.linkedNoun ?? "linked children";

  if (coordinator === "review-only") {
    return {
      headline: `1 Review Run Row · ${pages(input.pageCount)}`,
      rows: [
        {
          key: k("review"),
          role: "review",
          rowType: "run",
          title: input.title,
          subtitle: TRACE_PENDING,
          panel: ocr.label,
          bornAs: "queued",
          note: input.source ? `${input.source}. Reads the document and stops at a read-only review.` : "Reads the document and stops at a read-only review.",
        },
      ],
      decisions: ["A standalone review has no approve flow — approval is delegation, and nothing delegated this run."],
      warnings: [],
    };
  }

  if (coordinator === "single-run") {
    return {
      headline: `1 Run Row · ${pages(input.pageCount)}`,
      rows: [
        {
          key: k("run"),
          role: "run",
          rowType: "run",
          title: input.title,
          subtitle: TRACE_PENDING,
          panel: workflow.label,
          bornAs: "queued",
          note: "One row walks the whole document: OCR prep → your approval → wait for signatures → file the ticket.",
        },
        {
          key: k("linked"),
          role: "linked",
          rowType: "run",
          containment: "linked",
          title: linkedNoun,
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
    headline: `1 Group Row · ${pages(input.pageCount)}`,
    rows: [
      {
        key: k("group"),
        role: "group",
        rowType: "group",
        title: input.title,
        subtitle: TRACE_PENDING,
        panel: workflow.label,
        bornAs: "running",
        note: `The ${input.documentNoun}${input.source ? ` (${input.source})` : ""}. Its count badge stays empty until the review reads the pages — then it shows “N people extracted”, and flips to “N people” when the members are fanned out. Nobody knows N before the pages are read.`,
      },
      {
        key: k("review"),
        role: "review",
        rowType: "run",
        containment: "linked",
        title: `Review — ${input.title}`,
        subtitle: TRACE_PENDING,
        panel: ocr.label,
        bornAs: "queued",
        note: "The delegated review keeps its OWN row in the OCR panel; the packet carries a link to it, never a copy.",
      },
      {
        key: k("members"),
        role: "member",
        rowType: "member",
        containment: "member",
        title: "One per person the review reads",
        subtitle: "created when the review releases them, never before",
        panel: workflow.label,
        bornAs: "not yet created",
        note:
          workflow.id === "i9-check"
            ? "Created when the review completes — an I-9 check has nothing to approve, so the review finishes itself and fans out."
            : "Created when you approve the review. Nothing is fanned out before then.",
      },
    ],
    decisions: [
      "A document upload is always a Group Row, even for one person (D2/D14) — a group of one that looked like a Run Row would make the next fan-out look like a new object.",
      "The delegated review keeps its own Run Row in the OCR panel (D4); the packet links to it rather than duplicating it.",
    ],
    warnings: [],
  };
}

export function deriveTypedPlan(workflow: DemoWorkflowRef, entries: ParsedEntry[]): EnqueuePlan {
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
      key: `entry-${entry.position}`,
      role: valid.length > 1 ? "member" : "run",
      rowType: valid.length > 1 ? "member" : "run",
      containment: valid.length > 1 ? "member" : undefined,
      title: entry.value,
      subtitle: entry.kind === "eid" ? `EID ${entry.value}` : TRACE_PENDING,
      panel: workflow.label,
      bornAs: "queued",
      note: resolved ? `Resolves to ${resolved.name}` : "Nobody has looked this subject up yet — the title stays as typed.",
    });
  }

  return {
    headline: valid.length > 1 ? `1 Group Row · ${valid.length} members` : valid.length === 1 ? "1 Run Row" : "Nothing — no valid entry",
    rows,
    decisions:
      valid.length > 1
        ? ["More than one typed value mints a Group Row (S5); each value becomes a Member Row under it."]
        : ["A single typed value mints a Run Row — no group, no anchor."],
    warnings: entries.some((e) => e.problem)
      ? [`${entries.filter((e) => e.problem).length} typed value(s) will not be enqueued — fix or remove them first.`]
      : [],
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
  /** conflict only — the start CONTRACT the form was built against vs the server's */
  expectedContract?: string;
  serverContract?: string;
  /** applied only — what was actually created */
  created?: EnqueuePlanRow[];
  clock: string;
  requestedBy: string;
  dryRun: boolean;
  testSystems: SystemKey[];
}

export interface EnqueueRequest {
  workflow: DemoWorkflowId;
  /**
   * The START CONTRACT the form was built against — the CAS token, and
   * deliberately not a version number. A form goes stale because the run's
   * SHAPE moved, not because a label was reworded, so a minor bump leaves every
   * open form valid and this token untouched.
   */
  expectedContract: string;
  /** which peer method started it */
  method: StartMethodKind;
  plan: EnqueuePlan;
  policy: EnqueuePolicy;
  dryRun: boolean;
  duplicateCheck?: boolean;
  instances: InstanceChoice;
  /** the resolved sub-selections — a hidden choice is not in here */
  choices?: Record<string, string>;
  /** what the start is about, in the operator's words */
  scopeLabel?: string;
  /** a subject/document the server already has an active run for */
  activeConflictSubject?: string;
  tick?: number;
}

/**
 * The server's CURRENT start contract per workflow. `i9-check` is deliberately
 * one MAJOR ahead of the registry the demo's forms are built from, so a start
 * submitted against the stale contract comes back `conflict` — the CAS path is
 * reachable by clicking, not just describable.
 *
 * A minor bump never appears here: it does not move the shape, so it does not
 * move the contract.
 */
export const SERVER_CONTRACT_TOKEN: Partial<Record<DemoWorkflowId, string>> = {
  "i9-check": startContractToken(DEMO_WORKFLOWS["i9-check"], DEMO_WORKFLOWS["i9-check"].version + 1),
};

/** the contract token the server would compare a start against */
export function serverContractToken(workflow: DemoWorkflowRef): string {
  return SERVER_CONTRACT_TOKEN[workflow.id] ?? startContractToken(workflow);
}

let sequence = 0;

/** test seam — the demo's own enqueue ids restart per test file */
export function resetEnqueueSequence(): void {
  sequence = 0;
}

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
  const serverContract = serverContractToken(workflow);
  if (serverContract !== req.expectedContract) {
    return {
      ...base,
      state: "conflict",
      expectedContract: req.expectedContract,
      serverContract,
      headline: "Conflict — this form was built against an older START CONTRACT",
      detail: `You filled in the ${workflow.label} form built against contract ${req.expectedContract}; the server serves ${serverContract}. NOTHING was enqueued. The run's SHAPE moved — a step or a field this form does not know about — so reload the form and check every value again. (A reworded label would not have done this: only a shape change moves the contract.)`,
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

  // 3. A start with nothing to start is refused with its own code, rather than
  //    "succeeding" into an empty queue.
  if (req.plan.rows.length === 0) {
    return {
      ...base,
      state: "rejected",
      code: "nothing-to-start",
      headline: "Rejected — this start would create nothing",
      detail: "There is no valid subject on this form, so there is no row to create. Nothing was enqueued.",
    };
  }

  const superseded = req.activeConflictSubject && req.policy === "supersede-active";
  const parallel = req.activeConflictSubject && req.policy === "allow-parallel";

  const scope = req.scopeLabel ?? `${req.plan.rows.filter((r) => r.role === "member" || r.role === "run").length} subject(s)`;
  const dryNote = req.dryRun
    ? " This is a DRY RUN: every read happens for real, nothing is written to any system, and the row carries a dry-run chip so it can never be mistaken for a filing."
    : "";
  const dupeNote = req.duplicateCheck ? " A duplicate check runs first — if this document has already been filed for this person the run refuses rather than filing it twice." : "";
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
    detail: `${req.plan.headline} for ${scope}.${policyNote}${dryNote}${dupeNote}${testNote}`,
    created: req.plan.rows.filter((r) => r.bornAs !== "not yet created"),
  };
}

/** re-exported so a surface never has to reach past this file for the contract */
export type { StartCapabilityWire, StartMethodWire, StartMethodKind };
