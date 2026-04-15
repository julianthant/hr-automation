import { log } from "../../utils/log.js";
import { errorMessage } from "../../utils/errors.js";

export class RetryStepError extends Error {
  constructor(
    message: string,
    readonly step: string,
    readonly attempts: number,
    readonly cause: unknown,
  ) {
    super(message);
    this.name = "RetryStepError";
  }
}

export interface RetryOptions {
  attempts?: number;
  backoffMs?: number;
  logPrefix?: string;
  onRetry?: (err: unknown, attempt: number) => void | Promise<void>;
}

export async function retryStep<T>(
  stepName: string,
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const backoff = options.backoffMs ?? 2_000;
  const prefix = options.logPrefix ? `${options.logPrefix} ` : "";
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (attempt > 1) log.step(`${prefix}${stepName}: retry ${attempt}/${attempts}`);
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = errorMessage(err);
      log.error(`${prefix}${stepName}: attempt ${attempt}/${attempts} failed — ${msg}`);
      if (attempt < attempts) {
        if (options.onRetry) {
          try { await options.onRetry(err, attempt); } catch { /* non-fatal */ }
        }
        await new Promise((r) => setTimeout(r, backoff * attempt));
      }
    }
  }

  const finalMsg = `${stepName} failed after ${attempts} attempt(s): ${errorMessage(lastErr)}`;
  throw new RetryStepError(finalMsg, stepName, attempts, lastErr);
}
