import { log } from "./log.js";
import { errorMessage } from "./errors.js";

export interface WorkerPoolOptions<T, Ctx> {
  items: T[];
  workerCount: number;
  setup: (workerId: number) => Promise<Ctx>;
  process: (item: T, ctx: Ctx, workerId: number) => Promise<void>;
  teardown?: (ctx: Ctx, workerId: number) => Promise<void>;
  maxConsecutiveErrors?: number;
}

export async function runWorkerPool<T, Ctx>(
  options: WorkerPoolOptions<T, Ctx>,
): Promise<void> {
  const { items, workerCount, setup, process, teardown, maxConsecutiveErrors = Infinity } = options;
  const queue = [...items];
  const actualWorkers = Math.min(workerCount, items.length);

  async function worker(workerId: number): Promise<void> {
    const prefix = `[W${workerId}]`;
    const ctx = await setup(workerId);
    let consecutiveErrors = 0;
    try {
      while (queue.length > 0) {
        const item = queue.shift();
        if (item === undefined) break;
        try {
          await process(item, ctx, workerId);
          consecutiveErrors = 0;
        } catch (err) {
          consecutiveErrors++;
          log.error(`${prefix} Error: ${errorMessage(err)}`);
          if (consecutiveErrors >= maxConsecutiveErrors) {
            log.error(`${prefix} ${maxConsecutiveErrors} consecutive errors — stopping worker`);
            break;
          }
        }
      }
    } finally {
      if (teardown) await teardown(ctx, workerId).catch(() => {});
    }
  }

  const workers = Array.from({ length: actualWorkers }, (_, i) => worker(i + 1));
  await Promise.all(workers);
}
