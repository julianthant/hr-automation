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

export interface TaskDependenciesState {
  summary: TaskDependencySummary | null;
  children: TaskDependencyChild[];
  /**
   * True whenever the last poll attempt did NOT succeed (network error, non-OK
   * response, or `{ok:false}` body) or no poll has succeeded yet for the current
   * parentRunId. Callers MUST treat `unknown: true` as "can't tell" — never as
   * "0 pending" — and keep any gate (e.g. OCR Approve) disabled while it's true.
   * Fail-loud: a failed/uncertain check must never read as "nothing pending / all
   * clear".
   */
  unknown: boolean;
}

export const INITIAL_TASK_DEPENDENCIES_STATE: TaskDependenciesState = {
  summary: null,
  children: [],
  unknown: false,
};

export type TaskDependencyPollResult =
  | { kind: "success"; summary: TaskDependencySummary | null; children: TaskDependencyChild[] }
  | { kind: "error" };

/**
 * Pure reducer for one poll attempt. Extracted so the "don't clear state on
 * failure" fix is independently testable without a React render harness:
 * - `error` keeps the PRIOR summary/children untouched and marks `unknown`
 *   (a thrown/failed poll must never look like "0 pending").
 * - `success` replaces summary/children with the fresh response and clears
 *   `unknown` — this is the ONLY path that can clear it.
 */
export function applyTaskDependencyPoll(
  prev: TaskDependenciesState,
  result: TaskDependencyPollResult,
): TaskDependenciesState {
  if (result.kind === "error") {
    return prev.unknown ? prev : { ...prev, unknown: true };
  }
  return { summary: result.summary, children: result.children, unknown: false };
}

export function useTaskDependencies(parentRunId: string | undefined): TaskDependenciesState {
  const [state, setState] = useState<TaskDependenciesState>(INITIAL_TASK_DEPENDENCIES_STATE);

  // Per-parent poll (1s) — this resource is parameterized by parentRunId, so it
  // can't share a module-level singleton; `useInterval` removes the hand-rolled
  // setInterval + cleanup boilerplate. The fetch is gated to the latest
  // parentRunId via the cancellation flag.
  const tick = useCallback(async (): Promise<void> => {
    if (!parentRunId) {
      setState(INITIAL_TASK_DEPENDENCIES_STATE);
      return;
    }
    let result: TaskDependencyPollResult;
    try {
      const res = await fetch(
        `/api/task-dependencies?parentRunId=${encodeURIComponent(parentRunId)}`,
      );
      if (!res.ok) {
        result = { kind: "error" };
      } else {
        const body = (await res.json()) as {
          ok: boolean;
          summary?: TaskDependencySummary;
          children?: TaskDependencyChild[];
        };
        result = body.ok
          ? { kind: "success", summary: body.summary ?? null, children: body.children ?? [] }
          : { kind: "error" };
      }
    } catch {
      // Network blip / thrown fetch — do NOT clear summary/children (that would
      // read as "0 pending" and silently unblock a gate like OCR Approve). Keep
      // prior state and mark unknown so the caller keeps the gate disabled until
      // a poll actually succeeds.
      result = { kind: "error" };
    }
    setState((prevState) => applyTaskDependencyPoll(prevState, result));
  }, [parentRunId]);

  // Kick an immediate fetch on parentRunId change; clear state when it goes away.
  useEffect(() => {
    if (!parentRunId) {
      setState(INITIAL_TASK_DEPENDENCIES_STATE);
      return;
    }
    // Unknown until this parentRunId's first poll succeeds — a fresh mount must
    // not read as "0 pending" before any data has actually arrived.
    setState((prevState) => (prevState.unknown ? prevState : { ...prevState, unknown: true }));
    void tick();
  }, [parentRunId, tick]);

  useInterval(() => void tick(), parentRunId ? 1_000 : null);

  return state;
}
