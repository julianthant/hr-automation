import { useState, useEffect, useRef } from "react";
import { toast } from "@/lib/notify";
import type { TrackerEntry } from "@/components/shared/types";
import { dateLocal, stableKey } from "../../lib/utils";
import { sseHub } from "@/lib/sse-hub";
import { dedupeLatestByIdWithCarriedEmplId } from "../../../tracker/queue-row-count.js";

interface UseEntriesResult {
  entries: TrackerEntry[];
  /**
   * `${workflow}|${date}` of the data currently in `entries`. Empty string
   * means a new subscription is in flight and `entries` is stale from the
   * previous (workflow, date). Consumers (e.g. App's toast effect) should
   * skip processing until this matches the target key — otherwise stale
   * entries from the previous date pollute per-key status maps and produce
   * spurious "transition" toasts when fresh data arrives with id collisions.
   */
  entriesKey: string;
  workflows: string[];
  wfCounts: Record<string, number>;
  /** Collapsed top-level QUEUED surface count per workflow — rail "queued" sub-badge (always <= wfCounts). */
  wfQueuedCounts: Record<string, number>;
  failureCounts: Record<string, number>;
  connected: boolean;
  loading: boolean;
}

type WithFirstLog = TrackerEntry & { firstLogTs?: string; lastLogTs?: string };
type EntriesEnvelope = {
  entries: TrackerEntry[];
  workflows: string[];
  wfCounts?: Record<string, number>;
  wfQueuedCounts?: Record<string, number>;
  failureCounts?: Record<string, number>;
};

export function isEntriesEnvelope(value: unknown): value is EntriesEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  return Array.isArray(envelope.entries) && Array.isArray(envelope.workflows);
}

export function shouldApplyEntriesUpdate(args: {
  previousHash: string;
  nextHash: string;
  activeKey: string;
  targetKey: string;
}): boolean {
  return args.previousHash !== args.nextHash || args.activeKey !== args.targetKey;
}

export function buildEntriesHash(raw: TrackerEntry[]): string {
  let hash = "";
  for (const r of raw as WithFirstLog[]) {
    hash += stableKey([
      r.id,
      r.status,
      r.step,
      r.timestamp,
      r.firstLogTs,
      r.lastLogTs,
      r.runId,
      r.error,
    ]);
    hash += ";";
  }
  return hash;
}

export function resetEntriesMemoRefs(
  prevHashRef: { current: string },
  activeKeyRef: { current: string },
): void {
  prevHashRef.current = "";
  activeKeyRef.current = "";
}

export function entryRenderHash(entry: WithFirstLog): string {
  const d = entry.data ?? {};
  return stableKey([
    entry.id,
    entry.workflow,
    entry.status,
    entry.step,
    entry.timestamp,
    entry.startTimestamp,
    entry.runId,
    entry.runOrdinal,
    entry.parentRunId,
    entry.error,
    entry.lastLogMessage,
    entry.firstLogTs,
    entry.lastLogTs,
    d.__queueRootTitle,
    d.__queueTitle,
    d.__queueTitleKind,
    d.__subject,
    d.__subjectKind,
    d.__name,
    d.__id,
    d.name,
    d.employeeName,
    d.searchName,
    d.emplId,
    d.parentSubject,
    d.formType,
    d.activeStatus,
    d.isActive,
    d.mode,
  ]);
}

function entrySortKey(entry: WithFirstLog): number {
  const start = entry.firstLogTs ? Date.parse(entry.firstLogTs) : Number.NaN;
  if (Number.isFinite(start)) return -start;
  const fallback = Date.parse(entry.timestamp);
  return Number.isFinite(fallback) ? -fallback : 0;
}

/**
 * SSE hook for workflow entries.
 * Dedupes by ID (keeps latest), sorts newest-first by first-seen timestamp.
 */
export function useEntries(workflow: string, date: string): UseEntriesResult {
  const [entries, setEntries] = useState<TrackerEntry[]>([]);
  const [entriesKey, setEntriesKey] = useState("");
  const [workflows, setWorkflows] = useState<string[]>([]);
  const [wfCounts, setWfCounts] = useState<Record<string, number>>({});
  const [wfQueuedCounts, setWfQueuedCounts] = useState<Record<string, number>>({});
  const [failureCounts, setFailureCounts] = useState<Record<string, number>>({});
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const prevHashRef = useRef("");
  const activeKeyRef = useRef("");
  const prevWorkflowsRef = useRef<string>("");
  const prevWfCountsRef = useRef<string>("");
  const prevWfQueuedCountsRef = useRef<string>("");
  const prevFailureCountsRef = useRef<string>("");
  // Cache: maps entry id → the last-emitted { entry, _hash } object.
  // Reusing the same object reference for unchanged rows lets EntryItem's
  // memo bailout on referential equality before the comparator body runs.
  const entryRefCacheRef = useRef<Map<string, TrackerEntry & { _hash: string }>>(new Map());

  useEffect(() => {
    setLoading(true);
    setEntriesKey("");
    activeKeyRef.current = "";
    // Reset the entry-hash/key memos on every (workflow, date) change so a
    // new subscription applies its first payload even when the payload is
    // empty. Without the key guard, switching to an empty date leaves the
    // previous date's rows on screen because both hashes are "".
    prevHashRef.current = "";
    prevWorkflowsRef.current = "";
    prevWfCountsRef.current = "";
    prevWfQueuedCountsRef.current = "";
    prevFailureCountsRef.current = "";
    // Clear ref cache on workflow/date switch so stale objects from the
    // previous subscription don't contaminate the next one.
    entryRefCacheRef.current = new Map();

    const today = dateLocal();
    const params: { workflow: string; date?: string } = { workflow };
    if (date && date !== today) {
      params.date = date;
    }

    const unsubscribe = sseHub.subscribe(
      "entries",
      params,
      (data) => {
        if (!isEntriesEnvelope(data)) {
          console.error("[useEntries] malformed SSE envelope; ignoring", data);
          toast.error("Dashboard received a malformed update", {
            id: "entries-malformed-sse-envelope",
            description: "Refresh to recover if the queue stops updating.",
          });
          return;
        }
        const { entries: raw, workflows: wfs, wfCounts: counts, wfQueuedCounts: queuedCounts, failureCounts: fcounts } = data;

        setConnected(true);
        setLoading(false);

        // Workflows + per-workflow counts update EVERY tick regardless of
        // whether this workflow's entry list changed. They reflect a
        // date-wide aggregate that can shift while the selected workflow's
        // entries stay identical (e.g., other workflows running on the same
        // day, or switching to a date where the current workflow has 0
        // entries but others have activity). Gating them behind the entry
        // hash was the bug that made date switches show "0 / 0 / 0".
        const wfsKey = JSON.stringify(wfs || []);
        if (wfsKey !== prevWorkflowsRef.current) {
          prevWorkflowsRef.current = wfsKey;
          setWorkflows(wfs || []);
        }
        if (counts) {
          const countsKey = JSON.stringify(counts);
          if (countsKey !== prevWfCountsRef.current) {
            prevWfCountsRef.current = countsKey;
            setWfCounts(counts);
          }
        }
        // Collapsed-queued sub-badge counts ride the same date-wide aggregate as
        // wfCounts; update them unconditionally per tick (an older backend that
        // omits the field clears to {} so the rail falls back to no sub-badge).
        const queuedCountsKey = JSON.stringify(queuedCounts ?? {});
        if (queuedCountsKey !== prevWfQueuedCountsRef.current) {
          prevWfQueuedCountsRef.current = queuedCountsKey;
          setWfQueuedCounts(queuedCounts ?? {});
        }
        const fcountsKey = JSON.stringify(fcounts ?? {});
        if (fcountsKey !== prevFailureCountsRef.current) {
          prevFailureCountsRef.current = fcountsKey;
          setFailureCounts(fcounts ?? {});
        }

        // Skip if data hasn't changed (prevent unnecessary re-renders).
        // Compact fingerprint: id + status + step + timestamp + run anchors.
        // Deliberately omits `data` and `lastLogMessage` — neither affects
        // queue rendering identity, and including them caused per-log-line
        // hash churn that forced displayNames to rebuild every tick.
        const hash = buildEntriesHash(raw);
        const targetKey = `${workflow}|${date}`;
        if (!shouldApplyEntriesUpdate({
          previousHash: prevHashRef.current,
          nextHash: hash,
          activeKey: activeKeyRef.current,
          targetKey,
        })) {
          return;
        }
        prevHashRef.current = hash;

        const dedupedBase = dedupeLatestByIdWithCarriedEmplId(raw as TrackerEntry[]);

        const sorted = [...dedupedBase]
          .sort((a, b) => entrySortKey(a as WithFirstLog) - entrySortKey(b as WithFirstLog));

        // Per-id ref cache: reuse the same object reference for rows whose render
        // hash hasn't changed. This lets EntryItem's React.memo bail out on
        // referential equality (prev.entry === next.entry) before its comparator
        // body runs, rather than running the comparator on every row every tick.
        const cache = entryRefCacheRef.current;
        const nextCache = new Map<string, TrackerEntry & { _hash: string }>();
        const deduped = sorted.map((entry) => {
          const hash = entryRenderHash(entry as WithFirstLog);
          const cached = cache.get(entry.id);
          if (cached && cached._hash === hash) {
            nextCache.set(entry.id, cached);
            return cached;
          }
          const next = { ...entry, _hash: hash } as TrackerEntry & { _hash: string };
          nextCache.set(entry.id, next);
          return next;
        });
        // Replace the cache with the current set of present ids so entries that
        // left the queue don't accumulate indefinitely.
        entryRefCacheRef.current = nextCache;

        setEntries(deduped);
        activeKeyRef.current = targetKey;
        setEntriesKey(targetKey);
      },
      () => {
        setConnected(false);
        setLoading(false);
        // Reset memo refs so the first post-reconnect tick is always applied.
        resetEntriesMemoRefs(prevHashRef, activeKeyRef);
        // Clear ref cache so the reconnect tick always emits fresh objects
        // (avoids serving stale cached refs if entries changed while disconnected).
        entryRefCacheRef.current = new Map();
      },
    );

    return () => {
      unsubscribe();
      setConnected(false);
    };
  }, [workflow, date]);

  return { entries, entriesKey, workflows, wfCounts, wfQueuedCounts, failureCounts, connected, loading };
}
