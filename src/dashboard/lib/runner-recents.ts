/**
 * Runner-recents — small localStorage adapter for the "recall last input"
 * feature in the runner drawer. We don't sync this with the backend; it's
 * a per-browser convenience.
 *
 * Mirror of the backend ARGV_MAP keys — the frontend uses `ARGV_NAMES` to
 * filter the workflow picker into "launchable" vs "CLI-only" without needing
 * to call the backend. If we add a workflow to backend ARGV_MAP, add it
 * here too. (The set is small enough that drift is obvious in code review.)
 */

export const ARGV_NAMES: ReadonlySet<string> = new Set([
  "onboarding",
  "separations",
  "work-study",
  "emergency-contact",
  "kronos-reports",
  "eid-lookup",
]);

export interface RecentEntry {
  ts: number;
  input: Record<string, unknown>;
  dryRun: boolean;
}

const KEY_PREFIX = "runner-recents:";
const MAX_PER_WORKFLOW = 5;

function safeParse(raw: string | null): RecentEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RecentEntry =>
        e && typeof e === "object" && typeof e.ts === "number" && e.input && typeof e.input === "object",
    );
  } catch {
    return [];
  }
}

/** Read the last `MAX_PER_WORKFLOW` recent entries for a workflow. */
export function recallRecent(workflow: string): RecentEntry[] {
  if (typeof window === "undefined") return [];
  return safeParse(window.localStorage.getItem(KEY_PREFIX + workflow));
}

/**
 * Push a new entry to the top of the list, capped at `MAX_PER_WORKFLOW`.
 * Duplicate inputs (same JSON-stringified value + dry flag) are deduped to
 * avoid the list filling with identical re-runs.
 */
export function rememberRecent(
  workflow: string,
  input: Record<string, unknown>,
  dryRun: boolean,
): void {
  if (typeof window === "undefined") return;
  const current = recallRecent(workflow);
  const fingerprint = JSON.stringify({ input, dryRun });
  const filtered = current.filter((e) => JSON.stringify({ input: e.input, dryRun: e.dryRun }) !== fingerprint);
  const next: RecentEntry[] = [{ ts: Date.now(), input, dryRun }, ...filtered].slice(0, MAX_PER_WORKFLOW);
  try {
    window.localStorage.setItem(KEY_PREFIX + workflow, JSON.stringify(next));
  } catch {
    /* localStorage full / disabled — best-effort */
  }
}

/** Wipe recents for one workflow (useful for tests, not exposed in UI yet). */
export function clearRecents(workflow: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(KEY_PREFIX + workflow);
}
