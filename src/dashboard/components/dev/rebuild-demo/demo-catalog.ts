/**
 * DEV-ONLY — the NAMED catalog for the rebuild demo.
 *
 * The ratified model has three row types (Run Row / Group Row / Member Row) and
 * one Log Panel. That is the right structural answer, but it gives the operator
 * no vocabulary: "Run Row" does not tell you whether you are looking at one
 * person, one PDF, or a report selection, and it does not tell you which tabs
 * you will get. This file adds the missing layer — a NAME per row VARIANT and
 * per Log Panel KIND, each mapped to the workflows that use it and the
 * specifics that make it different.
 *
 * Names are derived, never stamped: `rowVariantOf` / `panelKindOf` read the
 * row's existing shape + subject, so nothing new has to be recorded to get one.
 */

import { DEMO_ROWS, MEMBER_LIST_SHAPE, ROLLUP_PRECEDENCE, type Containment, type DemoRow } from "./demo-data";
import { panelKindOf as panelKind, tabsForPanelKind, TAB_LABEL, type PanelKind as PanelKindKey } from "./demo-wire";
import { PROPOSED_STATUS } from "./demo-status";

// ---------------------------------------------------------------------------
// Row variants — 8 names across the 3 ratified row types
// ---------------------------------------------------------------------------

export type RowVariant =
  | "person-run"
  | "document-run"
  | "review-run"
  | "catalog-run"
  | "packet-group"
  | "roster-group"
  | "person-member"
  | "rejected-member";

// The panel kind is part of the CONTRACT — it is what `detailSurfaces` is
// derived from — so it lives in `demo-wire` and is re-exported here rather than
// defined a second time.
export { panelKindOf, type PanelKind } from "./demo-wire";

export function rowVariantOf(row: DemoRow): RowVariant {
  if (row.rowType === "member") return row.containment === "rejected" ? "rejected-member" : "person-member";
  if (row.rowType === "group") return row.reviewRunId ? "packet-group" : "roster-group";
  if (row.records) return "review-run";
  if (row.subjectKind === "file") return "document-run";
  if (row.subjectKind === "catalog") return "catalog-run";
  return "person-run";
}

export interface WorkflowUse {
  /** 2-char defineWorkflow code */
  code: string;
  label: string;
  /** how this workflow uses the variant — the "specifics" the operator asked for */
  note: string;
}

export interface RowVariantSpec {
  key: RowVariant;
  name: string;
  rowType: "Run Row" | "Group Row" | "Member Row";
  /** one line: what this row is ABOUT */
  subject: string;
  /** title / subtitle rule */
  titleRule: string;
  /** what the body of the row carries that the other variants do not */
  carries: string[];
  /** the trap this variant exists to avoid */
  gotcha: string;
  workflows: WorkflowUse[];
  exampleId?: string;
}

export const ROW_VARIANTS: RowVariantSpec[] = [
  {
    key: "person-run",
    name: "Person Run Row",
    rowType: "Run Row",
    subject: "One person, one run, no members.",
    titleRule: "Title = the resolved person name. Subtitle = EID if known, else the trace id.",
    carries: [
      "Outcome facts inline (what changed: dates, transaction number, pay rule)",
      "Live step text while running · error line when failed",
      "Identity-approval gate when the resolved person differs from the input record",
    ],
    gotcha:
      "Never show a raw run id as the title. Before UCPath resolves the person the title is the typed name/EID — that pending→resolved flip is derived at render, not re-stamped.",
    workflows: [
      { code: "se", label: "Separations", note: "Kuali → UCPath → Kronos; pauses on identity approval before the termination write." },
      { code: "on", label: "Onboarding", note: "Same identity gate; new hire has no prior EID, so one candidate is always EID-less." },
      { code: "pl", label: "Person Lookup", note: "Read-only Search/Match modes. Terminal states include Not found — a real outcome, not a failure." },
      { code: "i9", label: "I-9 Lookup", note: "Enrichment lookup — often invisible, folded into its caller's timeline." },
      { code: "ws", label: "Work-Study", note: "Typed input run; one UCPath transaction per person." },
      { code: "kp", label: "Kronos Pay Rule", note: "Kronos-only; the receipt is the observed pay rule after the write." },
      { code: "cd", label: "CRM Doc Download", note: "Subject is a person (email), output is a file — still a person run." },
    ],
    exampleId: "sep-maria",
  },
  {
    key: "document-run",
    name: "Document Run Row",
    rowType: "Run Row",
    subject: "One document processed end-to-end as a single unit — no members.",
    titleRule: "Title = the PDF filename. Subtitle = the trace id.",
    carries: [
      "Page count + the identifier the document produced (ticket number, document id)",
      "An approval step inside its OWN pipeline — it does not fan out",
      "A chip at the signers it is waiting on (6 signers · 3 done) that jumps to the panel they live in",
    ],
    gotcha:
      "This is the deliberate exception to 'a PDF upload is always a Group'. Oath Upload files ONE ticket for the whole document, so splitting it into members would invent work that does not exist. Its signers are LINKED, not members: each is an Oath Signature run with its own row in that panel. Copying them under this row would double both the rows and the counts.",
    workflows: [
      {
        code: "ou",
        label: "Oath Upload",
        note: "Born at upload; walks OCR prep → your review → wait signatures → file ticket as one row. Its signers are linked Oath Signature runs; its OCR run is a linked Review Run Row.",
      },
    ],
    exampleId: "ou-packet",
  },
  {
    key: "review-run",
    name: "Review Run Row",
    rowType: "Run Row",
    subject: "An OCR extraction awaiting your per-person review. The ONLY row that owns records.",
    titleRule: "Title = the source PDF filename. Subtitle = the trace id. Lives in the OCR entry of the Workflow Panel.",
    carries: [
      "Record counts: read / reviewed / approvable / blocked",
      "A back-link to the parent packet, and the parent links forward to it",
      "The only Review tab in the product",
    ],
    gotcha:
      "It keeps its OWN row rather than being absorbed into the parent (D4) — that is what stops the same OCR run appearing twice. A standalone OCR run (no parent) has no approve flow at all.",
    workflows: [
      { code: "oc", label: "OCR", note: "Every packet-backed workflow delegates here. The form spec decides which record card renders." },
    ],
    exampleId: "ocr-summer",
  },
  {
    key: "catalog-run",
    name: "Catalog Run Row",
    rowType: "Run Row",
    subject: "A selection from a registry — reports, files, a download set. No person at all.",
    titleRule: "Title = the registry/spec label. Subtitle = the trace id.",
    carries: ["The selection size (7 of 34 reports) and the period it covers", "Per-file progress rather than per-person progress"],
    gotcha: "Do not force a person subtitle onto it. There is no EID, and showing a blank person field reads as broken.",
    workflows: [
      { code: "kr", label: "Old Kronos Reports", note: "Multi-worker download of a report selection; the receipt lists every saved file." },
      { code: "sp", label: "SharePoint Download", note: "Fetches the roster the other workflows match against." },
    ],
    exampleId: "kr-reports",
  },
  {
    key: "packet-group",
    name: "Packet Group Row",
    rowType: "Group Row",
    subject: "A PDF of many people that STOPS for your approval before anything is written.",
    titleRule: "Title = the PDF filename. Subtitle = the trace id. Always a Group, even with one person.",
    carries: [
      "Before approval: the extracted count (6 people) — there are no member rows yet",
      "Bulk approve on the row itself (Approve 5 of 6) plus a link to the review; editing a value is only offered inside the review",
      "A prominent link to its Review Run Row",
      "After approval: member rows inline, with per-member status counts and progress",
    ],
    gotcha:
      "Members are created by the FAN-OUT, so a packet at review has none — it shows what it read, not a fake member list. Blocked records are excluded from the approve count rather than silently approved. A rejected page never counts toward done: the packet stays at Done with warnings until each one is deleted or acknowledged. A packet of one is still a Group Row.",
    workflows: [
      { code: "os", label: "Oath Signature", note: "One signer member per approved person; no ServiceNow ticket." },
      { code: "ec", label: "Emergency Contact", note: "One contact-fill member per approved person; a person may carry several contacts." },
      { code: "ob", label: "OnBase", note: "One document-import member per approved record; keyword fill is the write." },
    ],
    exampleId: "oath-summer",
  },
  {
    key: "roster-group",
    name: "Roster Group Row",
    rowType: "Group Row",
    subject: "A large fan-out that runs WITHOUT a pre-approval gate — you review the outcomes, not the inputs.",
    titleRule: "Title = the PDF/roster filename. Subtitle = the trace id.",
    carries: [
      "The same member lines every other group shows, ordered attention first, in a fixed-height scroll well",
      "Per-status counts plus a separate rejected tally, so a roster never reads as clean while a page is unrunnable",
      "Your own reviewed-N-of-M counter, because nobody else is tracking that you looked",
    ],
    gotcha:
      "Scale is presentation, never a second look. A 50-person roster renders in the SAME shape and at the SAME height as an 18-person one — the scroll well is capped and the attention-first ordering puts what needs you at the top of it. `Open all N` is where a set that size is actually worked.",
    workflows: [
      {
        code: "ic",
        label: "I-9 Check",
        note: "Read-only checks per person, appended to the master retention tracker. Pages that can never be searched become Rejected Member Rows.",
      },
      { code: "pl", label: "Person Lookup", note: "A multi-person typed input run groups its people the same way." },
      { code: "ws", label: "Work-Study", note: "Same — several typed people become one group instead of N loose rows." },
    ],
    exampleId: "i9-batch",
  },
  {
    key: "person-member",
    name: "Person Member Row",
    rowType: "Member Row",
    subject: "One person's work inside a group. A real task with its own run, receipt and retry.",
    titleRule: "Title = the person name. Subtitle = EID. Reached inline under the group or via the review conveyor.",
    carries: [
      "The one fact that distinguishes this person's outcome (signed 11:14 AM · S2 missing · no UCPath match)",
      "A checked-by-you mark, so a 50-person group can be worked through without losing your place",
      "Its own retry — replaying one person never re-runs the group",
    ],
    gotcha: "A retry creates a new run under the SAME person. Count each person once; keep both attempts visible in history.",
    workflows: [
      { code: "os", label: "Oath Signature", note: "Signer — CRM verify → UCPath sign." },
      { code: "ec", label: "Emergency Contact", note: "Contact fill — one member per contact, not per person." },
      { code: "ic", label: "I-9 Check", note: "UCPath search + roster re-match + retention append." },
      { code: "ob", label: "OnBase", note: "Document import with keyword fill." },
      { code: "pl", label: "Person Lookup", note: "Delegated lookups under an OCR run land here." },
    ],
    exampleId: "i9-m-19",
  },
  {
    key: "rejected-member",
    name: "Rejected Member Row",
    rowType: "Member Row",
    subject: "A page or roster line that can never become work. Display-only — no task exists behind it.",
    titleRule: "Title = what it is (Page 31), not a person. Subtitle = the reason.",
    carries: ["The reason it is unrunnable", "Delete as the ONLY action"],
    gotcha:
      "Retry/cancel/bump must be structurally absent, not merely disabled — there is no task to replay. It is typed as rejected at creation, never inferred later (D3).",
    workflows: [
      { code: "ic", label: "I-9 Check", note: "Scanned pages with no searchable name — cover sheets, blank scans, unreadable forms." },
      { code: "oc", label: "OCR", note: "Records the model could not classify into any form type." },
    ],
    exampleId: "i9-m-46",
  },
];

// ---------------------------------------------------------------------------
// Log Panel kinds — 4 named panels over the one Log Panel surface
// ---------------------------------------------------------------------------

export interface PanelKindSpec {
  key: PanelKindKey;
  name: string;
  forRows: string;
  /**
   * DERIVED from `tabsForPanelKind` — the same function the panel itself calls
   * — and labelled from `TAB_LABEL`, the same map the tab bar draws with. It is
   * not a field a spec may author, because the version of this catalog that let
   * one still declared a `Data` tab a wave after Data moved to the context rail,
   * and a catalog that documents a UI which no longer exists is worse than none.
   */
  readonly tabs: readonly string[];
  defaultTab: string;
  pinned: string[];
  specifics: string[];
  exampleId?: string;
}

/** the tab words for one panel kind, straight off the panel's own derivation */
export function tabNamesForPanelKind(kind: PanelKindKey): string[] {
  return tabsForPanelKind(kind).map((tab) => TAB_LABEL[tab]);
}

const PANEL_KIND_SPECS: Omit<PanelKindSpec, "tabs">[] = [
  {
    key: "run",
    name: "Run Panel",
    forRows: "Person Run Row · Document Run Row · Catalog Run Row",
    defaultTab: "Running → Logs · terminal → Receipt · failed → Logs, on the record it left behind",
    pinned: [
      "Header: title · status with its own age · trace id",
      "Outcome line — one sentence of what it means, and its one verb",
      "Run shape: an equal-width timeline above the panel, one segment per step",
    ],
    specifics: [
      "No Review tab — this row has no records to review.",
      "There is no gate banner. A decision renders inline in the log stream at the line that produced it, and a dismissable notice appears in the corner only while that decision is scrolled out of reach.",
      "Data and Evidence are not tabs. Both are sections of the context rail beside the panel, so what the run read can be read WHILE the stream is still running.",
      "The Data ledger corrects read values in place; a write is shown and never editable.",
    ],
    exampleId: "sep-maria",
  },
  {
    key: "review",
    name: "Review Panel",
    forRows: "Review Run Row only",
    defaultTab: "Review — always, this row exists to be reviewed",
    pinned: [
      "Header with reviewed N of M and its progress bar",
      "Approve bar: how many are approvable, and the count of your own corrections",
      "Run shape: the same equal-width timeline",
    ],
    specifics: [
      "The ONLY panel with a Review tab.",
      "Review is one person at a time: the source page beside the fields read from it, never a collapsed table.",
      "Per-person approve/skip with prev · next · next-flagged, and a reviewed counter that gates Approve all.",
      "A field you type over changes its provenance from PAPER to YOU and drops the model's confidence — a hand-typed value is not a paper read.",
      "Blocked records cannot be approved and say why in plain language.",
    ],
    exampleId: "ocr-summer",
  },
  {
    key: "group",
    name: "Group Panel",
    forRows: "Packet Group Row · Roster Group Row",
    defaultTab: "Anyone needing attention → People · otherwise Logs while running, Receipt when finished",
    pinned: [
      "Header with member counts",
      "Outcome line",
      "Run shape: the coordinator's own timeline (extract → review → fan-out → rollup)",
    ],
    specifics: [
      "People is the per-person work surface: one filtered list, attention first, click into any person.",
      "Before approval there are no members — People lists the people the OCR extracted, read-only, with a route to the review that would release them.",
      "The group's Logs are the coordinator's own — member detail belongs to the member.",
      "The receipt carries every member's confirmation number inline, so filing a packet never means opening N rows.",
    ],
    exampleId: "i9-batch",
  },
  {
    key: "member",
    name: "Member Panel",
    forRows: "Person Member Row · Rejected Member Row",
    defaultTab: "Running → Logs · terminal → Receipt",
    pinned: [
      "Conveyor header: prev · next · position in set · next needing attention",
      "Progress bar of how many you have checked",
      "Record block when the member came from an OCR packet — the page it was read from",
      "Action bar: retry · mark checked · skip",
    ],
    specifics: [
      "Built for walking a set: keyboard c checks, n jumps to the next person needing attention.",
      "A Rejected Member Row shows the reason and offers delete only.",
    ],
    exampleId: "i9-m-19",
  },
];

export const PANEL_KINDS: PanelKindSpec[] = PANEL_KIND_SPECS.map((spec) => ({
  ...spec,
  tabs: tabNamesForPanelKind(spec.key),
}));

// ---------------------------------------------------------------------------
// Row explanations — the ⓘ on every queue row
//
// The operator's words: "i feel like we have too much clutter right now. maybe
// its because i dont understand what is being done." That is the diagnosis to
// take seriously — a row nobody can name reads as clutter even when every pixel
// on it is earning its place. So each row can say, on demand, what it is doing,
// what opening it will show, and why it exists as its own row at all.
//
// It hangs off the NAMING layer above rather than off the fixtures, for the
// same reason the names do: a new fixture inherits a correct sentence with
// nothing to author, and a sentence can never drift from the row it describes.
// `doing` + `why` come from the row VARIANT (8), `panel` from the panel KIND
// (4) — so the four axes an operator confuses (delegated review vs. coordinator
// vs. member vs. standalone run) each read differently by construction.
//
// It is an EXPLANATION, never a hiding place: nothing here is a fact about this
// particular run. Every load-bearing value — status, age, counts, error, trace
// — stays on the row where it already lives.
// ---------------------------------------------------------------------------

export interface RowExplanation {
  /** the work this row stands for */
  doing: string;
  /** what opening it puts on screen */
  panel: string;
  /** why it is its own row instead of a line inside something else */
  why: string;
  /**
   * A RULE this row's controls obey — present only where the row offers a
   * control whose limits are not visible from the control itself.
   *
   * It is still derived: the sentence is the PRODUCT's policy (identical for
   * every packet), keyed on the row offering a bulk approval, not copy a
   * fixture wrote. It lives here because the row used to print it as a
   * five-line paragraph inside a 400px column, where a rule that never changes
   * was costing the same space as the facts that do.
   */
  constraint?: string;
}

const VARIANT_EXPLANATION: Record<RowVariant, { doing: string; why: string }> = {
  "person-run": {
    doing: "One person, start to finish — this row is that person's entire run.",
    why: "One person is the smallest thing you can retry, cancel or file, so it gets a row of its own.",
  },
  "document-run": {
    doing: "One document handled end to end — read, reviewed by you, then filed as a single ticket.",
    why: "The whole PDF produces ONE ticket, so splitting it into people would invent work that does not exist. Its signers are separate runs, linked from here.",
  },
  "review-run": {
    doing: "An OCR extraction waiting for you to check each person against the page it was read from.",
    // replaced below when the run has no parent — approval only means something
    // when something downstream is waiting to be released
    why: "It keeps its own row so the packet that delegated it is counted once, here, and never a second time under that packet.",
  },
  "catalog-run": {
    doing: "A selection from a registry — reports or files, with no person involved anywhere in it.",
    why: "The whole selection is one job: one place reporting progress, one receipt listing every file it saved.",
  },
  "packet-group": {
    doing: "A PDF of many people, stopped for your approval before anything is written.",
    why: "Approving fans out one real run per person, so every person stays separately retryable afterwards.",
  },
  "roster-group": {
    doing: "A fan-out running with no approval gate — you review the outcomes here, not the inputs.",
    why: "One roster is one thing to track, and one bad person is one member to retry rather than a re-run of everyone.",
  },
  "person-member": {
    doing: "One person's share of the group above it — a real run with its own retry and its own receipt.",
    why: "Replaying this person must never re-run the group, which is only possible because the work is a row and not a line item.",
  },
  "rejected-member": {
    doing: "A page that could never become work — nothing ran for it, and nothing will.",
    why: "It is listed rather than dropped, so the group cannot read as finished while it is still unresolved.",
  },
};

const PANEL_EXPLANATION: Record<PanelKindKey, string> = {
  run: "Opening it shows the log stream, every value the run read or wrote, and the receipt once it ends.",
  review: "Opening it starts the review — the scanned page beside the fields read from it, one person at a time.",
  group: "Opening it lists the people it holds, attention first, and you can open any one of them from there.",
  member: "Opening it walks the set — previous, next, and a checked mark so you keep your place in it.",
};

/** the one case where SCOPE, not shape, changes what the row is for */
const STANDALONE_REVIEW_WHY =
  "Nobody delegated it, so approving would release no work — this is a read of a document, not a gate in front of one.";

/**
 * D8, in one sentence. It is the same sentence on every packet in the product,
 * which is exactly why it does not belong on the row.
 */
const BULK_APPROVE_CONSTRAINT =
  "Approving is a decision about a list, so it can be made from here. Changing an extracted value is a claim about paper, so it opens the review — a value may only be edited with its scanned page on screen.";

export function rowExplanationOf(row: DemoRow): RowExplanation {
  const variant = rowVariantOf(row);
  const base = VARIANT_EXPLANATION[variant];
  const standaloneReview = variant === "review-run" && !row.reviewOf;
  return {
    doing: base.doing,
    panel: PANEL_EXPLANATION[panelKind(row)],
    why: standaloneReview ? STANDALONE_REVIEW_WHY : base.why,
    // Spread rather than `constraint: … : undefined`, so a row with no rule to
    // state carries no key at all — a present-but-undefined field is a field
    // every consumer has to guard, and this one is iterated.
    ...(row.bulkApprove ? { constraint: BULK_APPROVE_CONSTRAINT } : {}),
  };
}

// ---------------------------------------------------------------------------
// Containment — the one field that decides where a child lives and whether it
// is counted. Every "why does this run appear twice / why is the badge wrong"
// question in the old dashboard was really this question, unasked.
// ---------------------------------------------------------------------------

export interface ContainmentSpec {
  key: Containment;
  name: string;
  rule: string;
  counts: string;
  lives: string;
  examples: string[];
}

export const CONTAINMENT_KINDS: ContainmentSpec[] = [
  {
    key: "member",
    name: "Member",
    rule: "Created by the parent fanning out. It exists because the parent made it, and it has no meaning away from the parent.",
    counts: "Counts toward the group's rollup and its member tallies.",
    lives: "Renders ONLY nested inside the group — it never gets a top-level row.",
    examples: [
      "Each signer of an approved Oath Signature packet",
      "Each person of an I-9 Check roster",
      "Each contact fill of an Emergency Contact packet",
    ],
  },
  {
    key: "linked",
    name: "Linked",
    rule: "An independently meaningful sub-run the parent WAITS ON. It would still make sense if the parent did not exist.",
    counts: "Never counted as a member. It is counted once, in its own panel.",
    lives: "Keeps its OWN row in its OWN panel. The parent shows a chip pointing at it; the child shows a chip pointing back. Never a copy.",
    examples: [
      "An OCR review run under a packet — it stays the one row in the OCR panel",
      "Oath Upload's signers — each is an Oath Signature run in the Oath Signature panel",
    ],
  },
  {
    key: "rejected",
    name: "Rejected",
    rule: "The parent could not turn it into work — an unreadable page, a line with no searchable name. It is typed as rejected at creation, never inferred later.",
    counts: "Counted separately and EXCLUDED from the rollup. It cannot count toward done, and it stops the group reading as clean.",
    lives: "A Member Row with delete as its only action — retry and cancel are structurally absent, because there is no task to replay.",
    examples: ["A scanned cover sheet in an I-9 packet", "A page with no emergency-contact block"],
  },
];

// ---------------------------------------------------------------------------
// Rollup + density — both derived, both single-sourced
// ---------------------------------------------------------------------------

export const ROLLUP_STEPS = ROLLUP_PRECEDENCE.map((s) => PROPOSED_STATUS[s].label);

export const MEMBER_SHAPE = MEMBER_LIST_SHAPE;

export function rowVariantSpec(row: DemoRow): RowVariantSpec {
  const key = rowVariantOf(row);
  return ROW_VARIANTS.find((v) => v.key === key) ?? ROW_VARIANTS[0];
}

export function panelKindSpec(row: DemoRow): PanelKindSpec {
  const key = panelKind(row);
  return PANEL_KINDS.find((p) => p.key === key) ?? PANEL_KINDS[0];
}

/** every demo row that renders as a given variant — powers the catalog's example links */
export function rowsForVariant(key: RowVariant): DemoRow[] {
  return Object.values(DEMO_ROWS).filter((r) => rowVariantOf(r) === key);
}
