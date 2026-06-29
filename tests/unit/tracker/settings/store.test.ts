/**
 * Unit tests for the operator-settings store: the read/write/delete round-trip
 * (fail-soft on a bad file, fail-loud on an invalid write) and the env-population
 * core. The env contract is the load-bearing one: only operator-set fields are
 * populated, never over an already-set env var (explicit `.env` wins), and
 * OCR page concurrency `0` (Auto) is left unset so the dynamic pool-size default
 * survives.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { operatorSettingsFile } from "../../../../src/tracker/paths.js";
import {
  applyOperatorSettingsEnv,
  deleteOperatorSettings,
  readOperatorSettingsOverride,
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

  it("fail-soft READ: an unparseable file is ignored (null), not thrown", () => {
    writeFileSync(operatorSettingsFile(root), "{ not json", "utf8");
    expect(readOperatorSettingsOverride(root)).toBe(null);
  });

  it("fail-soft READ: a schema-invalid file is ignored (null)", () => {
    writeFileSync(operatorSettingsFile(root), JSON.stringify({ display: { screenWidth: -5 } }), "utf8");
    expect(readOperatorSettingsOverride(root)).toBe(null);
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
});
