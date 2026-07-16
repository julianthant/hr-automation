/**
 * Unit tests for the operator-settings store: the read/write/delete round-trip
 * (fail-soft on a bad file, fail-loud on an invalid write) and the env-population
 * core. The env contract is the load-bearing one: only operator-set fields are
 * populated, never over an already-set env var (explicit `.env` wins), and
 * OCR page concurrency `0` (Auto) is left unset so the dynamic pool-size default
 * survives.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  operatorSettingsBackupFile,
  operatorSettingsFile,
} from "../../../../src/tracker/paths.js";
import {
  applyOperatorSettingsEnv,
  deleteOperatorSettings,
  readOperatorSettingsOverride,
  readOperatorSettingsFileState,
  recoverOperatorSettingsBackup,
  writeOperatorSettings,
} from "../../../../src/tracker/settings/store.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "settings-store-"));
  mkdirSync(path.join(root, "config"), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("read/write/delete round-trip", () => {
  it("returns null when no file exists", () => {
    expect(readOperatorSettingsOverride(root)).toBe(null);
    expect(readOperatorSettingsFileState(root)).toEqual({ state: "missing" });
  });

  it("persists a validated sparse override and reads it back", () => {
    writeOperatorSettings(root, { display: { screenWidth: 3840 }, features: { debugScreenshots: true } });
    expect(existsSync(operatorSettingsFile(root))).toBe(true);
    expect(readOperatorSettingsOverride(root)).toEqual({
      display: { screenWidth: 3840 },
      features: { debugScreenshots: true },
    });
  });

  it("delete removes the file and reports whether it existed", () => {
    writeOperatorSettings(root, { features: { duoWebAuthn: false } });
    expect(deleteOperatorSettings(root)).toBe(true);
    expect(existsSync(operatorSettingsFile(root))).toBe(false);
    expect(deleteOperatorSettings(root)).toBe(false);
  });

  it("reports an unparseable existing file as a configuration fault", () => {
    writeFileSync(operatorSettingsFile(root), "{ not json", "utf8");
    expect(readOperatorSettingsFileState(root)).toMatchObject({
      state: "fault",
      backupAvailable: false,
    });
    expect(() => readOperatorSettingsOverride(root)).toThrow(/configuration fault/i);
  });

  it("reports a schema-invalid existing file as a configuration fault", () => {
    writeFileSync(operatorSettingsFile(root), JSON.stringify({ display: { screenWidth: -5 } }), "utf8");
    expect(readOperatorSettingsFileState(root)).toMatchObject({
      state: "fault",
      backupAvailable: false,
    });
    expect(() => readOperatorSettingsOverride(root)).toThrow(/configuration fault/i);
  });

  it("keeps the last valid settings as an explicit recovery backup", () => {
    writeOperatorSettings(root, { display: { screenWidth: 3200 } });
    writeOperatorSettings(root, { display: { screenWidth: 3840 } });

    expect(JSON.parse(readFileSync(operatorSettingsBackupFile(root), "utf8"))).toEqual({
      display: { screenWidth: 3200 },
    });

    writeFileSync(operatorSettingsFile(root), "{ broken", "utf8");
    expect(readOperatorSettingsFileState(root)).toMatchObject({
      state: "fault",
      backupAvailable: true,
    });
    expect(recoverOperatorSettingsBackup(root)).toEqual({ display: { screenWidth: 3200 } });
    expect(readOperatorSettingsFileState(root)).toEqual({
      state: "valid",
      override: { display: { screenWidth: 3200 } },
    });
  });

  it("never advertises or restores a corrupt recovery backup", () => {
    writeFileSync(operatorSettingsFile(root), "{ broken", "utf8");
    writeFileSync(operatorSettingsBackupFile(root), "{ also broken", "utf8");
    expect(readOperatorSettingsFileState(root)).toMatchObject({
      state: "fault",
      backupAvailable: false,
    });
    expect(() => recoverOperatorSettingsBackup(root)).toThrow(/backup/i);
  });

  it("reset removes only the active file and preserves the recovery backup", () => {
    writeOperatorSettings(root, { display: { screenWidth: 3200 } });
    writeOperatorSettings(root, { display: { screenWidth: 3840 } });
    expect(deleteOperatorSettings(root)).toBe(true);
    expect(existsSync(operatorSettingsFile(root))).toBe(false);
    expect(existsSync(operatorSettingsBackupFile(root))).toBe(true);
  });

  it("fail-loud WRITE: an out-of-range value throws", () => {
    expect(() => writeOperatorSettings(root, { display: { screenWidth: 10 } })).toThrow();
  });

  it("fail-loud WRITE: an unknown key is rejected (strict schema)", () => {
    // @ts-expect-error — exercising the strict-object rejection at runtime
    expect(() => writeOperatorSettings(root, { display: { bogus: 1 } })).toThrow();
  });
});

describe("applyOperatorSettingsEnv", () => {
  it("populates env vars only for operator-set fields", () => {
    const env: NodeJS.ProcessEnv = {};
    applyOperatorSettingsEnv(
      { performance: { navigationRetries: 5 }, features: { debugScreenshots: true } },
      env,
    );
    expect(env.HRAUTO_NAVIGATION_RETRIES).toBe("5");
    expect(env.DEBUG_SCREENSHOTS).toBe("1");
    // Unset fields are never written, so the consuming default survives.
    expect("OCR_SECOND_OPINION_MAX" in env).toBe(false);
    expect("HRAUTO_SEPARATION_TERMINATION_WINDOW_DAYS" in env).toBe(false);
  });

  it("never overrides an already-set env var (explicit .env wins)", () => {
    const env: NodeJS.ProcessEnv = { OCR_SECOND_OPINION_MAX: "9" };
    applyOperatorSettingsEnv({ ocr: { secondOpinionMax: 2 } }, env);
    expect(env.OCR_SECOND_OPINION_MAX).toBe("9");
  });

  it("OCR page concurrency 0 (Auto) leaves OCR_PAGE_CONCURRENCY unset", () => {
    const env: NodeJS.ProcessEnv = {};
    applyOperatorSettingsEnv({ ocr: { pageConcurrency: 0 } }, env);
    expect("OCR_PAGE_CONCURRENCY" in env).toBe(false);

    const env2: NodeJS.ProcessEnv = {};
    applyOperatorSettingsEnv({ ocr: { pageConcurrency: 6 } }, env2);
    expect(env2.OCR_PAGE_CONCURRENCY).toBe("6");
  });

  it("booleans map to 1/0", () => {
    const env: NodeJS.ProcessEnv = {};
    applyOperatorSettingsEnv({ features: { duoWebAuthn: false } }, env);
    expect(env.HR_AUTOMATION_DUO_WEBAUTHN).toBe("0");
  });

  it("populates the capture / browser-health / daemon / concurrency / ocr-backoff knobs", () => {
    const env: NodeJS.ProcessEnv = {};
    applyOperatorSettingsEnv(
      {
        capture: { width: 1600, sliceHeight: 1000, maxSlices: 40 },
        browserHealth: { monitorTickMs: 45_000, maxAutoRefresh: 5, maxReopen: 2 },
        daemon: { idleMs: 600_000, idleRepollMs: 15_000 },
        concurrency: { defaultWorkers: 6 },
        ocr: { backoffBaseMs: 1_000, backoffCapMs: 30_000, maxValidationRetries: 3 },
      },
      env,
    );
    expect(env.HRAUTO_CAPTURE_WIDTH).toBe("1600");
    expect(env.HRAUTO_CAPTURE_SLICE_HEIGHT).toBe("1000");
    expect(env.HRAUTO_CAPTURE_MAX_SLICES).toBe("40");
    expect(env.HRAUTO_HEALTH_MONITOR_TICK_MS).toBe("45000");
    expect(env.HRAUTO_HEALTH_MONITOR_MAX_REFRESH).toBe("5");
    expect(env.HRAUTO_HEALTH_MONITOR_MAX_REOPEN).toBe("2");
    expect(env.HRAUTO_DAEMON_IDLE_MS).toBe("600000");
    expect(env.HRAUTO_DAEMON_IDLE_REPOLL_MS).toBe("15000");
    expect(env.HRAUTO_DEFAULT_WORKERS).toBe("6");
    expect(env.OCR_BACKOFF_BASE_MS).toBe("1000");
    expect(env.OCR_BACKOFF_CAP_MS).toBe("30000");
    expect(env.OCR_MAX_VALIDATION_RETRIES).toBe("3");
    // A field the operator left unset is never written.
    expect("HRAUTO_CAPTURE_MAX_WIDTH" in env).toBe(false);
  });

  it("persists the new editable sections (urls / capture / daemon) round-trip", () => {
    writeOperatorSettings(root, {
      urls: { i9: "https://stse-test.i9complete.com" },
      capture: { width: 1440 },
      daemon: { idleRepollMs: 20_000 },
    });
    expect(readOperatorSettingsOverride(root)).toEqual({
      urls: { i9: "https://stse-test.i9complete.com" },
      capture: { width: 1440 },
      daemon: { idleRepollMs: 20_000 },
    });
  });

  it("fail-loud WRITE: a non-http url override is rejected", () => {
    expect(() => writeOperatorSettings(root, { urls: { i9: "not-a-url" } })).toThrow();
  });
});
