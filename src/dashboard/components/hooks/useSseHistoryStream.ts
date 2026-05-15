import { useEffect, useRef, useState } from "react";
import { compact } from "@/lib/utils";
import { sseHub } from "@/lib/sse-hub";

type StreamParams = {
  workflow: string;
  itemId: string | null;
  runId: string | null;
  date: string;
};

interface SseHistoryStreamOptions<T> {
  enabled?: boolean;
  buildParams?: (params: StreamParams) => Record<string, unknown>;
  replaceFn?: (entries: T[]) => T[];
  appendFn?: (prev: T[], entries: T[]) => T[];
}

export function useSseHistoryStream<T>(
  topic: string,
  params: StreamParams,
  opts: SseHistoryStreamOptions<T> = {},
): { entries: T[]; loading: boolean } {
  const { enabled = Boolean(params.itemId), buildParams, replaceFn, appendFn } = opts;
  const [entries, setEntries] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const prevItemIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !params.itemId) {
      setEntries([]);
      setLoading(false);
      prevItemIdRef.current = null;
      return;
    }

    if (params.itemId !== prevItemIdRef.current) {
      setEntries([]);
      prevItemIdRef.current = params.itemId;
    }
    setLoading(true);

    const hubParams = buildParams
      ? buildParams(params)
      : compact({
          workflow: params.workflow,
          id: params.itemId,
          runId: params.runId,
          date: params.date,
        });

    let gotSseData = false;
    const unsubscribe = sseHub.subscribe<T[]>(
      topic,
      hubParams,
      (newEntries) => {
        if (!Array.isArray(newEntries)) return;
        if (!gotSseData) {
          setEntries(replaceFn ? replaceFn(newEntries) : newEntries);
          setLoading(false);
          gotSseData = true;
          return;
        }
        if (newEntries.length > 0) {
          setEntries((prev) =>
            appendFn ? appendFn(prev, newEntries) : [...prev, ...newEntries],
          );
        }
      },
      () => {
        gotSseData = false;
        setLoading(false);
      },
    );

    return () => unsubscribe();
  }, [
    topic,
    params.workflow,
    params.itemId,
    params.runId,
    params.date,
    enabled,
    buildParams,
    replaceFn,
    appendFn,
  ]);

  return { entries, loading };
}
