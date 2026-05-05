import { getDependencySummaryByParentRunId, openTaskStore } from "./store.js";

export interface TaskDependenciesHttpInput {
  parentRunId?: string;
}

export interface TaskDependenciesHttpOk {
  ok: true;
  parentRunId: string;
  summary: {
    total: number;
    pending: number;
    satisfied: number;
    failed: number;
    cancelled: number;
  };
  children: Array<{
    workflow: string;
    itemId: string;
    runId?: string;
    status: string;
    metadata: Record<string, unknown>;
  }>;
}

export type TaskDependenciesHttpResult =
  | { status: 200; body: TaskDependenciesHttpOk }
  | { status: 400 | 500; body: { ok: false; error: string } };

export function buildTaskDependenciesHandler(opts: {
  trackerDir?: string;
  getSummaryByParentRunId?: (parentRunId: string) => Promise<Omit<TaskDependenciesHttpOk, "ok">>;
} = {}) {
  return async (input: TaskDependenciesHttpInput): Promise<TaskDependenciesHttpResult> => {
    const parentRunId = (input.parentRunId ?? "").trim();
    if (!parentRunId) {
      return { status: 400, body: { ok: false, error: "parentRunId is required" } };
    }

    try {
      const summary = opts.getSummaryByParentRunId
        ? await opts.getSummaryByParentRunId(parentRunId)
        : await getDependencySummaryByParentRunId(openTaskStore(opts.trackerDir), parentRunId);
      return { status: 200, body: { ok: true, ...summary } };
    } catch (err) {
      return {
        status: 500,
        body: { ok: false, error: err instanceof Error ? err.message : String(err) },
      };
    }
  };
}
