import { useState, useEffect, useRef } from "react";
import type { TrackerEntry } from "@/components/shared/types";
import { dateLocal } from "../../lib/utils";
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
  failureCounts: Record<string, number>;
  connected: boolean;
  loading: boolean;
}

export function shouldApplyEntriesUpdate(args: {
  previousHash: string;
  nextHash: string;
  activeKey: string;
  targetKey: string;
}): boolean {
  return args.previousHash !== args.nextHash || args.activeKey !== args.targetKey;
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
  const [failureCounts, setFailureCounts] = useState<Record<string, number>>({});
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const prevHashRef = useRef("");
  const activeKeyRef = useRef("");

  useEffect(() => {
    setLoading(true);
    setEntriesKey("");
    activeKeyRef.current = "";
    // Reset the entry-hash/key memos on every (workflow, date) change so a
    // new subscription applies its first payload even when the payload is
    // empty. Without the key guard, switching to an empty date leaves the
    // previous date's rows on screen because both hashes are "".
    prevHashRef.current = "";

    const today = dateLocal();
    const params: { workflow: string; date?: string } = { workflow };
    if (date && date !== today) {
      params.date = date;
    }

    const unsubscribe = sseHub.subscribe(
      "entries",
      params,
      (data) => {
        const { entries: raw, workflows: wfs, wfCounts: counts, failureCounts: fcounts } = data as {
          entries: TrackerEntry[];
          workflows: string[];
          wfCounts?: Record<string, number>;
          failureCounts?: Record<string, number>;
        };

        setConnected(true);
        setLoading(false);

        // Workflows + per-workflow counts update EVERY tick regardless of
        // whether this workflow's entry list changed. They reflect a
        // date-wide aggregate that can shift while the selected workflow's
        // entries stay identical (e.g., other workflows running on the same
        // day, or switching to a date where the current workflow has 0
        // entries but others have activity). Gating them behind the entry
        // hash was the bug that made date switches show "0 / 0 / 0".
        setWorkflows(wfs || []);
        if (counts) setWfCounts(counts);
        setFailureCounts(fcounts ?? {});

        // Skip if data hasn't changed (prevent unnecessary re-renders).
        // Compact fingerprint: id + status + step + timestamp + run anchors.
        // Deliberately omits `data` and `lastLogMessage` — neither affects
        // queue rendering identity, and including them caused per-log-line
        // hash churn that forced displayNames to rebuild every tick.
        const hash = raw.map((r) =>
          `${r.id}|${r.status}|${r.step ?? ""}|${r.timestamp}|${(r as any).firstLogTs ?? ""}|${(r as any).lastLogTs ?? ""}|${r.runId ?? ""}|${r.error ?? ""}`
        ).join(";");
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

        type WithFirstLog = TrackerEntry & { firstLogTs?: string };
        // Sort by running start time (firstLogTs), pending entries at bottom
        const deduped = [...dedupedBase]
          .sort((a, b) => {
            // Pending entries (no firstLogTs) go to bottom
            const aStart = (a as WithFirstLog).firstLogTs || "";
            const bStart = (b as WithFirstLog).firstLogTs || "";
            if (!aStart && bStart) return 1;
            if (aStart && !bStart) return -1;
            if (!aStart && !bStart) return b.timestamp.localeCompare(a.timestamp);
            return bStart.localeCompare(aStart);
          });

        setEntries(deduped);
        activeKeyRef.current = targetKey;
        setEntriesKey(targetKey);
      },
      () => {
        setConnected(false);
        setLoading(false);
      },
    );

    return () => {
      unsubscribe();
      setConnected(false);
    };
  }, [workflow, date]);

  return { entries, entriesKey, workflows, wfCounts, failureCounts, connected, loading };
}
