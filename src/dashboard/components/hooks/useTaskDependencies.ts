import { useEffect, useState } from "react";

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

  useEffect(() => {
    if (!parentRunId) {
      setSummary(null);
      setChildren([]);
      return;
    }

    let cancelled = false;
    const checkedParentRunId = parentRunId;

    async function tick(): Promise<void> {
      try {
        const res = await fetch(`/api/task-dependencies?parentRunId=${encodeURIComponent(checkedParentRunId)}`);
        if (!res.ok) return;
        const body = await res.json() as {
          ok: boolean;
          summary?: TaskDependencySummary;
          children?: TaskDependencyChild[];
        };
        if (cancelled || !body.ok) return;
        setSummary(body.summary ?? null);
        setChildren(body.children ?? []);
      } catch {
        if (!cancelled) {
          setSummary(null);
          setChildren([]);
        }
      }
    }

    void tick();
    const handle = window.setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [parentRunId]);

  return { summary, children };
}
