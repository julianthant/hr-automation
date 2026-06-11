import { useCallback, useEffect, useState } from "react";
import { useInterval } from "./resource-factory";

export interface TaskDependencySummary {
  total: number;
  pending: number;
  satisfied: number;
  failed: number;
  cancelled: number;
}

export interface TaskDependencyChild {
  workflow: string;
  itemId: string;
  runId?: string;
  status: string;
  metadata: Record<string, unknown>;
  traceId?: string;
}

export function useTaskDependencies(parentRunId: string | undefined): {
  summary: TaskDependencySummary | null;
  children: TaskDependencyChild[];
} {
  const [summary, setSummary] = useState<TaskDependencySummary | null>(null);
  const [children, setChildren] = useState<TaskDependencyChild[]>([]);

  // Per-parent poll (1s) — this resource is parameterized by parentRunId, so it
  // can't share a module-level singleton; `useInterval` removes the hand-rolled
  // setInterval + cleanup boilerplate. The fetch is gated to the latest
  // parentRunId via the cancellation flag.
  const tick = useCallback(async (): Promise<void> => {
    if (!parentRunId) {
      setSummary(null);
      setChildren([]);
      return;
    }
    try {
      const res = await fetch(
        `/api/task-dependencies?parentRunId=${encodeURIComponent(parentRunId)}`,
      );
      if (!res.ok) return;
      const body = (await res.json()) as {
        ok: boolean;
        summary?: TaskDependencySummary;
        children?: TaskDependencyChild[];
      };
      if (!body.ok) return;
      setSummary(body.summary ?? null);
      setChildren(body.children ?? []);
    } catch {
      setSummary(null);
      setChildren([]);
    }
  }, [parentRunId]);

  // Kick an immediate fetch on parentRunId change; clear state when it goes away.
  useEffect(() => {
    if (!parentRunId) {
      setSummary(null);
      setChildren([]);
      return;
    }
    void tick();
  }, [parentRunId, tick]);

  useInterval(() => void tick(), parentRunId ? 1_000 : null);

  return { summary, children };
}
