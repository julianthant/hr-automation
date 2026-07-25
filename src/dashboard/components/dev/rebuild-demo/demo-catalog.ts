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

import { DEMO_ROWS, type DemoRow } from "./demo-data";

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

export type PanelKind = "run" | "review" | "group" | "member";

export function rowVariantOf(row: DemoRow): RowVariant {
  if (row.rowType === "member") return row.displayOnly ? "rejected-member" : "person-member";
  if (row.rowType === "group") return row.reviewRunId ? "packet-group" : "roster-group";
  if (row.records) return "review-run";
  if (row.subjectKind === "file") return "document-run";
  if (row.subjectKind === "catalog") return "catalog-run";
  return "person-run";
}

export function panelKindOf(row: DemoRow): PanelKind {
  if (row.rowType === "member") return "member";
  if (row.rowType === "group") return "group";
  if (row.records) return "review";
  return "run";
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
      { code: "pl", label: "Person Lookup", note: "Read-only. Terminal states include Not found — a real outcome, not a failure." },
      { code: "pm", label: "Person Match", note: "Usually runs delegated; standalone it is an ordinary person run." },
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
    ],
    gotcha:
      "This is the deliberate exception to 'a PDF upload is always a Group'. Oath Upload files ONE ticket for the whole document, so splitting it into members would invent work that does not exist.",
    workflows: [
      {
        code: "ou",
        label: "Oath Upload",
        note: "Born at upload; walks OCR prep → your review → wait signatures → file ticket as one row. Its OCR run is delegated and keeps its own Review Run Row.",
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
      { code: "kr", label: "Kronos Reports", note: "Multi-worker download of a report selection; the receipt lists every saved file." },
      { code: "sp", label: "SharePoint Download", note: "Fetches the roster the other workflows match against." },
    ],
    exampleId: "kr-reports",
  },
  {
    key: "packet-group",
    name: "Packet Group Row",
    rowType: "Group Row",
    subject: "A PDF of many people that STOPS for your approval before anything is written.",
    titleRule: "Title = the PDF filename. Subtitle = the trace id. Always a Group, even with one person (D2).",
    carries: [
      "Extraction phase text, then the review gate: reviewed N of M · approvable · blocked",
      "A prominent link to its Review Run Row",
      "After approval: member rows inline, with per-member status counts and progress",
    ],
    gotcha:
      "The gate is the whole point — members stay Queued and NOTHING is written until you approve. Blocked records (inactive employee, unsigned form) are excluded from the approve count rather than silently approved.",
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
      "The status matrix — one cell per person, the general lookup view",
      "An attention band: how many failed / waiting / warned, with Start review",
      "Your own reviewed-N-of-M counter, because nobody else is tracking that you looked",
    ],
    gotcha:
      "At 50 people the matrix is the overview, NOT the review. There must always be a per-person detail path off it — a matrix alone cannot be signed off on.",
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
  key: PanelKind;
  name: string;
  forRows: string;
  tabs: string[];
  defaultTab: string;
  pinned: string[];
  specifics: string[];
  exampleId?: string;
}

export const PANEL_KINDS: PanelKindSpec[] = [
  {
    key: "run",
    name: "Run Panel",
    forRows: "Person Run Row · Document Run Row · Catalog Run Row",
    tabs: ["Logs", "Data", "Receipt"],
    defaultTab: "Running → Logs · terminal → Receipt · gated → Logs with the gate pinned open",
    pinned: [
      "Header: title · status · elapsed · trace id",
      "Outcome bar",
      "Gate banner when waiting on you",
      "Timeline — each step sized by its real duration, hover for detail",
      "Evidence bar",
    ],
    specifics: [
      "No Review tab — this row has no records to review.",
      "Data is one surface, not two: every value the run touched, with the read values editable in place, and a footer that starts a fresh run from them.",
      "The 4-column detail grid of today's panel is gone; those fields live on the row as facts and in the Data ledger.",
    ],
    exampleId: "sep-maria",
  },
  {
    key: "review",
    name: "Review Panel",
    forRows: "Review Run Row only",
    tabs: ["Review", "Logs", "Data", "Receipt"],
    defaultTab: "Review — always, this row exists to be reviewed",
    pinned: ["Header with reviewed N of M", "Approve bar showing approvable vs blocked", "Timeline", "Evidence bar"],
    specifics: [
      "The ONLY panel with a Review tab.",
      "Review is one person at a time: the source page beside the fields read from it, never a collapsed table.",
      "Per-person approve/skip with prev · next · next-flagged, and a reviewed counter that gates Approve all.",
      "Blocked records cannot be approved and say why in plain language.",
    ],
    exampleId: "ocr-summer",
  },
  {
    key: "group",
    name: "Group Panel",
    forRows: "Packet Group Row · Roster Group Row",
    tabs: ["People", "Logs", "Data", "Receipt"],
    defaultTab: "Anyone needing attention → People · otherwise Logs while running, Receipt when finished",
    pinned: ["Header with member counts", "Outcome bar", "Coordinator timeline (extract → review → fan-out → rollup)", "Evidence bar"],
    specifics: [
      "People is the per-person work surface: matrix or list, attention first, click into any person.",
      "The group's Logs are the coordinator's own — member detail belongs to the member.",
      "The group receipt rolls up only when every member is terminal; a single failed member does not fail the group.",
    ],
    exampleId: "i9-batch",
  },
  {
    key: "member",
    name: "Member Panel",
    forRows: "Person Member Row · Rejected Member Row",
    tabs: ["Logs", "Data", "Receipt"],
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

export function rowVariantSpec(row: DemoRow): RowVariantSpec {
  const key = rowVariantOf(row);
  return ROW_VARIANTS.find((v) => v.key === key) ?? ROW_VARIANTS[0];
}

export function panelKindSpec(row: DemoRow): PanelKindSpec {
  const key = panelKindOf(row);
  return PANEL_KINDS.find((p) => p.key === key) ?? PANEL_KINDS[0];
}

/** every demo row that renders as a given variant — powers the catalog's example links */
export function rowsForVariant(key: RowVariant): DemoRow[] {
  return Object.values(DEMO_ROWS).filter((r) => rowVariantOf(r) === key);
}
