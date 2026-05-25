import { createContext, useContext, type ReactNode } from "react";

/**
 * When non-null, the queue is in **batch queue mode** scoped to this id
 * (OCR prep `runId`, or a dashboard multi-enqueue batch UUID). Input run,
 * retry, and run-with-data pick this up so new work stays in the batch.
 */
const BatchQueueParentRunIdContext = createContext<string | null>(null);

export function BatchQueueParentRunIdProvider({
  parentRunId,
  children,
}: {
  parentRunId: string | null;
  children: ReactNode;
}) {
  return (
    <BatchQueueParentRunIdContext.Provider value={parentRunId}>
      {children}
    </BatchQueueParentRunIdContext.Provider>
  );
}

export function useOptionalBatchQueueParentRunId(): string | null {
  return useContext(BatchQueueParentRunIdContext);
}
