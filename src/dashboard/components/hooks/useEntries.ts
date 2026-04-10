import { useState, useEffect, useRef } from "react";
import type { TrackerEntry } from "../types";

interface UseEntriesResult {
  entries: TrackerEntry[];
  workflows: string[];
  connected: boolean;
  loading: boolean;
}

/**
 * SSE hook for workflow entries.
 * Dedupes by ID (keeps latest), sorts newest-first by first-seen timestamp.
 */
export function useEntries(workflow: string, date: string): UseEntriesResult {
  const [entries, setEntries] = useState<TrackerEntry[]>([]);
  const [workflows, setWorkflows] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const prevHashRef = useRef("");

  useEffect(() => {
    setLoading(true);
    const today = new Date().toISOString().slice(0, 10);
    let sseUrl = "/events?workflow=" + encodeURIComponent(workflow);
    if (date && date !== today) {
      sseUrl += "&date=" + encodeURIComponent(date);
    }

    const es = new EventSource(sseUrl);

    es.onopen = () => setConnected(true);

    es.onmessage = (e) => {
      try {
        const { entries: raw, workflows: wfs }: { entries: TrackerEntry[]; workflows: string[] } = JSON.parse(e.data);

        setLoading(false);

        // Skip if data hasn't changed (prevent unnecessary re-renders)
        const hash = JSON.stringify(raw.map((r) => `${r.id}:${r.status}:${r.step}:${r.timestamp}`));
        if (hash === prevHashRef.current) return;
        prevHashRef.current = hash;

        // Dedupe by ID, keep latest entry
        const latest = new Map<string, TrackerEntry>();
        // Track first-seen timestamp per ID for sort order
        const firstSeen = new Map<string, string>();
        for (const entry of raw) {
          latest.set(entry.id, entry);
          if (!firstSeen.has(entry.id)) {
            firstSeen.set(entry.id, entry.timestamp);
          }
        }

        // Sort newest-first by first-seen timestamp
        const deduped = [...latest.values()].sort((a, b) => {
          const aFirst = firstSeen.get(a.id) || a.timestamp;
          const bFirst = firstSeen.get(b.id) || b.timestamp;
          return bFirst.localeCompare(aFirst);
        });

        setEntries(deduped);
        setWorkflows(wfs || []);
      } catch {
        // ignore malformed
      }
    };

    es.onerror = () => {
      setConnected(false);
      setLoading(false);
    };

    return () => {
      es.close();
      setConnected(false);
    };
  }, [workflow, date]);

  return { entries, workflows, connected, loading };
}
