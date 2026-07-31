/**
 * DEV-ONLY — the TRUST half of the wire contract: `RunEvidenceReceipt`,
 * `FailureRecord` and the evidence captures rendered inside Receipt.
 *
 * `docs/rebuild/12-operator-trust-and-authoring.md` §2.1–2.4 owns these shapes;
 * `docs/rebuild/reviews/demo-feature-plan-2026-07-25.md` §1.2 says they are
 * fetched ON DEMAND by id (`evidence.receiptId` / `evidence.failureId` ride the
 * queue row; the record itself lives in SQLite/diagnostic storage). That is
 * exactly how this module is shaped: the row carries the id, this store answers
 * the fetch.
 *
 * The same three rules as `demo-wire.ts` hold, and one more that only matters
 * here:
 *
 *  1. **A fixture authors FACTS; the projection derives the rest.** A receipt
 *     spec never writes its own trace id, attempt, actor, result or confidence —
 *     those are read off the row it belongs to, so a receipt cannot claim to be
 *     about a run it does not match.
 *  2. **Every write states its read-back.** `DemoActionEvidence` is a
 *     discriminated union: a `commit` or a `prepare` CANNOT be authored without
 *     a `readBack`, and every non-verified read-back is forced by the type to
 *     carry the reason it could not be verified. "We could not check" is a fact
 *     the operator gets told, never an absence they have to notice.
 *  3. **`Done` is earned, not typed.** `deriveReceiptResult` computes
 *     the verdict from the row's status and its members; `receiptInvariant`
 *     re-checks doc 12's rule (verified-done requires verified confidence, every
 *     mandatory criterion met and zero failed members) and the surface refuses
 *     to print a green verdict it cannot justify.
 *  4. **No live document becomes a demo asset.** The real corpus is used only
 *     to learn record shape and page geometry. Evidence pages are synthetic
 *     facsimiles derived from synthetic fixture values and marked as such; a
 *     browser capture without a facsimile renders its served metadata, never a
 *     fabricated screenshot of a live system.
 */

import { DEMO_ROWS, type DemoRecord, type DemoRow, type SystemKey } from "./demo-data";
import { effectiveStatus } from "./demo-data";
import type { ProposedStatus } from "./demo-status";
import { at, type DemoWorkflowId } from "./demo-wire";

// ===========================================================================
// 1. RunEvidenceReceipt (doc 12 §2.3)
// ===========================================================================

/** where a value came from — the provenance lane, never inferred at render time */
export type DemoFactSource = "input" | "live" | "checkpoint" | "operator" | "derived";

export interface DemoEvidenceFact {
  key: string;
  value: string;
  system?: SystemKey;
  /** when it was observed / written */
  at?: string;
  source?: DemoFactSource;
  /** the canonical value is redacted at capture time, never in the UI */
  redacted?: boolean;
  note?: string;
}

export interface DemoDecisionEvidence {
  key: string;
  outcome: string;
  reason: string;
  at: string;
  by: "rule" | "operator";
}

/**
 * The read-back, typed so it cannot be omitted or fudged.
 *
 *  - `verified`      we re-read the system of record and saw the write.
 *  - `unsupported`   the system cannot be read back for this fact — the reason
 *                    is REQUIRED, because "no read-back" must never render as
 *                    the same thing as a successful one.
 *  - `not-attempted` we could have read it back and did not (say why).
 *  - `failed`        we tried and the check itself failed — which is NOT the
 *                    same as "the write is absent".
 */
export type DemoReadBack =
  | { state: "verified"; at: string; observed: string }
  | { state: "unsupported" | "not-attempted" | "failed"; note: string; at?: string };

interface ActionCommon {
  key: string;
  system: SystemKey;
  target: string;
  at: string;
  detail?: string;
}

/**
 * One external interaction. `read` and `local` touch nothing in a system of
 * record, so they carry no read-back; `prepare` and `commit` cannot be authored
 * without one.
 */
export type DemoActionEvidence =
  | (ActionCommon & { kind: "read" | "local"; observed?: string })
  | (ActionCommon & {
      kind: "prepare" | "commit";
      wrote: { field: string; value: string }[];
      /** the system's own identifier for the transaction, when it issues one */
      confirmation?: { label: string; value: string };
      readBack: DemoReadBack;
    });

export interface DemoVerificationEvidence {
  criterion: string;
  method: string;
  result: "met" | "unmet" | "unverifiable";
  observed?: string;
  at?: string;
  note?: string;
}

export interface DemoReuseEvidence {
  lane: "fresh-live" | "checkpoint" | "corrected" | "prior-proof";
  label: string;
  detail: string;
  age?: string;
}

export interface DemoUncertaintyEvidence {
  key: string;
  text: string;
  /**
   * doc 12 §2.3: `done-with-warnings` is legal ONLY for declared,
   * non-load-bearing observations. A load-bearing uncertainty forces a partial.
   */
  loadBearing: boolean;
}

/** D17 — per-member confirmations are listed INLINE, never one link per member */
export interface DemoReceiptMember {
  rowId: string;
  name: string;
  eid?: string;
  confirmation?: string;
  readBack: "verified" | "failed" | "unverified";
  note?: string;
}

export type DemoReceiptResult = "verified-done" | "done-with-warnings" | "failed" | "cancelled" | "partial";

/** what the operator saw was on screen at the moment of the commit (Q8) */
export interface DemoSubjectAtCommit {
  name: string;
  eid: string;
  system: SystemKey;
  observedAt: string;
  proof: string;
}

/** what a FIXTURE authors — identity, actor, result and confidence are derived */
interface DemoReceiptSpec {
  receiptId: string;
  generatedAt: string;
  descriptorFingerprint: string;
  configFingerprint: string;
  /** the immutable hash of the run's input, doc 12 §2.3 */
  inputHash: string;
  input: DemoEvidenceFact[];
  decisions: DemoDecisionEvidence[];
  actions: DemoActionEvidence[];
  verification: DemoVerificationEvidence[];
  reuse: DemoReuseEvidence[];
  warnings: DemoUncertaintyEvidence[];
  subjectAtCommit?: DemoSubjectAtCommit;
  /** keyed by MEMBER ROW ID — names and EIDs come from the member rows */
  memberConfirmations?: Record<string, { confirmation?: string; readBack: DemoReceiptMember["readBack"]; note?: string }>;
  /** the closing sentence — what the operator should do with this receipt */
  note?: string;
}

export interface DemoRunReceipt extends Omit<DemoReceiptSpec, "memberConfirmations"> {
  runId: string;
  rowId: string;
  traceId: string;
  workflowId: DemoWorkflowId;
  workflowLabel: string;
  attempt: number;
  retryOf?: string;
  actor: string;
  /** per-system prod/test — a test-instance write is not a filing */
  resolvedInstance: Partial<Record<SystemKey, "prod" | "test">>;
  observations: DemoEvidenceFact[];
  output: DemoEvidenceFact[];
  members?: DemoReceiptMember[];
  confidence: "verified" | "partial" | "unknown";
  result: DemoReceiptResult;
}

// ===========================================================================
// 2. FailureRecord (doc 12 §2.1) + the diagnostic bundle (§2.2)
// ===========================================================================

export interface DemoFailureCause {
  layer: "input" | "page" | "driver" | "data" | "system";
  text: string;
  at?: string;
}

export interface DemoRemediation {
  key: string;
  label: string;
  detail: string;
  /**
   * What is safe to retry — the question the operator is actually asking. A
   * `blocked` remediation is listed WITH its reason rather than hidden, because
   * "why can I not just retry this" is the thing they need answered.
   */
  safety: "safe" | "needs-input" | "blocked";
}

/** what had already happened when it failed — the half-done question */
export interface DemoFailureProgressStep {
  step: string;
  state: "done" | "failed" | "never-ran";
  system?: SystemKey;
  /** what it left behind in a real system — `undefined` means it wrote nothing */
  left?: string;
}

export interface DemoDiagnosticBundle {
  bundleId: string;
  capturedAt: string;
  sizeLabel: string;
  contents: { key: string; detail: string }[];
  redactions: string[];
}

export interface DemoFailureRecord {
  failureId: string;
  fingerprint: string;
  runId: string;
  rowId: string;
  traceId: string;
  attempt: number;
  workflowId: DemoWorkflowId;
  workflowLabel: string;
  nodeId?: string;
  taskId?: string;
  code: string;
  summary: string;
  transient: boolean;
  occurredAt: string;
  subject?: { expected?: string; observed?: string; proofRef?: string; note?: string };
  page?: { screen?: string; state?: string; urlRedacted?: string; title?: string };
  action?: { elementId?: string; operation?: string; sequence?: number };
  causeChain: DemoFailureCause[];
  progress: DemoFailureProgressStep[];
  /** the plain-language answer to "what is half-done" */
  writeState: { tone: "none" | "partial" | "unknown"; text: string };
  remediation: DemoRemediation[];
  bundle: DemoDiagnosticBundle;
  /** fingerprint-matched history, never message text */
  seenBefore: { count: number; window: string; lastTrace: string; lastAt: string; note: string } | null;
  /** D13 — the failure is a linked child's, mirrored here verbatim */
  mirrored?: { childRowId: string; childTrace: string; childWorkflow: string; verbatim: string };
  /** the failure belongs to another row (a group showing its member's failure) */
  ownerRowId?: string;
}

/**
 * What a FIXTURE authors. Identity (`runId`/`traceId`/`attempt`/workflow) is
 * derived from the row the failure belongs to — `ownerRowId` when the record is
 * fetched from a parent that carries a member's failure id.
 */
type DemoFailureSpec = Omit<DemoFailureRecord, "runId" | "rowId" | "traceId" | "attempt" | "workflowId" | "workflowLabel">;

// ===========================================================================
// 3. Evidence captures (doc 03 §2.1, doc 12 §2.2)
// ===========================================================================

/**
 * `confirmation` is a real fourth kind, not a step with a nicer label: it is the
 * frame that proves a write LANDED, and on an archived run it is the one thing
 * an auditor opens. Widened in the primitive rather than mapped onto `step` at
 * one call site, so the archive and the live rail name the same artefact the
 * same way.
 */
export type DemoCaptureKind = "step" | "error" | "form" | "confirmation";

/**
 * WHAT THE PAGE GAVE UP — one extracted field, as the extractor reports it.
 *
 * The shape is taken from this repo's own extraction output
 * (`data/i9/extracted/*.records.json`: `lastName`, `firstName`, `middleInitial`,
 * `dateOfBirth`, `ssn`, `hireDate`, `documentType`, plus the three arrays
 * `originallyMissing` / `illegible` / `notes`). The STRUCTURE and the VOCABULARY
 * are real; every VALUE here is synthetic. Nothing in this file is copied from a
 * scan — those are live HR documents with live PII, and they are read for their
 * schema and nothing else.
 */
export interface DemoExtractedField {
  key: string;
  /** absent when the extractor nulled it — see `state` for why */
  value?: string;
  /** `read` = on the page; `missing` = the page left it blank; `illegible` = it is there and could not be trusted */
  state: "read" | "missing" | "illegible";
  /** 0–1, as the model reported it. Absent on a field that was not read. */
  confidence?: number;
  /** what the value was taken from — `PAPER` for handwriting, a system for a looked-up value */
  source: string;
  /** why a field is missing or illegible, in the extractor's own words */
  reason?: string;
}

/**
 * ONE PAGE'S EXTRACTION RECORD — the thing the `What was recorded` panel exists
 * to show, and the thing it had nothing of. A packet capture served no metadata
 * at all, so 70% of a full-screen viewer was empty beside a frame that said the
 * bytes were missing.
 */
export interface DemoPageExtraction {
  formKind: string;
  sourcePdf: string;
  sourcePage: number;
  pageCount: number;
  fields: DemoExtractedField[];
  /** the extractor's free-text observations — the real corpus carries these verbatim */
  notes: string[];
}

/**
 * A DEMO-ONLY, SYNTHETIC rendering of the page — never a picture of a real one.
 *
 * The rule this respects is the one already written into `CaptureFrame`: a drawn
 * approximation of a REAL system page on an evidence surface is a fabrication,
 * and the demo must not commit scans of live HR documents either. So this is
 * neither: it is a facsimile built from the SYNTHETIC record beside it, marked
 * as synthetic on its face, and it stands in for the page's LAYOUT so the viewer
 * can be designed and judged at full size. A capture with no facsimile keeps the
 * honest "no bytes here" frame.
 */
export interface DemoPageFacsimile {
  /** the printed heading across the top of the form */
  formTitle: string;
  agency: string;
  /** the boxed sections, each with its own printed fields */
  sections: { heading: string; fields: { label: string; value: string; hand?: boolean }[] }[];
  /** the signature block along the bottom */
  signatures: { label: string; signedBy?: string; date?: string }[];
}

export interface DemoCapture {
  id: string;
  label: string;
  kind: DemoCaptureKind;
  /** a failure capture carries a red frame (D19b) */
  failure: boolean;
  step?: string;
  system?: SystemKey;
  capturedAt?: string;
  /** content-addressed ref — what the backend actually stores */
  ref?: string;
  screen?: string;
  pageState?: string;
  urlRedacted?: string;
  size?: { w: number; h: number };
  note?: string;
  extraction?: DemoPageExtraction;
  facsimile?: DemoPageFacsimile;
}

interface DemoCaptureMeta {
  step?: string;
  system?: SystemKey;
  capturedAt?: string;
  ref?: string;
  screen?: string;
  pageState?: string;
  urlRedacted?: string;
  size?: { w: number; h: number };
  note?: string;
  extraction?: DemoPageExtraction;
  facsimile?: DemoPageFacsimile;
}

// ===========================================================================
// 4. The store — authored facts, keyed the way the backend keys them
// ===========================================================================

const VIEWPORT = { w: 1600, h: 1000 };

const RECEIPT_SPECS: Record<string, DemoReceiptSpec> = {
  // -------------------------------------------------------------------------
  // The Q8 acceptance specimen: a UCPath-writing run the operator can
  // double-check WITHOUT opening UCPath.
  // -------------------------------------------------------------------------
  "rcpt-on-4f9b": {
    receiptId: "rcpt-on-4f9b",
    generatedAt: at("11:48:46"),
    descriptorFingerprint: "on@11:9f4c1e2a",
    configFingerprint: "cfg:6b1d90fe",
    inputHash: "sha256:2f7a…c410",
    input: [
      { key: "CRM case", value: "CRM-2026-4471", source: "input" },
      { key: "Name", value: "Jordan Whitfield", source: "input" },
      { key: "Email", value: "j•••••••@ucsd.edu", source: "input", redacted: true, note: "redacted at capture time — the receipt stores the hash, never the address" },
      { key: "Start date", value: "07/01/2026", source: "input" },
    ],
    decisions: [
      {
        key: "Hire path",
        outcome: "New hire",
        reason: "UCPath person search returned 0 active or inactive matches for the name + date of birth pair, so the run took the new-hire template instead of a rehire.",
        at: at("11:44:20"),
        by: "rule",
      },
      {
        key: "I-9 required",
        outcome: "Yes — profile created",
        reason: "Start date is in the future and no I-9 profile existed for this person.",
        at: at("11:45:12"),
        by: "rule",
      },
    ],
    actions: [
      {
        key: "crm-read",
        kind: "read",
        system: "crm",
        target: "Onboarding case CRM-2026-4471",
        at: at("11:42:20"),
        observed: "wage $18.50/hr · effective 07/01/2026 · dept 000482 · supervisor Ana Alvarez",
        detail: "Read only. Nothing in CRM was changed by this run.",
      },
      {
        key: "crm-docs",
        kind: "local",
        system: "crm",
        target: "3 onboarding PDFs → local archive",
        at: at("11:43:31"),
        observed: "3 files written to the run's own archive directory",
        detail: "A local projection — no system of record was touched.",
      },
      {
        key: "i9-commit",
        kind: "commit",
        system: "i9",
        target: "Create I-9 profile",
        at: at("11:45:40"),
        wrote: [
          { field: "Employee", value: "Jordan Whitfield" },
          { field: "Start date", value: "07/01/2026" },
        ],
        confirmation: { label: "I-9 profile id", value: "PRF-118203" },
        readBack: {
          state: "verified",
          at: at("11:45:58"),
          observed: "Re-opened PRF-118203: Jordan Whitfield · start 07/01/2026 · Section 1 pending employee",
        },
      },
      {
        key: "ucpath-commit",
        kind: "commit",
        system: "ucpath",
        target: "Smart HR — Hire template",
        at: at("11:48:12"),
        wrote: [
          { field: "Wage", value: "$18.50/hr" },
          { field: "Effective date", value: "07/01/2026" },
          { field: "Department", value: "000482" },
        ],
        confirmation: { label: "Transaction", value: "TXN-0891245" },
        readBack: {
          state: "verified",
          at: at("11:48:41"),
          observed: "Transaction TXN-0891245 · status Submitted · wage $18.50/hr · effective 07/01/2026 · EID 10633092",
        },
        detail: "The confirmation page was read back on a fresh navigation, not from the submit response.",
      },
    ],
    verification: [
      {
        criterion: "The hire transaction exists in UCPath",
        method: "Re-navigated to Transaction Status and read the row by transaction number",
        result: "met",
        observed: "TXN-0891245 · Submitted",
        at: at("11:48:41"),
      },
      {
        criterion: "The wage on the transaction equals the wage read from CRM",
        method: "Field-by-field compare of the read-back against the observation",
        result: "met",
        observed: "$18.50/hr = $18.50/hr",
        at: at("11:48:41"),
      },
      {
        criterion: "The I-9 profile exists and is bound to this person",
        method: "Re-opened the profile by id",
        result: "met",
        observed: "PRF-118203 · Jordan Whitfield",
        at: at("11:45:58"),
      },
    ],
    subjectAtCommit: {
      name: "Jordan Whitfield",
      eid: "10633092",
      system: "ucpath",
      observedAt: at("11:48:05"),
      proof: "The Smart HR header read “Whitfield, Jordan · 10633092” in the same DOM snapshot as the Submit click — the identity and the commit are one observation, not two.",
    },
    reuse: [
      {
        lane: "fresh-live",
        label: "Every value on this receipt was observed in this run",
        detail: "No checkpoint was reused and no prior write proof was replayed. Attempt 1 is the only attempt.",
      },
    ],
    warnings: [],
    note: "Everything a double-check needs is on this page: the transaction number, the values as UCPath echoed them back, and who UCPath said the person was when Submit was pressed.",
  },

  // -------------------------------------------------------------------------
  // D17 — a packet receipt lists every member's confirmation INLINE.
  // -------------------------------------------------------------------------
  "rcpt-os-c2f0": {
    receiptId: "rcpt-os-c2f0",
    generatedAt: at("11:24:13"),
    descriptorFingerprint: "os@6:41ba7708",
    configFingerprint: "cfg:6b1d90fe",
    inputHash: "sha256:9c02…7ab1",
    input: [
      { key: "Document", value: "Oath_Packet_Spring.pdf", source: "input" },
      { key: "Pages", value: "12", source: "input" },
      { key: "Roster", value: "spring-2026-students.xlsx", source: "input" },
    ],
    decisions: [
      {
        key: "Approval",
        outcome: "Approved 12 of 12 records",
        reason: "Each extracted person was reviewed against their scanned page and matched to a roster row before the fan-out was allowed.",
        at: at("11:12:02"),
        by: "operator",
      },
    ],
    actions: [
      {
        key: "ocr-read",
        kind: "read",
        system: "i9",
        target: "OCR extraction of Oath_Packet_Spring.pdf",
        at: at("11:07:41"),
        observed: "12 records on 12 pages · 12 roster matches",
        detail: "Read only — the document is never modified.",
      },
      {
        key: "fanout",
        kind: "local",
        system: "ucpath",
        target: "Fan out 12 signer runs",
        at: at("11:12:02"),
        observed: "12 member tasks enqueued",
        detail:
          "The packet itself writes nothing to UCPath. Each signature is its own member run with its own commit — which is why the confirmations are listed per person below instead of rolled into one number here.",
      },
    ],
    verification: [
      {
        criterion: "Every approved record produced a signature",
        method: "Member rollup at terminal state",
        result: "unmet",
        observed: "11 of 12 — Grace Egan produced none",
        at: at("11:24:10"),
        note: "The packet is therefore a PARTIAL outcome, not a done one. Retry the one member, never the packet.",
      },
      {
        criterion: "Each signature was read back on its own page after save",
        method: "Per-member read-back, listed inline below",
        result: "met",
        observed: "11 of 11 signatures that exist were re-read",
        at: at("11:23:58"),
      },
    ],
    reuse: [
      { lane: "fresh-live", label: "11 signatures observed in this run", detail: "No member replayed a prior proof; every confirmation below was read from the page after that member's save." },
    ],
    warnings: [
      {
        key: "member-failed",
        text: "One signer produced no signature and no confirmation. The packet cannot read as done while a person on it is unfinished.",
        loadBearing: true,
      },
    ],
    memberConfirmations: {
      "oath-m-0": { confirmation: "OATH-2026-4400", readBack: "verified" },
      "oath-m-1": { confirmation: "OATH-2026-4407", readBack: "verified" },
      "oath-m-2": { readBack: "failed", note: "no confirmation — the signature field never rendered after 3 attempts" },
      "oath-m-3": { confirmation: "OATH-2026-4421", readBack: "verified" },
      "oath-m-4": { confirmation: "OATH-2026-4428", readBack: "verified" },
      "oath-m-5": { confirmation: "OATH-2026-4435", readBack: "verified" },
      "oath-m-6": { confirmation: "OATH-2026-4442", readBack: "verified" },
      "oath-m-7": { confirmation: "OATH-2026-4449", readBack: "verified" },
      "oath-m-8": { confirmation: "OATH-2026-4456", readBack: "verified" },
      "oath-m-9": { confirmation: "OATH-2026-4463", readBack: "verified" },
      "oath-m-10": { confirmation: "OATH-2026-4470", readBack: "verified" },
      "oath-m-11": { confirmation: "OATH-2026-4477", readBack: "verified" },
    },
    note: "Twelve confirmation numbers on one page is the whole point: filing this packet is one read, not twelve member rows opened one at a time.",
  },

  // -------------------------------------------------------------------------
  // The system that CANNOT be read back — said out loud, not implied.
  // -------------------------------------------------------------------------
  "rcpt-ob-77b2": {
    receiptId: "rcpt-ob-77b2",
    generatedAt: at("09:55:01"),
    descriptorFingerprint: "ob@5:c07e3311",
    configFingerprint: "cfg:6b1d90fe",
    inputHash: "sha256:41de…8802",
    input: [
      { key: "Document", value: "I-9 Supporting · source page 4", source: "input" },
      { key: "Employee", value: "Elena Vasquez", source: "input" },
      { key: "EID", value: "10590114", source: "input" },
    ],
    decisions: [
      {
        key: "Keyword fill path",
        outcome: "Field-by-field fallback",
        reason: "The keyset autofill control did not populate after two attempts, so each keyword was typed individually. The fallback path is slower and is not covered by the autofill's own validation.",
        at: at("09:53:11"),
        by: "rule",
      },
    ],
    actions: [
      {
        key: "onbase-prepare",
        kind: "prepare",
        system: "onbase",
        target: "Keyword panel — document type I-9 Supporting",
        at: at("09:54:20"),
        wrote: [
          { field: "Document type", value: "I-9 Supporting" },
          { field: "Employee ID", value: "10590114" },
          { field: "Source page", value: "4" },
        ],
        readBack: {
          state: "unsupported",
          note: "OnBase returns no keyword set on the import response, and this workflow does not re-open the imported document to read one. The keywords above were typed and submitted — they were NOT read back. Treat them as unverified until you look at the document.",
        },
      },
      {
        key: "onbase-commit",
        kind: "commit",
        system: "onbase",
        target: "Import document",
        at: at("09:54:55"),
        wrote: [{ field: "Document", value: "I-9 Supporting · 1 page" }],
        confirmation: { label: "OnBase document id", value: "OB-8841203" },
        readBack: {
          state: "verified",
          at: at("09:54:58"),
          observed: "Import result panel lists OB-8841203 under EID 10590114",
        },
        detail: "The document's EXISTENCE is verified. Its keyword set is not — see the prepare step above.",
      },
    ],
    verification: [
      {
        criterion: "The document exists in OnBase under this employee",
        method: "Read the import result panel by document id",
        result: "met",
        observed: "OB-8841203 · EID 10590114",
        at: at("09:54:58"),
      },
      {
        criterion: "The keyword set matches the source page",
        method: "No method available — OnBase does not expose the stored keyword set to this workflow",
        result: "unverifiable",
        note: "This is why the run is Done with warnings rather than plain Done. A green verdict here would be a claim nothing checked.",
      },
    ],
    reuse: [{ lane: "fresh-live", label: "Values read from the source page in this run", detail: "No checkpoint was reused." }],
    warnings: [
      {
        key: "keyset-fallback",
        text: "Keyset autofill fell back to field-by-field entry — the keywords are typed values with no autofill validation behind them.",
        loadBearing: false,
      },
      {
        key: "keywords-unverified",
        text: "The keyword set was never read back. It may be right; nothing here says it is.",
        loadBearing: false,
      },
    ],
    note: "Open OB-8841203 and glance at the keyword panel. That one look is the read-back this workflow cannot do for you.",
  },

  // -------------------------------------------------------------------------
  // A verified write that is NOT a filing — it landed on the test instance.
  // -------------------------------------------------------------------------
  "rcpt-kp-d6a0": {
    receiptId: "rcpt-kp-d6a0",
    generatedAt: at("10:16:16"),
    descriptorFingerprint: "kp@3:2ad5b910",
    configFingerprint: "cfg:6b1d90fe",
    inputHash: "sha256:7710…3f5c",
    input: [
      { key: "Employee", value: "Marcus Bell", source: "input" },
      { key: "EID", value: "10312007", source: "input" },
      { key: "Election file", value: "work-study-elections-2026.csv", source: "input" },
    ],
    decisions: [
      {
        key: "Rule change",
        outcome: "SDCMP → SDCMP-WS",
        reason: "Union code CX with a work-study election maps to the work-study pay rule. The current rule was read before the change, not assumed.",
        at: at("10:15:04"),
        by: "rule",
      },
    ],
    actions: [
      {
        key: "kronos-read",
        kind: "read",
        system: "kronos",
        target: "Person — pay rule",
        at: at("10:15:03"),
        observed: "union CX · current pay rule SDCMP",
      },
      {
        key: "kronos-commit",
        kind: "commit",
        system: "kronos",
        target: "Person — pay rule",
        at: at("10:15:41"),
        wrote: [{ field: "Pay rule", value: "SDCMP-WS" }],
        readBack: {
          state: "verified",
          at: at("10:16:12"),
          observed: "Re-opened the person on a fresh navigation: pay rule reads SDCMP-WS",
        },
        detail: "Kronos issues no transaction id for a pay-rule change, so the read-back IS the proof — there is no confirmation number to quote.",
      },
    ],
    verification: [
      {
        criterion: "The pay rule reads SDCMP-WS after save",
        method: "Fresh navigation to the person, re-read the field",
        result: "met",
        observed: "SDCMP-WS",
        at: at("10:16:12"),
      },
    ],
    reuse: [{ lane: "fresh-live", label: "Read before the write, read again after it", detail: "Both observations are from this run." }],
    warnings: [],
    note: "Verified — but against the TEST instance. Nothing on this receipt is a filing in the production Kronos.",
  },
};

const FAILURE_SPECS: Record<string, DemoFailureSpec> = {
  // -------------------------------------------------------------------------
  // A permanent, input-caused failure that wrote nothing.
  // -------------------------------------------------------------------------
  "fail-cd-5e19": {
    failureId: "fail-cd-5e19",
    fingerprint: "crm/onboarding-search/no-results/email",
    nodeId: "search-record",
    taskId: "cd.search",
    code: "crm.record-not-found",
    summary: "CRM onboarding search returned 0 records for the address on the roster row.",
    transient: false,
    occurredAt: at("13:12:50"),
    subject: {
      expected: "samuel.ortiz@ucsd.edu — roster row 41",
      observed: "no CRM record with that address (0 results, no near matches offered)",
      note: "The search itself succeeded. Zero results is a real answer, not a broken page — which is why this is permanent and not transient.",
    },
    page: {
      screen: "crm.onboarding.search",
      state: "results-empty",
      urlRedacted: "https://crm.ucsd.edu/onboarding/search?q=•••",
      title: "Onboarding — Search",
    },
    action: { elementId: "crm.onboarding.searchSubmit", operation: "click", sequence: 14 },
    causeChain: [
      { layer: "input", text: "The roster row carries an address that exists in no CRM record.", at: at("13:12:21") },
      { layer: "page", text: "CRM search rendered its empty-results state (0 rows, no suggestions).", at: at("13:12:50") },
      { layer: "data", text: "The download step consumes a CRM record id, so with no record there was nothing to consume — the run stopped rather than guessing at a near match." },
    ],
    progress: [
      { step: "CRM auth", state: "done", system: "crm" },
      { step: "Search record", state: "failed", system: "crm" },
      { step: "Download", state: "never-ran", system: "crm" },
      { step: "Archive", state: "never-ran" },
    ],
    writeState: {
      tone: "none",
      text: "Nothing was written. This workflow only writes in Download and Archive, and neither ran — there is no half-finished state to clean up before you retry.",
    },
    remediation: [
      {
        key: "fix-email",
        label: "Correct the address on the roster and start a new run",
        detail: "The address is the input; a retry that replays it will fail identically. Fix it at the source so the next run and every future run agree.",
        safety: "needs-input",
      },
      {
        key: "retry-asis",
        label: "Retry with the same input",
        detail: "Safe — nothing was written, so nothing can be duplicated. It will almost certainly fail the same way: attempt 1 and attempt 2 already did.",
        safety: "safe",
      },
      {
        key: "hide",
        label: "Remove the row from the queue",
        detail: "Safe. The receipt, this failure record and the diagnostic bundle stay in history; only the listing stops.",
        safety: "safe",
      },
    ],
    bundle: {
      bundleId: "bndl-cd-5e19",
      capturedAt: at("13:12:51"),
      sizeLabel: "412 KB",
      contents: [
        { key: "Failure record + cause chain", detail: "this record, verbatim" },
        { key: "Redacted URL, title, screen + page state", detail: "crm.onboarding.search · results-empty" },
        { key: "Last 12 driver actions", detail: "semantic UI ids, never raw selectors" },
        { key: "Captures", detail: "3 images — search results (0), CRM auth, query as typed" },
        { key: "Accessibility excerpt around the failed element", detail: "bounded to the search form, not a page dump" },
        { key: "Console + network failures", detail: "request bodies and credentials removed at capture" },
        { key: "Input digest + schema fingerprint", detail: "sha256:5c1b…9d3e · roster.v4" },
        { key: "Descriptor / config / build fingerprints", detail: "cd@4:9911af02 · cfg:6b1d90fe" },
        { key: "Worker, lease, clock + disk health", detail: "worker 2 · lease ok · clock drift 0.2s" },
        { key: "Checkpoint freshness + retry lineage", detail: "CRM auth checkpoint 14m old · retryOf attempt 1" },
      ],
      redactions: ["email address", "query string", "session cookies"],
    },
    seenBefore: {
      count: 2,
      window: "the last 24 hours",
      lastTrace: "cd-125802-0b8c",
      lastAt: at("12:58:41"),
      note: "Same fingerprint, same roster row. Two attempts with an unchanged input is the signature of a data problem, not a flaky page.",
    },
  },

  // -------------------------------------------------------------------------
  // D13 — a linked child failed, so the parent is Failed and mirrors the child's
  // error verbatim. Never "Waiting on you", never "Unknown error".
  // -------------------------------------------------------------------------
  "fail-se-31c6": {
    failureId: "fail-se-31c6",
    fingerprint: "ucpath/person-search/no-results/name",
    nodeId: "identity-check",
    taskId: "se.identity",
    code: "separations.identity-unresolved",
    summary: "The delegated person lookup found nobody, so there is no person to write a termination against.",
    transient: false,
    occurredAt: at("13:19:28"),
    mirrored: {
      childRowId: "pl-dana",
      childTrace: "pl-131847-e88f",
      childWorkflow: "Person Lookup",
      verbatim: "UCPath person search returned 0 matches for “Dana Whitmore”; the fallback search on last name + department 000371 also returned 0.",
    },
    subject: {
      expected: "Dana Whitmore — from separation document 5-RWP2KD (no EID on the document)",
      observed: "no UCPath person matched either search",
      note: "Without an EID nothing downstream can be keyed, which is why the run stopped here instead of continuing on a name.",
    },
    page: {
      screen: "ucpath.person.search",
      state: "results-empty",
      urlRedacted: "https://ucpath.universityofcalifornia.edu/psp/…/PERSON_SEARCH",
      title: "Person Search",
    },
    action: { elementId: "ucpath.person.searchSubmit", operation: "click", sequence: 6 },
    causeChain: [
      { layer: "input", text: "The name on the Kuali separation document does not exist in UCPath as spelled." },
      { layer: "system", text: "Delegated run pl-131847-e88f returned no-match; the dependency stayed unsatisfied.", at: at("13:19:26") },
      { layer: "data", text: "Every later step of a separation is keyed by EID, so the run failed rather than proceeding without one." },
    ],
    progress: [
      { step: "Kuali extraction", state: "done", system: "kuali", left: "read only — the Kuali document was opened, not edited" },
      { step: "Identity check", state: "failed", system: "ucpath" },
      { step: "Job summary", state: "never-ran", system: "ucpath" },
      { step: "Kronos search", state: "never-ran", system: "kronos" },
      { step: "UCPath transaction", state: "never-ran", system: "ucpath" },
      { step: "Kuali finalization", state: "never-ran", system: "kuali" },
    ],
    writeState: {
      tone: "none",
      text: "Nothing was written to UCPath, Kronos or Kuali, and no termination was staged. The Kuali document is untouched and still open for editing.",
    },
    remediation: [
      {
        key: "retry-child",
        label: "Retry the lookup",
        detail: "Replays the CHILD run under its own task id, so this separation resumes behind it instead of starting over. Safe — nothing has been written.",
        safety: "safe",
      },
      {
        key: "fix-name",
        label: "Correct the name on the Kuali document, then retry the lookup",
        detail: "The name is the input. If UCPath spells her differently, fix the document first or the replayed lookup will find nobody again.",
        safety: "needs-input",
      },
      {
        key: "retry-parent",
        label: "Retry the whole separation",
        detail: "Blocked while the lookup is unresolved — a separation with no EID has nothing to key its writes to. Resolve the identity first.",
        safety: "blocked",
      },
    ],
    bundle: {
      bundleId: "bndl-se-31c6",
      capturedAt: at("13:19:29"),
      sizeLabel: "296 KB",
      contents: [
        { key: "Failure record + cause chain", detail: "this record, plus the child's own record by reference" },
        { key: "Child run pointer", detail: "pl-131847-e88f — its bundle is separate and linked, never copied" },
        { key: "Both search attempts", detail: "full name, then last name + department" },
        { key: "Captures", detail: "1 image — Kuali doc 5-RWP2KD" },
        { key: "Descriptor / config fingerprints", detail: "se@7:5d31c8b0 · cfg:6b1d90fe" },
        { key: "Dependency state", detail: "identity-check waiting on pl-dana at failure time" },
      ],
      redactions: ["employee identifiers on the Kuali page"],
    },
    seenBefore: null,
  },

  // -------------------------------------------------------------------------
  // A member's failure, fetched from the PACKET row that carries its id.
  // -------------------------------------------------------------------------
  "fail-os-c2f0-m2": {
    failureId: "fail-os-c2f0-m2",
    ownerRowId: "oath-m-2",
    fingerprint: "ucpath/oath-form/signature-canvas-never-mounted",
    nodeId: "sign-oath",
    taskId: "os.sign",
    code: "ucpath.element-never-rendered",
    summary: "The oath form's signature canvas never mounted for this person, on three fresh page loads.",
    transient: true,
    occurredAt: at("11:23:44"),
    subject: {
      expected: "Grace Egan · EID 10531182",
      observed: "Grace Egan · EID 10531182 — the right person, the wrong page state",
      note: "Identity was never in doubt here. The person resolved; the form did not.",
    },
    page: {
      screen: "ucpath.oath.form",
      state: "form-partial",
      urlRedacted: "https://ucpath.universityofcalifornia.edu/psp/…/OATH_FORM",
      title: "Loyalty Oath",
    },
    action: { elementId: "ucpath.oath.signatureCanvas", operation: "wait-for", sequence: 9 },
    causeChain: [
      { layer: "page", text: "The signature canvas element never appeared within the step timeout, on each of 3 attempts with a fresh page.", at: at("11:23:44") },
      { layer: "driver", text: "Each attempt re-authenticated and re-navigated, so a stale session is ruled out." },
      { layer: "system", text: "The other 11 signers on the same packet rendered the same form in the same minutes — this is per-person, not a UCPath outage." },
    ],
    progress: [
      { step: "CRM verify", state: "done", system: "crm", left: "read only" },
      { step: "UCPath auth", state: "done", system: "ucpath" },
      { step: "Sign oath", state: "failed", system: "ucpath" },
    ],
    writeState: {
      tone: "none",
      text: "No signature was saved and no confirmation number exists for this person. The other 11 signers on the packet are finished and are NOT affected by a retry here.",
    },
    remediation: [
      {
        key: "retry-member",
        label: "Retry this signer",
        detail: "Safe. It replays one person; the 11 signed oaths are untouched. Transient failures of this shape usually clear on a later attempt.",
        safety: "safe",
      },
      {
        key: "retry-packet",
        label: "Retry the packet",
        detail: "Blocked — re-running the packet would sign 11 people a second time. The command service refuses it with `not-retryable-at-this-level`.",
        safety: "blocked",
      },
    ],
    bundle: {
      bundleId: "bndl-os-m002",
      capturedAt: at("11:23:45"),
      sizeLabel: "508 KB",
      contents: [
        { key: "Failure record + cause chain", detail: "this record" },
        { key: "3 attempt captures", detail: "the blank canvas, once per attempt" },
        { key: "Accessibility excerpt around the missing element", detail: "the oath form's own subtree" },
        { key: "Console + network failures", detail: "2 script errors on the oath bundle" },
        { key: "Packet context", detail: "member 3 of 12 on Oath_Packet_Spring.pdf" },
      ],
      redactions: ["employee identifiers in the page excerpt"],
    },
    seenBefore: {
      count: 4,
      window: "the last 30 days",
      lastTrace: "os-094412-b81d",
      lastAt: at("09:44:12"),
      note: "Same fingerprint on 4 runs across 3 packets. Worth a lesson entry — a repeating transient is a bug with a slow clock.",
    },
  },
};

/**
 * The i9 fan-out's failures are generated the same way its member rows are —
 * one shape, 50 people. Authoring 50 near-identical records would only invite
 * them to drift from the rows they belong to.
 */
function i9MemberFailure(row: DemoRow, failureId: string): DemoFailureSpec {
  const name = row.title;
  return {
    failureId,
    fingerprint: "ucpath/person-search/no-results/name-then-eid",
    nodeId: "person-lookup",
    taskId: "ic.search",
    code: "ucpath.person-not-found",
    summary: `UCPath person search found no row for “${name}”, on the name and again on the EID read from the page.`,
    transient: false,
    occurredAt: row.endedAt ?? row.startedAt ?? row.enqueuedAt,
    subject: {
      expected: `${name}${row.eid ? ` · EID ${row.eid}` : ""} — read from the retention packet`,
      observed: "no UCPath person matched either search",
      note: "Two independent searches disagreeing with the paper is a roster problem, not a page problem.",
    },
    page: { screen: "ucpath.person.search", state: "results-empty", title: "Person Search" },
    action: { elementId: "ucpath.person.searchSubmit", operation: "click", sequence: 4 },
    causeChain: [
      { layer: "input", text: "The name as OCR read it does not match any UCPath person." },
      { layer: "data", text: "The EID fallback search also returned nothing, so the pair on the page cannot be reconciled." },
    ],
    progress: [
      { step: "Person lookup", state: "done", system: "ucpath", left: "read only" },
      { step: "Person match", state: "failed", system: "ucpath" },
      { step: "Retention append", state: "never-ran" },
    ],
    writeState: {
      tone: "none",
      text: "Nothing was written and nothing was appended to the master retention tracker for this person. The other members of this packet are unaffected.",
    },
    remediation: [
      {
        key: "retry-member",
        label: "Retry this person",
        detail: "Safe — it replays one member and writes nothing until a person resolves.",
        safety: "safe",
      },
      {
        key: "fix-roster",
        label: "Check the spelling on the roster row, then retry",
        detail: "The packet page and the roster disagree with UCPath. Correcting the roster is what makes the next run different from this one.",
        safety: "needs-input",
      },
    ],
    bundle: {
      bundleId: `bndl-${failureId}`,
      capturedAt: row.endedAt ?? row.enqueuedAt,
      sizeLabel: "188 KB",
      contents: [
        { key: "Failure record + cause chain", detail: "this record" },
        { key: "Both search attempts", detail: "name, then EID" },
        { key: "Packet page reference", detail: "the page this person was read from" },
        { key: "Descriptor / config fingerprints", detail: "ic@2:70c4de19 · cfg:6b1d90fe" },
      ],
      redactions: ["employee identifiers on the packet page"],
    },
    seenBefore: null,
  };
}

/**
 * Capture metadata, keyed `<rowId>::<capture label>` so it can never bind to the
 * wrong image by position. A capture with no entry still renders — it just shows
 * only what the row itself serves, rather than inventing the rest.
 */
/**
 * PAGE COUNTS for the two packets the demo pages through. Named because the
 * facsimile, the extraction record and the review pane all print them, and a
 * capture that says "page 2 of 8" beside a strip of three is the kind of
 * disagreement a fixture is supposed to make impossible.
 */
const SUMMER_PACKET_PAGES = 8;

/**
 * The oath form as it is PRINTED — the layout every page of a summer packet
 * shares. The per-person values are filled in beside it; this is the paper.
 */
function oathFacsimile(person: { name: string; eid: string; date: string }): DemoPageFacsimile {
  return {
    formTitle: "Oath or Affirmation of Allegiance",
    agency: "University of California · State of California",
    sections: [
      {
        heading: "Employee",
        fields: [
          { label: "Printed name", value: person.name, hand: true },
          { label: "Employee ID", value: person.eid, hand: true },
          { label: "Department", value: "000371 · Student Health" },
          { label: "Payroll title", value: "Blank Assistant 3" },
        ],
      },
      {
        heading: "Declaration",
        fields: [
          { label: "I solemnly swear", value: "…that I will support and defend the Constitution of the United States and the Constitution of the State of California against all enemies, foreign and domestic…" },
        ],
      },
    ],
    signatures: [
      { label: "Employee signature", signedBy: person.name, date: person.date },
      { label: "Officer / witness", signedBy: "R. Okonkwo, HR", date: person.date },
    ],
  };
}

/**
 * The page beside an OCR review record.
 *
 * Every value comes from the synthetic record already being reviewed. Paper
 * fields become printed form rows; system lookups stay in the extracted-data
 * column and never get painted onto the page. The builder throws when a review
 * record serves no paper facts, because an empty facsimile would put the old
 * placeholder back under a more reassuring name.
 */
export function reviewPageFacsimile(record: DemoRecord): DemoPageFacsimile {
  const paperFields = record.fields.filter((field) => field.source === "paper");
  if (paperFields.length === 0) {
    throw new Error(`Review record ${record.id} (${record.name}) has no paper fields for its page facsimile`);
  }

  const formKind = record.pageNote.split("·").slice(1).join("·").trim();
  if (!formKind) {
    throw new Error(`Review record ${record.id} (${record.name}) has no form kind in pageNote '${record.pageNote}'`);
  }

  const date = paperFields.find((field) => field.label.toLowerCase().includes("date"))?.value;
  const employeeSigned = record.checks.find((check) => check.label === "Employee signed")?.value.startsWith("yes");
  const officerSigned = record.checks.find((check) => check.label === "Officer signed")?.value.startsWith("yes");

  return {
    formTitle: formKind,
    agency: `Synthetic review record · page ${record.page}`,
    sections: [
      {
        heading: "Fields on this page",
        fields: paperFields.map((field) => ({
          label: field.label,
          value: field.value,
          hand: true,
        })),
      },
    ],
    signatures: [
      ...(employeeSigned === undefined
        ? []
        : [{ label: "Employee signature", signedBy: employeeSigned ? record.name : undefined, date }]),
      ...(officerSigned === undefined
        ? []
        : [{ label: "Officer / witness", signedBy: officerSigned ? "R. Okonkwo, HR" : undefined, date }]),
    ],
  };
}

const CAPTURE_META: Record<string, DemoCaptureMeta> = {
  // -------------------------------------------------------------------------
  // THE PACKET PAGES. These carried NO metadata at all, which is why the
  // lightbox's `What was recorded` panel opened empty on the one capture the
  // operator was most likely to open. They now serve the same things a real
  // extraction serves — and the SHAPE of that record is this repo's own
  // (`data/i9/extracted/*.records.json`: per-field values, the three
  // `originallyMissing` / `illegible` / `notes` arrays, `sourcePdf`,
  // `sourcePage`). Every VALUE is synthetic; the scans are live HR documents
  // and are read for their schema and never for their contents.
  // -------------------------------------------------------------------------
  "oath-summer::Packet page 1": {
    step: "OCR extraction",
    system: "i9",
    capturedAt: at("14:20:31"),
    ref: "sha256:7c11…9ad4",
    screen: "packet.page",
    pageState: "extracted",
    size: { w: 612, h: 792 },
    note: "The packet's cover page — the batch header the extractor keys the run to, before any person's page is read.",
    extraction: {
      formKind: "oath packet cover",
      sourcePdf: "Oath_Packet_Summer.pdf",
      sourcePage: 1,
      pageCount: SUMMER_PACKET_PAGES,
      fields: [
        { key: "Packet title", value: "Summer 2026 · Student Health", state: "read", confidence: 0.99, source: "PAPER" },
        { key: "Prepared by", value: "R. Okonkwo, HR", state: "read", confidence: 0.96, source: "PAPER" },
        { key: "Prepared on", value: "07/21/2026", state: "read", confidence: 0.98, source: "PAPER" },
        { key: "Forms enclosed", value: "6", state: "read", confidence: 0.94, source: "PAPER" },
        { key: "Department", value: "000371 · Student Health", state: "read", confidence: 0.91, source: "PAPER" },
        { key: "Cover sheet signature", state: "missing", source: "PAPER", reason: "the cover sheet signature line was left blank — a cover page is not a form, so nothing is blocked by it" },
      ],
      notes: [
        "Cover page; no employee fields on this sheet — the six oath forms begin on page 2.",
        "Enclosure count read as 6 and reconciled against the 6 person pages found in the packet.",
      ],
    },
    facsimile: {
      formTitle: "Oath packet — cover sheet",
      agency: "UC San Diego · Student Health · Summer 2026",
      sections: [
        {
          heading: "Batch",
          fields: [
            { label: "Prepared by", value: "R. Okonkwo, HR", hand: true },
            { label: "Prepared on", value: "07/21/2026", hand: true },
            { label: "Forms enclosed", value: "6", hand: true },
            { label: "Department", value: "000371 · Student Health" },
          ],
        },
      ],
      signatures: [{ label: "Cover sheet signature" }],
    },
  },
  "oath-summer::Roster match report": {
    step: "Roster match",
    system: "i9",
    capturedAt: at("14:21:06"),
    ref: "sha256:be40…2f18",
    screen: "roster.match.report",
    pageState: "complete",
    size: VIEWPORT,
    note: "Every extracted person against the roster row that claimed them. 5 matched on EID, 1 on name + department.",
    extraction: {
      formKind: "roster match report",
      sourcePdf: "Summer_Roster_0721.xlsx",
      sourcePage: 1,
      pageCount: 1,
      fields: [
        { key: "Roster rows", value: "6", state: "read", confidence: 1, source: "ROSTER" },
        { key: "Matched on EID", value: "5", state: "read", confidence: 1, source: "ROSTER" },
        { key: "Matched on name + dept", value: "1", state: "read", confidence: 0.88, source: "ROSTER" },
        { key: "Unmatched", value: "0", state: "read", confidence: 1, source: "ROSTER" },
        { key: "Roster file hash", value: "sha256:0d5c…71bb", state: "read", confidence: 1, source: "ROSTER" },
      ],
      notes: [
        "One person matched on name + department rather than EID — the EID written on their form is a digit short.",
        "No roster row was consumed twice; each match is one-to-one.",
      ],
    },
    facsimile: {
      formTitle: "Roster match report",
      agency: "Synthetic reconciliation · Summer_Roster_0721.xlsx",
      sections: [
        {
          heading: "Match summary",
          fields: [
            { label: "Roster rows", value: "6" },
            { label: "Matched on EID", value: "5" },
            { label: "Name + dept", value: "1" },
            { label: "Unmatched", value: "0" },
          ],
        },
        {
          heading: "Integrity",
          fields: [
            { label: "One-to-one", value: "6 of 6 rows consumed once" },
            { label: "Roster hash", value: "sha256:0d5c…71bb" },
          ],
        },
      ],
      signatures: [],
    },
  },
  "ocr-summer::Page 2 · Alvarez": {
    step: "OCR extraction",
    system: "i9",
    capturedAt: at("14:20:44"),
    ref: "sha256:1d77…04ae",
    screen: "packet.page",
    pageState: "extracted",
    size: { w: 612, h: 792 },
    note: "Typed name block, handwritten signature and date. Every field read on the first pass.",
    extraction: {
      formKind: "oath form",
      sourcePdf: "Oath_Packet_Summer.pdf",
      sourcePage: 2,
      pageCount: SUMMER_PACKET_PAGES,
      fields: [
        { key: "Printed name", value: "Ana Alvarez", state: "read", confidence: 0.97, source: "PAPER" },
        { key: "Employee ID", value: "10510221", state: "read", confidence: 0.93, source: "PAPER" },
        { key: "Signature date", value: "07/21/2026", state: "read", confidence: 0.95, source: "PAPER" },
        { key: "Employee signed", value: "yes — on paper", state: "read", confidence: 0.99, source: "PAPER" },
        { key: "Officer signed", value: "yes — on paper", state: "read", confidence: 0.98, source: "PAPER" },
        { key: "Department", value: "000371 · Student Health", state: "read", confidence: 1, source: "UCPATH" },
        { key: "Payroll title", value: "Blank Assistant 3", state: "read", confidence: 1, source: "UCPATH" },
      ],
      notes: [
        "Name block is typed, not handwritten.",
        "Signature date matches the packet's preparation date within tolerance.",
      ],
    },
    facsimile: oathFacsimile({ name: "Ana Alvarez", eid: "10510221", date: "07/21/2026" }),
  },
  "ocr-summer::Page 3 · Brooks": {
    step: "OCR extraction",
    system: "i9",
    capturedAt: at("14:20:51"),
    ref: "sha256:33e0…c5b2",
    screen: "packet.page",
    pageState: "extracted-with-flags",
    size: { w: 612, h: 792 },
    note: "The EID on this page is a digit short of the roster's; the match fell back to name + department.",
    extraction: {
      formKind: "oath form",
      sourcePdf: "Oath_Packet_Summer.pdf",
      sourcePage: 3,
      pageCount: SUMMER_PACKET_PAGES,
      fields: [
        { key: "Printed name", value: "Ben Brooks", state: "read", confidence: 0.95, source: "PAPER" },
        { key: "Employee ID", value: "1053874", state: "illegible", confidence: 0.52, source: "PAPER", reason: "seven digits where UCPath EIDs are eight — the final digit is written over the ruled line and could not be trusted" },
        { key: "Signature date", value: "07/21/2026", state: "read", confidence: 0.9, source: "PAPER" },
        { key: "Employee signed", value: "yes — on paper", state: "read", confidence: 0.97, source: "PAPER" },
        { key: "Officer signed", value: "yes — on paper", state: "read", confidence: 0.96, source: "PAPER" },
        { key: "Department", value: "000371 · Student Health", state: "read", confidence: 1, source: "UCPATH" },
        { key: "Payroll title", value: "Blank Assistant 3", state: "read", confidence: 1, source: "UCPATH" },
      ],
      notes: [
        "Employee ID transcribed as written and flagged rather than corrected — an EID guessed to eight digits is how the wrong person gets an oath filed.",
        "Roster matched this person on name + department instead; the EID above is what the PAGE says, not what was used.",
      ],
    },
    facsimile: oathFacsimile({ name: "Ben Brooks", eid: "1053874_", date: "07/21/2026" }),
  },
  "ocr-summer::Page 5 · Diaz": {
    step: "OCR extraction",
    system: "i9",
    capturedAt: at("14:21:02"),
    ref: "sha256:a904…7e63",
    screen: "packet.page",
    pageState: "extracted-blocked",
    size: { w: 612, h: 792 },
    note: "Read cleanly. It is UCPath that blocks this one — the person is separated, so the packet cannot file an oath for them.",
    extraction: {
      formKind: "oath form",
      sourcePdf: "Oath_Packet_Summer.pdf",
      sourcePage: 5,
      pageCount: SUMMER_PACKET_PAGES,
      fields: [
        { key: "Printed name", value: "Diego Diaz", state: "read", confidence: 0.96, source: "PAPER" },
        { key: "Employee ID", value: "10499310", state: "read", confidence: 0.94, source: "PAPER" },
        { key: "Signature date", value: "07/20/2026", state: "read", confidence: 0.92, source: "PAPER" },
        { key: "Employee signed", value: "yes — on paper", state: "read", confidence: 0.98, source: "PAPER" },
        { key: "Officer signed", state: "missing", source: "PAPER", reason: "the officer line is blank on this sheet" },
        { key: "Employment status", value: "Inactive — separated 06/30/2026", state: "read", confidence: 1, source: "UCPATH" },
      ],
      notes: [
        "Extraction is clean; the block is an employment-status fact from UCPath, not a reading problem.",
        "Officer signature missing — this would block the filing on its own even if the person were active.",
      ],
    },
    facsimile: {
      ...oathFacsimile({ name: "Diego Diaz", eid: "10499310", date: "07/20/2026" }),
      signatures: [
        { label: "Employee signature", signedBy: "Diego Diaz", date: "07/20/2026" },
        { label: "Officer / witness" },
      ],
    },
  },
  // An I-9 SECTION 1 page, so the viewer is exercised against the other form
  // kind the corpus knows. Same synthetic-values rule.
  "i9-m-19::Section 1 p22": {
    step: "Roster match",
    system: "i9",
    capturedAt: at("13:52:18"),
    ref: "sha256:5ab2…8c40",
    screen: "packet.page",
    pageState: "extracted-with-flags",
    size: { w: 612, h: 792 },
    note: "Section 1 only. No Section 2 sheet for this person appears in the batch, which is what the retention tracker is flagged with.",
    extraction: {
      formKind: "i9 section 1",
      sourcePdf: "I9_Supporting_0724.pdf",
      sourcePage: 22,
      pageCount: 62,
      fields: [
        { key: "Last name", value: "Okafor", state: "read", confidence: 0.97, source: "PAPER" },
        { key: "First name", value: "Ngozi", state: "read", confidence: 0.95, source: "PAPER" },
        { key: "Middle initial", state: "missing", source: "PAPER", reason: "field left blank on the form" },
        { key: "Date of birth", state: "illegible", confidence: 0.41, source: "PAPER", reason: "written with a 2-digit year and the final digit is ambiguous (4 vs 7), so the field was nulled rather than guessed" },
        { key: "SSN", value: "•••-••-4182", state: "read", confidence: 0.88, source: "PAPER" },
        { key: "Hire date", value: "03/07/2024", state: "read", confidence: 0.93, source: "PAPER" },
        { key: "Telephone", state: "missing", source: "PAPER", reason: "telephone number field left blank" },
      ],
      notes: [
        "Section 1 fields are typed, not handwritten.",
        "No Section 2 sheet for this employee appears in this batch.",
        "SSN is stored masked; the full value never leaves the extractor.",
      ],
    },
    facsimile: {
      formTitle: "Employment Eligibility Verification — Section 1",
      agency: "U.S. Citizenship and Immigration Services · Form I-9",
      sections: [
        {
          heading: "Employee information and attestation",
          fields: [
            { label: "Last name", value: "Okafor" },
            { label: "First name", value: "Ngozi" },
            { label: "Middle initial", value: "—" },
            { label: "Date of birth", value: "—  (illegible)", hand: true },
            { label: "SSN", value: "•••-••-4182", hand: true },
            { label: "Telephone", value: "—" },
          ],
        },
      ],
      signatures: [{ label: "Employee signature", signedBy: "N. Okafor", date: "03/07/2024" }],
    },
  },
  "onb-jordan::CRM record": {
    step: "CRM extraction",
    system: "crm",
    capturedAt: at("11:42:20"),
    ref: "sha256:1a90…4e21",
    screen: "crm.onboarding.case",
    pageState: "loaded",
    urlRedacted: "https://crm.ucsd.edu/onboarding/case/•••",
    size: VIEWPORT,
    note: "The case as it was read — wage, effective date and department in one frame.",
  },
  "onb-jordan::I-9 profile": {
    step: "I-9 creation",
    system: "i9",
    capturedAt: at("11:45:58"),
    ref: "sha256:88bc…0f77",
    screen: "i9.profile",
    pageState: "created",
    size: VIEWPORT,
    note: "The read-back of PRF-118203, not the submit response.",
  },
  "onb-jordan::SmartHR form": {
    step: "SmartHR transaction",
    system: "ucpath",
    capturedAt: at("11:48:05"),
    ref: "sha256:2c41…9ba3",
    screen: "ucpath.smarthr.hire",
    pageState: "form-complete",
    size: VIEWPORT,
    note: "The frame the identity-at-commit was observed in — the header reads “Whitfield, Jordan · 10633092”.",
  },
  "onb-jordan::TXN confirmation": {
    step: "SmartHR transaction",
    system: "ucpath",
    capturedAt: at("11:48:41"),
    ref: "sha256:5f08…c132",
    screen: "ucpath.smarthr.confirmation",
    pageState: "submitted",
    size: VIEWPORT,
    note: "TXN-0891245 as UCPath printed it. This is the capture the Q8 double-check rests on.",
  },
  "cd-samuel::Search results (0)": {
    step: "Search record",
    system: "crm",
    capturedAt: at("13:12:50"),
    ref: "sha256:9d3e…7710",
    screen: "crm.onboarding.search",
    pageState: "results-empty",
    urlRedacted: "https://crm.ucsd.edu/onboarding/search?q=•••",
    size: VIEWPORT,
    note: "The empty-results state at the moment of failure — the frame the failure record points at.",
  },
  "cd-samuel::CRM auth": {
    step: "CRM auth",
    system: "crm",
    capturedAt: at("13:12:21"),
    ref: "sha256:3b6a…1d05",
    screen: "crm.auth",
    pageState: "authenticated",
    size: VIEWPORT,
  },
  "cd-samuel::Query as typed": {
    step: "Search record",
    system: "crm",
    capturedAt: at("13:12:49"),
    ref: "sha256:6612…ae40",
    screen: "crm.onboarding.search",
    pageState: "query-entered",
    size: VIEWPORT,
    note: "Kept because “what did it actually type” is the first question a no-results failure raises.",
  },
  "sep-rosa::Form at submit": {
    step: "UCPath transaction",
    system: "ucpath",
    capturedAt: at("13:50:29"),
    ref: "sha256:aa71…33d9",
    screen: "ucpath.smarthr.termination",
    pageState: "form-complete",
    size: VIEWPORT,
    note: "The last frame before Submit. Everything after this is unknown — which is the whole reason this run is parked.",
  },
  "sep-rosa::Dropped session": {
    step: "UCPath transaction",
    system: "ucpath",
    capturedAt: at("13:52:07"),
    ref: "sha256:0e5c…b284",
    screen: "ucpath.sso.login",
    pageState: "session-expired",
    size: VIEWPORT,
    note: "Where the confirmation page should have been. No transaction number was ever on screen.",
  },
  "sep-rosa::Kuali doc": { step: "Kuali extraction", system: "kuali", capturedAt: at("13:48:22"), ref: "sha256:74b2…9901", screen: "kuali.separation.doc", pageState: "loaded", size: VIEWPORT },
  "sep-rosa::Job summary": { step: "Job summary", system: "ucpath", capturedAt: at("13:49:10"), ref: "sha256:c318…2f60", screen: "ucpath.person.jobsummary", pageState: "loaded", size: VIEWPORT },
  "oath-batch::Packet page 1": {
    step: "OCR extraction",
    system: "i9",
    capturedAt: at("11:05:44"),
    ref: "sha256:4410…de92",
    screen: "ocr.page",
    pageState: "rendered",
    size: { w: 1275, h: 1650 },
    note: "Page 1 of 12 as the extractor saw it.",
  },
  "oath-batch::Approval snapshot": {
    step: "Approval",
    capturedAt: at("11:12:02"),
    ref: "sha256:71fe…0c48",
    screen: "review.approval",
    pageState: "approved",
    size: VIEWPORT,
    note: "The record set exactly as it was approved — 12 of 12, before any fan-out.",
  },
  "ob-elena::Import confirmation": {
    step: "Import",
    system: "onbase",
    capturedAt: at("09:54:58"),
    ref: "sha256:8802…41de",
    screen: "onbase.import.result",
    pageState: "imported",
    size: VIEWPORT,
    note: "OB-8841203 in the import result panel — the one thing on this run that WAS read back.",
  },
  "ob-elena::Keyword panel": {
    step: "Fill keywords",
    system: "onbase",
    capturedAt: at("09:54:20"),
    ref: "sha256:1f27…6d3b",
    screen: "onbase.keywords",
    pageState: "filled",
    size: VIEWPORT,
    note: "The keywords as typed. OnBase never showed them back, so this frame is the only record of what went in.",
  },
  "sep-dana::Kuali doc 5-RWP2KD": {
    step: "Kuali extraction",
    system: "kuali",
    capturedAt: at("13:18:36"),
    ref: "sha256:5d31…c8b0",
    screen: "kuali.separation.doc",
    pageState: "loaded",
    size: VIEWPORT,
    note: "The document the name was read from — the name that then matched nobody.",
  },
  "sep-maria::Kronos timeout": {
    step: "Kronos search",
    system: "kronos",
    capturedAt: at("14:04:41"),
    ref: "sha256:be14…7a02",
    screen: "kronos.employee.search",
    pageState: "timeout",
    size: VIEWPORT,
    note: "Attempt 1's timeout. Attempt 2 succeeded, and both frames are kept.",
  },
  "sep-maria::Kronos search": { step: "Kronos search", system: "kronos", capturedAt: at("14:05:44"), ref: "sha256:2091…ff3c", screen: "kronos.employee.search", pageState: "results", size: VIEWPORT },
  "sep-maria::Paused at gate": { step: "Identity check", system: "ucpath", capturedAt: at("14:08:02"), ref: "sha256:cc70…5518", screen: "ucpath.person.search", pageState: "results-multiple", size: VIEWPORT, note: "Two candidates on screen — the frame the identity gate is asking about." },
  "sep-maria::Kuali doc 4-VMPHRW": {
    step: "Kuali extraction",
    system: "kuali",
    capturedAt: at("14:01:12"),
    ref: "sha256:a91c…44e2",
    screen: "kuali.separation.doc",
    pageState: "loaded",
    size: VIEWPORT,
  },
  "sep-maria::Identity check": {
    step: "Identity check",
    system: "ucpath",
    capturedAt: at("14:07:40"),
    ref: "sha256:11f0…c3a8",
    screen: "ucpath.person.search",
    pageState: "results-multiple",
    size: VIEWPORT,
  },
  "sep-maria::Job summary": {
    step: "Job summary",
    system: "ucpath",
    capturedAt: at("14:03:18"),
    ref: "sha256:6b2e…91d0",
    screen: "ucpath.person.jobsummary",
    pageState: "loaded",
    size: VIEWPORT,
  },

  // EC packet — both frames from OCR extraction; the rejected page never left that step.
  "ec-packet::Packet page 1": {
    step: "OCR extraction",
    system: "i9",
    capturedAt: at("11:28:18"),
    ref: "sha256:e4c0…7b19",
    screen: "packet.page",
    pageState: "extracted",
    size: { w: 612, h: 792 },
    note: "Cover page of EC_Forms_0722.pdf — the batch header before contact blocks are read.",
  },
  "ec-packet::Page 7 (rejected)": {
    step: "OCR extraction",
    system: "i9",
    capturedAt: at("11:29:44"),
    ref: "sha256:91aa…2c0f",
    screen: "packet.page",
    pageState: "rejected",
    size: { w: 612, h: 792 },
    note: "No contact block on this page — rejected member emitted; delete-only until acknowledged.",
  },
};

// ===========================================================================
// 5. The projection — fetch by id, derive identity from the row
// ===========================================================================

const RESULT_BY_STATUS: Partial<Record<ProposedStatus, DemoReceiptResult>> = {
  verifiedDone: "verified-done",
  doneWarnings: "done-with-warnings",
  cancelled: "cancelled",
  failed: "failed",
};

/**
 * The verdict is DERIVED, never authored. A run that failed after landing real
 * writes is a PARTIAL outcome — doc 12's enum has that word precisely so a
 * packet with 11 confirmations and 1 casualty cannot be filed under "failed"
 * (which reads as "nothing happened") or under "done" (which reads as a lie).
 */
export function deriveReceiptResult(status: ProposedStatus, members: DemoReceiptMember[] | undefined): DemoReceiptResult {
  const base = RESULT_BY_STATUS[status] ?? "partial";
  if (base === "failed" && members?.some((m) => m.readBack === "verified")) return "partial";
  return base;
}

/**
 * doc 12 §2.3's receipt invariant, re-checked at render time: `verified-done`
 * requires verified confidence, every mandatory criterion met, and no member
 * left unfinished. The surface calls this and refuses to print a green verdict
 * that fails it, rather than trusting the fixture that produced it.
 */
export function receiptInvariant(receipt: DemoRunReceipt): string | null {
  if (receipt.result !== "verified-done") return null;
  if (receipt.confidence !== "verified") {
    return `result "verified-done" with confidence "${receipt.confidence}" — a verdict this receipt cannot justify.`;
  }
  const unmet = receipt.verification.filter((v) => v.result !== "met");
  if (unmet.length > 0) {
    return `result "verified-done" with ${unmet.length} unmet or unverifiable criterion — ${unmet[0].criterion}.`;
  }
  if (receipt.members?.some((m) => m.readBack !== "verified")) {
    return `result "verified-done" with a member that was never read back.`;
  }
  return null;
}

/** how much of this receipt is a claim about a TEST instance rather than a filing */
export function testInstanceSystems(receipt: DemoRunReceipt): SystemKey[] {
  return (Object.keys(receipt.resolvedInstance) as SystemKey[]).filter((s) => receipt.resolvedInstance[s] === "test");
}

/** `evidence.receiptId` on the row → the full record. Null when none is served. */
export function receiptFor(row: DemoRow): DemoRunReceipt | null {
  const id = row.evidence.receiptId;
  if (!id) return null;
  const found = RECEIPT_SPECS[id];
  if (!found) return null;
  const { memberConfirmations, ...spec } = found;

  const members = memberConfirmations
    ? (row.memberIds ?? [])
        .map((memberId) => ({ memberId, member: DEMO_ROWS[memberId] }))
        .filter((m) => Boolean(m.member) && m.member.containment !== "rejected")
        .map(({ memberId, member }) => {
          const authored = memberConfirmations[memberId];
          return {
            rowId: memberId,
            name: member.title,
            eid: member.eid,
            confirmation: authored?.confirmation,
            readBack: authored?.readBack ?? "unverified",
            note: authored?.note ?? (authored ? undefined : "no confirmation recorded for this member"),
          } satisfies DemoReceiptMember;
        })
    : undefined;

  const status = effectiveStatus(row);
  return {
    ...spec,
    rowId: row.id,
    runId: row.runId,
    traceId: row.trace,
    workflowId: row.workflowId,
    workflowLabel: row.workflow.label,
    attempt: row.attempt,
    retryOf: row.retryOf,
    actor: row.requestedBy,
    resolvedInstance: row.resolvedInstance,
    observations: row.data
      .filter((d) => d.dir === "read")
      .map((d) => ({ key: d.field, value: d.value, system: d.system, at: d.ts, source: "live" as const })),
    output: row.data
      .filter((d) => d.dir === "write")
      .map((d) => ({
        key: d.field,
        value: d.value,
        system: d.system,
        at: d.ts,
        source: "live" as const,
        note: d.unconfirmed ? "submitted, never read back" : d.staged ? "staged, not submitted" : undefined,
      })),
    members,
    confidence: row.evidence.confidence,
    result: deriveReceiptResult(status, members),
  };
}

/** `evidence.failureId` on the row → the full record. Null when none is served. */
export function failureFor(row: DemoRow): DemoFailureRecord | null {
  const id = row.evidence.failureId;
  if (!id) return null;
  const spec = FAILURE_SPECS[id] ?? (id.startsWith("fail-ic-m") ? i9MemberFailure(row, id) : undefined);
  if (!spec) return null;
  // A group can carry a MEMBER's failure id (the packet's `evidence.failureId`
  // points at the signer that failed). Identity comes from the row the failure
  // actually happened on, so a mirrored record never claims the parent's trace.
  const owner = spec.ownerRowId ? (DEMO_ROWS[spec.ownerRowId] ?? row) : row;
  return {
    ...spec,
    rowId: owner.id,
    runId: owner.runId,
    traceId: owner.trace,
    attempt: owner.attempt,
    workflowId: owner.workflowId,
    workflowLabel: owner.workflow.label,
  };
}

/**
 * The receipt capture gallery's model. Built from the row's OWN `shots` so the
 * gallery and lightbox can never show different sets, enriched with whatever
 * the capture store serves for that row and label.
 */
export function capturesFor(row: DemoRow): DemoCapture[] {
  return row.shots.map((shot, i) => {
    const meta = CAPTURE_META[`${row.id}::${shot.label}`];
    return {
      id: `${row.id}-cap-${i}`,
      label: shot.label,
      kind: shot.kind,
      failure: shot.kind === "error",
      ...meta,
      // Fixture `step` wins when meta is absent; meta wins when both exist
      // (richer CAPTURE_META stays authoritative for authored captures).
      step: meta?.step ?? shot.step,
    };
  });
}

/** Captures with no authored workflow step — kept last, never invent a fake name. */
export const CAPTURE_STEP_UNSCOPED = "Unscoped";

/**
 * Group captures by the workflow step they were taken on — same order idea as
 * the Data ledger: the run's own `steps[]` first, then any leftover step names
 * in first-seen order, with unscoped frames last.
 *
 * Kind filters (All / Errors / Steps) stay orthogonal — call this on the
 * already-filtered list.
 */
export function groupCapturesByStep(
  captures: readonly DemoCapture[],
  stepOrder?: readonly string[],
): { step: string; captures: DemoCapture[] }[] {
  const buckets = new Map<string, DemoCapture[]>();
  for (const capture of captures) {
    const key = capture.step?.trim() || CAPTURE_STEP_UNSCOPED;
    const list = buckets.get(key);
    if (list) list.push(capture);
    else buckets.set(key, [capture]);
  }

  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const step of stepOrder ?? []) {
    if (buckets.has(step) && !seen.has(step)) {
      ordered.push(step);
      seen.add(step);
    }
  }
  for (const key of buckets.keys()) {
    if (key === CAPTURE_STEP_UNSCOPED || seen.has(key)) continue;
    ordered.push(key);
    seen.add(key);
  }
  if (buckets.has(CAPTURE_STEP_UNSCOPED) && !seen.has(CAPTURE_STEP_UNSCOPED)) {
    ordered.push(CAPTURE_STEP_UNSCOPED);
  }

  return ordered.map((step) => ({ step, captures: buckets.get(step)! }));
}

export const CAPTURE_KIND_LABEL: Record<DemoCaptureKind, string> = {
  step: "Steps",
  error: "Errors",
  form: "Forms",
  confirmation: "Confirmations",
};

// ---------------------------------------------------------------------------
// Identity-candidate captures — fetch by id, like every other record here
// ---------------------------------------------------------------------------

/**
 * The capture of ONE candidate as it appeared in the source system at the
 * moment the run stopped to ask.
 *
 * An identity gate that shows two names and no pictures is asking the operator
 * to choose between two strings. These are what makes that a choice between two
 * PEOPLE: the search result, the person page, the document the name was typed
 * off. They are captured at identity-resolution time — the page is gone by the
 * time anybody reads the gate — and retained with the run for as long as the
 * run's evidence is retained.
 *
 * Keyed by `captureId` and fetched by id, exactly like `receiptFor` and
 * `failureFor`: a candidate whose id resolves to nothing has NO capture and the
 * surface says so. It never borrows a neighbour's.
 */
const CANDIDATE_CAPTURES: Record<string, DemoCapture> = {
  "cap-ident-sep-maria-input": {
    id: "cap-ident-sep-maria-input",
    label: "Kuali doc 4-VMPHRW — the name as filed",
    kind: "form",
    failure: false,
    step: "Identity check",
    system: "kuali",
    capturedAt: at("14:03:31"),
    ref: "sha256:c07f…12ab",
    screen: "kuali.separation.document",
    pageState: "loaded",
    urlRedacted: "https://kuali.ucsd.edu/space/•••/doc/4-VMPHRW",
    size: VIEWPORT,
    note: "The separation document as it was read. The employee block gives a name and no EID — which is the whole reason this gate exists.",
  },
  "cap-ident-sep-maria-match": {
    id: "cap-ident-sep-maria-match",
    label: "UCPath person search — 1 active match",
    kind: "step",
    failure: false,
    step: "Identity check",
    system: "ucpath",
    capturedAt: at("14:03:33"),
    ref: "sha256:4d21…9e08",
    screen: "ucpath.person.search.results",
    pageState: "results-1",
    urlRedacted: "https://ucpath.universityofcalifornia.edu/•••/person_search",
    size: VIEWPORT,
    note: "The result row the match came from: M. Lopez-Garcia · 10583942 · Dept 000371 · Blank Ast 3, HR status Active.",
  },
  "cap-ident-sep-l-2-match": {
    id: "cap-ident-sep-l-2-match",
    label: "UCPath person search — I. R. Garcia",
    kind: "step",
    failure: false,
    step: "Identity check",
    system: "ucpath",
    capturedAt: at("13:53:18"),
    ref: "sha256:7b93…20cd",
    screen: "ucpath.person.search.results",
    pageState: "results-1",
    size: VIEWPORT,
    note: "One active match, with a middle initial the typed name does not carry. Dept 000482 · Lab Ast 2.",
  },
  "cap-ident-ic-m11-a": {
    id: "cap-ident-ic-m11-a",
    label: "Candidate A — UCPath person page",
    kind: "step",
    failure: false,
    step: "Person match",
    system: "ucpath",
    capturedAt: at("13:56:12"),
    ref: "sha256:aa10…7714",
    screen: "ucpath.person.summary",
    pageState: "loaded",
    size: VIEWPORT,
    note: "10531548 · Dept 000371 · hired 03/12/2024. The hire date on this page is the one that matches the form.",
  },
  "cap-ident-ic-m11-b": {
    id: "cap-ident-ic-m11-b",
    label: "Candidate B — UCPath person page",
    kind: "step",
    failure: false,
    step: "Person match",
    system: "ucpath",
    capturedAt: at("13:56:14"),
    ref: "sha256:bb42…03f1",
    screen: "ucpath.person.summary",
    pageState: "loaded",
    size: VIEWPORT,
    note: "10577940 · Dept 000512 · hired 09/02/2019. Same printed name, different person.",
  },
  "cap-ident-ic-m11-c": {
    id: "cap-ident-ic-m11-c",
    label: "Candidate C — UCPath person page",
    kind: "step",
    failure: false,
    step: "Person match",
    system: "ucpath",
    capturedAt: at("13:56:16"),
    ref: "sha256:cc85…c920",
    screen: "ucpath.person.summary",
    pageState: "loaded",
    size: VIEWPORT,
    note: "10604771 · Dept 000371 · hired 08/19/2025, HR status Active. Shares the department with candidate A, which is why the department alone cannot decide this.",
  },
};

/** the identity-candidate capture behind a `captureId`, or nothing */
export function candidateCaptureFor(captureId: string | undefined): DemoCapture | undefined {
  return captureId ? CANDIDATE_CAPTURES[captureId] : undefined;
}

// ===========================================================================
// 6. Export — the three exports the operator actually asked for
// ===========================================================================

/**
 * The run as text: what a bug report gets pasted into. Built from the row's own
 * served lines, so it cannot say anything the Logs tab does not.
 */
export function exportRunLogsText(row: DemoRow): string {
  const head = [
    `# ${row.displayName ?? row.title} — ${row.workflow.label}`,
    `trace   ${row.trace}`,
    `run     ${row.runId} · attempt ${row.attempt} · version ${row.version}`,
    `actor   ${row.requestedBy}`,
    `status  ${row.status}${row.dryRun ? " · DRY RUN — nothing was written" : ""}`,
    `window  enqueued ${row.enqueuedAt}${row.startedAt ? ` · started ${row.startedAt}` : ""}${row.endedAt ? ` · ended ${row.endedAt}` : ""}`,
    "",
  ];
  const body = row.lines.map((l) => {
    const pills = (l.pills ?? []).map((p) => `${p.dir === "read" ? "←" : "→"} ${p.label}=${p.value}`).join(" ");
    return [l.ts, l.kind.toUpperCase().padEnd(6), l.system ? `[${l.system}]` : "", l.text ?? "", pills].filter(Boolean).join(" ");
  });
  return [...head, ...body, ""].join("\n");
}

/** the run as JSON — the row, its receipt and its failure record, exactly as served */
export function exportRunJson(row: DemoRow): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      note: "Rebuild demo export. Every field here is one the mock server served to the surface — nothing was added at export time.",
      run: {
        runId: row.runId,
        itemId: row.itemId,
        traceId: row.trace,
        workflow: row.workflow,
        rowType: row.rowType,
        status: row.status,
        attempt: row.attempt,
        version: row.version,
        dryRun: row.dryRun,
        priority: row.priority,
        resolvedInstance: row.resolvedInstance,
        workflowVersion: row.workflowVersion,
        appVersion: row.appVersion,
        requestedBy: row.requestedBy,
        enqueuedAt: row.enqueuedAt,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        evidence: row.evidence,
      },
      pipeline: row.steps,
      dataPoints: row.data,
      receipt: receiptFor(row),
      failure: failureFor(row),
      captures: capturesFor(row),
    },
    null,
    2,
  );
}

/** the bundle manifest as JSON — what `explain run --bundle` would write */
export function exportBundleJson(failure: DemoFailureRecord): string {
  return JSON.stringify({ exportedAt: new Date().toISOString(), failure }, null, 2);
}
