import assert from "node:assert/strict";
import { test } from "vitest";

import {
  DEMO_ENVIRONMENT_FACTS,
  DEMO_SETTINGS,
  SETTING_GROUPS,
  runPreflight,
  settingsInGroup,
  submitEnvironmentOverride,
  submitSettingChanges,
  type SettingEdit,
} from "@/components/dev/rebuild-demo/demo-settings-wire";

/**
 * The settings surface's pure seam.
 *
 * The bug these exist for: the page's Save submitted `dirty[0]` and then
 * cleared the whole draft, under a footer that said "3 unsaved changes". A save
 * is a transaction over EVERY dirty leaf and it answers about every one of
 * them — that is the property, and it is asserted here rather than trusted.
 */

const leaf = (key: string) => {
  const found = DEMO_SETTINGS.find((l) => l.key === key);
  assert.ok(found, `${key} is not a settings leaf`);
  return found;
};

const edit = (key: string, value: string): SettingEdit => ({ leaf: leaf(key), value });

// ---------------------------------------------------------------------------
// A save applies EVERY dirty edit
// ---------------------------------------------------------------------------

test("a save applies every dirty edit, not the first one", () => {
  const edits = [
    edit("display.defaultSort", "newest"),
    edit("performance.duoTimeoutSec", "240"),
    edit("paths.reportsDir", "~/Desktop/reports"),
  ];
  const result = submitSettingChanges(edits, "read-write");

  assert.equal(result.state, "applied");
  assert.equal(result.outcomes.length, 3, "a save over three leaves must answer about three leaves");
  assert.deepEqual(
    result.outcomes.map((o) => o.key),
    ["display.defaultSort", "performance.duoTimeoutSec", "paths.reportsDir"],
  );
  for (const outcome of result.outcomes) assert.equal(outcome.state, "applied");
  assert.match(result.headline, /3 changes/);
});

test("a refused leaf does not take the valid ones down with it, and says which was refused", () => {
  const result = submitSettingChanges(
    [edit("display.defaultSort", "newest"), edit("performance.ocrConcurrency", "99")],
    "read-write",
  );

  assert.equal(result.state, "applied");
  assert.equal(result.outcomes.filter((o) => o.state === "applied").length, 1);
  const refused = result.outcomes.find((o) => o.state === "refused");
  assert.ok(refused, "the out-of-bounds leaf must be refused");
  assert.equal(refused.key, "performance.ocrConcurrency");
  assert.equal(refused.code, "out-of-bounds");
  assert.match(result.headline, /Saved 1 of 2/);
});

test("every leaf refused means the whole save is rejected, with a quotable code", () => {
  const result = submitSettingChanges([edit("performance.ocrConcurrency", "not a number")], "read-write");
  assert.equal(result.state, "rejected");
  assert.equal(result.code, "not-a-number");
  assert.equal(result.outcomes.every((o) => o.state === "refused"), true);
});

test("read-only storage refuses the whole transaction — never part of it", () => {
  const edits = [edit("display.defaultSort", "newest"), edit("paths.reportsDir", "~/tmp")];
  const result = submitSettingChanges(edits, "read-only-degraded");

  assert.equal(result.state, "rejected");
  assert.equal(result.code, "storage-read-only");
  assert.equal(result.outcomes.length, 2);
  assert.equal(result.outcomes.some((o) => o.state === "applied"), false, "a degraded save may not apply anything");
});

test("an empty save is a no-op that says so, rather than a success claim", () => {
  const result = submitSettingChanges([], "read-write");
  assert.equal(result.state, "applied");
  assert.deepEqual(result.outcomes, []);
  assert.match(result.headline, /Nothing to save/);
});

// ---------------------------------------------------------------------------
// The reduction — what is left, and what is a fact instead
// ---------------------------------------------------------------------------

test("every remaining leaf is editable and belongs to a declared group", () => {
  const groups = new Set(SETTING_GROUPS.map((g) => g.key));
  for (const l of DEMO_SETTINGS) {
    assert.ok(groups.has(l.group), `${l.key} is in group "${l.group}", which is not declared`);
  }
  for (const group of SETTING_GROUPS) {
    assert.ok(settingsInGroup(group.key).length > 0, `${group.key} renders as an empty section`);
  }
});

test("the values the environment owns are facts, not settings", () => {
  const settingKeys = new Set(DEMO_SETTINGS.map((l) => l.key));
  for (const fact of DEMO_ENVIRONMENT_FACTS) {
    assert.equal(settingKeys.has(fact.key), false, `${fact.key} is both a fact and a setting`);
    assert.ok(fact.reason.length > 20, `${fact.key} does not say why it is not a setting`);
    assert.ok(fact.toChangeIt.length > 10, `${fact.key} does not say what would change it`);
  }
});

test("an environment-owned value refuses with a code that names the owner", () => {
  const navRetries = DEMO_ENVIRONMENT_FACTS.find((f) => f.key === "performance.navRetries");
  assert.ok(navRetries);
  const result = submitEnvironmentOverride(navRetries, "read-write");
  assert.equal(result.state, "rejected");
  assert.equal(result.code, "env-owns-this-value");
  assert.match(result.headline, /HRAUTO_NAV_RETRIES/);
});

// ---------------------------------------------------------------------------
// The hazard, and the bound that goes with it
// ---------------------------------------------------------------------------

test("the one hazardous setting carries a safe bound inside its accepted range", () => {
  const hazardous = DEMO_SETTINGS.filter((l) => l.hazard);
  assert.equal(hazardous.length, 1, "the hazard treatment is for the setting that can put wrong data in a record");
  const [ocr] = hazardous;
  assert.equal(ocr.key, "performance.ocrConcurrency");
  assert.ok(ocr.hazard);
  assert.equal(ocr.control.kind, "number");
  if (ocr.control.kind !== "number") return;
  assert.ok(
    ocr.hazard.safeMax > ocr.control.min && ocr.hazard.safeMax < ocr.control.max,
    "a safe bound equal to the max is a bound that never warns",
  );
  // The server refuses past the hard max, and permits (loudly) between the safe
  // bound and it — a hazard is a warning, not a second validator.
  assert.equal(submitSettingChanges([edit(ocr.key, "6")], "read-write").state, "applied");
  assert.equal(submitSettingChanges([edit(ocr.key, "9")], "read-write").state, "rejected");
});

// ---------------------------------------------------------------------------
// The doctor is a command with an answer
// ---------------------------------------------------------------------------

test("re-running the doctor restamps every check with the new clock", () => {
  const checks = runPreflight("3:02 PM");
  assert.ok(checks.length > 0);
  for (const check of checks) assert.equal(check.checkedAt, "3:02 PM");
});
