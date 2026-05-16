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

  // Keep latest callback refs so the effect closure always calls the current
  // version without needing them in the dep array. Callbacks are intentionally
  // excluded from deps — they are pure helpers (capLogWindow, etc.) whose
  // identity is irrelevant to when the SSE subscription should reconnect.
  const buildParamsRef = useRef(buildParams);
  const replaceFnRef = useRef(replaceFn);
  const appendFnRef = useRef(appendFn);
  buildParamsRef.current = buildParams;
  replaceFnRef.current = replaceFn;
  appendFnRef.current = appendFn;

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

    const currentBuildParams = buildParamsRef.current;
    const hubParams = currentBuildParams
      ? currentBuildParams(params)
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
        const currentReplaceFn = replaceFnRef.current;
        const currentAppendFn = appendFnRef.current;
        if (!gotSseData) {
          setEntries(currentReplaceFn ? currentReplaceFn(newEntries) : newEntries);
          setLoading(false);
          gotSseData = true;
          return;
        }
        if (newEntries.length > 0) {
          setEntries((prev) =>
            currentAppendFn ? currentAppendFn(prev, newEntries) : [...prev, ...newEntries],
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
    // buildParams, replaceFn, appendFn intentionally omitted — stored in refs above.
    // The SSE subscription should reconnect only when the stream identity changes
    // (topic, workflow, itemId, runId, date, enabled), not when helper callbacks
    // get new object identities due to parent re-renders.
  ]);

  return { entries, loading };
}
