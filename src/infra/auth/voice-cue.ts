// Best-effort macOS voice cue for Duo MFA prompts.
//
// When a workflow waits on Duo, the operator may not be looking at the
// terminal — a spoken "Duo for <system>" via macOS `say` lets them hear the
// prompt from across the room. Opt-in via `HR_AUTOMATION_VOICE_CUES=1`;
// otherwise a no-op.
//
// Design constraints:
//   * MUST NOT throw. Any error in `say` is swallowed.
//   * MUST NOT block the caller meaningfully. We `exec` with a 2s timeout and
//     resolve immediately — we don't await `say`'s stdout.
//   * Per-systemId cooldown prevents back-to-back duplicate prompts (e.g. if
//     a workflow retries auth, we don't speak twice in 3 seconds).

import { exec } from "node:child_process";

/** Minimum ms between two cues for the same systemId. 30 s. */
const COOLDOWN_MS = 30_000;

/** Env var that turns voice cues on. Any other value (unset, "0", "false") disables. */
const ENV_FLAG = "HR_AUTOMATION_VOICE_CUES";

/**
 * Injected `exec` — exported factory so tests can mock the child-process
 * spawner without touching the real `say` binary. Default value wraps
 * node:child_process.exec into a simple fire-and-forget.
 */
export type ExecFn = (cmd: string) => void;

const defaultExec: ExecFn = (cmd) => {
  try {
    exec(cmd, { timeout: 2_000 }, () => {
      /* swallow stdout / errors — best-effort */
    });
  } catch {
    /* exec can throw synchronously if the command cannot be spawned */
  }
};

/**
 * Factory: create a `cueDuo` function with injectable dependencies. Exposed
 * for tests that need to observe behavior without invoking the real `say`.
 *
 * @param opts.execFn        child-process runner (default: node's `exec`)
 * @param opts.platform      platform string ("darwin" on macOS — default: process.platform)
 * @param opts.envFlagValue  value of the gating env var (default: process.env[ENV_FLAG])
 * @param opts.now           clock fn (default: Date.now) — used for cooldown
 */
export function createCueDuo(opts: {
  execFn?: ExecFn;
  platform?: NodeJS.Platform;
  envFlagValue?: string | undefined;
  now?: () => number;
} = {}): (systemId: string) => Promise<void> {
  const execFn = opts.execFn ?? defaultExec;
  const platform = opts.platform ?? process.platform;
  const envFlagValue = opts.envFlagValue ?? process.env[ENV_FLAG];
  const now = opts.now ?? Date.now;

  // Cooldown state is closure-scoped — each factory call is its own ledger.
  const lastCueAt = new Map<string, number>();

  return async function cueDuo(systemId: string): Promise<void> {
    try {
      if (platform !== "darwin") return;
      if (envFlagValue !== "1") return;

      const last = lastCueAt.get(systemId) ?? 0;
      if (now() - last < COOLDOWN_MS) return;
      lastCueAt.set(systemId, now());

      // Sanitize systemId for the shell — only allow alnum + dash/space to
      // stop any attempted shell-injection via unexpected workflow input.
      const safe = systemId.replace(/[^A-Za-z0-9 \-_]/g, "");
      execFn(`say "Duo for ${safe}"`);
    } catch {
      // Any error path → no-op. Voice cue failure must never fail a workflow.
    }
  };
}

/**
 * Default instance used by production code. The factory's internal
 * `envFlagValue` check is bypassed by passing `"1"` — the real gating
 * happens in `cueDuo` below where we read `process.env` live on each call.
 * The factory closure keeps the cooldown ledger + platform check.
 */
const defaultInstance = createCueDuo({ envFlagValue: "1" });

/**
 * Fire a "Duo for <systemId>" voice cue on macOS when
 * `HR_AUTOMATION_VOICE_CUES=1`. Silently no-ops on all other platforms or
 * when the env flag is unset. Per-systemId 30s cooldown prevents rapid
 * duplicates across retries. Never throws.
 */
export async function cueDuo(systemId: string): Promise<void> {
  // Re-check env on each call so changing it mid-run (tests / shell) takes
  // effect without needing a new module instantiation.
  if (process.env[ENV_FLAG] !== "1") return;
  return defaultInstance(systemId);
}
