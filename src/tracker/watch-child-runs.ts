/**
 * Watch a workflow's JSONL until N expected itemIds reach terminal status.
 *
 * Hoisted from the duplicated watchers in src/workflows/oath-signature/prepare.ts
 * and src/workflows/emergency-contact/prepare.ts (both deleted as part of the
 * OCR migration).
 *
 * Filters by explicit `expectedItemIds` (deterministic at spawn time), NOT by
 * `parentRunId` — parentRunId is purely for dashboard visualization.
 */
import { existsSync, readFileSync, statSync, watch as fsWatch } from "node:fs";
import { join } from "node:path";
import type { TrackerEntry } from "./jsonl.js";

export interface ChildOutcome {
  workflow: string;
  itemId: string;
  runId: string;
  status: "done" | "failed";
  data?: Record<string, string>;
  error?: string;
}

export interface WatchChildRunsOpts {
  /** Workflow name whose JSONL we watch. */
  workflow: string;
  /** Specific itemIds to wait for. Resolves when all reach terminal status. */
  expectedItemIds: string[];
  /** Tracker dir. Default: `.tracker`. */
  trackerDir?: string;
  /** YYYY-MM-DD; default today (local). */
  date?: string;
  /** Hard timeout in ms. Default 1h. Rejects with `Error("watchChildRuns timeout")`. */
  timeoutMs?: number;
  /** Custom terminal predicate. Default: status in {done, failed}. */
  isTerminal?: (entry: TrackerEntry) => boolean;
  /** Fired as each expected item terminates, with the remaining count. */
  onProgress?: (outcome: ChildOutcome, remaining: number) => void;
  /**
   * If set, the watcher polls the latest entry on `(workflow, id)` and
   * aborts the watch when that entry's `step` matches. Used for
   * dashboard-driven soft-cancel: an HTTP cancel handler writes a
   * sentinel running entry on the parent's own row, and the watcher
   * (running in the daemon process) sees it and rejects so the handler
   * can unwind.
   */
  abortIfRowState?: {
    workflow: string;
    id: string;
    step: string;
  };
}

const DEFAULT_TIMEOUT_MS = 60 * 60_000;

function dateLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function watchChildRuns(opts: WatchChildRunsOpts): Promise<ChildOutcome[]> {
  const dir = opts.trackerDir ?? ".tracker";
  const date = opts.date ?? dateLocal();
  const file = join(dir, `${opts.workflow}-${date}.jsonl`);
  const expected = new Set(opts.expectedItemIds);
  const totalExpected = expected.size;
  const isTerminal =
    opts.isTerminal ?? ((e: TrackerEntry) => e.status === "done" || e.status === "failed");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const outcomes: ChildOutcome[] = [];
  let lastSize = 0;

  return new Promise<ChildOutcome[]>((resolve, reject) => {
    let finalized = false;
    let watcher: ReturnType<typeof fsWatch> | undefined;
    let pollHandle: ReturnType<typeof setInterval> | undefined;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      finalized = true;
      try { watcher?.close(); } catch { /* ignore */ }
      if (pollHandle) clearInterval(pollHandle);
      if (timeoutHandle) clearTimeout(timeoutHandle);
    };

    const checkFile = (): void => {
      if (finalized) return;
      if (!existsSync(file)) return;
      let cur;
      try { cur = statSync(file); } catch { return; }
      if (cur.size <= lastSize) return;
      let raw;
      try { raw = readFileSync(file, "utf-8"); } catch { return; }
      const lines = raw.split("\n").filter(Boolean);
      for (const line of lines) {
        let entry: TrackerEntry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry.id || !expected.has(entry.id)) continue;
        if (!isTerminal(entry)) continue;
        const outcome: ChildOutcome = {
          workflow: entry.workflow,
          itemId: entry.id,
          runId: entry.runId ?? "",
          status: entry.status as "done" | "failed",
          data: entry.data,
          error: entry.error,
        };
        outcomes.push(outcome);
        expected.delete(entry.id);
        const remaining = totalExpected - outcomes.length;
        if (opts.onProgress) {
          try { opts.onProgress(outcome, remaining); } catch { /* swallow */ }
        }
      }
      lastSize = cur.size;
      if (expected.size === 0) {
        cleanup();
        resolve(outcomes);
      }
    };

    const checkAbort = (): void => {
      if (finalized) return;
      if (!opts.abortIfRowState) return;
      const abortFile = join(
        dir,
        `${opts.abortIfRowState.workflow}-${date}.jsonl`,
      );
      if (!existsSync(abortFile)) return;
      let raw;
      try { raw = readFileSync(abortFile, "utf-8"); } catch { return; }
      const lines = raw.split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        let entry: TrackerEntry;
        try { entry = JSON.parse(lines[i]); } catch { continue; }
        if (entry.id !== opts.abortIfRowState.id) continue;
        if (entry.step === opts.abortIfRowState.step) {
          cleanup();
          reject(new Error(
            `watchChildRuns aborted by parent row state (${opts.abortIfRowState.workflow}/${opts.abortIfRowState.id} step="${opts.abortIfRowState.step}")`,
          ));
        }
        return;
      }
    };

    // Initial pass — file may already have terminal entries.
    checkFile();
    if (finalized) return;
    checkAbort();          // NEW — abort immediately if sentinel already present
    if (finalized) return;

    // fs.watch on the file (best effort).
    try {
      if (existsSync(file)) {
        watcher = fsWatch(file, { persistent: false }, () => checkFile());
      }
    } catch {
      // fs.watch can throw on some FS (NFS, certain Linux configs). Polling
      // covers; not fatal.
    }

    // Poll fallback — also handles the "file doesn't exist yet" case.
    pollHandle = setInterval(() => {
      checkFile();
      checkAbort();        // NEW
      // Re-arm watcher once the file appears.
      if (!watcher && existsSync(file)) {
        try {
          watcher = fsWatch(file, { persistent: false }, () => checkFile());
        } catch { /* tolerate */ }
      }
    }, 200);
    pollHandle.unref?.();

    timeoutHandle = setTimeout(() => {
      if (finalized) return;
      cleanup();
      const stillWaiting = Array.from(expected).join(", ");
      reject(new Error(`watchChildRuns timeout (${timeoutMs}ms) — still waiting for: ${stillWaiting}`));
    }, timeoutMs);
    timeoutHandle.unref?.();
  });
}
