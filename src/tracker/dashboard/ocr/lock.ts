// ─── Per-sessionId lock ──────────────────────────────────────

const activeSessionIds = new Set<string>();

// ─── Per-row mutex (sessionId:runId) ─────────────────────────

const activeRowKeys = new Set<string>();

export function rowKey(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}`;
}

export function hasSessionLock(sessionId: string): boolean {
  return activeSessionIds.has(sessionId);
}

export function acquireSessionLock(sessionId: string): void {
  activeSessionIds.add(sessionId);
}

export function releaseSessionLock(sessionId: string): void {
  activeSessionIds.delete(sessionId);
}

export function hasRowLock(key: string): boolean {
  return activeRowKeys.has(key);
}

export function acquireRowLock(key: string): void {
  activeRowKeys.add(key);
}

export function releaseRowLock(key: string): void {
  activeRowKeys.delete(key);
}

export function _resetSessionLockForTests(): void {
  activeSessionIds.clear();
  activeRowKeys.clear();
}
