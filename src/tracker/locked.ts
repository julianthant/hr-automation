import type { Mutex } from "async-mutex";

export function createLockedTracker<T>(
  mutex: Mutex,
  updateFn: (filePath: string, data: T) => Promise<void>,
): (filePath: string, data: T) => Promise<void> {
  return async (filePath: string, data: T): Promise<void> => {
    const release = await mutex.acquire();
    try {
      await updateFn(filePath, data);
    } finally {
      release();
    }
  };
}
