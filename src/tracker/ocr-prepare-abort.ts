/**
 * In-process cancellation for OCR prepare: `/api/ocr/discard-prepare` fires while
 * `runOcrOrchestrator` is still async in the dashboard process. Dedup-by-latest-
 * tracker-line would resurrect "running" if the orchestrator kept emitting —
 * coordinating through this registry stops further writes instead.
 */

const abortedKeys = new Set<string>();

function key(sessionId: string, runId: string): string {
  return `${sessionId}\0${runId}`;
}

export function requestOcrPrepareAbort(sessionId: string, runId: string): void {
  abortedKeys.add(key(sessionId, runId));
}

export function clearOcrPrepareAbort(sessionId: string, runId: string): void {
  abortedKeys.delete(key(sessionId, runId));
}

export function isOcrPrepareAbortRequested(sessionId: string, runId: string): boolean {
  return abortedKeys.has(key(sessionId, runId));
}

export function createOperatorDiscardError(): Error {
  const err = new Error("operator discarded OCR prep");
  err.name = "OcrPrepareOperatorDiscardAbort";
  return err;
}

export function isOperatorDiscardAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "OcrPrepareOperatorDiscardAbort";
}

/**
 * Long OCR / PDF renders have no intervening tracker writes; poll for discard so
 * the operator doesn't wait minutes for abandonment.
 */
export async function raceOcrPrepWithDiscard<T>(
  sessionId: string,
  runId: string,
  work: Promise<T>,
  pollMs = 500,
): Promise<T> {
  let tm: ReturnType<typeof setInterval> | undefined;
  const aborted = new Promise<never>((_, reject) => {
    tm = setInterval(() => {
      if (isOcrPrepareAbortRequested(sessionId, runId)) {
        reject(createOperatorDiscardError());
      }
    }, pollMs);
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (tm !== undefined) clearInterval(tm);
  }
}

/** Test-only cleanup */
export function _resetOcrPrepareAbortRegistryForTests(): void {
  abortedKeys.clear();
}
