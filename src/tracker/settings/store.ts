import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { log } from "../../utils/log.js";
import {
  mergeOperatorSettings,
  type OperatorSettings,
  type OperatorSettingsOverride,
} from "../../domain/settings/types.js";
import { operatorSettingsFile } from "../paths.js";
import { OperatorSettingsOverrideSchema } from "./schema.js";

/**
 * Operator-settings store — the read/write/apply layer over the single
 * `config/settings.json` override file. Mirrors the workflow-presentation
 * override store: **fail-soft on READ** (a bad file can't crash the dashboard or
 * a daemon — it falls back to defaults with a warning) and **fail-loud on WRITE**
 * (Zod-validated; the POST route maps the throw to a 400).
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
 * Read the raw (sparse) override from disk, or `null` if absent/invalid.
 * Fail-soft: an unparseable or schema-invalid file logs a warning and is ignored
 * so the system falls back to defaults rather than breaking.
 */
export function readOperatorSettingsOverride(
  repoRoot: string = defaultRepoRoot(),
): OperatorSettingsOverride | null {
  const file = operatorSettingsFile(repoRoot);
  if (!existsSync(file)) return null;
  try {
    const parsed = OperatorSettingsOverrideSchema.safeParse(
      JSON.parse(readFileSync(file, "utf8")),
    );
    if (!parsed.success) {
      const summary = parsed.error.issues.map((i) => i.message).join("; ");
      log.warn(`operator settings invalid; ignoring (${summary})`);
      return null;
    }
    return parsed.data;
  } catch (err) {
    log.warn(`operator settings unreadable; ignoring (${String(err)})`);
    return null;
  }
}

/** Validate (fail loud) + persist the override, pretty-printed for git/diff. Returns the validated (trimmed) override. */
export function writeOperatorSettings(
  repoRoot: string,
  override: OperatorSettingsOverride,
): OperatorSettingsOverride {
  const validated = OperatorSettingsOverrideSchema.parse(override);
  mkdirSync(join(repoRoot, "config"), { recursive: true });
  writeFileSync(
    operatorSettingsFile(repoRoot),
    JSON.stringify(validated, null, 2) + "\n",
    "utf8",
  );
  invalidateOperatorSettingsCache();
  return validated;
}

/** Remove the override file (revert to all defaults). Returns whether it existed. */
export function deleteOperatorSettings(repoRoot: string): boolean {
  const file = operatorSettingsFile(repoRoot);
  if (!existsSync(file)) return false;
  rmSync(file);
  invalidateOperatorSettingsCache();
  return true;
}

// ── Process-cached merge for config.ts ──────────────────────────────────────

let cachedOverride: OperatorSettingsOverride | null | undefined;
let cacheLoaded = false;

function overrideCached(): OperatorSettingsOverride | null {
  if (!cacheLoaded) {
    cachedOverride = readOperatorSettingsOverride();
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
