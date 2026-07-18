import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// NOTE: no `utils/log.js` import — this module loads at `src/config.ts` module
// init (before the logger can), and the logger itself persists through the
// tracker layer. Warnings route through the settable tracker log sink
// (silent until `utils/log.ts` wires it; see `../log-sink.ts`).
import { trackerWarn } from "../log-sink.js";
import {
  mergeOperatorSettings,
  type OperatorSettings,
  type OperatorSettingsOverride,
} from "../../domain/settings/types.js";
import { writeFileAtomic, unlinkFileDurable } from "../fs-atomic.js";
import { operatorSettingsBackupFile, operatorSettingsFile } from "../paths.js";
import { OperatorSettingsOverrideSchema } from "./schema.js";

/**
 * Operator-settings store — the read/write/apply layer over the single
 * `config/settings.json` override file. Mirrors the workflow-presentation
 * override store. A missing file means defaults. An existing invalid file is a
 * first-class configuration fault: dashboard reads can surface it, while launch
 * and workflow-mutation boundaries block until the operator explicitly resets
 * the file or restores the last valid backup. A corrupt file is never treated
 * as equivalent to a missing file.
 *
 * Two consumers:
 *   - the dashboard `/api/settings` route → `readOperatorSettingsOverride` /
 *     `writeOperatorSettings` / `deleteOperatorSettings` (repoRoot from deps);
 *   - `src/config.ts` at module load → `loadMergedOperatorSettings` +
 *     `applyOperatorSettingsToEnv` (repoRoot resolved from this module's path so
 *     it's correct regardless of `process.cwd()`), cached so the file is read at
 *     most once per process.
 */

/** Repo root resolved from this module's location (`src/tracker/settings/store.ts`). */
function defaultRepoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/**
 * The active file's complete state. Error text is deliberately limited to a
 * parser/schema summary; settings contents (which may contain operator-entered
 * URLs or paths) are never included.
 */
export type OperatorSettingsFileState =
  | { state: "missing" }
  | { state: "valid"; override: OperatorSettingsOverride }
  | { state: "fault"; error: string; backupAvailable: boolean };

export class OperatorSettingsFaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorSettingsFaultError";
  }
}

function parseSettingsFile(file: string):
  | { ok: true; override: OperatorSettingsOverride }
  | { ok: false; error: string } {
  try {
    const parsed = OperatorSettingsOverrideSchema.safeParse(
      JSON.parse(readFileSync(file, "utf8")),
    );
    if (!parsed.success) {
      const summary = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "settings"}: ${issue.message}`)
        .join("; ");
      return { ok: false, error: `Operator settings failed validation (${summary})` };
    }
    return { ok: true, override: parsed.data };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Operator settings could not be read (${detail})` };
  }
}

function validBackup(repoRoot: string): OperatorSettingsOverride | null {
  const file = operatorSettingsBackupFile(repoRoot);
  if (!existsSync(file)) return null;
  const parsed = parseSettingsFile(file);
  return parsed.ok ? parsed.override : null;
}

export function readOperatorSettingsFileState(
  repoRoot: string = defaultRepoRoot(),
): OperatorSettingsFileState {
  const file = operatorSettingsFile(repoRoot);
  if (!existsSync(file)) return { state: "missing" };
  const parsed = parseSettingsFile(file);
  if (parsed.ok) return { state: "valid", override: parsed.override };
  return {
    state: "fault",
    error: parsed.error,
    backupAvailable: validBackup(repoRoot) !== null,
  };
}

/** Read the sparse override. Missing is `null`; an existing corrupt file throws. */
export function readOperatorSettingsOverride(
  repoRoot: string = defaultRepoRoot(),
): OperatorSettingsOverride | null {
  const state = readOperatorSettingsFileState(repoRoot);
  if (state.state === "missing") return null;
  if (state.state === "valid") return state.override;
  throw new OperatorSettingsFaultError(`Configuration fault: ${state.error}`);
}

/** Validate (fail loud) + persist the override, pretty-printed for git/diff. Returns the validated (trimmed) override. */
export function writeOperatorSettings(
  repoRoot: string,
  override: OperatorSettingsOverride,
): OperatorSettingsOverride {
  const validated = OperatorSettingsOverrideSchema.parse(override);
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  const current = readOperatorSettingsFileState(repoRoot);
  if (current.state === "valid") {
    writeFileAtomic(
      operatorSettingsBackupFile(repoRoot),
      `${JSON.stringify(current.override, null, 2)}\n`,
    );
  }
  writeFileAtomic(
    operatorSettingsFile(repoRoot),
    `${JSON.stringify(validated, null, 2)}\n`,
  );
  invalidateOperatorSettingsCache();
  return validated;
}

/** Restore a schema-valid backup. Recovery is always explicit; never automatic. */
export function recoverOperatorSettingsBackup(
  repoRoot: string,
): OperatorSettingsOverride {
  const backup = validBackup(repoRoot);
  if (!backup) {
    throw new OperatorSettingsFaultError("No valid operator settings backup is available");
  }
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  writeFileAtomic(
    operatorSettingsFile(repoRoot),
    `${JSON.stringify(backup, null, 2)}\n`,
  );
  invalidateOperatorSettingsCache();
  return backup;
}

/** Remove the override file (revert to all defaults). Returns whether it existed. */
export function deleteOperatorSettings(repoRoot: string): boolean {
  const file = operatorSettingsFile(repoRoot);
  if (!existsSync(file)) return false;
  unlinkFileDurable(file);
  invalidateOperatorSettingsCache();
  return true;
}

// ── Process-cached merge for config.ts ──────────────────────────────────────

let cachedOverride: OperatorSettingsOverride | null | undefined;
let cacheLoaded = false;

function overrideCached(): OperatorSettingsOverride | null {
  if (!cacheLoaded) {
    const state = readOperatorSettingsFileState();
    if (state.state === "fault") {
      // Config modules must remain importable so the dashboard can render the
      // repair surface. Mutation and daemon boundaries independently reject
      // work while this fault exists; these defaults are control-plane-only.
      trackerWarn(`operator settings configuration fault (${state.error})`);
      cachedOverride = null;
    } else {
      cachedOverride = state.state === "valid" ? state.override : null;
    }
    cacheLoaded = true;
  }
  return cachedOverride ?? null;
}

/** Test/refresh seam — drops the cached override so the next read re-hits disk. */
export function invalidateOperatorSettingsCache(): void {
  cacheLoaded = false;
  cachedOverride = undefined;
}

/**
 * Fully-populated operator settings (defaults + on-disk override), cached for
 * the process. Used by `src/config.ts` for the constants it owns directly
 * (SCREEN / TIMEOUTS / PATHS / ANNUAL_DATES / timekeeper), with explicit env
 * vars still taking precedence at the config.ts read site.
 */
export function loadMergedOperatorSettings(): OperatorSettings {
  return mergeOperatorSettings(overrideCached());
}

/**
 * Pure env-population core (exported for unit tests): for each override field the
 * operator explicitly set, write the matching env var into `env` — but ONLY when
 * it is currently UNSET (so a real `.env` value always wins) and never for a
 * field the operator left unset (so the consuming module's own default —
 * including dynamic ones like OCR page concurrency = vision-pool size — is
 * untouched). Takes the env object so a test can pass a fresh `{}`.
 */
export function applyOperatorSettingsEnv(
  override: OperatorSettingsOverride,
  env: NodeJS.ProcessEnv,
): void {
  const setIfUnset = (key: string, value: string | undefined): void => {
    if (value !== undefined && env[key] === undefined) {
      env[key] = value;
    }
  };
  const numStr = (n: number | undefined): string | undefined =>
    n === undefined ? undefined : String(n);
  const boolStr = (b: boolean | undefined): string | undefined =>
    b === undefined ? undefined : b ? "1" : "0";

  const ocr = override.ocr;
  if (ocr) {
    setIfUnset("OCR_SECOND_OPINION_MAX", numStr(ocr.secondOpinionMax));
    setIfUnset("OCR_PAGE_MAX_WAIT_MS", numStr(ocr.pageMaxWaitMs));
    setIfUnset("OCR_TIER1_PATIENCE_MS", numStr(ocr.tier1PatienceMs));
    // 0 = Auto → leave OCR_PAGE_CONCURRENCY unset so the pool-size default holds.
    if (ocr.pageConcurrency !== undefined && ocr.pageConcurrency > 0) {
      setIfUnset("OCR_PAGE_CONCURRENCY", numStr(ocr.pageConcurrency));
    }
    setIfUnset("OCR_DISAMBIG_CONCURRENCY", numStr(ocr.disambigConcurrency));
    setIfUnset("OCR_SUGGEST_CONCURRENCY", numStr(ocr.suggestConcurrency));
    setIfUnset("OCR_BACKOFF_BASE_MS", numStr(ocr.backoffBaseMs));
    setIfUnset("OCR_BACKOFF_CAP_MS", numStr(ocr.backoffCapMs));
    setIfUnset("OCR_MAX_VALIDATION_RETRIES", numStr(ocr.maxValidationRetries));
  }

  const perf = override.performance;
  if (perf) {
    setIfUnset("HRAUTO_NAVIGATION_RETRIES", numStr(perf.navigationRetries));
    setIfUnset(
      "HRAUTO_SEPARATION_TERMINATION_WINDOW_DAYS",
      numStr(perf.separationTerminationWindowDays),
    );
  }

  const capture = override.capture;
  if (capture) {
    setIfUnset("HRAUTO_CAPTURE_WIDTH", numStr(capture.width));
    setIfUnset("HRAUTO_CAPTURE_MAX_WIDTH", numStr(capture.maxWidth));
    setIfUnset("HRAUTO_CAPTURE_SLICE_HEIGHT", numStr(capture.sliceHeight));
    setIfUnset("HRAUTO_CAPTURE_SLICE_OVERLAP", numStr(capture.sliceOverlap));
    setIfUnset("HRAUTO_CAPTURE_MAX_SLICES", numStr(capture.maxSlices));
  }

  const browserHealth = override.browserHealth;
  if (browserHealth) {
    setIfUnset("HRAUTO_HEALTH_MONITOR_TICK_MS", numStr(browserHealth.monitorTickMs));
    setIfUnset("HRAUTO_HEALTH_MONITOR_MAX_REFRESH", numStr(browserHealth.maxAutoRefresh));
    setIfUnset("HRAUTO_HEALTH_MONITOR_MAX_REOPEN", numStr(browserHealth.maxReopen));
  }

  const concurrency = override.concurrency;
  if (concurrency) {
    setIfUnset("HRAUTO_DEFAULT_WORKERS", numStr(concurrency.defaultWorkers));
  }

  const daemon = override.daemon;
  if (daemon) {
    setIfUnset("HRAUTO_DAEMON_IDLE_MS", numStr(daemon.idleMs));
    setIfUnset("HRAUTO_DAEMON_IDLE_REPOLL_MS", numStr(daemon.idleRepollMs));
  }

  const features = override.features;
  if (features) {
    setIfUnset("DEBUG_SCREENSHOTS", boolStr(features.debugScreenshots));
    setIfUnset("HR_AUTOMATION_DUO_WEBAUTHN", boolStr(features.duoWebAuthn));
  }
}

/**
 * Populate `process.env` from the cached on-disk override (the cross-module,
 * env-backed knobs). Idempotent; safe to call at the top of `src/config.ts`
 * before anything reads these vars.
 */
export function applyOperatorSettingsToEnv(): void {
  const ov = overrideCached();
  if (!ov) return;
  applyOperatorSettingsEnv(ov, process.env);
}
