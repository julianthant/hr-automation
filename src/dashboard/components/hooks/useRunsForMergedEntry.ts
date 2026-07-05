import { useState, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import type { TrackerEntry, RunInfo } from "@/components/shared/types";

interface UseRunsForMergedEntryInput {
  entry: TrackerEntry | null;
  siblings?: TrackerEntry[];
  workflow: string;
  date: string;
}

interface UseRunsForMergedEntryResult {
  runs: RunInfo[];
  setRuns: Dispatch<SetStateAction<RunInfo[]>>;
  activeRunId: string | null;
  setActiveRunId: Dispatch<SetStateAction<string | null>>;
}

/**
 * Fetches and pools runs for an entry + its merged siblings.
 *
 * Effect re-runs only when the set of member ids or their latest runIds
 * change — NOT on every status/step update. Status changes at ~1 Hz were
 * causing a /api/runs refetch per status flip; this hook keys on a stable
 * requestKey derived from (workflow, id, runId) tuples so refetches only
 * happen when a new run actually starts.
 */
export function useRunsForMergedEntry({
  entry,
  siblings,
  workflow,
  date,
}: UseRunsForMergedEntryInput): UseRunsForMergedEntryResult {
  const [runs, setRuns] = useState<RunInfo[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(entry?.runId || null);
  const fetchGeneration = useRef(0);

  // Stable request key: encodes the (id, runId) pair for each member, sorted
  // oldest-first by firstSeen. Excludes status and step — those change every
  // tick and do not affect which runs exist. The key only changes when:
  //   (a) a new sibling is added/removed (id set changes), or
  //   (b) a new run starts for an existing member (runId changes).
  const members: { id: string; runId: string | undefined; firstSeen: string }[] = entry
    ? [
        {
          id: entry.id,
          runId: entry.runId,
          firstSeen: entry.startTimestamp || entry.firstLogTs || entry.timestamp || "",
        },
        ...((siblings ?? []).map((s) => ({
          id: s.id,
          runId: s.runId,
          firstSeen: s.startTimestamp || s.firstLogTs || s.timestamp || "",
        }))),
      ]
    : [];

  // Sort oldest-first so ordinal assignment is stable across renders
  // (older entry keeps the lower ordinals — matches "Langley keeps 1–5").
  members.sort((a, b) => (a.firstSeen || "").localeCompare(b.firstSeen || ""));

  // requestKey is stable as long as no new run starts. Status/step changes
  // to existing runs produce no key change → no refetch.
  const requestKey = members
    .map((m) => `${workflow}:${m.id}:${m.runId ?? ""}:${date}`)
    .join("|");

  const runsWorkflow = entry?.workflow ?? workflow;

  useEffect(() => {
    if (!entry) {
      setRuns([]);
      setActiveRunId(null);
      return;
    }

    setActiveRunId((prev) => prev || entry.runId || null);

    const fetchItems = members.map((m) => ({
      id: m.id,
      firstSeen: m.firstSeen,
    }));

    const myGen = ++fetchGeneration.current;

    void Promise.all(
      fetchItems.map((m) =>
        fetch(
          `/api/runs?workflow=${encodeURIComponent(runsWorkflow)}&id=${encodeURIComponent(m.id)}&date=${encodeURIComponent(date)}`,
        )
          .then((r) => r.json())
          .then((data: RunInfo[]) => data.map((run) => ({ ...run, itemId: m.id })))
          .catch(() => [] as RunInfo[]),
      ),
    ).then((perMember) => {
      if (myGen !== fetchGeneration.current) return;

      const pooled = perMember.flat();
      const renumbered = pooled.map((run, i) => ({ ...run, runOrdinal: i + 1 }));

      setRuns((prev) => {
        if (
          prev.length === renumbered.length &&
          prev.every(
            (r, i) =>
              r.runId === renumbered[i].runId &&
              r.status === renumbered[i].status &&
              r.step === renumbered[i].step &&
              r.lastLogTs === renumbered[i].lastLogTs &&
              r.itemId === renumbered[i].itemId,
          )
        )
          return prev;
        return renumbered;
      });

      setActiveRunId((prev) => {
        if (!prev)
          return renumbered.length > 0
            ? renumbered[renumbered.length - 1].runId
            : entry.runId || null;
        const latestRunId =
          renumbered.length > 0 ? renumbered[renumbered.length - 1].runId : null;
        if (
          latestRunId &&
          latestRunId !== prev &&
          !renumbered.slice(0, -1).some((r) => r.runId === latestRunId)
        ) {
          return latestRunId;
        }
        if (renumbered.some((r) => r.runId === prev)) return prev;
        return renumbered.length > 0
          ? renumbered[renumbered.length - 1].runId
          : entry.runId || null;
      });
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);
  // requestKey encodes entry.id + entry.runId + all sibling ids/runIds + date.
  // Intentionally excludes entry.status, entry.step, sibling status/step —
  // those change every second and do not affect which /api/runs rows exist.
  // runsWorkflow and entry.workflow are encoded inside requestKey via
  // the per-member id/runId tuples; if workflow identity itself changed we'd
  // see a different requestKey anyway.

  return { runs, setRuns, activeRunId, setActiveRunId };
}
