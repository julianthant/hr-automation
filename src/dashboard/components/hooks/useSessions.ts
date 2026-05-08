import { useState, useEffect } from "react";
import type { SessionState, WorkflowInstanceState, DuoQueueEntry } from "@/components/shared/types";
import { sseHub } from "@/lib/sse-hub";

const EMPTY_STATE: SessionState = { workflows: [], duoQueue: [] };

/**
 * Cheap structural fingerprint compare. Returns true when the meaningful
 * fields are identical. Replaces the previous `JSON.stringify` short-circuit
 * (1-5ms per tick on large payloads) and the briefly-broken "no dedupe"
 * variant (Tier 3 Task 10B) which caused TerminalDrawer's filter() to
 * produce fresh array refs on every tick, defeating React.memo on children.
 */
function sessionStateEqual(a: SessionState, b: SessionState): boolean {
  if (a === b) return true;
  if (a.workflows.length !== b.workflows.length) return false;
  if (a.duoQueue.length !== b.duoQueue.length) return false;
  for (let i = 0; i < a.workflows.length; i++) {
    if (!workflowEqual(a.workflows[i], b.workflows[i])) return false;
  }
  for (let i = 0; i < a.duoQueue.length; i++) {
    if (!duoEntryEqual(a.duoQueue[i], b.duoQueue[i])) return false;
  }
  return true;
}

function workflowEqual(a: WorkflowInstanceState, b: WorkflowInstanceState): boolean {
  return (
    a.instance === b.instance &&
    a.active === b.active &&
    a.pidAlive === b.pidAlive &&
    a.crashedOnLaunch === b.crashedOnLaunch &&
    a.currentItemId === b.currentItemId &&
    a.itemInFlight === b.itemInFlight &&
    a.currentStep === b.currentStep &&
    a.finalStatus === b.finalStatus &&
    a.startedAt === b.startedAt &&
    a.sessions.length === b.sessions.length
  );
}

function duoEntryEqual(a: DuoQueueEntry, b: DuoQueueEntry): boolean {
  return (
    a.requestId === b.requestId &&
    a.state === b.state &&
    a.position === b.position
  );
}

export function useSessions(): { state: SessionState; connected: boolean } {
  const [state, setState] = useState<SessionState>(EMPTY_STATE);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const unsubscribe = sseHub.subscribe<SessionState>(
      "sessions",
      {},
      (data) => {
        setConnected(true);
        setState((prev) => (sessionStateEqual(prev, data) ? prev : data));
      },
      () => {
        setConnected(false);
      },
    );

    return () => {
      unsubscribe();
      setConnected(false);
    };
  }, []);

  return { state, connected };
}
