import { createContext, useContext, type ReactNode } from "react";

/**
 * When non-null, the queue is in **batch queue mode** scoped to this id
 * (OCR prep `runId`, or a dashboard multi-enqueue batch UUID). Input run,
 * retry, and run-with-data pick this up so new work stays in the batch.
 */
const OperationQueueParentRunIdContext = createContext<string | null>(null);

export function OperationQueueParentRunIdProvider({
  parentRunId,
  children,
}: {
  parentRunId: string | null;
  children: ReactNode;
}) {
  return (
    <OperationQueueParentRunIdContext.Provider value={parentRunId}>
      {children}
    </OperationQueueParentRunIdContext.Provider>
  );
}

export function useOptionalOperationQueueParentRunId(): string | null {
  return useContext(OperationQueueParentRunIdContext);
}
