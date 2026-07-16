/**
 * Leaf logging sink for the tracker persistence layer (ZERO imports).
 *
 * The tracker persistence modules (`jsonl-core.ts`, `jsonl-io.ts`,
 * `session-events.ts`, `state/*`, `find-latest-entry.ts`, `settings/store.ts`)
 * must not import `utils/log.ts` — `log.ts` itself persists through them
 * (`appendLogEntry` / `emitDaemonLog`), so a direct import is a runtime module
 * cycle (guarded by `tests/unit/architecture/import-cycles.test.ts`). They
 * report through this settable sink instead.
 *
 * Default is SILENT, not `console.warn`: console.warn writes to stderr, and
 * the vitest stderr audit (`tests/log-audit-core.ts`) fails any un-allowlisted
 * stderr line — tests that import tracker modules without the logger would
 * spuriously fail. In every production process `utils/log.ts` is loaded (all
 * entrypoints log) and wires the sink to `log.warn` / `log.error` at module
 * load, so warnings surface exactly as they did when these modules called
 * `log.*` directly.
 */

export interface TrackerLogSink {
  warn: (message: string) => void;
  error: (message: string) => void;
}

let sink: TrackerLogSink = {
  warn: () => {},
  error: () => {},
};
let delivering = false;

/** Wire the sink (production: `utils/log.ts` at module load). */
export function setTrackerLogSink(next: TrackerLogSink): void {
  sink = next;
}

/** The tracker persistence layer's `log.warn`. Silent until wired. */
export function trackerWarn(message: string): void {
  deliver("warn", message);
}

/** The tracker persistence layer's `log.error`. Silent until wired. */
export function trackerError(message: string): void {
  deliver("error", message);
}

function deliver(level: keyof TrackerLogSink, message: string): void {
  if (delivering) {
    throw new Error(`Reentrant tracker log delivery (${level}): ${message}`);
  }
  delivering = true;
  try {
    sink[level](message);
  } finally {
    delivering = false;
  }
}

/** Test-only: restore the silent default and clear delivery state. */
export function resetTrackerLogSinkForTests(): void {
  sink = { warn: () => {}, error: () => {} };
  delivering = false;
}
