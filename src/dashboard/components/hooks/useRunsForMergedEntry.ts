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
  /**
   * True when the MOST RECENT `/api/runs` fetch failed for at least one
   * member. `runs` is never silently truncated by a failure — a failed
   * member's PRIOR entries are preserved rather than dropped — but this flag
   * lets a consumer (e.g. `RunSelector`) show that the run history may be
   * stale instead of reading identically to "confirmed, no other runs."
   */
  runsError: boolean;
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
  const [runsError, setRunsError] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(entry?.runId || null);
  const fetchGeneration = useRef(0);
  // Latest `runs`, mirrored outside React state so a partial-failure refetch
  // (an async .then, not a functional setState updater) can read the PRIOR
  // value to fall back a failed member's entries instead of dropping them.
  // Kept in sync via the effect below regardless of what set `runs` (this
  // hook's own fetch, or an external `setRuns` call like LogPanel's delete).
  const runsRef = useRef<RunInfo[]>([]);
  useEffect(() => {
    runsRef.current = runs;
  }, [runs]);

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
      runsRef.current = [];
      setRunsError(false);
      setActiveRunId(null);
      return;
    }

    setActiveRunId((prev) => prev || entry.runId || null);

    const fetchItems = members.map((m) => ({
      id: m.id,
      firstSeen: m.firstSeen,
    }));

    const myGen = ++fetchGeneration.current;

    void Promise.allSettled(
      fetchItems.map((m) =>
        fetch(
          `/api/runs?workflow=${encodeURIComponent(runsWorkflow)}&id=${encodeURIComponent(m.id)}&date=${encodeURIComponent(date)}`,
        )
          .then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
          })
          .then((data: RunInfo[]) => data.map((run) => ({ ...run, itemId: m.id }))),
      ),
    ).then((results) => {
      if (myGen !== fetchGeneration.current) return;

      // A failed member's refetch must not silently erase its previously
      // known runs — that would read as "this run has no other attempts"
      // instead of "we couldn't refresh it" (fail-loud: see root CLAUDE.md).
      // Fall back to the last-known-good list for that one member and flag
      // `runsError` so a stale RunSelector is distinguishable from a
      // confirmed one.
      const priorByItemId = new Map<string, RunInfo[]>();
      for (const r of runsRef.current) {
        const key = r.itemId ?? "";
        const list = priorByItemId.get(key);
        if (list) list.push(r);
        else priorByItemId.set(key, [r]);
      }

      let anyFailed = false;
      const perMember = results.map((result, i) => {
        if (result.status === "fulfilled") return result.value;
        anyFailed = true;
        return priorByItemId.get(fetchItems[i].id) ?? [];
      });

      const priorRuns = runsRef.current;
      const pooled = perMember.flat();
      runsRef.current = pooled;
      setRunsError(anyFailed);

      setRuns((prev) => {
        if (
          prev.length === pooled.length &&
          prev.every(
            (r, i) =>
              r.runId === pooled[i].runId &&
              r.status === pooled[i].status &&
              r.step === pooled[i].step &&
              r.lastLogTs === pooled[i].lastLogTs &&
              r.itemId === pooled[i].itemId &&
              r.runOrdinal === pooled[i].runOrdinal,
          )
        )
          return prev;
        return pooled;
      });

      setActiveRunId((prev) => {
        // Prefer the merge-primary's own run (entry.runId). For person-lookup,
        // that may be an EID-keyed search whose Search field is the original
        // query — auto-jumping to the overall newest sibling (often a later
        // name search) would overwrite Search with the resolved person name.
        const preferred =
          entry.runId && pooled.some((r) => r.runId === entry.runId)
            ? entry.runId
            : pooled.length > 0
              ? pooled[pooled.length - 1].runId
              : entry.runId || null;

        if (!prev) return preferred;

        const latestRunId =
          pooled.length > 0 ? pooled[pooled.length - 1].runId : null;
        const priorIds = new Set(priorRuns.map((r) => r.runId));
        // Auto-advance only when a brand-new run appears mid-session — not on
        // the initial hydrate of an already-complete merged EID+name group.
        if (
          latestRunId &&
          latestRunId !== prev &&
          priorRuns.length > 0 &&
          !priorIds.has(latestRunId)
        ) {
          return latestRunId;
        }
        if (pooled.some((r) => r.runId === prev)) return prev;
        return preferred;
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

  return { runs, setRuns, activeRunId, setActiveRunId, runsError };
}
