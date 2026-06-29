/**
 * Unit tests for the pure operator-settings contract shared by the server and
 * the dashboard Settings page. The invariant that matters most: an empty
 * override is behavior-neutral (merge → defaults), and `diff` is a left inverse
 * of `merge` so the page persists ONLY operator-changed fields (a sparse
 * override keeps `config/settings.json` small and the env-population parity-safe).
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";

import {
  DEFAULT_OPERATOR_SETTINGS,
  cloneOperatorSettings,
  diffOperatorSettings,
  mergeOperatorSettings,
  type OperatorSettings,
  type OperatorSettingsOverride,
} from "../../../../src/domain/settings/types.js";

describe("mergeOperatorSettings", () => {
  test("null/empty override → the defaults (behavior-neutral)", () => {
    assert.deepEqual(mergeOperatorSettings(null), DEFAULT_OPERATOR_SETTINGS);
    assert.deepEqual(mergeOperatorSettings(undefined), DEFAULT_OPERATOR_SETTINGS);
    assert.deepEqual(mergeOperatorSettings({}), DEFAULT_OPERATOR_SETTINGS);
  });

  test("merges one field without disturbing the rest of its section", () => {
    const merged = mergeOperatorSettings({ display: { screenWidth: 3840 } });
    assert.equal(merged.display.screenWidth, 3840);
    // The unspecified field in the same section keeps its default.
    assert.equal(merged.display.screenHeight, DEFAULT_OPERATOR_SETTINGS.display.screenHeight);
    // Other sections are untouched.
    assert.deepEqual(merged.ocr, DEFAULT_OPERATOR_SETTINGS.ocr);
  });

  test("does not mutate DEFAULT_OPERATOR_SETTINGS", () => {
    const before = cloneOperatorSettings(DEFAULT_OPERATOR_SETTINGS);
    mergeOperatorSettings({ operator: { timekeeperName: "Jordan Lee" } });
    assert.deepEqual(DEFAULT_OPERATOR_SETTINGS, before);
  });
});

describe("diffOperatorSettings", () => {
  test("all-default settings → empty override", () => {
    assert.deepEqual(diffOperatorSettings(DEFAULT_OPERATOR_SETTINGS), {});
  });

  test("keeps only changed fields, drops sections with no diff", () => {
    const edited: OperatorSettings = {
      ...cloneOperatorSettings(DEFAULT_OPERATOR_SETTINGS),
      display: { screenWidth: 1920, screenHeight: DEFAULT_OPERATOR_SETTINGS.display.screenHeight },
      operator: { timekeeperName: "Jordan Lee" },
    };
    const diff = diffOperatorSettings(edited);
    assert.deepEqual(diff, {
      display: { screenWidth: 1920 },
      operator: { timekeeperName: "Jordan Lee" },
    });
    // Sections with no change are absent, not present-and-empty.
    assert.equal("ocr" in diff, false);
    assert.equal("timeouts" in diff, false);
  });

  test("merge ∘ diff round-trips to the original settings", () => {
    const edited: OperatorSettings = cloneOperatorSettings(DEFAULT_OPERATOR_SETTINGS);
    edited.ocr.pageConcurrency = 8;
    edited.features.debugScreenshots = true;
    edited.annualDates.jobEndDate = "06/30/2027";
    edited.paths.reportsDir = "/data/reports";
    const override: OperatorSettingsOverride = diffOperatorSettings(edited);
    assert.deepEqual(mergeOperatorSettings(override), edited);
  });
});
