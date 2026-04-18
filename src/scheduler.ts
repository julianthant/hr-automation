/**
 * Minimal cron-like scheduler for HR automation workflows.
 *
 * Reads a `schedule.yaml` file describing recurring runs and fires
 * `npm run <workflow> -- <args...>` on the declared cadence. No external cron
 * dependency — a tiny spec parser + `setTimeout` drives the loop.
 *
 * **Supported schedule formats** (deliberately small — document the subset):
 *
 *   daily HH:MM              Every day at HH:MM local time
 *   weekly <dow> HH:MM       Every <dow> at HH:MM, where <dow> is a comma-
 *                            separated list of day abbreviations
 *                            (mon,tue,wed,thu,fri,sat,sun)
 *   interval <N><unit>       Every N minutes or hours (unit: m or h)
 *
 * Times are local (system clock, not UTC). Rejecting anything outside the
 * subset with a clear error beats pretending to support richer cron.
 */

import { readFileSync, existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { z } from "zod/v4";

// ── Schedule spec parser ───────────────────────────────────

const DOW_MAP: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export interface ParsedSchedule {
  /** Original spec string (for logging). */
  readonly spec: string;
  /** Return the next wall-clock time this schedule should fire, strictly AFTER `now`. */
  nextRunAfter(now: Date): Date;
}

function parseHHMM(s: string): { hh: number; mm: number } {
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`Expected HH:MM, got '${s}'`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23) throw new Error(`Hours out of range in '${s}' (0-23)`);
  if (mm < 0 || mm > 59) throw new Error(`Minutes out of range in '${s}' (0-59)`);
  return { hh, mm };
}

function parseDowList(s: string): number[] {
  const parts = s.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`Expected at least one day-of-week, got '${s}'`);
  }
  const out: number[] = [];
  for (const p of parts) {
    if (!(p in DOW_MAP)) {
      throw new Error(
        `Unknown day-of-week '${p}' (expected one of: mon,tue,wed,thu,fri,sat,sun)`
      );
    }
    out.push(DOW_MAP[p]!);
  }
  return [...new Set(out)].sort();
}

/**
 * Parse a schedule spec string into an object that can compute its next firing.
 *
 * @throws Error with a human-readable message if the spec is malformed.
 */
export function parseSchedule(spec: string): ParsedSchedule {
  const raw = spec.trim();
  if (!raw) throw new Error("Schedule spec is empty");
  const [kind, ...rest] = raw.split(/\s+/);

  if (kind === "daily") {
    if (rest.length !== 1) {
      throw new Error(`'daily' expects 1 argument (HH:MM), got: '${spec}'`);
    }
    const { hh, mm } = parseHHMM(rest[0]!);
    return {
      spec: raw,
      nextRunAfter(now: Date): Date {
        const next = new Date(now);
        next.setHours(hh, mm, 0, 0);
        if (next.getTime() <= now.getTime()) {
          // Already past today's firing → tomorrow.
          next.setDate(next.getDate() + 1);
        }
        return next;
      },
    };
  }

  if (kind === "weekly") {
    if (rest.length !== 2) {
      throw new Error(
        `'weekly' expects 2 arguments (<dow[,dow]> HH:MM), got: '${spec}'`
      );
    }
    const dows = parseDowList(rest[0]!);
    const { hh, mm } = parseHHMM(rest[1]!);
    return {
      spec: raw,
      nextRunAfter(now: Date): Date {
        // Try today, tomorrow, ... up to 7 days out. The loop must terminate
        // within 7 iterations because dows is non-empty.
        for (let delta = 0; delta <= 7; delta++) {
          const candidate = new Date(now);
          candidate.setDate(candidate.getDate() + delta);
          candidate.setHours(hh, mm, 0, 0);
          if (candidate.getTime() <= now.getTime()) continue;
          if (dows.includes(candidate.getDay())) return candidate;
        }
        // Unreachable — defensive fallback so the type is Date not Date | undefined.
        throw new Error(`weekly schedule '${spec}' failed to compute next run`);
      },
    };
  }

  if (kind === "interval") {
    if (rest.length !== 1) {
      throw new Error(
        `'interval' expects 1 argument (<N>m or <N>h), got: '${spec}'`
      );
    }
    const m = rest[0]!.match(/^(\d+)(m|h)$/);
    if (!m) {
      throw new Error(
        `'interval' value '${rest[0]}' must look like '30m' or '2h'`
      );
    }
    const n = Number(m[1]);
    if (n <= 0) throw new Error(`interval N must be positive, got: '${rest[0]}'`);
    const unit = m[2] as "m" | "h";
    const stepMs = unit === "m" ? n * 60_000 : n * 3_600_000;
    return {
      spec: raw,
      nextRunAfter(now: Date): Date {
        return new Date(now.getTime() + stepMs);
      },
    };
  }

  throw new Error(
    `Unknown schedule kind '${kind}' in '${spec}' ` +
      `(supported: daily HH:MM | weekly <dow[,dow]> HH:MM | interval <N>m or <N>h)`
  );
}

// ── Config schema ──────────────────────────────────────────

export const ScheduleEntrySchema = z.object({
  name: z.string().min(1),
  workflow: z.string().min(1),
  args: z.array(z.string()).default([]),
  schedule: z.string().min(1),
  enabled: z.boolean().default(true),
});
export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;

export const ScheduleConfigSchema = z.array(ScheduleEntrySchema).min(1);
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>;

/**
 * Load + validate a schedule YAML file. Throws on missing file or bad schema.
 */
export function loadScheduleConfig(configPath: string): ScheduleConfig {
  if (!existsSync(configPath)) {
    throw new Error(`Schedule config not found: ${configPath}`);
  }
  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw);
  const result = ScheduleConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("\n  ");
    throw new Error(`Schedule config is invalid:\n  ${issues}`);
  }
  return result.data;
}

// ── Runner ─────────────────────────────────────────────────

/** One fully-prepared schedule entry, with its parser attached. */
interface PreparedEntry {
  entry: ScheduleEntry;
  parsed: ParsedSchedule;
  /** Computed lazily on each tick. */
  nextRun: Date;
}

export interface RunSchedulerOpts {
  /** Override the npm binary path. Defaults to "npm". */
  npmBin?: string;
  /** Current working directory for the spawned npm process. Defaults to process.cwd(). */
  cwd?: string;
  /** Testability hook: returns current time. Defaults to `() => new Date()`. */
  now?: () => Date;
  /**
   * Testability hook: sleeps until the given wall time. Defaults to a
   * `setTimeout`-based sleeper. Tests can short-circuit to jump time forward.
   * Must resolve if `abortSignal` fires.
   */
  sleepUntil?: (target: Date, abortSignal: AbortSignal) => Promise<void>;
  /**
   * Maximum firings before the scheduler exits. Defaults to Infinity. Tests
   * can set this to 1 or 2 to avoid running forever.
   */
  maxFirings?: number;
}

/** Default setTimeout-based sleeper. Resolves early on abort. */
function defaultSleepUntil(target: Date, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const ms = Math.max(0, target.getTime() - Date.now());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/**
 * Run the scheduler loop: prepare every enabled entry, sleep until the soonest
 * next-run, spawn `npm run <workflow> -- <args...>`, log the result, repeat.
 *
 * Installs SIGINT / SIGTERM handlers that (a) flip an internal abort flag to
 * short-circuit any in-progress sleep, and (b) kill any in-flight child
 * process. The function then resolves cleanly.
 */
export async function runScheduler(
  configPath: string,
  opts: RunSchedulerOpts = {}
): Promise<void> {
  const config = loadScheduleConfig(configPath);
  const now = opts.now ?? (() => new Date());
  const sleepUntil = opts.sleepUntil ?? defaultSleepUntil;
  const maxFirings = opts.maxFirings ?? Number.POSITIVE_INFINITY;
  const npmBin = opts.npmBin ?? "npm";
  const cwd = opts.cwd ?? process.cwd();

  // Parse every entry up front so bad specs abort before the loop starts.
  const prepared: PreparedEntry[] = [];
  for (const entry of config) {
    if (!entry.enabled) {
      console.log(`[scheduler] skipping disabled entry: ${entry.name}`);
      continue;
    }
    try {
      const parsed = parseSchedule(entry.schedule);
      prepared.push({ entry, parsed, nextRun: parsed.nextRunAfter(now()) });
    } catch (err) {
      throw new Error(
        `Entry '${entry.name}' has invalid schedule: ${(err as Error).message}`
      );
    }
  }

  if (prepared.length === 0) {
    console.log("[scheduler] no enabled entries — exiting");
    return;
  }

  console.log(
    `[scheduler] loaded ${prepared.length} entries:\n` +
      prepared
        .map(
          (p) =>
            `  - ${p.entry.name} (${p.entry.workflow}): next run ${p.nextRun.toISOString()}`
        )
        .join("\n")
  );

  const aborter = new AbortController();
  let inFlight: ChildProcess | null = null;
  const onSignal = (sig: string) => {
    console.log(`[scheduler] received ${sig}, shutting down`);
    aborter.abort();
    if (inFlight && !inFlight.killed) {
      try {
        inFlight.kill("SIGTERM");
      } catch {
        /* best-effort */
      }
    }
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  let firings = 0;
  try {
    while (!aborter.signal.aborted && firings < maxFirings) {
      // Soonest next-run wins.
      prepared.sort((a, b) => a.nextRun.getTime() - b.nextRun.getTime());
      const target = prepared[0]!;

      console.log(
        `[scheduler] sleeping until ${target.nextRun.toISOString()} (${target.entry.name})`
      );
      await sleepUntil(target.nextRun, aborter.signal);
      if (aborter.signal.aborted) break;

      firings++;
      console.log(
        `[scheduler] firing '${target.entry.name}' → npm run ${target.entry.workflow} ${target.entry.args.join(" ")}`
      );

      // Build `npm run <workflow> [-- <args...>]`. npm's `--` separator lets
      // args reach the underlying script instead of being swallowed by npm.
      const npmArgs = ["run", target.entry.workflow];
      if (target.entry.args.length > 0) {
        npmArgs.push("--", ...target.entry.args);
      }

      const exitCode = await new Promise<number>((resolve) => {
        const child = spawn(npmBin, npmArgs, {
          cwd,
          stdio: "inherit",
          shell: process.platform === "win32",
        });
        inFlight = child;
        child.on("exit", (code) => {
          inFlight = null;
          resolve(code ?? 0);
        });
        child.on("error", (err) => {
          inFlight = null;
          console.error(
            `[scheduler] spawn failed for '${target.entry.name}': ${err.message}`
          );
          resolve(1);
        });
      });

      console.log(
        `[scheduler] '${target.entry.name}' finished with exit ${exitCode}`
      );

      // Compute this entry's next firing from NOW, not from its previous scheduled
      // time — if the run took longer than the interval we don't want a stampede
      // of backlogged firings.
      target.nextRun = target.parsed.nextRunAfter(now());
    }
  } finally {
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
  }
}
