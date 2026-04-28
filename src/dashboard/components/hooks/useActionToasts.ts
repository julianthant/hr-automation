import { toast } from "sonner";

/**
 * Action-toast registry. Wires sonner's `toast.loading` ids to entries
 * SSE so a "Cancel requested…" toast resolves to a concrete state when the
 * watched entry reaches a terminal status — instead of staying in the
 * intermediate "Cancelling 3934…" state forever.
 *
 * Why a module-scope registry, not a hook:
 * - The button component fires the toast and immediately unmounts when the
 *   entry transitions out of the running state (e.g. EntryItem hides the
 *   CancelRunningButton when status is no longer running). A hook scoped
 *   to the button can't observe its own resolution.
 * - The App-level entries SSE subscription is the single global listener;
 *   a registry it queries against is straightforward.
 *
 * Resolution semantics:
 *   `cancel-running`:
 *     entry.step === "cancelled" → toast.success("Cancelled")
 *     entry.status === "done"     → toast.success("Completed before cancel took effect")
 *     entry.status === "failed"   → toast.error(entry.error or "Failed")
 *
 *   `cancel-queued`:
 *     same as above (cancel-queued's tracker row is also `step="cancelled"`).
 *     The button already resolves on HTTP 200; SSE is a backstop for the
 *     race where the daemon's exit cleanup writes the failed row first.
 *
 * Fallback: if no terminal event arrives within `timeoutMs` (default 10s),
 * the toast text flips to a "still in progress" hint. The registration
 * stays in the map so a late-arriving SSE event can still resolve it.
 */

export type ActionKind = "cancel-running" | "cancel-queued";

interface RegisteredToast {
  toastId: string | number;
  workflow: string;
  id: string;
  runId: string;
  kind: ActionKind;
  registeredAt: number;
  fallbackTimer?: ReturnType<typeof setTimeout>;
}

function key(workflow: string, id: string, runId: string, kind: ActionKind): string {
  return `${workflow}|${id}|${runId}|${kind}`;
}

const registry = new Map<string, RegisteredToast>();

export interface RegisterActionToastOpts {
  toastId: string | number;
  workflow: string;
  id: string;
  runId: string;
  kind: ActionKind;
  /** Time before the toast text flips to a "still in progress" hint. Default 10000ms. */
  timeoutMs?: number;
  /** Customizable fallback hint when the timeout fires. */
  fallbackMessage?: string;
  fallbackDescription?: string;
}

export function registerActionToast(opts: RegisterActionToastOpts): void {
  const k = key(opts.workflow, opts.id, opts.runId, opts.kind);
  // If a previous registration for the same key exists, clear its fallback
  // timer — the new toast supersedes it.
  const prev = registry.get(k);
  if (prev?.fallbackTimer) clearTimeout(prev.fallbackTimer);

  const timeoutMs = opts.timeoutMs ?? 10_000;
  const fallbackMessage = opts.fallbackMessage ?? "Still in progress";
  const fallbackDescription =
    opts.fallbackDescription ??
    "No terminal state observed yet — check the entry status directly.";

  const fallbackTimer = setTimeout(() => {
    const stillPending = registry.get(k);
    if (!stillPending) return;
    // The toast persists with the new text. We don't clear from the
    // registry — a late-arriving SSE event may still resolve to a real
    // terminal state (e.g. cancel-running on a long Playwright wait).
    toast.loading(fallbackMessage, {
      id: stillPending.toastId,
      description: fallbackDescription,
    });
  }, timeoutMs);

  registry.set(k, {
    toastId: opts.toastId,
    workflow: opts.workflow,
    id: opts.id,
    runId: opts.runId,
    kind: opts.kind,
    registeredAt: Date.now(),
    fallbackTimer,
  });
}

export function clearActionToast(
  workflow: string,
  id: string,
  runId: string,
  kind: ActionKind,
): void {
  const k = key(workflow, id, runId, kind);
  const reg = registry.get(k);
  if (reg?.fallbackTimer) clearTimeout(reg.fallbackTimer);
  registry.delete(k);
}

interface EntryShape {
  workflow: string;
  id: string;
  runId?: string;
  status: string;
  step?: string;
  error?: string;
}

/**
 * Called by App's entries SSE effect when an entry transitions to a new
 * status. Resolves any registered action toasts that match the entry's
 * (workflow, id, runId), then clears them from the registry. Generic
 * status-change toasts in App.tsx still fire alongside — the action
 * resolution is in addition to, not in place of, the per-status toast.
 */
export function resolveActionToastsForEntry(entry: EntryShape): void {
  if (!entry.runId) return;
  const isCancelled = entry.status === "failed" && entry.step === "cancelled";
  const isDone = entry.status === "done";
  const isFailed = entry.status === "failed" && !isCancelled;

  if (!isCancelled && !isDone && !isFailed) return; // no terminal state for the registry

  for (const kind of ["cancel-running", "cancel-queued"] as const) {
    const k = key(entry.workflow, entry.id, entry.runId, kind);
    const reg = registry.get(k);
    if (!reg) continue;

    if (isCancelled) {
      toast.success(`Cancelled ${entry.id}`, {
        id: reg.toastId,
        description:
          kind === "cancel-running"
            ? "Workflow stopped at step boundary; daemon ready for next item."
            : "Removed from queue.",
      });
    } else if (isDone) {
      toast.success(`${entry.id} completed`, {
        id: reg.toastId,
        description: "The item finished before the cancel could take effect.",
      });
    } else if (isFailed) {
      toast.error(`${entry.id} failed`, {
        id: reg.toastId,
        description: entry.error ?? "Different error than cancellation.",
      });
    }
    clearActionToast(entry.workflow, entry.id, entry.runId, kind);
  }
}

/** Test helper: clear every registered toast. */
export function __resetActionToastRegistry(): void {
  for (const reg of registry.values()) {
    if (reg.fallbackTimer) clearTimeout(reg.fallbackTimer);
  }
  registry.clear();
}
