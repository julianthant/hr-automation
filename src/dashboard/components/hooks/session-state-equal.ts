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
    a.pid === b.pid &&
    a.crashedOnLaunch === b.crashedOnLaunch &&
    a.currentItemId === b.currentItemId &&
    a.currentTraceId === b.currentTraceId &&
    a.itemInFlight === b.itemInFlight &&
    a.currentStep === b.currentStep &&
    a.finalStatus === b.finalStatus &&
    a.startedAt === b.startedAt &&
    a.daemonPhase === b.daemonPhase &&
    idleBySystemEqual(a.idleBySystem, b.idleBySystem) &&
    sessionsEqual(a.sessions, b.sessions)
  );
}

function idleBySystemEqual(
  a: WorkflowInstanceState["idleBySystem"],
  b: WorkflowInstanceState["idleBySystem"],
): boolean {
  const aKeys = a ? Object.keys(a) : [];
  const bKeys = b ? Object.keys(b) : [];
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (a![k].lastTouchAt !== b?.[k]?.lastTouchAt) return false;
    if (a![k].refreshing !== b?.[k]?.refreshing) return false;
  }
  return true;
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
  // Compare as a map keyed by browserId — order is cosmetic; the binding is what
  // matters. A reorder of the same set of browsers is NOT a change, and each
  // tile's auth/health is compared against ITS OWN browser, never a positional
  // neighbour.
  const byId = new Map(b.map((x) => [x.browserId, x]));
  for (const x of a) {
    const y = byId.get(x.browserId);
    if (
      !y ||
      x.system !== y.system ||
      x.authState !== y.authState ||
      x.health !== y.health ||
      x.lastError !== y.lastError ||
      x.url !== y.url
    ) {
      return false;
    }
  }
  return true;
}

export function duoEntryEqual(a: DuoQueueEntry, b: DuoQueueEntry): boolean {
  return a.requestId === b.requestId && a.state === b.state && a.position === b.position;
}
