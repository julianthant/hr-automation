import type { CaptureState } from "../capture-types.js";

export function isTerminal(state: CaptureState): boolean {
  return (
    state === "finalized" ||
    state === "finalize_failed" ||
    state === "discarded" ||
    state === "expired"
  );
}
