import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { resolveRowArchetype } from "../domain/row-archetype.js";
import { log } from "../utils/log.js";
import { buildTrackerQueueSurfaces } from "./queue-surfaces.js";
import { DEFAULT_DIR, dateLocal, listWorkflows, readEntries } from "./jsonl-io.js";
import type { TrackerEntry } from "./jsonl.js";

/**
 * Queue-surface debug trail.
 *
 * The dashboard queue panel classifies every batch-parent / delegation
 * anchor into a *surface* — an approval-delegation card, a batch card, a
 * passive-delegation card, or a flat row — via `buildTrackerQueueSurfaces`.
 * That decision is derived at render time and never persisted, so when a
 * row renders with the wrong type (e.g. a single-signer prep PDF collapsing
 * from a card into a flat row after OCR approval) there is no trail showing
 * when the surface changed or what the inputs were.
 *
 * This module samples the classifier on the dashboard's sweep interval and
 * appends one line to `.tracker/debug/queue-surfaces-<date>.jsonl` whenever
 * an anchor's surface changes — or is seen for the first time, which records
 * "what the row started as". The file is debug-only: nothing reads it
 * programmatically, it is never streamed to the dashboard, it does not show
 * up as a workflow (it lives in the `debug/` subdirectory, not as a
 * top-level `<workflow>-<date>.jsonl`), and it is safe to delete any time.
 */

export interface QueueSurfaceSnapshot {
  workflow: string;
  /** runId the surface is keyed on (batch-parent anchor or delegation parent). */
  anchorRunId: string;
  /** tracker id of the anchor row. */
  anchorId: string;
  /** `resolveRowArchetype` of the anchor row, or `delegation-group` for member-keyed groups. */
  archetype: string;
  /** true when the anchor is an approved prep row (status `done` / step `approved`). */
  approved: boolean;
  step?: string;
  status?: string;
  /**
   * Resolved surface:
   *  - `card:approval-delegation:awaiting-approval` / `:approved`
   *  - `card:batch` / `card:passive-delegation`
   *  - `flat:self`      — the anchor row itself renders as a flat row
   *  - `flat:collapsed` — the anchor was dropped and its member(s) flattened
   *  - `discarded`      — discarded prep row, excluded from the queue
   */
  surface: string;
  memberCount: number;
  memberIds: string[];
}

function isApprovedPrep(entry: TrackerEntry): boolean {
  return entry.status === "done" && entry.step === "approved";
}

function isDiscardedPrep(entry: TrackerEntry): boolean {
  return entry.status === "failed" && entry.step === "discarded";
}

/** Keep the newest tracker line per item id — the queue dedupes the same way. */
function dedupeLatestById(entries: TrackerEntry[]): TrackerEntry[] {
  const byId = new Map<string, TrackerEntry>();
  for (const entry of entries) {
    const prev = byId.get(entry.id);
    if (!prev || entry.timestamp >= prev.timestamp) byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

/**
 * Classify every batch-parent / delegation anchor in a workflow's tracker
 * rows into its queue surface. Pure — feeds `buildTrackerQueueSurfaces` the
 * same shape the dashboard's server-side `wfCounts` pass already uses.
 */
export function summarizeQueueSurfaces(
  workflow: string,
  rawEntries: TrackerEntry[],
): QueueSurfaceSnapshot[] {
  const entries = dedupeLatestById(rawEntries);
  const surfaces = buildTrackerQueueSurfaces({
    entries,
    delegationSourceEntries: entries,
  });
  const snapshots: QueueSurfaceSnapshot[] = [];
  const accountedAnchorRunIds = new Set<string>();
  const groupedMemberRunIds = new Set<string>();

  for (const group of surfaces.groupRows) {
    const anchor = group.kind === "approval-delegation" ? group.parent : undefined;
    accountedAnchorRunIds.add(group.parentRunId);
    for (const member of group.members) {
      groupedMemberRunIds.add(member.runId ?? member.id);
    }
    snapshots.push({
      workflow,
      anchorRunId: group.parentRunId,
      anchorId: anchor?.id ?? group.parentRunId,
      archetype: anchor ? resolveRowArchetype(anchor) : "delegation-group",
      approved: anchor ? isApprovedPrep(anchor) : false,
      ...(anchor?.step ? { step: anchor.step } : {}),
      ...(anchor?.status ? { status: anchor.status } : {}),
      surface:
        group.kind === "approval-delegation"
          ? `card:approval-delegation:${group.approvalState}`
          : `card:${group.kind}`,
      memberCount: group.members.length,
      memberIds: group.members.map((member) => member.id),
    });
  }

  // Batch-parent anchors that never became a group card — they stayed flat
  // (approved with no visible members), collapsed (their member(s) were
  // flattened into single rows), or were discarded. These are the
  // bug-prone outcomes worth a transition line.
  for (const entry of entries) {
    if (resolveRowArchetype(entry) !== "batch-parent") continue;
    const anchorRunId = entry.runId ?? entry.id;
    if (accountedAnchorRunIds.has(anchorRunId)) continue;
    if (groupedMemberRunIds.has(anchorRunId)) continue;
    accountedAnchorRunIds.add(anchorRunId);
    const members = entries.filter((other) => other.parentRunId === anchorRunId);
    const selfFlat = surfaces.flatEntries.some(
      (flat) => (flat.runId ?? flat.id) === anchorRunId,
    );
    snapshots.push({
      workflow,
      anchorRunId,
      anchorId: entry.id,
      archetype: "batch-parent",
      approved: isApprovedPrep(entry),
      ...(entry.step ? { step: entry.step } : {}),
      status: entry.status,
      surface: isDiscardedPrep(entry)
        ? "discarded"
        : selfFlat
          ? "flat:self"
          : "flat:collapsed",
      memberCount: members.length,
      memberIds: members.map((member) => member.id),
    });
  }

  return snapshots;
}

/** Last surface seen per `${workflow}\0${anchorRunId}` — drives transition detection. */
const lastSurfaceByAnchor = new Map<string, string>();

/**
 * Append a line for every anchor whose surface changed since the last
 * sweep — or is seen for the first time (`from: null`). Steady-state
 * anchors write nothing, so the file stays small: one line per real
 * surface transition.
 */
export function recordQueueSurfaceTransitions(
  snapshots: QueueSurfaceSnapshot[],
  dir: string = DEFAULT_DIR,
): void {
  const ts = new Date().toISOString();
  const lines: string[] = [];
  for (const snap of snapshots) {
    const key = `${snap.workflow}\0${snap.anchorRunId}`;
    const prev = lastSurfaceByAnchor.get(key);
    if (prev === snap.surface) continue;
    lastSurfaceByAnchor.set(key, snap.surface);
    lines.push(
      JSON.stringify({
        ts,
        workflow: snap.workflow,
        anchorId: snap.anchorId,
        anchorRunId: snap.anchorRunId,
        from: prev ?? null,
        to: snap.surface,
        archetype: snap.archetype,
        approved: snap.approved,
        step: snap.step ?? null,
        status: snap.status ?? null,
        memberCount: snap.memberCount,
        memberIds: snap.memberIds,
      }),
    );
  }
  if (lines.length === 0) return;
  try {
    const debugDir = join(dir, "debug");
    mkdirSync(debugDir, { recursive: true });
    appendFileSync(
      join(debugDir, `queue-surfaces-${dateLocal()}.jsonl`),
      `${lines.join("\n")}\n`,
    );
  } catch (err) {
    log.warn(
      `queue-surface debug log write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Classify + record one debug sweep across every workflow with tracker
 * data for the current day. Wired into the dashboard sweep interval;
 * failures are swallowed so a debug-log glitch never stalls the dashboard.
 */
export function runQueueSurfaceDebugSweep(dir: string = DEFAULT_DIR): void {
  try {
    for (const workflow of listWorkflows(dir)) {
      const snapshots = summarizeQueueSurfaces(workflow, readEntries(workflow, dir));
      recordQueueSurfaceTransitions(snapshots, dir);
    }
  } catch (err) {
    log.warn(
      `queue-surface debug sweep failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Test hook — clears the in-memory last-surface map. */
export function __resetQueueSurfaceDebugForTests(): void {
  lastSurfaceByAnchor.clear();
}
