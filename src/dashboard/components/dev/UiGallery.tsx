import { useState, type ReactNode } from "react";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BatchQueueParentRunIdProvider } from "@/components/hooks/useBatchQueueContext";
import { TerminalDrawerProvider } from "@/components/hooks/useTerminalDrawer";
import { WorkflowsProvider } from "@/lib/workflows-context";
import type { TrackerEntry, WorkflowInstanceState } from "@/components/shared/types";
import { EntryItem } from "@/components/queue-panel/EntryItem";
import { DaemonBatchRow } from "@/components/queue-panel/DaemonBatchRow";
import { OperationRow } from "@/components/queue-panel/OperationRow";
import { StatPills } from "@/components/queue-panel/StatPills";
import { QueueSortDropdown } from "@/components/queue-panel/QueueSortDropdown";
import { RetryAllButton } from "@/components/queue-panel/RetryAllButton";
import { StopAllButton } from "@/components/queue-panel/StopAllButton";
import { DeleteAllButton } from "@/components/queue-panel/DeleteAllButton";
import {
  buildQueueProjectionRows,
  type OperationSurface,
  type QueueGroupProjectionRow,
} from "@/components/queue-panel/queue-surface-classifier";
import { DEFAULT_QUEUE_SORT_MODE, type QueueSortMode } from "@/components/queue-panel/queue-sort";
import { WorkflowBox } from "@/components/terminal-drawer/WorkflowBox";
import { LiveIndicator } from "@/components/terminal-drawer/LiveIndicator";
import { BrowserChip } from "@/components/terminal-drawer/BrowserChip";
import { EmptyState } from "@/components/shared/EmptyState";
import type { AuthState } from "@/components/shared/types";
import { buildWorkflowRunProjection } from "../../../domain/workflow-runtime/projection.js";
import type { TrackerEntry as TrackerEntryJsonl } from "../../../tracker/jsonl.js";
import type { WorkflowRunProjection } from "../../../domain/workflow-runtime/types.js";

/**
 * TEMPORARY DEV ROUTE — `?view=ui-gallery`.
 *
 * A catalog of the dashboard's reusable surfaces, rendered with the REAL
 * components fed synthetic data. Organized into tabs:
 *
 *   - Queue Rows   → row archetypes (single / batch / approval+preview).
 *                    Workflow-agnostic; variations come from kind + status/
 *                    derived tags. Approval and preview rows share the `preview`
 *                    archetype (approval gates fan-out; preview is read-only).
 *   - Session Cards → the terminal-drawer `WorkflowBox` daemon session card,
 *                     across its lifecycle states (in-flight, authing, duo,
 *                     idle, keepalive, complete, failed, crashed).
 *   - Controls     → toolbar buttons, stat/filter pills, sort, and the small
 *                    indicators (Live pill, browser chips, empty state).
 *
 * Reusing the real components means design regressions show up here. Remove
 * this file + its `?view=ui-gallery` gate in App.tsx when done.
 */

const DATE = "2026-06-01";
const NOOP = () => {};
const EMPTY_DISPLAY_NAMES = new Map<string, string>();

/** Relative ISO start so session-card elapsed timers read as live. */
function agoIso(secondsAgo: number): string {
  return new Date(Date.now() - secondsAgo * 1000).toISOString();
}

// ===========================================================================
// Shared layout chrome (tabs + labeled variant cells).
// ===========================================================================

interface VariantProps {
  label: string;
  axes: string;
  note?: string;
  /** Variant cell width; session cards need their native 290px. */
  width?: number;
  children: ReactNode;
}

function Variant({ label, axes, note, width = 380, children }: VariantProps) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/30 overflow-hidden">
      <div className="px-3 py-2 border-b border-border/60 bg-secondary/20">
        <div className="text-[13px] font-semibold text-foreground">{label}</div>
        <div className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">{axes}</div>
        {note && <div className="mt-0.5 text-[10.5px] text-muted-foreground/80">{note}</div>}
      </div>
      {/* Mimic the owning column width so wrapping/truncation matches reality. */}
      <div className="pb-2" style={{ width }}>
        {children}
      </div>
    </div>
  );
}

function Section({ title, sub }: { title: ReactNode; sub: string }) {
  return (
    <div className="col-span-full mt-7 first:mt-0">
      <h2 className="text-[16px] font-bold text-foreground">{title}</h2>
      <p className="text-[12px] text-muted-foreground mt-0.5">{sub}</p>
    </div>
  );
}

// ===========================================================================
// QUEUE ROWS — synthetic tracker rows + the real EntryItem / DaemonBatchRow.
// ===========================================================================

/** Build a synthetic tracker row. `_hash` is required for EntryItem's memo. */
function row(partial: Partial<TrackerEntry> & { id: string }): TrackerEntry {
  return {
    workflow: "onboarding",
    timestamp: "2026-06-01T09:56:00.000Z",
    status: "pending",
    _hash: partial.id,
    ...partial,
  } as TrackerEntry;
}

/**
 * Minimal projection carrying a batch card's title + (trace-id) subtitle.
 * `projection.title` (batchGroupTitle) is the primary title path in production,
 * so passing it here is faithful. An empty title renders a no-title anchor.
 */
function batchProjection(runId: string, title: string, subtitle: string): WorkflowRunProjection {
  // Enabled retry+delete descriptors with empty targets → BatchFooterActions
  // acts on every member, so the bulk retry/delete icons render in the footer.
  const bulk = (kind: "retry" | "delete") => ({
    kind,
    scope: "group" as const,
    source: "queue-panel" as const,
    label: kind === "retry" ? "Retry all" : "Delete all",
    enabled: true,
    targets: [],
  });
  return {
    runId,
    workflowId: "",
    itemId: runId,
    title,
    subtitle,
    status: "running",
    surfaceType: "batch",
    rowTypeLabel: "Batch",
    actions: [bulk("retry"), bulk("delete")],
    batchMembers: [],
  } as unknown as WorkflowRunProjection;
}

/**
 * A flat EntryItem in its own selectable shell. Feeds the row a REAL projection
 * (default policy, status-gated row actions) so the footer's button cluster
 * matches production exactly: running → ×, queued → ▲ × 🗑, done/failed → ↻ 🗑.
 */
function Flat({ entry, selected = false }: { entry: TrackerEntry; selected?: boolean }) {
  return (
    <EntryItem
      entry={entry}
      projection={buildWorkflowRunProjection(entry as unknown as TrackerEntryJsonl, {})}
      displayNames={EMPTY_DISPLAY_NAMES}
      selected={selected}
      onSelect={NOOP}
      date={DATE}
      onDelete={NOOP}
    />
  );
}

/**
 * A neutral batch group card — same component for every workflow.
 * `title=""` renders a no-title person anchor (count + member names identify it).
 */
function Batch({
  parentRunId,
  members,
  workflowLabel,
  title,
  subtitle,
  anchorEntry,
}: {
  parentRunId: string;
  members: TrackerEntry[];
  workflowLabel: string;
  title: string;
  subtitle: string;
  /** Footer fallback when the batch has no members (pre-fan-out anchor). */
  anchorEntry?: TrackerEntry;
}) {
  return (
    <DaemonBatchRow
      workflow="oath-signature"
      date={DATE}
      batchParentRunId={parentRunId}
      workflowLabel={workflowLabel}
      projection={batchProjection(parentRunId, title, subtitle)}
      memberEntries={members}
      anchorEntry={anchorEntry}
      isBatchQueueFocused={false}
      onEnterBatchQueue={NOOP}
      onDeletedIds={NOOP}
    />
  );
}

type OperationGalleryRow = QueueGroupProjectionRow & { surface: OperationSurface };

function buildOperationGalleryRow(
  parent: TrackerEntry,
  members: TrackerEntry[],
  workflowLabel: string,
): OperationGalleryRow {
  const projected = buildQueueProjectionRows({
    entries: [parent],
    delegationSourceEntries: [parent, ...members],
    workflow: parent.workflow,
    workflowLabel,
    displayNames: EMPTY_DISPLAY_NAMES,
  });
  const operation = projected.groupRows.find(
    (group): group is OperationGalleryRow =>
      group.surface.kind === "operation" &&
      group.surface.parentRunId === (parent.runId ?? parent.id),
  );
  if (!operation) {
    throw new Error(`UI gallery operation fixture did not produce an operation surface for ${parent.id}`);
  }
  return operation;
}

function OperationFixture({
  fixture,
  defaultExpanded = false,
}: {
  fixture: OperationGalleryRow;
  defaultExpanded?: boolean;
}) {
  return (
    <OperationRow
      date={DATE}
      parentRunId={fixture.surface.parentRunId}
      projection={fixture.projection}
      displayNames={EMPTY_DISPLAY_NAMES}
      parent={fixture.surface.parent}
      members={fixture.surface.members}
      ocr={fixture.surface.ocr}
      selected={false}
      selectedId={null}
      onSelect={NOOP}
      onDelete={NOOP}
      defaultExpanded={defaultExpanded}
      onOpenOcrReview={NOOP}
    />
  );
}

// --- SINGLE: kind variations (title/subtitle only) ---
const singlePerson = row({
  id: "s-person",
  status: "running",
  firstLogTs: "2026-06-01T09:24:00.000Z",
  lastLogMessage: "Filling award row…",
  runOrdinal: 1,
  data: {
    archetype: "single",
    queueRowKind: "person",
    name: "Maria Gonzalez",
    emplId: "10012345",
    __traceId: "ws-092400-7c2a",
  },
});

const singleFile = row({
  id: "s-file",
  status: "running",
  firstLogTs: "2026-06-01T09:40:00.000Z",
  lastLogMessage: "Downloading document…",
  runOrdinal: 1,
  data: {
    archetype: "single",
    queueRowKind: "file",
    pdfOriginalName: "I9_Form_Scan.pdf",
    __traceId: "cd-094000-d4c1",
  },
});

const singleCatalog = row({
  id: "s-catalog",
  status: "running",
  firstLogTs: "2026-06-01T09:41:00.000Z",
  lastLogMessage: "Fetching report…",
  runOrdinal: 1,
  data: {
    archetype: "single",
    queueRowKind: "catalog",
    __queueTitle: "UKG Roster — Q3 FY26",
    __traceId: "ur-094100-aa90",
  },
});

// --- SINGLE: status tags (person kind) ---
const statusDone = row({
  id: "s-done",
  status: "done",
  firstLogTs: "2026-06-01T08:10:00.000Z",
  lastLogTs: "2026-06-01T08:12:30.000Z",
  runOrdinal: 2,
  data: { archetype: "single", queueRowKind: "person", name: "Darnell Pierce", emplId: "10067890", __traceId: "ws-081000-1b4e" },
});

const statusFailed = row({
  id: "s-failed",
  status: "failed",
  firstLogTs: "2026-06-01T08:40:00.000Z",
  lastLogTs: "2026-06-01T08:41:10.000Z",
  error: "Selector timeout: award amount field never appeared",
  runOrdinal: 1,
  data: { archetype: "single", queueRowKind: "person", name: "Aisha Khan", emplId: "10055512", __traceId: "ws-084000-9d10" },
});

const statusQueued = row({
  id: "s-queued",
  status: "pending",
  runOrdinal: 1,
  data: { archetype: "single", queueRowKind: "person", name: "Tomás Rivera", emplId: "10043321", __traceId: "ws-095500-4f88" },
});

const statusCancelled = row({
  id: "s-cancelled",
  status: "failed",
  step: "cancelled",
  firstLogTs: "2026-06-01T09:00:00.000Z",
  lastLogTs: "2026-06-01T09:00:40.000Z",
  runOrdinal: 1,
  data: { archetype: "single", queueRowKind: "person", name: "Priya Nair", emplId: "10078900", __traceId: "ws-090000-2a55" },
});

// --- SINGLE: derived tags (resolved from data; workflow-keyed in current code) ---
const derivedNotFound = row({
  id: "s-notfound",
  workflow: "person-lookup",
  status: "done",
  firstLogTs: "2026-06-01T09:30:00.000Z",
  lastLogTs: "2026-06-01T09:30:20.000Z",
  runOrdinal: 1,
  data: { archetype: "single", queueRowKind: "person", searchName: "Jordan Vale", activeStatus: "not-found", __traceId: "pl-093000-aa01" },
});

const tagActive = row({
  id: "s-active",
  workflow: "person-lookup",
  status: "done",
  firstLogTs: "2026-06-01T09:31:00.000Z",
  lastLogTs: "2026-06-01T09:31:18.000Z",
  runOrdinal: 1,
  data: { archetype: "single", queueRowKind: "person", name: "Wei Chen", emplId: "10090011", activeStatus: "active", __traceId: "pl-093100-bb02" },
});

const tagInactive = row({
  id: "s-inactive",
  workflow: "person-lookup",
  status: "done",
  firstLogTs: "2026-06-01T09:32:00.000Z",
  lastLogTs: "2026-06-01T09:32:14.000Z",
  runOrdinal: 1,
  data: { archetype: "single", queueRowKind: "person", name: "Helen Park", emplId: "10090022", activeStatus: "inactive", __traceId: "pl-093200-cc03" },
});

// A "batch member" is just a single scoped under a batch (parentRunId set).
const memberAsSingle = row({
  id: "s-member",
  workflow: "oath-signature",
  status: "done",
  parentRunId: "batch-parent-2",
  firstLogTs: "2026-06-01T09:12:00.000Z",
  lastLogTs: "2026-06-01T09:13:40.000Z",
  runOrdinal: 1,
  data: { archetype: "batch-member", queueRowKind: "person", name: "Carlos Mendez", emplId: "10031200", __traceId: "os-091200-3c0f" },
});

// --- BATCH: neutral group cards, identical for every workflow. ---
function member(
  id: string,
  status: TrackerEntry["status"],
  name: string,
  emplId: string,
  parentRunId: string,
): TrackerEntry {
  return row({
    id,
    workflow: "oath-signature",
    status,
    parentRunId,
    firstLogTs: "2026-06-01T09:05:00.000Z",
    lastLogTs:
      status === "running" || status === "pending" ? undefined : "2026-06-01T09:07:00.000Z",
    data: {
      archetype: "batch-member",
      queueRowKind: "person",
      name,
      emplId,
      __traceId: `os-090500-${id}`,
    },
  });
}

const FILE_BATCH_RUN = "batch-file-1";
const fileBatchMembers = [
  member("fb-1", "done", "Lena Ortiz", "10010001", FILE_BATCH_RUN),
  member("fb-2", "running", "Marcus Bell", "10010002", FILE_BATCH_RUN),
  member("fb-3", "pending", "Sofia Ruiz", "10010003", FILE_BATCH_RUN),
  member("fb-4", "failed", "Dev Patel", "10010004", FILE_BATCH_RUN),
];

const PERSON_BATCH_RUN = "batch-person-1";
const personBatchMembers = [
  member("pb-1", "done", "Grace Liu", "10020001", PERSON_BATCH_RUN),
  member("pb-2", "done", "Ian Wong", "10020002", PERSON_BATCH_RUN),
  member("pb-3", "running", "Nadia Haddad", "10020003", PERSON_BATCH_RUN),
  member("pb-4", "pending", "Owen Fischer", "10020004", PERSON_BATCH_RUN),
  member("pb-5", "pending", "Rosa Delgado", "10020005", PERSON_BATCH_RUN),
  member("pb-6", "failed", "Dev Patel", "10020006", PERSON_BATCH_RUN),
];

// A real transient state: a `batch` anchor that has not fanned out yet, so it
// has ZERO members. The oath-signature PDF row sits here during the whole OCR
// approval window — it's stamped `archetype: batch` at pre-emit but its
// `batch-member` signer children don't exist until the `fan-out` step.
const EMPTY_BATCH_RUN = "batch-prefanout-1";
const emptyBatchMembers: TrackerEntry[] = [];
const emptyBatchAnchor = row({
  id: EMPTY_BATCH_RUN,
  runId: EMPTY_BATCH_RUN,
  workflow: "oath-signature",
  status: "running",
  step: "ocr",
  firstLogTs: "2026-06-01T09:50:00.000Z",
  lastLogMessage: "Awaiting OCR approval…",
  runOrdinal: 1,
  data: {
    archetype: "batch",
    queueRowKind: "file",
    pdfOriginalName: "Oath_Packet_Batch.pdf",
    sessionId: "sess-oath-prefanout",
    __traceId: "os-095000-7711",
  },
});

// --- APPROVAL / PREVIEW: OCR review surfaces (archetype: preview). ---
// Two named row types share the `preview` archetype. An APPROVAL ROW gates
// downstream fan-out on operator approval (oath / emergency-contact — the form
// declares approveTo / approveDocumentTo, so the review pane shows an Approve
// button). A PREVIEW ROW is read-only — no approval gate (verify: the form
// declares neither target, so there is no Approve button; the operator inspects
// the completeness report then discards). Same queue-row shape for both; the
// only difference is the Approve button in the review pane.
const approvalReady = row({
  id: "pv-ready",
  workflow: "ocr",
  status: "done",
  firstLogTs: "2026-06-01T09:56:00.000Z",
  lastLogTs: "2026-06-01T10:28:06.000Z",
  runOrdinal: 1,
  data: {
    archetype: "preview",
    queueRowKind: "file",
    mode: "prepare",
    pdfOriginalName: "Xerox Scan_04282026111307.pdf",
    __traceId: "oc-095600-5603",
  },
});

const approvalNeedsReview = row({
  id: "pv-needs-review",
  workflow: "ocr",
  status: "running",
  step: "awaiting-approval",
  parentRunId: "ou-parent-1",
  firstLogTs: "2026-06-01T09:50:00.000Z",
  lastLogTs: "2026-06-01T09:52:00.000Z",
  runOrdinal: 1,
  data: {
    archetype: "preview",
    queueRowKind: "file",
    pdfOriginalName: "Oath_Packet_Batch.pdf",
    __traceId: "oc-095000-7711",
  },
});

// Read-only review surface — no approval gate (verify completeness report).
const previewReadOnly = row({
  id: "pv-verify",
  workflow: "ocr",
  status: "running",
  step: "awaiting-approval",
  firstLogTs: "2026-06-01T09:50:00.000Z",
  lastLogTs: "2026-06-01T09:52:00.000Z",
  runOrdinal: 1,
  data: {
    archetype: "preview",
    queueRowKind: "file",
    formType: "verify",
    pdfOriginalName: "Mixed_Oath_EC_Packet.pdf",
    __traceId: "vf-095000-9a2c",
  },
});

// --- OPERATION: target-workflow coordinator rows for OCR-backed PDF runs. ---
const OPERATION_PRE_RUN = "op-oath-pre-1";
const operationPreApprovalParent = row({
  id: "ocr-prep-sess-op-pre",
  runId: OPERATION_PRE_RUN,
  workflow: "oath-signature",
  status: "running",
  step: "ocr-prep",
  firstLogTs: "2026-06-01T09:58:00.000Z",
  lastLogMessage: "OCR prep running in the OCR panel…",
  runOrdinal: 1,
  data: {
    archetype: "operation",
    mode: "prepare",
    formType: "oath",
    queueRowKind: "file",
    pdfOriginalName: "Oath_Packet_Batch.pdf",
    ocrRunId: "ocr-run-op-pre",
    ocrSessionId: "sess-op-pre",
    ocrStatus: "awaiting-review",
    ocrStep: "awaiting-approval",
    operationWorkflow: "oath-signature",
    operationKind: "oath",
    operationRunId: OPERATION_PRE_RUN,
    __traceId: "os-095800-opre",
  },
});

const OPERATION_POST_RUN = "op-oath-post-1";
const operationPostApprovalParent = row({
  id: "ocr-prep-sess-op-post",
  runId: OPERATION_POST_RUN,
  workflow: "oath-signature",
  status: "running",
  step: "approved",
  firstLogTs: "2026-06-01T10:02:00.000Z",
  lastLogMessage: "Waiting on signer rows…",
  runOrdinal: 1,
  data: {
    archetype: "operation",
    mode: "prepare",
    formType: "oath",
    queueRowKind: "file",
    pdfOriginalName: "Oath_Packet_Approved.pdf",
    ocrRunId: "ocr-run-op-post",
    ocrSessionId: "sess-op-post",
    ocrStatus: "approved",
    ocrStep: "approved",
    operationWorkflow: "oath-signature",
    operationKind: "oath",
    operationRunId: OPERATION_POST_RUN,
    __traceId: "os-100200-opst",
  },
});

const operationMembers = [
  member("opm-1", "done", "Amara Brooks", "10041001", OPERATION_POST_RUN),
  member("opm-2", "running", "Noah Kim", "10041002", OPERATION_POST_RUN),
  member("opm-3", "pending", "Elena Vega", "10041003", OPERATION_POST_RUN),
];

const operationPreApproval = buildOperationGalleryRow(
  operationPreApprovalParent,
  [],
  "Oath Signature",
);
const operationPostApproval = buildOperationGalleryRow(
  operationPostApprovalParent,
  operationMembers,
  "Oath Signature",
);

function QueueRowsTab() {
  return (
    <div className="grid grid-cols-1 min-[820px]:grid-cols-2 gap-4 items-start">
      {/* ---- SINGLE ---- */}
      <Section
        title="single"
        sub="One flat EntryItem. Kind sets title/subtitle; tags set the status badge / chip. A batch member is just a single with a parentRunId — not a separate type."
      />
      <Variant label="kind = person" axes="single · kind=person · running" note="title = name, subtitle = EID">
        <Flat entry={singlePerson} />
      </Variant>
      <Variant label="kind = file" axes="single · kind=file · running" note="title = PDF filename, subtitle = trace id">
        <Flat entry={singleFile} />
      </Variant>
      <Variant label="kind = catalog" axes="single · kind=catalog · running" note="title = spec label, subtitle = trace id">
        <Flat entry={singleCatalog} />
      </Variant>
      <Variant label="tag = done" axes="single · tag=done">
        <Flat entry={statusDone} selected />
      </Variant>
      <Variant label="tag = failed" axes="single · tag=failed" note="error surfaced inline">
        <Flat entry={statusFailed} />
      </Variant>
      <Variant label="tag = queued" axes="single · tag=pending">
        <Flat entry={statusQueued} />
      </Variant>
      <Variant label="tag = cancelled" axes="single · tag=failed+step=cancelled" note="operator-stopped (amber, not red)">
        <Flat entry={statusCancelled} />
      </Variant>
      <Variant label="tag = not found" axes="single · derived=notFound" note="from data.activeStatus=not-found (status still done)">
        <Flat entry={derivedNotFound} />
      </Variant>
      <Variant label="tag = active (A)" axes="single · secondaryTag=A" note="from data.activeStatus=active">
        <Flat entry={tagActive} />
      </Variant>
      <Variant label="tag = inactive (IA)" axes="single · secondaryTag=IA" note="from data.activeStatus=inactive">
        <Flat entry={tagInactive} />
      </Variant>
      <Variant label="member = single (scoped)" axes="single · parentRunId set · done" note="a 'batch member' is just a single under a batch">
        <Flat entry={memberAsSingle} />
      </Variant>

      {/* ---- BATCH ---- */}
      <Section
        title="batch"
        sub="Neutral DaemonBatchRow group card (count badge + member preview). Identical for every workflow. Title optional; subtitle = trace id. An anchor can sit at 0 members before it fans out (real transient state — see below)."
      />
      <Variant label="with title (file)" axes="batch · 4 members · titled" note="title from the batch's file/spec">
        <Batch
          parentRunId={FILE_BATCH_RUN}
          members={fileBatchMembers}
          workflowLabel="Oath Signature"
          title="Approved_Oath_Batch.pdf"
          subtitle="oc-090500-aprv"
        />
      </Variant>
      <Variant label="no title (person anchor)" axes="batch · 6 members · no title · incl. failed" note="4-count status line + badge — checking overflow">
        <Batch
          parentRunId={PERSON_BATCH_RUN}
          members={personBatchMembers}
          workflowLabel="Onboarding"
          title=""
          subtitle="ob-090500-7f31"
        />
      </Variant>
      <Variant label="0 members (pre-fan-out)" axes="batch · 0 members · file · running" note="oath-signature PDF anchor during OCR approval — 0/0, but footer falls back to the anchor so time/elapsed/retry+delete stay">
        <Batch
          parentRunId={EMPTY_BATCH_RUN}
          members={emptyBatchMembers}
          workflowLabel="Oath Signature"
          title="Oath_Packet_Batch.pdf"
          subtitle="os-095000-7711"
          anchorEntry={emptyBatchAnchor}
        />
      </Variant>

      {/* ---- APPROVAL / PREVIEW ---- */}
      <Section
        title="approval / preview"
        sub="OCR review surfaces (archetype: preview). An approval row gates downstream fan-out on operator approval (oath / emergency-contact — Approve button in the review pane). A preview row is read-only — no approval gate (verify completeness report); operator inspects then discards. Same queue-row shape; the Approve button is the only difference. 'Needs review' is a derived tag, not a separate row."
      />
      <Variant label="approval row · ready / done" axes="preview · kind=file · done" note="approval already resolved (done)">
        <Flat entry={approvalReady} />
      </Variant>
      <Variant label="approval row · needs review" axes="preview · derived=needsReview" note="delegated awaiting-approval (parentRunId set); review pane shows Approve">
        <Flat entry={approvalNeedsReview} />
      </Variant>
      <Variant label="preview row · read-only (verify)" axes="preview · kind=file · awaiting-approval" note="no approveTo → no Approve button; operator inspects then discards">
        <Flat entry={previewReadOnly} />
      </Variant>

      {/* ---- OPERATION ---- */}
      <Section
        title="operation"
        sub="Target-workflow coordinator for OCR-backed Oath Signature / Emergency Contact PDF runs. The OCR review row stays in the OCR panel; this row tracks the target workflow and expands inline after approval."
      />
      <Variant label="operation · before approval" axes="operation · 0 members · OCR status" note="selectable coordinator row + lightweight OCR status/link">
        <OperationFixture fixture={operationPreApproval} />
      </Variant>
      <Variant label="operation · expanded after approval" axes="operation · inline member rows · mixed status" note="signer/contact rows stay under the coordinator instead of opening a batch page">
        <OperationFixture fixture={operationPostApproval} defaultExpanded />
      </Variant>
    </div>
  );
}

// ===========================================================================
// SESSION CARDS — the terminal-drawer WorkflowBox across lifecycle states.
// Real workflow names so icon + step pipeline resolve from the live registry.
// ===========================================================================

function browser(system: string, authState: AuthState): { browserId: string; system: string; authState: AuthState } {
  return { browserId: `${system}-1`, system, authState };
}

function session(
  partial: Partial<WorkflowInstanceState> & { instance: string; workflow: string },
): WorkflowInstanceState {
  return {
    active: true,
    pidAlive: true,
    currentItemId: null,
    currentTraceId: null,
    itemInFlight: false,
    currentStep: null,
    finalStatus: null,
    sessions: [],
    ...partial,
  } as WorkflowInstanceState;
}

const sessInFlight = session({
  instance: "Onboarding 1",
  workflow: "onboarding",
  startedAt: agoIso(95),
  currentItemId: "Maria Gonzalez",
  currentTraceId: "on-022400-9f1a",
  itemInFlight: true,
  currentStep: "fill-award",
  sessions: [{ sessionId: "s1", browsers: [browser("ucpath", "authed"), browser("crm", "authed")] }],
  recentDaemonLogs: [
    { ts: agoIso(90), level: "info", message: "Daemon ready — watching queue" },
    { ts: agoIso(70), level: "info", message: "Picked up item 10012345 (Maria Gonzalez)" },
    { ts: agoIso(12), level: "info", message: "Step: fill-award" },
  ],
});

const sessAuthing = session({
  instance: "Separation 1",
  workflow: "separations",
  startedAt: agoIso(18),
  currentStep: "auth",
  sessions: [{ sessionId: "s2", browsers: [browser("ucpath", "authenticating"), browser("kuali", "idle")] }],
  recentDaemonLogs: [
    { ts: agoIso(18), level: "info", message: "Daemon started" },
    { ts: agoIso(15), level: "info", message: "Launching browsers: ucpath, kuali" },
    { ts: agoIso(4), level: "info", message: "Authenticating UCPath…" },
  ],
});

const sessDuo = session({
  instance: "Oath Upload 1",
  workflow: "oath-upload",
  startedAt: agoIso(135),
  currentStep: "auth",
  sessions: [{ sessionId: "s3", browsers: [browser("ucpath", "duo_waiting"), browser("crm", "authed")] }],
  recentDaemonLogs: [
    { ts: agoIso(40), level: "info", message: "Authenticating UCPath…" },
    { ts: agoIso(20), level: "warn", message: "Duo push sent — awaiting approval on phone" },
  ],
});

const sessIdleUcpath = session({
  instance: "Work Study 1",
  workflow: "work-study",
  startedAt: agoIso(240),
  daemonPhase: "idle",
  sessions: [{ sessionId: "s4", browsers: [browser("ucpath", "authed")] }],
  ucpathIdle: { lastTouchAt: agoIso(120), refreshing: false },
  recentDaemonLogs: [
    { ts: agoIso(200), level: "info", message: "Daemon ready — watching queue" },
    { ts: agoIso(120), level: "info", message: "Idle — UCPath kept warm (reload in 5m)" },
  ],
});

const sessIdleLogs = session({
  instance: "Person Lookup 1",
  workflow: "person-lookup",
  startedAt: agoIso(300),
  // Idle daemon that already processed an item — keeps the last run's trace id
  // in the subtitle (mirrors the kept-after-complete backend behavior).
  currentTraceId: "pl-093100-bb02",
  daemonPhase: "idle",
  sessions: [{ sessionId: "s5", browsers: [browser("crm", "authed")] }],
  recentDaemonLogs: [
    { ts: agoIso(60), level: "info", message: "Daemon ready — watching queue" },
    { ts: agoIso(40), level: "info", message: "Processed item 10090011 in 18s" },
    { ts: agoIso(25), level: "warn", message: "CRM search returned 0 rows for 'Jordan Vale'" },
    { ts: agoIso(8), level: "error", message: "Retry 1/3: navigation timeout, re-authing" },
  ],
});

const sessKeepalive = session({
  instance: "Onboarding 2",
  workflow: "onboarding",
  startedAt: agoIso(420),
  daemonPhase: "keepalive",
  sessions: [{ sessionId: "s6", browsers: [browser("ucpath", "authed"), browser("crm", "authed")] }],
  recentDaemonLogs: [
    { ts: agoIso(400), level: "info", message: "Daemon ready — watching queue" },
    { ts: agoIso(30), level: "info", message: "Keepalive — verifying browser health" },
  ],
});

const sessComplete = session({
  instance: "Work Study 2",
  workflow: "work-study",
  startedAt: agoIso(180),
  currentTraceId: "ws-090000-2a55",
  active: false,
  pidAlive: false,
  finalStatus: "done",
  sessions: [{ sessionId: "s7", browsers: [browser("ucpath", "authed")] }],
  recentDaemonLogs: [
    { ts: agoIso(60), level: "info", message: "Processed item 10090022 in 22s" },
    { ts: agoIso(20), level: "info", message: "Run complete — daemon exiting" },
  ],
});

const sessFailed = session({
  instance: "Separation 2",
  workflow: "separations",
  startedAt: agoIso(90),
  currentTraceId: "se-014000-9d10",
  active: false,
  pidAlive: false,
  finalStatus: "failed",
  sessions: [{ sessionId: "s8", browsers: [browser("ucpath", "failed")] }],
  recentDaemonLogs: [
    { ts: agoIso(80), level: "info", message: "Picked up item 10055512 (Aisha Khan)" },
    { ts: agoIso(30), level: "error", message: "Selector timeout: award amount field never appeared" },
    { ts: agoIso(10), level: "error", message: "Run failed after 3 retries" },
  ],
});

// A daemon that just spawned: browsers authing, but no daemon-log line has
// streamed in yet. The "Daemon log (0)" section must still render (empty
// state when expanded) rather than vanishing — guards the always-present
// contract in WorkflowBox.
const sessNoLogs = session({
  instance: "Emergency Contact 1",
  workflow: "emergency-contact",
  startedAt: agoIso(6),
  currentStep: "auth",
  sessions: [{ sessionId: "s9", browsers: [browser("ucpath", "authenticating")] }],
  recentDaemonLogs: [],
});

const sessCrashed = session({
  instance: "Kronos Reports 1",
  workflow: "kronos-reports",
  startedAt: agoIso(12),
  active: false,
  pidAlive: false,
  crashedOnLaunch: true,
  sessions: [],
});

function SessionCardsTab() {
  return (
    <WorkflowsProvider>
      <TerminalDrawerProvider>
        <p className="mb-4 text-[12px] text-muted-foreground">
          The real <span className="font-mono">WorkflowBox</span> card from the terminal drawer.
          The collapsible <span className="font-mono">Daemon log</span> is a standard element on every
          session card (only the crashed-on-launch card omits it — it renders a compact early-return
          shell). Icon + step pipeline resolve from the live registry; the{" "}
          <span className="font-mono">queued</span> chip and idle-refresh ring are driven by{" "}
          <span className="font-mono">/api/queue-depth</span> + <span className="font-mono">/api/daemons</span>{" "}
          polling, so they reflect whatever the backend reports (typically 0 here). Clicking a card sets
          its focus ring; the <span className="font-mono">× stop</span> pill fires a real{" "}
          <span className="font-mono">/api/daemon/stop</span> — don&apos;t click it against a live daemon.
        </p>
        <div className="grid grid-cols-1 min-[680px]:grid-cols-2 min-[1040px]:grid-cols-3 gap-4 items-start">
          <Variant width={290} label="in-flight" axes="active · itemInFlight · 2 browsers authed" note="cyan border tint; subline = current item">
            <div className="px-2"><WorkflowBox workflow={sessInFlight} /></div>
          </Variant>
          <Variant width={290} label="authenticating" axes="active · auth · 1/2 authed" note="blue step; one tile still spinning">
            <div className="px-2"><WorkflowBox workflow={sessAuthing} /></div>
          </Variant>
          <Variant width={290} label="duo waiting" axes="active · auth · duo_waiting tile" note="amber pulse tile + amber elapsed pill (≥1m)">
            <div className="px-2"><WorkflowBox workflow={sessDuo} /></div>
          </Variant>
          <Variant width={290} label="idle + UCPath ring" axes="active · daemonPhase=idle · ucpathIdle set" note="idle-refresh countdown ring on the UCPath tile">
            <div className="px-2"><WorkflowBox workflow={sessIdleUcpath} /></div>
          </Variant>
          <Variant width={290} label="idle · warn/error log" axes="active · daemonPhase=idle" note="daemon log with info/warn/error tints">
            <div className="px-2"><WorkflowBox workflow={sessIdleLogs} /></div>
          </Variant>
          <Variant width={290} label="keepalive" axes="active · daemonPhase=keepalive" note="'keepalive — checking browsers'">
            <div className="px-2"><WorkflowBox workflow={sessKeepalive} /></div>
          </Variant>
          <Variant width={290} label="complete" axes="!active · finalStatus=done" note="dimmed (opacity 55); no stop pill">
            <div className="px-2"><WorkflowBox workflow={sessComplete} /></div>
          </Variant>
          <Variant width={290} label="failed" axes="!active · finalStatus=failed" note="dimmed; failed auth tile">
            <div className="px-2"><WorkflowBox workflow={sessFailed} /></div>
          </Variant>
          <Variant width={290} label="no logs yet" axes="active · recentDaemonLogs=[]" note="fresh daemon — 'Daemon log (0)' still renders (empty state when expanded)">
            <div className="px-2"><WorkflowBox workflow={sessNoLogs} /></div>
          </Variant>
          <Variant width={290} label="crashed on launch" axes="crashedOnLaunch" note="compact destructive card; points to the queue row">
            <div className="px-2"><WorkflowBox workflow={sessCrashed} /></div>
          </Variant>
        </div>
      </TerminalDrawerProvider>
    </WorkflowsProvider>
  );
}

// ===========================================================================
// CONTROLS — toolbar buttons, filter/sort, and the small indicators.
// ===========================================================================

const AUTH_STATES: AuthState[] = ["idle", "authenticating", "authed", "duo_waiting", "failed"];

const controlEntries: TrackerEntry[] = [
  statusDone,
  statusDone,
  singlePerson,
  statusFailed,
  statusQueued,
];

function ControlsTab() {
  const [filter, setFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<QueueSortMode>(DEFAULT_QUEUE_SORT_MODE);
  return (
    <div className="grid grid-cols-1 min-[820px]:grid-cols-2 gap-4 items-start">
      <Section title="filter + sort" sub="The queue header's stat/filter pills and the sort dropdown. Stateful here." />
      <Variant label="StatPills" axes="status filter strip" note="click a pill to filter; click active to clear">
        <div className="px-3 py-2">
          <StatPills entries={controlEntries} activeFilter={filter} onFilter={setFilter} />
        </div>
      </Variant>
      <Variant label="QueueSortDropdown" axes="sort mode menu">
        <div className="px-3 py-2">
          <QueueSortDropdown value={sort} onChange={setSort} />
        </div>
      </Variant>

      <Section title="bulk actions" sub="Toolbar icon buttons. These POST to the real API on click — present for layout only." />
      <Variant label="RetryAllButton" axes="bulk retry" note="POSTs /api/.../retry-all">
        <div className="px-3 py-2 flex">
          <RetryAllButton workflow="onboarding" ids={["s-failed"]} items={[{ id: "s-failed" }]} date={DATE} />
        </div>
      </Variant>
      <Variant label="StopAllButton" axes="bulk stop" note="POSTs /api/.../stop-all">
        <div className="px-3 py-2 flex">
          <StopAllButton workflow="onboarding" items={[{ id: "s-person", status: "running" }]} />
        </div>
      </Variant>
      <Variant label="DeleteAllButton" axes="bulk delete" note="POSTs /api/.../delete-all">
        <div className="px-3 py-2 flex">
          <DeleteAllButton workflow="onboarding" date={DATE} entries={[{ id: "s-done" }]} onDeleted={NOOP} />
        </div>
      </Variant>

      <Section title="indicators" sub="Small status atoms used across the drawer and panels." />
      <Variant label="LiveIndicator" axes="connected: true / false">
        <div className="px-3 py-2 flex items-center gap-4">
          <LiveIndicator connected={true} />
          <LiveIndicator connected={false} />
        </div>
      </Variant>
      <Variant label="BrowserChip" axes="every AuthState">
        <div className="px-3 py-2 flex flex-wrap gap-2">
          {AUTH_STATES.map((s) => (
            <BrowserChip key={s} system="ucpath" authState={s} />
          ))}
        </div>
      </Variant>
      <Variant label="EmptyState" axes="icon + title + description">
        <div className="px-3 py-2">
          <EmptyState icon={Inbox} title="No runs yet" description="Start a workflow to see it here." />
        </div>
      </Variant>
    </div>
  );
}

// ===========================================================================
// Gallery shell — tabbed.
// ===========================================================================

type TabKey = "rows" | "sessions" | "controls";
const TABS: { key: TabKey; label: string }[] = [
  { key: "rows", label: "Queue Rows" },
  { key: "sessions", label: "Session Cards" },
  { key: "controls", label: "Controls" },
];

export function UiGallery() {
  const [tab, setTab] = useState<TabKey>("rows");
  return (
    <BatchQueueParentRunIdProvider parentRunId={null}>
      <TooltipProvider delayDuration={150}>
        <div className="h-screen overflow-y-auto bg-background text-foreground">
          <div className="mx-auto max-w-[1200px] px-6 py-8">
            <header className="mb-5">
              <h1 className="text-[20px] font-bold">UI Gallery</h1>
              <p className="text-[13px] text-muted-foreground mt-1">
                Temporary dev route (<code className="font-mono">?view=ui-gallery</code>). Catalogs the
                dashboard&apos;s reusable surfaces rendered with the <span className="font-mono">real</span>{" "}
                components fed synthetic data, so design regressions surface here.
              </p>
            </header>

            <div role="tablist" className="mb-6 flex items-center gap-1 border-b border-border/60">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                  className={cn(
                    "relative px-3.5 py-2 text-[13px] font-medium transition-colors -mb-px border-b-2",
                    tab === t.key
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {tab === "rows" && <QueueRowsTab />}
            {tab === "sessions" && <SessionCardsTab />}
            {tab === "controls" && <ControlsTab />}
          </div>
        </div>
      </TooltipProvider>
    </BatchQueueParentRunIdProvider>
  );
}
