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

/**
 * THE APP'S OWN VERSION — `major.minor`, and it is a different axis from a
 * workflow's `v7.2`.
 *
 * It used to be a DATE STAMP (`2026.07.3`), which reads like a version and
 * carries none of a version's information: two date stamps tell you which
 * shipped later and nothing about whether the later one moved anything under
 * your runs. The operator drew the scheme: *"the app will be like this 1.1. the
 * first 1 is for the major dashboard change. the second 1 is for a minor
 * change. the minor change does not affect any workflows but the major change
 * affect some/all workflows."*
 *
 *   MAJOR — a dashboard change that reaches SOME OR ALL WORKFLOWS. Old rows may
 *           not be interpretable by the new projection, so it archives every
 *           prior-version run and a non-terminal run blocks it.
 *   MINOR — a dashboard change that reaches NO workflow. Nothing archives,
 *           nothing in flight is disturbed, nothing can block it.
 *
 * The test for "affects a workflow" is deliberately mechanical rather than a
 * judgement at release time, and it is the same test the descriptor version
 * already uses: did a workflow's SHAPE move — its steps, its data contract, the
 * projection that renders its rows? A change that only alters the app's own
 * chrome (a colour, a page's layout, a shortcut) is minor however large it
 * looks.
 *
 * TWO PARTS, NOT THREE, is the operator's call and it holds: this product ships
 * from one tree to one operator, so there is no "patch" audience — a cosmetic
 * fix and a small behavioural one both reach the same person on the same day,
 * and the only question either has to answer is "did my runs move".
 *
 * THE TRACE ID DOES NOT CARRY THIS. A run's trace correlates it to the app
 * version it ran under (both are on the archived row); it never encodes one.
 * Versions live in exactly two places — this constant for the app, the
 * descriptor for the workflow — and every surface reads them from there.
 */
export interface AppVersion {
  major: number;
  minor: number;
}

/** the app build serving every row — the `appVersion` half of the archive key */
export const DEMO_APP_VERSION_PARTS: AppVersion = { major: 3, minor: 1 };

/** `3.1` — the app version as every surface prints it */
export function fmtAppVersion(version: AppVersion): string {
  return `${version.major}.${version.minor}`;
}

/** `app 3.1` — where the number needs to say WHICH version it is */
export function appVersionTag(version: AppVersion): string {
  return `app ${fmtAppVersion(version)}`;
}

export const DEMO_APP_VERSION = fmtAppVersion(DEMO_APP_VERSION_PARTS);

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

/**
 * `n` with its noun, pluralised.
 *
 * The Explorer rendered `1 nodes` on two graphs, and a sweep found the same
 * shape all over the folder — a template literal is the easiest place in a
 * codebase to write a number beside a word that does not agree with it, and it
 * only shows up on the one fixture where the count happens to be one.
 *
 * The rule this encodes is the rest of the product's rule, at the grammar
 * level: a surface may not say something that is not true, and `1 nodes` is a
 * small lie in the same family as a green verdict nothing checked. Irregular
 * plurals pass their own (`plural(n, "person", "people")`); the default appends
 * an `s`, which covers everything else this product counts.
 */
export function plural(n: number, singular: string, pluralForm?: string): string {
  return `${n} ${n === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
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
  | "i9-lookup"
  | "work-study"
  | "kronos-pay-rule"
  | "ocr"
  | "oath-signature"
  | "oath-upload"
  | "emergency-contact"
  | "onbase"
  | "i9-check"
  | "crm-doc-download"
  | "sharepoint-download"
  | "old-kronos-reports";

/**
 * A workflow's rail group.
 *
 * **Deliberately an open string, not a union.** The category is a field on the
 * workflow's own descriptor (`defineWorkflow({ category })` — `src/core/kernel/types.ts`),
 * so declaring a new one is a one-line edit in a workflow and must not require
 * a frontend type to be widened first. A closed union here is how the demo
 * ended up inventing three categories of its own and re-binning every workflow
 * into them.
 */
export type DemoWorkflowCategory = string;

/**
 * The rail's display ORDER, and the only hardcoded thing about grouping. It
 * mirrors production's `PREFERRED_CATEGORY_ORDER`
 * (`src/dashboard/components/navigation/WorkflowRail.tsx`): a category not
 * listed here is appended in first-seen order, and `Other` is always last.
 */
export const DEMO_CATEGORY_ORDER: readonly string[] = [
  "Onboarding",
  "OnBase",
  "Separations",
  "Work Study",
  "Payroll",
  "Timekeeping",
  "Search",
  "Utils",
];

/** where a workflow that declares no category lands — always the last group */
export const DEMO_CATEGORY_OTHER = "Other";

/**
 * One answer a workflow's MEMBER rows are allowed to give to "what did you
 * find?" — which is a different question from "did you run?".
 *
 * Status and outcome are orthogonal and must never be conflated: a member can
 * be `Done` with the outcome `Not found`, because looking and finding
 * nothing is a successful run with a negative answer. The demo used to cram
 * both axes plus the evidence ("S1 + S2 · retain 3y", "no UCPath match") into
 * one free-text detail string, which truncated to `S1 + S2 · ret…` in a column
 * that sized itself to whatever the longest member happened to say.
 *
 * The vocabulary is DECLARED PER WORKFLOW (`DemoWorkflowRef.memberOutcomes`),
 * never inferred from the workflow id — a surface that branches on
 * `workflow === "i9-check"` is a surface that cannot serve the next workflow
 * that needs outcomes.
 */
export interface MemberOutcomeSpec {
  /** stable key — what the member row carries on the wire */
  key: string;
  /** the operator's word for it, one or two words so a column can hold it */
  label: string;
  /**
   * How loud it is, on the SAME four channels everything else uses. An outcome
   * is not a status, so it never renders as a `StatusPill` — the tone only
   * picks which text token the word is drawn in, and the word itself is always
   * the differentiator.
   */
  tone: "danger" | "warn" | "neutral" | "quiet";
  /** one sentence: what this outcome means, verbatim, for the hover + a11y */
  meaning: string;
}

// ---------------------------------------------------------------------------
// Start capability — how a workflow is STARTED, served on its own descriptor
// ---------------------------------------------------------------------------

/**
 * **The Run Modal renders what a workflow DECLARES, never what a component
 * knows about it.**
 *
 * Production splits run-starting across two surfaces by *how* you start — a
 * file-upload `RunModal` and a typed `InputRunPanel` — which is an
 * implementation detail leaking into the UI: `oath-signature` lives in both, so
 * its typed box has to open the *other* modal when you press Run on an empty
 * line. One modal that splits by *what you are running* has no such seam: you
 * pick a workflow, it declares what it accepts, and you get its inputs, its
 * sub-selections and its settings.
 *
 * That only holds if the capability is SERVED. This mirrors what the rail
 * already does with `category` (a hardcoded frontend union became the
 * descriptor's own field): a workflow registered tomorrow gets a correct modal
 * with no frontend edit, and a workflow that declares no `start` is not offered
 * at all rather than offered and broken.
 */

/** a value a typed box accepts. More than one means PER-TOKEN discrimination. */
export type StartValueKind = "eid" | "name" | "email" | "docId";

export const START_VALUE_NOUN: Record<StartValueKind, { one: string; many: string }> = {
  eid: { one: "EID", many: "EIDs" },
  name: { one: "name", many: "names" },
  email: { one: "campus email", many: "campus emails" },
  docId: { one: "Kuali doc ID", many: "Kuali doc IDs" },
};

/**
 * How a list of typed values is separated. It is a SERVED fact because it is a
 * property of the values, not a house style: a person-lookup list holds
 * `Battistessa, Johnnie`, so its separator cannot be a comma.
 */
export type StartSeparator = "comma" | "semicolon";

export const START_SEPARATOR: Record<StartSeparator, { char: string; label: string }> = {
  comma: { char: ",", label: "comma-separated" },
  semicolon: { char: ";", label: "semicolon-separated" },
};

export type StartFileKind = "pdf" | "spreadsheet";

/**
 * What a start CREATES — ratified decision D6 expressed as a served field
 * rather than a UI branch.
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

/** typed values, one box, validated per line */
export interface TypedStartMethod {
  kind: "typed";
  label: string;
  /** every value kind this ONE box accepts, discriminated per token */
  accepts: StartValueKind[];
  separator: StartSeparator;
  placeholder: string;
  /** how the server describes its own parser — the client never invents one */
  parserLabel: string;
  note: string;
  /**
   * Fixture shortcuts for the demo, and labelled as such. These are VALUES,
   * not run modes: the real "skip these steps" control is a `preset` choice
   * below, and letting these two look alike is how the demo came to show a
   * preset control that presets nothing.
   */
  examples?: { key: string; label: string; values: string[]; note: string }[];
}

/** one or more files picked from disk */
export interface UploadStartMethod {
  kind: "upload";
  label: string;
  accepts: StartFileKind[];
  /** more than one file may be picked at once */
  multiFile: boolean;
  /**
   * N files become ONE document rather than N independent runs. Only OnBase
   * does this, and it is the difference between three runs and one three-page
   * import — so it is served, never inferred from the workflow id.
   */
  merge: boolean;
  documentNoun: string;
  coordinator: CoordinatorShape;
  /** `single-run` only — the panel its `linked` children live in */
  linkedPanel?: DemoWorkflowId;
  /** `single-run` only — what those linked children are called */
  linkedNoun?: string;
  note: string;
}

/** pages photographed on a phone instead of picked off disk */
export interface CaptureStartMethod {
  kind: "capture";
  label: string;
  documentNoun: string;
  coordinator: CoordinatorShape;
  note: string;
}

/**
 * A spreadsheet, which is a different KIND of start and not another file type.
 * A sheet means nothing until it has a header row, an operator-built column
 * mapping and a per-cell accept-or-reject on every row — so this method hands
 * off to the intake pipeline rather than pretending to derive a plan from a
 * grid nobody has bound yet.
 */
export interface SpreadsheetStartMethod {
  kind: "spreadsheet";
  label: string;
  note: string;
}

/** a start with no subject at all — it is the whole instruction */
export interface BareStartMethod {
  kind: "bare";
  label: string;
  note: string;
}

export type StartMethodWire =
  | TypedStartMethod
  | UploadStartMethod
  | CaptureStartMethod
  | SpreadsheetStartMethod
  | BareStartMethod;

export type StartMethodKind = StartMethodWire["kind"];

export interface StartChoiceOptionWire {
  value: string;
  label: string;
  note?: string;
  /**
   * The option exists in the target system but is not wired end to end. It is
   * offered DISABLED with the reason on it — hiding it would make the operator
   * think the product had never heard of a document type they can see in
   * OnBase.
   */
  unavailable?: string;
}

/**
 * One sub-selection a start offers. Every one of them renders through the same
 * control, so a workflow that declares five reads like a workflow that declares
 * one, and a workflow that declares none shows no empty scaffolding.
 */
export interface StartChoiceWire {
  key: string;
  label: string;
  /** one line under the control: what this decides */
  note?: string;
  options: StartChoiceOptionWire[];
  defaultValue: string;
  /**
   * The target FIXES this. Rendered as a locked value with the reason, never as
   * a one-option select — "you may not change this" is a different shape from
   * "you may", and the pair is told apart by shape (wave 8).
   */
  locked?: boolean;
  lockedReason?: string;
  /** only offered while another choice holds one of these values */
  visibleWhen?: { choice: string; equals: string[] };
  /** only offered for these start methods (absent = every method) */
  methods?: StartMethodKind[];
}

/**
 * A binary run flag. Method-scoped for the same reason a choice is:
 * `oath-signature` offers a dry run on its uploaded packet and not on a typed
 * EID, because only the packet path has an irreversible write to suppress.
 */
export interface StartFlagWire {
  key: "dryRun" | "duplicateCheck";
  label: string;
  note: string;
  /** absent = offered on every method */
  methods?: StartMethodKind[];
}

export interface StartCapabilityWire {
  /** the peer methods this workflow can be started by, in offer order */
  methods: StartMethodWire[];
  /** the sub-selections, in the order the modal renders them */
  choices: StartChoiceWire[];
  /** the run flags this start offers */
  flags: StartFlagWire[];
  /** the one line saying what starting this workflow does */
  note: string;
}

function dryRunFlag(methods?: StartMethodKind[]): StartFlagWire {
  return {
    key: "dryRun",
    label: "Dry run",
    note: "Reads everything for real and writes nothing, anywhere. The row carries a dry-run chip for its whole life, so it can never be mistaken for a filing.",
    methods,
  };
}

const DUPLICATE_CHECK_FLAG: StartFlagWire = {
  key: "duplicateCheck",
  label: "Check for a duplicate first",
  note: "Refuses the start if this document has already been filed for this person, instead of filing it twice.",
};

// --- the served corpora a choice's options are drawn from -------------------

export interface RosterFileWire {
  path: string;
  sizeLabel: string;
  modifiedLabel: string;
}

/**
 * What the roster folder holds right now. Served, because "which rosters exist"
 * is a fact about the machine and not about the workflow — every roster-backed
 * start reads the same listing.
 */
export const DEMO_ROSTER_FILES: RosterFileWire[] = [
  { path: "UCSD_Roster_2026-07-25.xlsx", sizeLabel: "1.2 MB", modifiedLabel: "Jul 25, 6:02 AM" },
  { path: "UCSD_Roster_2026-07-18.xlsx", sizeLabel: "1.2 MB", modifiedLabel: "Jul 18, 6:01 AM" },
  { path: "RRSS_OT_Elections_2026-07-01.csv", sizeLabel: "34 KB", modifiedLabel: "Jul 1, 9:40 AM" },
];

/** the sentinel that tracks whatever is newest rather than pinning one file */
export const ROSTER_LATEST = "latest";

/** every OCR form spec, and what approving one releases */
const OCR_FORM_TYPE_OPTIONS: StartChoiceOptionWire[] = [
  { value: "oath", label: "Oath signature", note: "Approving signs each oath in UCPath and files one ServiceNow ticket for the document." },
  { value: "emergency-contact", label: "Emergency contact", note: "Approving fills each person's emergency contact in UCPath." },
  { value: "onbase-emergency-contact", label: "OnBase Emergency Contact", note: "Approving files each page under its person's record in OnBase." },
  { value: "verify", label: "Verify (mixed)", note: "A read-only completeness report. There is no approve step, so nothing is released." },
  { value: "i9", label: "I-9 (UCPath check)", note: "No approve gate: the review completes itself and fans out one UCPath check per person." },
];

/** the OnBase Import Document type list, exactly as the dropdown reads it */
const ONBASE_DOC_TYPE_OPTIONS: StartChoiceOptionWire[] = [
  { value: "X_HR_Emergency Contact", label: "Emergency Contact", note: "Personnel Records — the one type wired end to end today." },
  ...[
    ["X_HR_Benefits", "Benefits", "Payroll Records"],
    ["X_HR_Taxes", "Taxes", "Payroll Records"],
    ["X_HR_Awards and Honors", "Awards and Honors", "Personnel Records"],
    ["X_HR_Certifications and Licenses", "Certifications and Licenses", "Personnel Records"],
    ["X_HR_Disciplinary", "Disciplinary", "Personnel Records"],
    ["X_HR_Education", "Education", "Personnel Records"],
    ["X_HR_Employee Relations", "Employee Relations", "Personnel Records"],
    ["X_HR_General Correspondence", "General Correspondence", "Personnel Records"],
    ["X_HR_Hiring", "Hiring", "Personnel Records"],
    ["X_HR_Job Description", "Job Description", "Personnel Records"],
    ["X_HR_Labor Relations", "Labor Relations", "Personnel Records"],
    ["X_HR_Leaves", "Leaves", "Personnel Records"],
    ["X_HR_Miscellaneous", "Miscellaneous", "Personnel Records"],
    ["X_HR_Performance Evaluations", "Performance Evaluations", "Personnel Records"],
    ["X_HR_Personnel Document", "Personnel Document", "Personnel Records"],
    ["X_HR_Salary", "Salary", "Personnel Records"],
    ["X_HR_Separation", "Separation", "Personnel Records"],
    ["X_HR_Service Credit", "Service Credit", "Personnel Records"],
    ["X_HR_Staff Volunteers", "Staff Volunteers", "Personnel Records"],
    ["X_HR_Telecommuting", "Telecommuting", "Personnel Records"],
    ["X_HR_Timekeeping", "Timekeeping", "Personnel Records"],
    ["X_HR_Training", "Training", "Personnel Records"],
    ["X_HR_Work Schedule", "Work Schedule", "Personnel Records"],
  ].map(([value, label, group]) => ({
    value,
    label,
    note: group,
    unavailable: "no OCR form spec and no import mapping yet — it is in OnBase, it is not wired here",
  })),
];

/** Automation workers. `auto` lets the daemon pool decide. */
function workerChoice(visibleWhen?: StartChoiceWire["visibleWhen"], methods?: StartMethodKind[]): StartChoiceWire {
  return {
    key: "workers",
    label: "Automation workers",
    note: "How many browsers work this start in parallel. Every worker needs its own authenticated session.",
    defaultValue: "auto",
    visibleWhen,
    methods,
    options: [
      { value: "auto", label: "Auto", note: "as many as the daemon pool already has warm" },
      ...["1", "2", "4", "6", "8"].map((n) => ({ value: n, label: n })),
    ],
  };
}

/** The roster pair: where the roster comes from, then which file. */
function rosterChoices(scope: { visibleWhen?: StartChoiceWire["visibleWhen"]; methods?: StartMethodKind[] } = {}): StartChoiceWire[] {
  const { visibleWhen, methods } = scope;
  return [
    {
      key: "rosterSource",
      label: "Roster",
      note: "The roster is how a name read off paper becomes an EID without a lookup per person.",
      defaultValue: "existing",
      visibleWhen,
      methods,
      options: [
        { value: "existing", label: "Use a roster already on disk" },
        { value: "wait", label: "Wait for the queued SharePoint download", note: "a download is already queued — this start waits for it instead of starting a second one" },
        { value: "download", label: "Download a fresh roster from SharePoint", note: "delegates a SharePoint Download run and waits for it to land" },
        { value: "none", label: "No roster", note: "every record resolves by person lookup instead: slower, and a name that resolves to nobody stays unresolved" },
      ],
    },
    {
      key: "rosterFile",
      label: "Roster file",
      note: "Tracking the latest re-reads whichever file is newest at run time; pinning one runs against exactly that file.",
      defaultValue: ROSTER_LATEST,
      visibleWhen: { choice: "rosterSource", equals: ["existing"] },
      methods,
      options: [
        { value: ROSTER_LATEST, label: `Track the latest · ${DEMO_ROSTER_FILES[0].path}` },
        ...DEMO_ROSTER_FILES.map((r) => ({ value: r.path, label: r.path, note: `${r.sizeLabel} · modified ${r.modifiedLabel}` })),
      ],
    },
  ];
}

function lockedFormType(value: string, reason: string): StartChoiceWire {
  const option = OCR_FORM_TYPE_OPTIONS.find((o) => o.value === value);
  if (!option) throw new Error(`demo wire: no OCR form spec "${value}"`);
  return {
    key: "formType",
    label: "Form type",
    locked: true,
    lockedReason: reason,
    defaultValue: value,
    options: [option],
    note: option.note,
  };
}

/**
 * THE CAPABILITY VOCABULARY — the questions the capability page asks of every
 * descriptor. It lives HERE, with the descriptors, and not with the derivation
 * that reads it: a descriptor has to be able to name the capability it is
 * declining, and a type that lived downstream of the descriptor would make that
 * a circular dependency.
 *
 * Each key is answered by a FIELD above, never by an id:
 *
 *   startable / capture   `start.methods`
 *   dryRun / duplicateCheck  `start.flags`
 *   roster / workers / presets / subSelections  `start.choices`
 *   multiFile / merge     the upload method's own two booleans
 *   memberOutcomes        `memberOutcomes`
 *   delegation            `linkedPanel` + the Explorer graph's `delegatesTo`
 *   systemWrite           the Explorer graph's `write` nodes
 */
export type CapabilityKey =
  | "startable"
  | "dryRun"
  | "roster"
  | "workers"
  | "presets"
  | "capture"
  | "duplicateCheck"
  | "multiFile"
  | "merge"
  | "subSelections"
  | "memberOutcomes"
  | "delegation"
  | "systemWrite";

/**
 * TWO KINDS OF NO, and the difference is the point of serving them.
 *
 *   `not-applicable`  the capability makes no sense here — a read-only workflow
 *                     has no rehearsal to offer, because every run of it
 *                     already is one. This is a DESIGN answer and it is final.
 *   `not-built`       it would make sense and it is not wired yet. This is a
 *                     ROADMAP answer and it can change.
 *
 * An operator plans differently depending on which they are looking at, and one
 * grey dash for both is what makes "we decided against it" and "we have not got
 * to it" indistinguishable.
 */
export interface CapabilityAbsenceWire {
  state: "not-applicable" | "not-built";
  reason: string;
}

export type CapabilityAbsences = Partial<Record<CapabilityKey, CapabilityAbsenceWire>>;

/** the capability facts that are NOT about starting — shared by several descriptors */
const NO_MEMBERS: CapabilityAbsenceWire = {
  state: "not-applicable",
  reason: "This workflow does not fan out — it has one row and no members, so there is no member outcome to answer with.",
};
const NO_UPLOAD_MULTI: CapabilityAbsenceWire = {
  state: "not-applicable",
  reason: "It is not started from a file, so there is no second file to pick.",
};
const NO_UPLOAD_MERGE: CapabilityAbsenceWire = {
  state: "not-applicable",
  reason: "It is not started from a file, so there is nothing to merge.",
};
const NO_CAPTURE_YET: CapabilityAbsenceWire = {
  state: "not-built",
  reason: "Phone capture is wired for OCR-backed uploads only. This start would accept photographed pages just as well; nobody has connected it.",
};
const NO_DUP_CHECK: CapabilityAbsenceWire = {
  state: "not-built",
  reason: "The duplicate check is wired for Oath Upload's ServiceNow filing only. The same shape would apply here and is not built.",
};
const NO_PRESET: CapabilityAbsenceWire = {
  state: "not-applicable",
  reason: "Every step of this workflow is load-bearing — there is no subset of them that is a coherent run, so there is nothing for a preset to skip.",
};
const NO_ROSTER_TYPED: CapabilityAbsenceWire = {
  state: "not-applicable",
  reason: "The start already carries the identifier, so there is no name that needs a roster to become an employee ID.",
};
const NO_DELEGATION: CapabilityAbsenceWire = {
  state: "not-applicable",
  reason: "It does the whole job itself — no part of this workflow is another workflow's work.",
};

export interface DemoWorkflowRef {
  id: DemoWorkflowId;
  /** the 2-char `defineWorkflow` code — the first component of every trace id */
  code: string;
  label: string;
  /** the workflow's OWN category — the rail groups by this and nothing else */
  category: DemoWorkflowCategory;
  /**
   * The MAJOR half of the descriptor version: the run's SHAPE. It moves when a
   * step is added, removed or renamed, or when the data contract changes — the
   * cases where a run started under the old descriptor can no longer be
   * rendered by the new one. **This is the digit that forces archiving**, and it
   * is the only digit the archive keys on.
   */
  version: number;
  /**
   * The MINOR half: presentation only — a label, a title rule, a description.
   * Nothing archives, in-flight runs continue, and every old run still renders
   * correctly. Absent means `.0`.
   *
   * There is deliberately no third digit. A third would need a category that is
   * neither shape-breaking nor cosmetic, and a change invisible to a run does
   * not need a version at all.
   */
  minorVersion?: number;
  /** the systems this workflow drives; `resolvedInstance` is served per system */
  systems: SystemKey[];
  /**
   * The outcome vocabulary this workflow's member rows answer with. Absent =
   * this workflow's members carry no outcome, and their detail column falls
   * back to the free-text fact they already send.
   */
  memberOutcomes?: MemberOutcomeSpec[];
  /** how an operator starts this workflow. Absent = it is not startable. */
  start?: StartCapabilityWire;
  /**
   * Why it is not startable, when it is not. A workflow that simply vanishes
   * from the picker teaches the operator the list is arbitrary; one that says
   * "delegated only, and here is why" teaches them the shape of the product.
   */
  notStartable?: string;
  /**
   * Why a capability this workflow does NOT have is absent — the descriptor
   * explaining its own `no`.
   *
   * The capability page derives every YES from the fields above; what it cannot
   * derive is the DIFFERENCE between "this makes no sense here" and "this is
   * not wired yet", and that difference is the whole reason the page is worth
   * having. Composing the explanation in the UI would mean the UI deciding, for
   * example, that Person Lookup has no dry run *because it is read-only* — true
   * today, and still on the screen unchanged on the day it stops being.
   *
   * Read by `demo-capability-wire.ts`; a test asserts every absent capability
   * on every workflow has an entry here.
   */
  absences?: CapabilityAbsences;
}

/**
 * I-9 Check's member outcomes. Derived from what the fan-out can actually
 * conclude about one person, in the operator's words rather than the system's:
 * a UCPath match, no UCPath match, several people who could be them, a person
 * whose packet is missing a section, and a page that was never searchable at
 * all.
 *
 * `Found` is deliberately the QUIETEST of the five. It is the expected answer
 * on 40-odd of 50 rows, and an outcome column that shouts the ordinary case is
 * a column the eye stops reading.
 */
const I9_MEMBER_OUTCOMES: MemberOutcomeSpec[] = [
  {
    key: "found",
    label: "Found",
    tone: "quiet",
    meaning: "Matched one active UCPath person, and both I-9 sections were located in the packet.",
  },
  {
    key: "not-found",
    label: "Not found",
    tone: "danger",
    meaning: "UCPath returned no person for this name or EID. The roster row is left unmatched.",
  },
  {
    key: "unsure",
    label: "Unsure",
    tone: "warn",
    meaning: "More than one active UCPath person matches this name — the run is stopped until you pick one.",
  },
  {
    key: "incomplete",
    label: "Incomplete",
    tone: "warn",
    meaning: "The person was found, but a section of their I-9 is missing from the packet and has been flagged.",
  },
  {
    key: "not-searchable",
    label: "Not searchable",
    tone: "quiet",
    meaning: "The page carries no name to search on, so no check was ever possible for it.",
  },
];

/**
 * Person Lookup's member outcomes.
 *
 * The three answers ONE lookup comes back with, in the operator's words. It had
 * none, so its members put a free-text fact in the detail column — `resolved
 * 10510…` beside a column already holding `10510221` in full, and `found ·
 * INACTI…`, a truncated qualifier doing the work of an outcome. Two columns for
 * one fact, and the one that mattered was the one being cut.
 *
 * The decisions worth keeping:
 *
 *  - **`separated` is its own key, not a qualifier on a successful `resolved`.**
 *    UCPath found the person; what it reports is that they no longer work here,
 *    which is a different ANSWER, not a footnote on a good one. It is also the
 *    answer that blocks work downstream — an oath packet cannot sign a separated
 *    employee — so it has to be one word the eye catches in a scroll well.
 *  - **`resolved` is the QUIETEST of the three.** It is the expected answer on
 *    almost every row, and an outcome column that shouts the ordinary case is a
 *    column the eye stops reading.
 *  - **`not-found` is declared even though no MEMBER in today's corpus answers
 *    it.** It is demonstrably an answer this workflow gives — `pl-dana` is a
 *    person-lookup run that ended with zero UCPath matches — and a vocabulary
 *    pruned to whatever the current fixtures happen to contain is one that
 *    throws (`resolveMemberOutcome` fails loud) the first time a real member
 *    answers it. The vocabulary belongs to the workflow, not to the fixture.
 *  - **The EID never appears in an outcome.** It has its own column, in full.
 */
const PERSON_LOOKUP_MEMBER_OUTCOMES: MemberOutcomeSpec[] = [
  {
    key: "resolved",
    label: "Resolved",
    tone: "quiet",
    meaning: "Matched exactly one active UCPath person, and their EID is in the next column.",
  },
  {
    key: "separated",
    label: "Separated",
    tone: "warn",
    meaning: "The person exists in UCPath, but their HR status is inactive — they no longer work here, so anything downstream of this lookup is blocked.",
  },
  {
    key: "not-found",
    label: "Not found",
    tone: "danger",
    meaning: "UCPath returned nobody for this name or EID. Whatever asked for the lookup cannot proceed until the input is corrected.",
  },
];

/**
 * The client projection of `/api/workflow-definitions`. The Workflow Panel rail,
 * the row's workflow chip and the per-row `workflowVersion` all read THIS —
 * there is no second hand-written workflow list anywhere in the demo.
 */
/**
 * The client projection of `/api/workflow-definitions`.
 *
 * Every `category` here is the one the production descriptor declares — the
 * demo does not have a category scheme of its own, because the rail is the
 * registry's view of itself and inventing a second taxonomy is how a workflow
 * comes to sit in a different group in the demo than in the product.
 */
export const DEMO_WORKFLOWS: Record<DemoWorkflowId, DemoWorkflowRef> = {
  separations: {
    id: "separations",
    code: "se",
    label: "Separations",
    category: "Separations",
    version: 7,
    minorVersion: 2,
    systems: ["kuali", "ucpath", "kronos"],
    start: {
      note: "Files one separation per Kuali document — the UCPath transaction, the Kuali finalization and the Kronos pay-rule change.",
      methods: [
        {
          kind: "typed",
          label: "Kuali doc IDs",
          accepts: ["docId"],
          separator: "comma",
          placeholder: "3930, 3929",
          parserLabel: "Kuali document IDs, comma-separated — 3 to 6 digits each",
          note: "One run per document. The person's name is unknown until Kuali is read, so the row is titled with the doc ID until then.",
          examples: [
            { key: "two", label: "Two separations", values: ["3930", "3928"], note: "two typed doc IDs under one Group Row" },
            { key: "bad", label: "With a bad doc ID", values: ["3930", "39-30", "3928"], note: "entry validation refuses the line before anything is enqueued" },
            { key: "active", label: "One already running", values: ["3930", "3929"], note: "3929 already has an active Separations run — the server rejects it" },
          ],
        },
      ],
      choices: [
        {
          key: "preset",
          label: "Run mode",
          note: "A preset skips steps. It never changes what the remaining steps do.",
          defaultValue: "full",
          options: [
            { value: "full", label: "Full run", note: "every step: Kuali finalization, the UCPath transaction and the Kronos pay rule" },
            { value: "transactions-only", label: "Transactions only", note: "skips the Kuali finalization and the Kronos pay-rule step — files the UCPath transaction and stops" },
          ],
        },
        workerChoice(),
      ],
      flags: [dryRunFlag()],
    },
    absences: {
      roster: NO_ROSTER_TYPED,
      capture: NO_CAPTURE_YET,
      duplicateCheck: NO_DUP_CHECK,
      multiFile: NO_UPLOAD_MULTI,
      merge: NO_UPLOAD_MERGE,
      memberOutcomes: {
        state: "not-built",
        reason: "Several typed doc IDs do fan out into members, but no outcome vocabulary has been written for them — their detail column is still the free-text fact the run sends.",
      },
    },
  },
  onboarding: {
    id: "onboarding",
    code: "on",
    label: "Onboarding",
    category: "Onboarding",
    version: 11,
    minorVersion: 1,
    systems: ["crm", "ucpath", "i9", "kuali"],
    start: {
      note: "Walks one new hire from their CRM record through the UCPath hire, the I-9 and the Kuali onboarding document.",
      methods: [
        {
          kind: "typed",
          label: "Campus emails",
          accepts: ["email"],
          separator: "comma",
          placeholder: "mdelgado@ucsd.edu, riglesias@ucsd.edu",
          parserLabel: "Campus email addresses, comma-separated — the CRM record is found by email",
          note: "The hire's name comes from CRM, so the row is titled with the address until CRM resolves it.",
          examples: [
            { key: "two", label: "Two hires", values: ["mdelgado@ucsd.edu", "riglesias@ucsd.edu"], note: "titles stay as typed until CRM resolves them" },
            { key: "bad", label: "With a bad address", values: ["mdelgado@ucsd.edu", "riglesias@ucsd"], note: "a malformed address is refused per line" },
          ],
        },
      ],
      choices: [workerChoice()],
      flags: [dryRunFlag()],
    },
    absences: {
      roster: {
        state: "not-applicable",
        reason: "The start is a campus email and the hire's identity comes from their CRM record, so there is no name a roster could turn into an employee ID.",
      },
      presets: NO_PRESET,
      capture: NO_CAPTURE_YET,
      duplicateCheck: {
        state: "not-built",
        reason: "A hire filed twice is a real hazard here and the check is not wired. What stands in for it today is the UCPath person search, which is a step of the run rather than a refusal at the start.",
      },
      multiFile: NO_UPLOAD_MULTI,
      merge: NO_UPLOAD_MERGE,
      memberOutcomes: NO_MEMBERS,
      delegation: NO_DELEGATION,
    },
  },
  "person-lookup": {
    id: "person-lookup",
    code: "pl",
    label: "Person Lookup",
    category: "Search",
    version: 4,
    systems: ["ucpath", "crm"],
    memberOutcomes: PERSON_LOOKUP_MEMBER_OUTCOMES,
    start: {
      note: "Looks one person up in UCPath and CRM and reports what it found. It writes nothing, anywhere.",
      methods: [
        {
          kind: "typed",
          label: "EIDs or names",
          accepts: ["eid", "name"],
          separator: "semicolon",
          placeholder: "10084412; Battistessa, Johnnie",
          parserLabel: "EIDs or names, SEMICOLON-separated — a name holds a comma, so a comma cannot separate the list",
          note: "Each value is read on its own: all digits is an EID, anything else is a name.",
          examples: [
            { key: "mixed", label: "An EID and a name", values: ["10084412", "Battistessa, Johnnie"], note: "the same box takes both — nothing had to be typed twice" },
            { key: "two", label: "Two lookups", values: ["10084412", "10091755"], note: "a two-member group" },
          ],
        },
      ],
      choices: [workerChoice()],
      flags: [],
    },
    absences: {
      dryRun: {
        state: "not-applicable",
        reason: "It writes nothing, anywhere — every run of it is already a rehearsal, so a dry-run switch would be a control with no off state.",
      },
      roster: NO_ROSTER_TYPED,
      presets: NO_PRESET,
      capture: NO_CAPTURE_YET,
      duplicateCheck: {
        state: "not-applicable",
        reason: "Nothing is filed, so there is no second filing to refuse.",
      },
      multiFile: NO_UPLOAD_MULTI,
      merge: NO_UPLOAD_MERGE,
      delegation: NO_DELEGATION,
      systemWrite: {
        state: "not-applicable",
        reason: "Read-only by design. It is the workflow other workflows delegate to precisely because it cannot change anything.",
      },
    },
  },
  "person-match": {
    id: "person-match",
    code: "pm",
    label: "Person Match",
    category: "Search",
    version: 2,
    systems: ["ucpath"],
    notStartable:
      "Delegated only — and nothing has delegated to it since 2026-07-16. Inventing a start path for code nothing calls would be worse than leaving it absent.",
    absences: {
      memberOutcomes: NO_MEMBERS,
      delegation: NO_DELEGATION,
      systemWrite: {
        state: "not-applicable",
        reason: "Read-only. It compares two identities and answers; changing one is its caller's job.",
      },
    },
  },
  "i9-lookup": {
    id: "i9-lookup",
    code: "i9",
    label: "I-9 Lookup",
    category: "Search",
    version: 3,
    systems: ["i9"],
    notStartable: "Delegated only — an I-9 lookup is enrichment inside its parent's run, and on its own it would answer a question nobody asked.",
    absences: {
      memberOutcomes: NO_MEMBERS,
      delegation: NO_DELEGATION,
      systemWrite: {
        state: "not-applicable",
        reason: "Read-only. It reads the I-9 portal; creating a profile belongs to Onboarding, which is the workflow that knows a hire is real.",
      },
    },
  },
  "work-study": {
    id: "work-study",
    code: "ws",
    label: "Work-Study",
    category: "Work Study",
    version: 5,
    systems: ["ucpath"],
    start: {
      note: "Files one work-study transaction in UCPath for a person, effective on the date the run carries.",
      methods: [
        {
          kind: "typed",
          label: "EIDs",
          accepts: ["eid"],
          separator: "comma",
          placeholder: "10601188, 10084412",
          parserLabel: "UCPath EIDs, comma-separated — 8 digits each",
          note: "One run per person.",
          examples: [
            { key: "one", label: "A single person", values: ["10084412"], note: "one value mints a Run Row, not a group" },
            { key: "active", label: "One already running", values: ["10601188"], note: "10601188 is queued in this panel right now — the server rejects a second one" },
          ],
        },
        {
          kind: "spreadsheet",
          label: "Import a spreadsheet",
          note: "The award export becomes N runs — but only after a header row, a column mapping and a per-cell accept-or-reject on every row.",
        },
      ],
      // Scoped to the typed method on purpose: once the start is handed to the
      // intake, the intake owns every setting the runs are enqueued with, and a
      // worker count answered here would be answered again there.
      choices: [workerChoice(undefined, ["typed"])],
      flags: [dryRunFlag(["typed"])],
    },
    absences: {
      roster: NO_ROSTER_TYPED,
      presets: NO_PRESET,
      capture: NO_CAPTURE_YET,
      duplicateCheck: NO_DUP_CHECK,
      multiFile: NO_UPLOAD_MULTI,
      merge: NO_UPLOAD_MERGE,
      memberOutcomes: {
        state: "not-built",
        reason: "A spreadsheet import fans out into members and no outcome vocabulary has been written for them yet.",
      },
      delegation: NO_DELEGATION,
    },
  },
  "kronos-pay-rule": {
    id: "kronos-pay-rule",
    code: "kp",
    label: "Kronos Pay Rule",
    category: "Payroll",
    version: 3,
    systems: ["kronos"],
    start: {
      note: "Reads a person's union and current pay rule, decides the correct one, and updates it in Kronos.",
      methods: [
        {
          kind: "typed",
          label: "EIDs",
          accepts: ["eid"],
          separator: "comma",
          placeholder: "10312007, 10084412",
          parserLabel: "UCPath EIDs, comma-separated — 8 digits each",
          note: "One run per person.",
          examples: [{ key: "three", label: "Three pay rules", values: ["10312007", "10084412", "10091755"], note: "a three-member group" }],
        },
      ],
      choices: [workerChoice()],
      flags: [],
    },
    absences: {
      dryRun: {
        state: "not-built",
        reason: "It changes a pay rule in Kronos and honours no rehearsal. A dry run belongs here and is not wired — this is the one write in the product you cannot practise.",
      },
      roster: NO_ROSTER_TYPED,
      presets: NO_PRESET,
      capture: NO_CAPTURE_YET,
      duplicateCheck: {
        state: "not-applicable",
        reason: "Setting the same pay rule twice is the same pay rule — there is no duplicate to refuse.",
      },
      multiFile: NO_UPLOAD_MULTI,
      merge: NO_UPLOAD_MERGE,
      memberOutcomes: {
        state: "not-built",
        reason: "Several typed EIDs fan out into members and no outcome vocabulary has been written for them yet.",
      },
      delegation: NO_DELEGATION,
    },
  },
  ocr: {
    id: "ocr",
    code: "oc",
    label: "OCR",
    category: "Utils",
    version: 9,
    minorVersion: 1,
    systems: ["i9"],
    start: {
      note: "Reads a document and stops at a review. Started here it is STANDALONE: nothing delegated it, so approving would release no work and there is no approve step.",
      methods: [
        {
          kind: "upload",
          label: "Upload a PDF",
          accepts: ["pdf"],
          multiFile: true,
          merge: false,
          documentNoun: "document",
          coordinator: "review-only",
          note: "Each file becomes its own review — a standalone review has no target workflow and no fan-out.",
        },
      ],
      choices: [
        {
          key: "formType",
          label: "Form type",
          note: "Which spec reads the pages. A standalone run still declares one, because the spec is what decides which fields exist.",
          defaultValue: "verify",
          options: OCR_FORM_TYPE_OPTIONS,
        },
        ...rosterChoices(),
        workerChoice(),
      ],
      flags: [],
    },
    absences: {
      dryRun: {
        state: "not-applicable",
        reason: "A standalone review reads a document and stops. There is no approve step and no fan-out, so there is no write for a rehearsal to suppress.",
      },
      presets: NO_PRESET,
      capture: {
        state: "not-built",
        reason: "Photographed pages arrive through a TARGET workflow's start today. A standalone review would take them just as well and is not wired for it.",
      },
      duplicateCheck: {
        state: "not-applicable",
        reason: "Reading the same document twice files nothing twice — there is no duplicate to refuse.",
      },
      merge: {
        state: "not-applicable",
        reason: "Each file becomes its own review. Merging is an OnBase concern: it imports one file, so its pages have to arrive as one document.",
      },
      memberOutcomes: {
        state: "not-applicable",
        reason: "Approval IS delegation, so a standalone review has no fan-out and no members. The people it read are records in the review, not rows.",
      },
      systemWrite: {
        state: "not-applicable",
        reason: "It reads a document and parks at a review. Every write in an OCR-backed flow belongs to the target workflow the review releases.",
      },
    },
  },
  "oath-signature": {
    id: "oath-signature",
    code: "os",
    label: "Oath Signature",
    category: "Onboarding",
    version: 6,
    systems: ["ucpath"],
    start: {
      note: "Signs each person's oath in UCPath. No ServiceNow ticket — signing only.",
      methods: [
        {
          kind: "typed",
          label: "EIDs",
          accepts: ["eid"],
          separator: "comma",
          placeholder: "10084412, 10091755",
          parserLabel: "UCPath EIDs, comma-separated — 8 digits each",
          note: "Signs the oath for a person you already have an EID for. No document is read.",
          examples: [{ key: "two", label: "Two signers", values: ["10084412", "10091755"], note: "a two-member group" }],
        },
        {
          kind: "upload",
          label: "Upload a packet",
          accepts: ["pdf"],
          multiFile: true,
          merge: false,
          documentNoun: "oath packet",
          coordinator: "packet-group",
          note: "Reads every signer off the packet, then signs each oath in UCPath after you approve the review.",
        },
        {
          kind: "capture",
          label: "Photograph the pages",
          documentNoun: "oath packet",
          coordinator: "packet-group",
          note: "Photograph the packet on a phone. The pages arrive as they are taken and become the same packet an upload would.",
        },
      ],
      choices: [
        { ...lockedFormType("oath", "The target is Oath Signature, so the spec that reads the pages is fixed to Oath."), methods: ["upload", "capture"] },
        ...rosterChoices({ methods: ["upload", "capture"] }),
        workerChoice(),
      ],
      flags: [dryRunFlag(["upload", "capture"])],
    },
    absences: {
      presets: NO_PRESET,
      duplicateCheck: {
        state: "not-applicable",
        reason: "Signing an oath twice is the same signed oath. The duplicate check guards a ServiceNow FILING, which is Oath Upload's job and not this one's.",
      },
      merge: {
        state: "not-applicable",
        reason: "Each packet is its own set of signers. Two packets merged into one would put two departments' people under a single coordinator row.",
      },
      memberOutcomes: {
        state: "not-built",
        reason: "Its signers are member rows and no outcome vocabulary has been written for them — a signer's detail column is still the free-text fact the run sends.",
      },
    },
  },
  "oath-upload": {
    id: "oath-upload",
    code: "ou",
    label: "Oath Upload",
    category: "Onboarding",
    version: 6,
    systems: ["ucpath", "servicenow"],
    start: {
      note: "One row for the signed document: OCR prep → your approval → wait for the signers → file the ServiceNow ticket.",
      methods: [
        {
          kind: "upload",
          label: "Upload the signed document",
          accepts: ["pdf"],
          multiFile: true,
          merge: false,
          documentNoun: "signed oath document",
          coordinator: "single-run",
          linkedPanel: "oath-signature",
          linkedNoun: "signers",
          note: "ONE Run Row walks the whole document. Its signers are linked runs in the Oath Signature panel, never members of this row.",
        },
      ],
      choices: [
        {
          key: "mode",
          label: "What to do with it",
          note: "The two modes do genuinely different things, which is why one of them hides the roster and the workers.",
          defaultValue: "full",
          options: [
            { value: "full", label: "Full run", note: "read the document, wait for your approval, sign every signer, then file the ticket" },
            { value: "upload-only", label: "Upload only", note: "file one ServiceNow ticket with the PDF attached. Nothing is read, nothing is signed — so there is nothing to roster against and nothing to parallelize" },
          ],
        },
        lockedFormType("oath", "Oath Upload files an oath, so the spec that reads the pages is fixed to Oath."),
        ...rosterChoices({ visibleWhen: { choice: "mode", equals: ["full"] } }),
        workerChoice({ choice: "mode", equals: ["full"] }),
      ],
      flags: [dryRunFlag(), DUPLICATE_CHECK_FLAG],
    },
    absences: {
      capture: NO_CAPTURE_YET,
      presets: {
        state: "not-applicable",
        reason: "Its `What to do with it` choice is a MODE, not a preset: `Upload only` does a different job (one ticket, nothing read, nothing signed) rather than the same job with steps left out.",
      },
      merge: {
        state: "not-applicable",
        reason: "One row walks one signed document. Two documents merged would file one ticket for two things.",
      },
      memberOutcomes: {
        state: "not-applicable",
        reason: "It has no members by design — its signers are LINKED runs in the Oath Signature panel, each with its own row, receipt and retry.",
      },
    },
  },
  "emergency-contact": {
    id: "emergency-contact",
    code: "ec",
    label: "Emergency Contact",
    category: "Onboarding",
    version: 4,
    systems: ["ucpath"],
    start: {
      note: "Reads each employee's emergency contact off the form, then fills it in UCPath.",
      methods: [
        {
          kind: "upload",
          label: "Upload forms",
          accepts: ["pdf"],
          multiFile: true,
          merge: false,
          documentNoun: "contact form packet",
          coordinator: "packet-group",
          note: "Each file becomes its own packet — several files are several independent runs, never one merged document.",
        },
        {
          kind: "capture",
          label: "Photograph the forms",
          documentNoun: "contact form packet",
          coordinator: "packet-group",
          note: "Photograph the forms on a phone. The pages arrive as they are taken and become the same packet an upload would.",
        },
      ],
      choices: [
        lockedFormType("emergency-contact", "The target is Emergency Contact, so the spec that reads the pages is fixed to it."),
        ...rosterChoices(),
        workerChoice(),
      ],
      flags: [dryRunFlag()],
    },
    absences: {
      presets: NO_PRESET,
      duplicateCheck: NO_DUP_CHECK,
      merge: {
        state: "not-applicable",
        reason: "Each file is its own packet of people. Merging two would put two packets' contacts under one coordinator row.",
      },
      memberOutcomes: {
        state: "not-built",
        reason: "Each person is a member row and no outcome vocabulary has been written for them yet.",
      },
      delegation: {
        state: "not-applicable",
        reason: "The OCR review it runs is DELEGATED TO it, not by it — the review is a child of this packet, so the arrow points the other way.",
      },
    },
  },
  onbase: {
    id: "onbase",
    code: "ob",
    label: "OnBase",
    category: "OnBase",
    version: 5,
    systems: ["onbase", "ucpath"],
    start: {
      note: "Reads each person off the pages, then files the document under their record in OnBase.",
      methods: [
        {
          kind: "upload",
          label: "Upload pages",
          accepts: ["pdf"],
          multiFile: true,
          merge: true,
          documentNoun: "document",
          coordinator: "packet-group",
          note: "Several files MERGE into one document — OnBase imports a single file, so three PDFs become one three-page import rather than three runs.",
        },
      ],
      choices: [
        {
          key: "onbaseDocType",
          label: "Document type",
          note: "The exact type from OnBase's Import Document screen. It decides the keyword set the import fills.",
          defaultValue: "X_HR_Emergency Contact",
          options: ONBASE_DOC_TYPE_OPTIONS,
        },
        ...rosterChoices(),
        workerChoice(),
      ],
      flags: [dryRunFlag()],
    },
    absences: {
      presets: NO_PRESET,
      capture: NO_CAPTURE_YET,
      duplicateCheck: {
        state: "not-built",
        reason: "Filing the same page under the same person twice is a real hazard in OnBase and the check is not wired here — it exists only on Oath Upload's ServiceNow filing.",
      },
      memberOutcomes: {
        state: "not-built",
        reason: "Each person is a member row and no outcome vocabulary has been written for them yet.",
      },
      delegation: {
        state: "not-applicable",
        reason: "The OCR review it runs is DELEGATED TO it, not by it — the review is a child of this document, so the arrow points the other way.",
      },
    },
  },
  "i9-check": {
    id: "i9-check",
    code: "ic",
    label: "I-9 Check",
    category: "Separations",
    version: 2,
    systems: ["ucpath", "i9"],
    memberOutcomes: I9_MEMBER_OUTCOMES,
    start: {
      note: "Reads each person off the scan, searches UCPath for them, and appends the retention tracker. The review completes itself — there is nothing to approve.",
      methods: [
        {
          kind: "upload",
          label: "Upload the scan",
          accepts: ["pdf"],
          multiFile: true,
          merge: false,
          documentNoun: "I-9 roster scan",
          coordinator: "packet-group",
          note: "One member per person on the scan, created when the review completes rather than when you approve it.",
        },
      ],
      // No roster and no dry run, and the absence is the honest answer rather
      // than an oversight: an I-9 check reads UCPath and appends a tracker, so
      // there is no roster to match against and no write for a rehearsal to
      // suppress.
      choices: [
        lockedFormType("i9", "The target is I-9 Check, so the spec that reads the pages is fixed to I-9."),
        workerChoice(),
      ],
      flags: [],
    },
    absences: {
      dryRun: {
        state: "not-applicable",
        reason: "It reads UCPath and appends the retention tracker — a local file, not a system of record. There is no HR write for a rehearsal to suppress.",
      },
      roster: {
        state: "not-applicable",
        reason: "The scan IS the roster. Each person on it is searched in UCPath by name, which is the work rather than a shortcut around it.",
      },
      presets: NO_PRESET,
      capture: NO_CAPTURE_YET,
      duplicateCheck: {
        state: "not-applicable",
        reason: "Checking the same person twice appends the tracker twice and changes nothing about them — there is no filing to refuse.",
      },
      merge: {
        state: "not-applicable",
        reason: "Each scan is its own batch of people.",
      },
      delegation: {
        state: "not-applicable",
        reason: "The OCR review it runs is DELEGATED TO it, not by it — the review is a child of this scan, so the arrow points the other way.",
      },
      systemWrite: {
        state: "not-applicable",
        reason: "It reads UCPath and appends a local retention tracker. Nothing in UCPath, Kuali, Kronos, OnBase or the I-9 portal changes.",
      },
    },
  },
  "crm-doc-download": {
    id: "crm-doc-download",
    code: "cd",
    label: "CRM Doc Download",
    category: "Utils",
    version: 3,
    systems: ["crm"],
    start: {
      note: "Finds a person's onboarding record in CRM and downloads the documents attached to it.",
      methods: [
        {
          kind: "typed",
          label: "EIDs or emails",
          accepts: ["eid", "email"],
          separator: "comma",
          placeholder: "10084412, samuel.ortiz@ucsd.edu",
          parserLabel: "EIDs or campus emails, comma-separated — each value is read on its own",
          note: "The same box takes both: all digits is an EID, anything with an @ is an email.",
          examples: [
            { key: "mixed", label: "An EID and an email", values: ["10084412", "samuel.ortiz@ucsd.edu"], note: "per-token discrimination — nothing had to be typed twice" },
          ],
        },
      ],
      choices: [workerChoice()],
      flags: [],
    },
    absences: {
      dryRun: {
        state: "not-applicable",
        reason: "Its whole product is a file on disk. A downloaded document is an output, not a write — nothing about it needs undoing, so there is nothing to rehearse.",
      },
      roster: NO_ROSTER_TYPED,
      presets: NO_PRESET,
      capture: NO_CAPTURE_YET,
      duplicateCheck: {
        state: "not-applicable",
        reason: "Downloading the same document twice overwrites a file. Nothing is filed, so there is no duplicate to refuse.",
      },
      multiFile: NO_UPLOAD_MULTI,
      merge: NO_UPLOAD_MERGE,
      memberOutcomes: {
        state: "not-built",
        reason: "Several typed values fan out into members and no outcome vocabulary has been written for them yet.",
      },
      delegation: NO_DELEGATION,
      systemWrite: {
        state: "not-applicable",
        reason: "It downloads files. No HR record anywhere changes.",
      },
    },
  },
  "sharepoint-download": {
    id: "sharepoint-download",
    code: "sp",
    label: "SharePoint Download",
    category: "Utils",
    version: 2,
    systems: ["crm"],
    start: {
      note: "Downloads the current roster export from SharePoint into the roster folder. Every roster-backed start reads whatever this leaves behind.",
      methods: [
        {
          kind: "bare",
          label: "Run it",
          note: "There is nothing to type and nothing to pick — the run IS the instruction. It takes one row and leaves one file.",
        },
      ],
      // Deliberately empty. A download has no roster to pick, no form spec, no
      // document type and nothing to parallelize, so the modal shows no
      // sub-selections at all rather than an empty section pretending there
      // was a decision to make.
      choices: [],
      flags: [],
    },
    absences: {
      dryRun: {
        state: "not-applicable",
        reason: "Its whole product is a file on disk. A download is an output, not a write, so there is nothing for a rehearsal to stop short of.",
      },
      roster: {
        state: "not-applicable",
        reason: "It IS the roster download. Every roster-backed start reads whatever this leaves behind.",
      },
      workers: {
        state: "not-applicable",
        reason: "One run, one file. There is nothing to split across a second browser.",
      },
      presets: NO_PRESET,
      capture: {
        state: "not-applicable",
        reason: "There is no document to photograph — the run takes no subject at all.",
      },
      duplicateCheck: {
        state: "not-applicable",
        reason: "A second download overwrites a file and files nothing.",
      },
      multiFile: NO_UPLOAD_MULTI,
      merge: NO_UPLOAD_MERGE,
      subSelections: {
        state: "not-applicable",
        reason: "There is nothing to decide: no roster to pick, no form spec, no document type and nothing to parallelize. The run IS the instruction.",
      },
      memberOutcomes: NO_MEMBERS,
      delegation: NO_DELEGATION,
      systemWrite: {
        state: "not-applicable",
        reason: "It leaves one file in the roster folder. No HR record anywhere changes.",
      },
    },
  },
  "old-kronos-reports": {
    id: "old-kronos-reports",
    code: "kr",
    label: "Old Kronos Reports",
    category: "Timekeeping",
    version: 4,
    systems: ["kronos"],
    start: {
      note: "Builds and downloads a timekeeping report into the reports folder. It writes no HR record — the output is a file.",
      methods: [
        {
          kind: "bare",
          label: "Run the report",
          note: "There is nothing to type. The span below is the whole instruction, and it takes one row.",
        },
      ],
      choices: [
        {
          key: "reportSpan",
          label: "Report span",
          note: "How much of the timekeeping history the report builder has to assemble.",
          defaultValue: "pay-period",
          options: [
            { value: "week", label: "One week" },
            { value: "pay-period", label: "Pay period" },
            { value: "quarter", label: "Quarter to date", note: "the builder is slow on this one — the patience below tracks it" },
          ],
        },
        {
          key: "reportPatience",
          label: "How long to wait for the builder",
          note: "A quarter-span report is not a slow one-week report; the wait belongs to the run, not to the machine.",
          defaultValue: "auto",
          options: [
            { value: "auto", label: "Match the span", note: "the server derives it — 4m for a week, 7m for a pay period, 15m for a quarter" },
            { value: "240", label: "4 minutes" },
            { value: "420", label: "7 minutes" },
            { value: "900", label: "15 minutes" },
          ],
        },
      ],
      flags: [],
    },
    absences: {
      dryRun: {
        state: "not-applicable",
        reason: "Its whole product is a file on disk. A report is an output, not a write — nothing about it needs undoing.",
      },
      roster: {
        state: "not-applicable",
        reason: "The report is built from Kronos' own timekeeping data; there are no names to resolve.",
      },
      workers: {
        state: "not-applicable",
        reason: "One run builds one report. Kronos assembles it server-side, so a second browser would sit and wait beside the first.",
      },
      presets: NO_PRESET,
      capture: {
        state: "not-applicable",
        reason: "There is no document to photograph — the run takes no subject at all.",
      },
      duplicateCheck: {
        state: "not-applicable",
        reason: "Building the same report twice leaves two files and files nothing.",
      },
      multiFile: NO_UPLOAD_MULTI,
      merge: NO_UPLOAD_MERGE,
      memberOutcomes: NO_MEMBERS,
      delegation: NO_DELEGATION,
      systemWrite: {
        state: "not-applicable",
        reason: "It leaves report files in the reports folder. No HR record anywhere changes.",
      },
    },
  },
};

export const DEMO_WORKFLOW_LIST: DemoWorkflowRef[] = Object.values(DEMO_WORKFLOWS);

// ---------------------------------------------------------------------------
// Descriptor version — `major.minor`, and the three things it is NOT
// ---------------------------------------------------------------------------

/**
 * A descriptor version is two parts because there is exactly one distinction
 * that changes what somebody does:
 *
 *  - **major** — the run's SHAPE moved (steps added / removed / renamed, or the
 *    data contract changed). Runs started under the old descriptor cannot be
 *    rendered by the new one, so a major bump ARCHIVES every prior-version run.
 *  - **minor** — presentation only. Nothing archives, in-flight runs continue,
 *    old runs still render correctly.
 *
 * ONE integer used to play three roles at once — descriptor identity, archive
 * key and the enqueue form's CAS token — while a DIFFERENT integer was the row
 * CAS token, and both reached the operator as the word "version". The three are
 * separated here so a refusal can name the right one:
 *
 *  - identity is `major.minor`, and is what is displayed;
 *  - the archive keys on `major` alone (`archiveKey`);
 *  - the start form's CAS token is `startContractToken` — an opaque string, not
 *    a version, that moves only when the shape does.
 *
 * The row CAS token is a fourth thing entirely (a per-row revision) and lives
 * on the action descriptor; it is never called a version in copy.
 */
export interface DescriptorVersion {
  major: number;
  minor: number;
}

export function descriptorVersion(workflow: DemoWorkflowRef): DescriptorVersion {
  return { major: workflow.version, minor: workflow.minorVersion ?? 0 };
}

/** `7.2` — the two-part identity, never a bare integer */
export function fmtVersion(version: DescriptorVersion): string {
  return `${version.major}.${version.minor}`;
}

/** `v7.2` — every place a descriptor version is shown to the operator */
export function fmtVersionTag(version: DescriptorVersion): string {
  return `v${fmtVersion(version)}`;
}

/** the workflow's current descriptor version, as it is displayed */
export function workflowVersionTag(workflow: DemoWorkflowRef): string {
  return fmtVersionTag(descriptorVersion(workflow));
}

/**
 * What the ARCHIVE keys on. Only the major digit: a minor bump changes nothing
 * a stored run needs, so it archives nothing and cannot make a run un-openable.
 */
export function archiveKey(version: DescriptorVersion): number {
  return version.major;
}

/**
 * The START FORM's CAS token. Deliberately a string that does not look like a
 * version: a form is not stale because a label was reworded, it is stale
 * because the SHAPE it was built against moved. Comparing this instead of a
 * version number is what lets a minor bump leave every open form valid.
 */
export function startContractToken(workflow: DemoWorkflowRef, major = workflow.version): string {
  return `${workflow.code}-c${major}`;
}

/** one rail group: a category heading and the workflows the registry binned under it */
export interface WorkflowCategoryGroup {
  label: string;
  workflows: DemoWorkflowRef[];
}

/**
 * Group the registry by each descriptor's OWN category, in the display order
 * above. This is the mock server's rail projection, and it mirrors production's
 * `computeDisplayGroups` exactly:
 *
 *  - a workflow bins by `category`; one that declares none bins into `Other`;
 *  - listed categories come first in `order`, then any newly-seen category in
 *    first-seen order, and `Other` is always last;
 *  - **a category with no workflows is dropped**, so an order entry for a group
 *    nothing is registered under (production's `Timekeeping` in a dashboard
 *    process that never imported Old Kronos Reports) costs nothing and needs no
 *    edit when it is registered later.
 */
export function buildWorkflowCategoryGroups(
  workflows: readonly DemoWorkflowRef[] = DEMO_WORKFLOW_LIST,
  order: readonly string[] = DEMO_CATEGORY_ORDER,
): WorkflowCategoryGroup[] {
  const byCategory = new Map<string, DemoWorkflowRef[]>();
  const seenOrder: string[] = [];
  for (const w of workflows) {
    const category = w.category || DEMO_CATEGORY_OTHER;
    let bin = byCategory.get(category);
    if (!bin) {
      bin = [];
      byCategory.set(category, bin);
      seenOrder.push(category);
    }
    bin.push(w);
  }

  const ordered: string[] = [];
  for (const category of order) if (byCategory.has(category)) ordered.push(category);
  for (const category of seenOrder) {
    if (category === DEMO_CATEGORY_OTHER) continue;
    if (order.includes(category)) continue;
    ordered.push(category);
  }
  if (byCategory.has(DEMO_CATEGORY_OTHER)) ordered.push(DEMO_CATEGORY_OTHER);

  return ordered.map((label) => ({ label, workflows: byCategory.get(label) ?? [] }));
}

// ---------------------------------------------------------------------------
// Start-capability resolution — the whole of what the Run Modal branches on
// ---------------------------------------------------------------------------

/** every workflow an operator may start, in registry order */
export function startableWorkflows(workflows: readonly DemoWorkflowRef[] = DEMO_WORKFLOW_LIST): DemoWorkflowRef[] {
  return workflows.filter((w) => w.start !== undefined);
}

/** every workflow that is NOT startable, each carrying its own reason */
export function unstartableWorkflows(
  workflows: readonly DemoWorkflowRef[] = DEMO_WORKFLOW_LIST,
): { workflow: DemoWorkflowRef; reason: string }[] {
  return workflows
    .filter((w) => w.start === undefined)
    .map((w) => ({
      workflow: w,
      // A workflow with no start and no reason is a registry defect, not a
      // display case: say so rather than render a blank line.
      reason: w.notStartable ?? "No start path is declared, and no reason was served for that.",
    }));
}

/** the picker's groups — the SAME category projection the rail uses, startable only */
export function startWorkflowGroups(workflows: readonly DemoWorkflowRef[] = DEMO_WORKFLOW_LIST): WorkflowCategoryGroup[] {
  return buildWorkflowCategoryGroups(startableWorkflows(workflows));
}

/**
 * The start capability, or a loud failure. Every caller here already knows the
 * workflow is startable (the picker only offers startable ones), so reaching
 * this with an unstartable id is a routing bug, and a `?? {}` would draw an
 * empty modal instead of naming it.
 */
export function requireStartCapability(workflow: DemoWorkflowRef): StartCapabilityWire {
  if (!workflow.start) {
    throw new Error(`demo wire: ${workflow.label} (${workflow.id}) declares no start capability — it is not startable`);
  }
  return workflow.start;
}

/** the method matching a kind, or a loud failure — a kind is never guessed */
export function requireStartMethod(capability: StartCapabilityWire, kind: StartMethodKind): StartMethodWire {
  const found = capability.methods.find((m) => m.kind === kind);
  if (!found) {
    throw new Error(`demo wire: this start declares no "${kind}" method — it offers [${capability.methods.map((m) => m.kind).join(", ")}]`);
  }
  return found;
}

/** every choice's declared default — the value set a fresh modal opens on */
export function defaultChoiceValues(capability: StartCapabilityWire): Record<string, string> {
  const out: Record<string, string> = {};
  for (const choice of capability.choices) out[choice.key] = choice.defaultValue;
  return out;
}

/**
 * The sub-selections this method + this value set actually offers.
 *
 * Both filters are load-bearing and neither is a UI preference: `methods`
 * expresses that a typed EID has no roster to match against, and `visibleWhen`
 * expresses that Oath Upload's upload-only mode reads nothing (so there is
 * nothing to roster and nothing to parallelize). A hidden choice is not a
 * disabled one — it is a decision this start does not have.
 */
export function visibleChoices(
  capability: StartCapabilityWire,
  method: StartMethodKind,
  values: Record<string, string>,
): StartChoiceWire[] {
  const shown: StartChoiceWire[] = [];
  for (const choice of capability.choices) {
    if (choice.methods && !choice.methods.includes(method)) continue;
    if (choice.visibleWhen) {
      const gate = capability.choices.find((c) => c.key === choice.visibleWhen?.choice);
      // A gate that names a choice this start does not declare is a contract
      // break, not a reason to show the dependent choice anyway.
      if (!gate) throw new Error(`demo wire: choice "${choice.key}" is gated on "${choice.visibleWhen.choice}", which this start does not declare`);
      const gateShown = shown.some((c) => c.key === gate.key);
      const gateValue = values[gate.key] ?? gate.defaultValue;
      if (!gateShown || !choice.visibleWhen.equals.includes(gateValue)) continue;
    }
    shown.push(choice);
  }
  return shown;
}

/** the values that will actually be SENT — a hidden choice sends nothing */
export function effectiveChoiceValues(
  capability: StartCapabilityWire,
  method: StartMethodKind,
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const choice of visibleChoices(capability, method, values)) {
    out[choice.key] = values[choice.key] ?? choice.defaultValue;
  }
  return out;
}

/** the run flags this method offers */
export function visibleFlags(capability: StartCapabilityWire, method: StartMethodKind): StartFlagWire[] {
  return capability.flags.filter((f) => !f.methods || f.methods.includes(method));
}

/** an option's label, for a value the modal is showing back to the operator */
export function choiceOptionLabel(choice: StartChoiceWire, value: string): string {
  const found = choice.options.find((o) => o.value === value);
  if (!found) throw new Error(`demo wire: "${value}" is not an option of choice "${choice.key}"`);
  return found.label;
}

/**
 * Resolve a member row's outcome KEY against the vocabulary its workflow
 * declares — and FAIL LOUD when it does not resolve.
 *
 * A key the workflow never declared is a contract break, not a display quirk:
 * silently dropping it would leave a member row that says nothing about what it
 * found while every neighbouring row does, which reads as "still working".
 */
export function resolveMemberOutcome(workflow: DemoWorkflowRef, key: string): MemberOutcomeSpec {
  const found = workflow.memberOutcomes?.find((o) => o.key === key);
  if (!found) {
    throw new Error(
      `demo wire: ${workflow.label} (${workflow.id}) declares no member outcome "${key}" — ` +
        `its vocabulary is [${(workflow.memberOutcomes ?? []).map((o) => o.key).join(", ") || "none"}]`,
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// Detail routing — capability-driven tabs
// ---------------------------------------------------------------------------

/**
 * `data` is NOT a tab. The merged Data surface (D19c) lives in the run's
 * CONTEXT RAIL, beside the log stream rather than instead of it — the operator
 * has to watch the stream and read what the run touched at the same time, and
 * two mutually-exclusive tabs made that impossible. The surface itself is
 * unchanged: reads are still editable (through `Edit & re-run`), writes are
 * still shown and never editable, staged is still staged.
 */
export type DemoTab = "logs" | "review" | "receipt" | "people";

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
 *  - Screenshots is not a tab at all — evidence is a rail SECTION (D19b).
 *  - Data and Edit Data are ONE surface (D19c) — and that one surface is the
 *    rail's, not a tab's, so it can be read WHILE the stream runs.
 */
export function tabsFor(row: Pick<DemoRow, "rowType" | "records">): DemoTab[] {
  return tabsForPanelKind(panelKindOf(row));
}

/**
 * The same derivation, addressed by KIND rather than by a row.
 *
 * It exists because the row-and-panel catalog documents the panel kinds without
 * holding a row of each, and a catalog that keeps its own copy of this list is
 * a catalog that documents a UI which no longer exists — which is exactly what
 * happened: it still declared a `Data` tab a wave after Data moved to the
 * context rail. There is one list now, and the catalog reads it.
 */
export function tabsForPanelKind(kind: PanelKind): DemoTab[] {
  if (kind === "review") return ["review", "logs", "receipt"];
  if (kind === "group") return ["people", "logs", "receipt"];
  return ["logs", "receipt"];
}

/**
 * The word each tab is drawn with. It lives beside the derivation, not in the
 * panel component, so the catalog can name a tab without importing the panel
 * (and without re-typing the word, which is the other half of the same drift).
 * `TAB_META` in `DemoLogPanel` composes this with the tab's icon.
 */
export const TAB_LABEL: Record<DemoTab, string> = {
  people: "People",
  review: "Review",
  logs: "Logs",
  receipt: "Receipt",
};

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
  | "edit-checkpoint"
  /**
   * Save the corrected checkpoint AND release the SAME run to carry on from the
   * step it stopped at — same runId, same lineage, same receipt. Distinct from
   * `rerun-with-existing-data`, which mints a NEW run: those are the two
   * outcomes the merged Data surface has to keep apart, because one continues a
   * history and the other starts one.
   */
  | "continue-with-data"
  | "rerun-with-existing-data"
  | "rerun-with-different-input";

/**
 * Where a descriptor renders. One descriptor can appear in more than one place.
 * `data` is the merged Data surface's own footer (D19c) — the same descriptor
 * protocol as every other control, so the Save button is not a special case.
 */
export type ActionPlacement = "footer" | "banner" | "outcome" | "menu" | "data";

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
  /**
   * The typed body of a command that carries one — a parked write's proof or
   * evidence note, a checkpoint patch. The surface COLLECTS it (in a form the
   * server's schema describes) and the command service PARSES it, so a bad
   * proof comes back `rejected` from the same protocol as everything else
   * rather than being validated only in the browser.
   */
  payload?: Record<string, string>;
  /** navigation kind only */
  navigate?: { kind: "self" | "panel" | "drill"; workflow?: string; runId?: string };
}

/**
 * One person a gate is asking the operator to choose between.
 *
 * `captureId` is the load-bearing addition: an identity gate that shows two
 * names and no pictures is asking the operator to pick between two strings.
 * The backend captures the candidate AS IT APPEARED in the source system at
 * resolution time and retains it with the run, so the choice is made against
 * evidence. A candidate with no capture renders as a candidate with no
 * capture — it never borrows another one, and it says so.
 *
 * The list is a LIST. Two is the common case, not the contract: a name search
 * can return three or five, and a surface that hard-codes a two-way choice
 * would have to silently drop the rest.
 */
export interface GateCandidateSpec {
  heading: string;
  name: string;
  sub: string;
  /** the identifier picking this candidate would bind the run to */
  eid?: string;
  /** what made this candidate a candidate — never "the system said so" */
  matchedOn?: string;
  /** the retained capture of this candidate in the source system */
  captureId?: string;
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
// Operator corrections to an extracted record (D8 / D19c, review surface)
// ---------------------------------------------------------------------------

/** where an extracted value came from. `operator` is a value a HUMAN typed. */
export type RecordFieldSource = "paper" | "roster" | "ucpath" | "operator";

/**
 * One value the operator changed on a review surface, as the approve command
 * carries it.
 *
 * Two fields here exist to stop the same lie. A machine read a name off a scan
 * at 0.97 confidence; the operator then re-typed it. The new value is NOT a
 * 0.97 paper read — it is an operator correction with no model confidence at
 * all, and the number that belonged to the old value must not follow the new
 * one. So `from` and `priorConfidence` keep the machine read verbatim, the
 * corrected field's source becomes `operator`, and its confidence is dropped
 * rather than inherited.
 *
 * A correction is EVIDENCE: it rides the approval into the run's receipt beside
 * the value it replaced, attributed and timestamped, so a later reader can tell
 * what the document said from what a person decided it said.
 */
export interface RecordCorrectionWire {
  recordId: string;
  field: string;
  /** the machine-read value, kept exactly as it was read */
  from: string;
  /** what the operator typed */
  to: string;
  priorSource: RecordFieldSource;
  /** the model confidence of the value being REPLACED — never of the new one */
  priorConfidence?: number;
  correctedBy: string;
  correctedAt: string;
}

export interface RecordFieldReading {
  label: string;
  value: string;
  source: RecordFieldSource;
  confidence?: number;
}

/**
 * Turn a record's fields plus the operator's edit map into the corrections the
 * approve command carries. Pure, and the ONE place a correction is minted, so
 * the count shown on the approve bar and the list written to the receipt can
 * never be two different derivations.
 *
 * `edits` is keyed `<recordId>:<field label>` — the same key the surface types
 * into — and an edit equal to the read value is not a correction.
 */
export function buildRecordCorrections(
  recordId: string,
  fields: RecordFieldReading[],
  edits: Record<string, string>,
  correctedAt: string,
  correctedBy: string = DEMO_OPERATOR,
): RecordCorrectionWire[] {
  const out: RecordCorrectionWire[] = [];
  for (const f of fields) {
    const typed = edits[`${recordId}:${f.label}`];
    if (typed === undefined || typed === f.value) continue;
    out.push({
      recordId,
      field: f.label,
      from: f.value,
      to: typed,
      priorSource: f.source,
      priorConfidence: f.confidence,
      correctedBy,
      correctedAt,
    });
  }
  return out;
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
      placement: ["footer", "menu"],
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
    placement: ["footer", "menu"],
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
    placement: ["footer", "menu"],
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
  // THE FOOTER ↺. On a row that failed at a DELEGATED child it is the only
  // replay left — the outcome bar's `Retry the lookup` twin is gone (item 19)
  // — so it inherits that twin's confirm: same command, same replayed child,
  // and the operator still reads what the replay does and what it will not
  // touch before it happens. An ordinary failure keeps the bare ↺; there is
  // nothing non-obvious to promise about retrying your own run.
  const replaysDelegatedChild = spec.mirroredFrom !== undefined && spec.subjectKind !== "file";
  const retry: ActionDescriptorWire = {
    key: "retry",
    kind: "command",
    command: "retry",
    label: replaysDelegatedChild ? "Retry the lookup" : "Retry",
    intent: "primary",
    icon: "retry",
    placement: ["footer", "menu"],
    expectedVersion: v,
    confirm: replaysDelegatedChild
      ? {
          title: "Replay the delegated lookup?",
          body: `The CHILD run is replayed under its own task id, so this ${ctx.workflow.label} run resumes behind it instead of starting over. Nothing that already ran is repeated, and nothing has been written to ${ctx.workflow.systems.join(" / ")}.`,
          confirmLabel: "Retry the lookup",
          tone: "neutral",
        }
      : undefined,
  };
  const hide: ActionDescriptorWire = {
    key: "hide",
    kind: "command",
    command: "hide",
    label: "Delete",
    intent: "destructive",
    icon: "delete",
    placement: ["footer", "menu"],
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
        placement: ["footer", "menu"],
        expectedVersion: v,
      });
      out.push(isGroup ? cancelTree : cancelRun);
      break;
    case "running":
    case "waiting":
      out.push(isGroup ? cancelTree : cancelRun);
      break;
    case "parked":
      // NO RETRY AND NO RESUME — a blind retry on a write whose outcome is
      // unknown is how you terminate somebody twice (D20). The two typed
      // resolutions already pushed from `gate.options` are the only ways to
      // settle the write itself.
      //
      // CANCEL IS NOT ONE OF THOSE, and withholding it was the bug. Operator:
      // *"even for write parked, it should still have the x at footer for
      // cancellation."* Cancelling stops the RUN; it does not claim the
      // submitted write did or did not land, and it never reverses anything —
      // which is exactly what the confirm copy has always said. A parked row
      // was the only row in the product with an empty footer, so the operator
      // could not stop a run that was going nowhere without first resolving a
      // write they may have had no way to resolve yet.
      out.push(
        isGroup
          ? cancelTree
          : {
              ...cancelRun,
              confirm: {
                title: `Cancel ${ctx.title}?`,
                body: `The run stops where it is. This does NOT settle the parked write — whether the submit landed in ${ctx.workflow.systems.join(" / ")} is still unknown, and cancelling neither confirms it nor reverses it. Record the outcome with one of the two resolutions when you know it.`,
                confirmLabel: "Cancel run",
                tone: "destructive",
              },
            },
      );
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

  // 3b. The merged Data surface's own controls (D19c). They are descriptors
  //     like everything else, which is what keeps "Save" out of the client's
  //     hands: a row whose checkpoint may not be edited simply is not sent one.
  //
  //     The surface offers exactly TWO outcomes and never blurs them:
  //       · this run carries on with these values  (same runId, same receipt)
  //       · a NEW run starts from these values     (its own trace, its own receipt)
  //     Which "save" arm appears depends on whether there is anything left to
  //     continue — a finished run has a checkpoint to correct but no work to
  //     release, so it is sent `edit-checkpoint`, not `continue-with-data`.
  //
  //     PARKED IS SENT NOTHING. A parked write's outcome is unknown, so
  //     starting a run from its data is how a person gets terminated twice
  //     (D20). The two typed park resolutions are its only exits, and they are
  //     already on the gate.
  const reads = spec.data.filter((d) => d.dir === "read").length;
  const live = ctx.status === "running" || ctx.status === "queued";
  const resumable = ctx.status === "failed" || ctx.status === "cancelled";
  if (reads > 0 && !live && ctx.status !== "parked") {
    out.push(
      resumable
        ? {
            key: "continue-with-data",
            kind: "command",
            command: "continue-with-data",
            label: "Save & continue",
            detail:
              "Saves your corrections to this run's checkpoint and releases the SAME run to carry on from the step it stopped at. It keeps its run id, its attempt history and its receipt.",
            intent: "primary",
            icon: "resolve",
            placement: ["data"],
            expectedVersion: v,
          }
        : {
            key: "save-checkpoint",
            kind: "command",
            command: "edit-checkpoint",
            label: "Save corrections",
            detail:
              "Writes your corrected values back to this run's checkpoint. Carries the generation your view was captured at. It does not release any work — nothing on this run is waiting on a value.",
            intent: "neutral",
            icon: "resolve",
            placement: ["data"],
            expectedVersion: v,
          },
    );
    out.push({
      key: "rerun-existing",
      kind: "command",
      command: "rerun-with-existing-data",
      label: "Start a new run",
      detail:
        "Enqueues a FRESH run on the current workflow version using these values. This row keeps its own history; the two are separate runs with separate receipts.",
      intent: resumable ? "neutral" : "primary",
      icon: "retry",
      placement: ["data"],
      expectedVersion: v,
    });
  }

  // 4. The one thing to DO about this row — rendered in the queue subline and
  //    the log panel's outcome bar. Navigation, never a mutation.
  const outcomeAction = deriveOutcomeAction(spec, ctx);
  if (outcomeAction) out.push(outcomeAction);

  // 5. Menu-only commands.
  //
  //    `menu` is the row's FULL command set, not a leftovers bin: every footer
  //    and outcome descriptor above also carries the `menu` placement, so the
  //    right-click menu on a row is served exactly what that row may do, and a
  //    command the surface never sent is unreachable from it. The footer stays
  //    the frequent subset; nothing lives ONLY in the footer.
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
  // A row that failed because its LINKED child failed is fixed at the child,
  // never here — but WHICH fix depends on what the child was reading.
  //
  // A PACKET came from a file, so the answer is a better file, and that is an
  // answer the footer does not have: `Re-upload` opens a file picker and starts
  // a DIFFERENT run. It is the row's only route to that, so it stays on the
  // outcome bar.
  //
  // A PERSON's mid-run lookup came from a name, so the answer is to replay that
  // lookup — and THE FOOTER'S ↺ ALREADY DOES EXACTLY THAT, same `retry`
  // command, same replayed child. So the outcome bar no longer offers it.
  // Operator: *"retry the lookup is not needed here since i know i can just do
  // it myself from the footer."* The child-replay confirm copy did not die with
  // the button — `deriveActions` hands it to the footer ↺ on precisely these
  // rows, so the promise the operator reads before replaying is unchanged; only
  // the second door to it is gone. The row falls through to `Open failure`,
  // which is what every other failed row shows.
  if (spec.mirroredFrom && spec.subjectKind === "file") {
    return {
      key: "reupload",
      kind: "command",
      command: "rerun-with-different-input",
      label: "Re-upload",
      intent: "destructive",
      icon: "retry",
      placement: ["outcome", "menu"],
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
      return { key: "open-gate", kind: "navigation", label: "Review", intent: "info", icon: "review", placement: ["outcome", "menu"], navigate: { kind: "self" } };
    case "parked":
      return { key: "open-park", kind: "navigation", label: "Resolve", intent: "violet", icon: "resolve", placement: ["outcome", "menu"], navigate: { kind: "self" } };
    case "failed":
      return {
        key: "open-failure",
        kind: "navigation",
        label: "Open failure",
        intent: "destructive",
        icon: "external",
        placement: ["outcome", "menu"],
        navigate: { kind: "self" },
      };
    case "running":
      return ctx.memberCount >= 41
        ? { key: "drill-in", kind: "navigation", label: "Start review", intent: "info", icon: "drill", placement: ["outcome", "menu"], navigate: { kind: "drill" } }
        : null;
    default:
      return null;
  }
}
