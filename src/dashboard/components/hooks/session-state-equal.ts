import type {
  BrowserState,
  DuoQueueEntry,
  SessionInfo,
  SessionState,
  WorkflowInstanceState,
} from "@/components/shared/types";

export function sessionStateEqual(a: SessionState, b: SessionState): boolean {
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

export function workflowEqual(a: WorkflowInstanceState, b: WorkflowInstanceState): boolean {
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
    a.daemonPhase === b.daemonPhase &&
    a.ucpathIdle?.lastTouchAt === b.ucpathIdle?.lastTouchAt &&
    a.ucpathIdle?.refreshing === b.ucpathIdle?.refreshing &&
    sessionsEqual(a.sessions, b.sessions)
  );
}

export function sessionsEqual(a: SessionInfo[], b: SessionInfo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].sessionId !== b[i].sessionId) return false;
    if (!browsersEqual(a[i].browsers, b[i].browsers)) return false;
  }
  return true;
}

export function browsersEqual(a: BrowserState[], b: BrowserState[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].browserId !== b[i].browserId ||
      a[i].system !== b[i].system ||
      a[i].authState !== b[i].authState
    ) {
      return false;
    }
  }
  return true;
}

export function duoEntryEqual(a: DuoQueueEntry, b: DuoQueueEntry): boolean {
  return a.requestId === b.requestId && a.state === b.state && a.position === b.position;
}
