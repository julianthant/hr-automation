/**
 * Shared OCR fan-out pipeline: dispatch N person-lookup / i9-lookup children
 * through `delegateToAllImpl`, watch them to terminal, and cascade-cancel the
 * still-queued children if the operator aborts mid-wait.
 *
 * Replaces the byte-identical dispatch→watch→cascade-cancel copies that lived
 * in (BM-1):
 *   - src/tracker/dashboard/ocr/force-research.ts → src/workflows/ocr/force-research.ts
 *   - src/workflows/ocr/retry-page.ts
 *   - src/services/ocr/forms/verify.ts (enrichRecords: person-lookup + i9-lookup)
 *   - src/tracker/dashboard/ocr/reocr-whole-pdf.ts
 *   - src/workflows/ocr/verify-relookup.ts (single-child variant)
 *
 * The orchestrator's `runFanOutPhase` keeps its own copy: it carries the SQLite
 * dependency-batch mode + scheduler-tick lifecycle that none of the operator-
 * driven re-fan paths share. This helper covers the simple "fan out, watch,
 * patch outcomes" shape they all DO share.
 *
 * Per-record outcome patching stays at the call site (every caller patches a
 * different record shape — oath/EC vs verify checks); this helper returns the
 * resolved outcomes + a `byItemId` lookup + the set of itemIds that never
 * produced an outcome (timeout/skip) so the caller can mark them unresolved.
 *
 * `delegateToAllImpl` callers stay on the architecture allow-list
 * (`tests/unit/architecture/delegate-to-all-impl-callers.test.ts`): this module
 * is the single dispatch site, plus the orchestrator's own `runFanOutPhase`.
 */
import type { DaemonFlags } from "../../core/daemon/types.js";
import type { ChildRunResult, RegisteredWorkflow } from "../../core/kernel/types.js";
import type { ChildOutcome, WatchChildRunsOpts } from "../../tracker/delegation/watch-child-runs.js";
import { watchChildRuns as realWatchChildRuns } from "../../tracker/delegation/watch-child-runs.js";
import { isOcrPrepareAbortRequested, isOperatorDiscardAbortError } from "../../tracker/ocr-prepare-abort.js";
import {
  openTaskStore,
  cancelQueuedChildTasksForParentRun,
} from "../../tracker/tasks/store.js";

/** One child to fan out: its logical input plus its stable, watch-correlated itemId. */
export interface FanOutChild<TInput> {
  input: TInput;
  itemId: string;
}

export interface FanOutAndWatchArgs<TInput> {
  /** The OCR session id (`item_id`) + run id that own this fan-out. */
  sessionId: string;
  runId: string;
  /** The run id that fanned-out child rows parent under (operation or OCR run). */
  parentRunId: string;
  trackerDir: string | undefined;
  /** YYYY-MM-DD; passed through to `watchChildRuns`. */
  date: string;
  /** Workflow to delegate to (person-lookup / i9-lookup). */
  child: RegisteredWorkflow<unknown, readonly string[]>;
  /**
   * Workflow name to WATCH. Usually `child.config.name`, but kept explicit
   * because `watchChildRuns` keys JSONL/SQLite lookups on this exact name and a
   * mismatch silently hangs the full timeout (the 2026-05-28 eid-lookup rename
   * footgun). Defaults to `child.config.name`.
   */
  watchWorkflow?: string;
  /** Children to dispatch — each carries the itemId its outcome correlates by. */
  children: ReadonlyArray<FanOutChild<TInput>>;
  /** Hard watch timeout in ms. */
  timeoutMs: number;
  /** Inherited root trace prefix for trace-id propagation. Omitted = standalone prefix. */
  rootTracePrefix?: string;
  /** Daemon spawn flags (operator worker count). Omitted = default reuse-or-spawn-one. */
  daemonFlags?: DaemonFlags;
  /** Forwarded to `delegateToAllImpl` so child pending rows carry OCR context. */
  buildPendingExtras?: (input: TInput, itemId: string) => Record<string, unknown>;
  /** Forwarded to `delegateToAllImpl` (SQLite dependency-batch hook). */
  onPreparedItems?: (items: Array<{ itemId: string; runId: string }>) => Promise<void> | void;
  /**
   * Fired AFTER dispatch and BEFORE the watch, with the per-child dispatch
   * results (`{ itemId, runId }`). Lets a caller stamp a "pending" status +
   * child trace id onto each record before the watch begins (verify's
   * enrichRecords does this so the Preview tab shows the children as queued).
   * Only fired on the real `delegateToAllImpl` path (the `dispatch` override
   * carries no result rows).
   */
  onDispatched?: (results: ReadonlyArray<{ itemId: string; runId: string }>) => void;
  /**
   * Fired as each expected child reaches terminal status (forwarded to
   * `watchChildRuns.onProgress`). The caller patches its own record shape.
   */
  onProgress?: (outcome: ChildOutcome, remaining: number) => void;
  /**
   * Per-run abort check. Defaults to the in-process prepare-abort flag for
   * `(sessionId, runId)` — the bridge a generic `ctx.signal` cancel trips. Pass
   * a custom predicate only to compose additional abort sources.
   */
  shouldAbort?: () => boolean;
  /**
   * Dispatch override (test seam / HTTP `_enqueueOverride`). When set it
   * REPLACES the `delegateToAllImpl` call — used by the HTTP-path sites that
   * have no parent `ctx` and by unit tests. Receives the children verbatim.
   */
  dispatch?: (children: ReadonlyArray<FanOutChild<TInput>>) => Promise<void>;
  /** Watch override (test seam / `_watchChildRunsOverride`). */
  watch?: (opts: WatchChildRunsOpts) => Promise<ChildOutcome[]>;
}

export interface FanOutResult {
  /** Every resolved child outcome. */
  outcomes: ChildOutcome[];
  /** Outcomes keyed by itemId for direct per-record correlation. */
  byItemId: Map<string, ChildOutcome>;
  /** Expected itemIds that never produced an outcome (timeout / skip). */
  missingItemIds: string[];
}

/**
 * Dispatch the children, watch them to terminal, and — on an operator
 * discard-abort during the wait — cascade-cancel the still-queued children
 * (`cancelQueuedChildTasksForParentRun`) so a daemon doesn't claim and run them
 * after the operator gave up. Fail-loud: a cascade error (and any non-abort
 * watch failure) propagates.
 *
 * Records are NOT mutated here — patching stays at the call site, driven by the
 * returned `byItemId` / `missingItemIds`.
 */
export async function fanOutAndWatch<TInput>(
  args: FanOutAndWatchArgs<TInput>,
): Promise<FanOutResult> {
  const {
    sessionId,
    runId,
    parentRunId,
    trackerDir,
    date,
    child,
    children,
    timeoutMs,
    rootTracePrefix,
    daemonFlags,
    buildPendingExtras,
    onPreparedItems,
    onProgress,
  } = args;
  const watchWorkflow = args.watchWorkflow ?? child.config.name;
  const shouldAbort = args.shouldAbort ?? (() => isOcrPrepareAbortRequested(sessionId, runId));
  const watch = args.watch ?? realWatchChildRuns;
  const expectedItemIds = children.map((c) => c.itemId);

  // ── Dispatch ──────────────────────────────────────────────
  if (args.dispatch) {
    await args.dispatch(children);
  } else {
    // Route through delegateToAllImpl so parentRunId stamping, canonical
    // archetype derivation, child pending pre-emit, and root-trace propagation
    // share one code path with every other delegation site. `renderAs:"flat"`
    // stamps each child `single` (parentRunId marks delegated scope; one vs many
    // children controls single vs batch grouping); `fireAndForget:true` because
    // the watch below drives the wait (a second wait inside delegateToAllImpl
    // would double-count).
    const { delegateToAllImpl } = await import("../../core/delegate.js");
    const itemIdByInput = new Map<TInput, string>(children.map((c) => [c.input, c.itemId]));
    const dispatchResults: ChildRunResult<TInput>[] = await delegateToAllImpl<TInput, readonly string[]>({
      parentRunId,
      trackerDir,
      child: child as RegisteredWorkflow<TInput, readonly string[]>,
      inputs: children.map((c) => c.input),
      renderAs: "flat",
      fireAndForget: true,
      ...(rootTracePrefix ? { rootTracePrefix } : {}),
      ...(daemonFlags ? { daemonFlags } : {}),
      ...(buildPendingExtras ? { buildPendingExtras } : {}),
      ...(onPreparedItems ? { onPreparedItems: (items) => onPreparedItems(items) } : {}),
      deriveItemId: (input: TInput) => itemIdByInput.get(input) ?? "",
    });
    args.onDispatched?.(dispatchResults.map((r) => ({ itemId: r.itemId, runId: r.runId })));
  }

  // ── Watch (with operator-cancel cascade) ──────────────────
  let outcomes: ChildOutcome[];
  try {
    outcomes = await watch({
      workflow: watchWorkflow,
      expectedItemIds,
      trackerDir,
      date,
      timeoutMs,
      shouldAbort,
      ...(onProgress ? { onProgress } : {}),
    });
  } catch (err) {
    if (isOperatorDiscardAbortError(err)) {
      // Cancel mid-fan-out: cascade-cancel the still-queued children so a daemon
      // doesn't run them after the operator gave up. Fail-loud — rethrow.
      cancelQueuedChildTasksForParentRun(openTaskStore(trackerDir), { parentRunId });
    }
    throw err;
  }

  const byItemId = new Map(outcomes.map((o) => [o.itemId, o]));
  const missingItemIds = expectedItemIds.filter((id) => !byItemId.has(id));
  return { outcomes, byItemId, missingItemIds };
}
