import { classifyPlaywrightError, errorMessage } from "../../utils/errors.js";
import { log } from "../../utils/log.js";

export function logSettledRejection(
  label: string,
  result: PromiseSettledResult<unknown>,
): boolean {
  if (result.status !== "rejected") return false;
  const classified = classifyPlaywrightError(result.reason);
  log.error(`[${label}] ${classified.kind}: ${classified.summary}`);
  log.debug(`[${label}] full error: ${errorMessage(result.reason)}`);
  return true;
}

export function unwrapSettled<T>(
  label: string,
  result: PromiseSettledResult<T>,
): T {
  if (result.status === "fulfilled") return result.value;
  throw new Error(`${label} failed: ${errorMessage(result.reason)}`);
}
