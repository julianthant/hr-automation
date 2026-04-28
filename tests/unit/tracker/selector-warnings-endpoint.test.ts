import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { buildSelectorWarningsHandler } from "../../../src/tracker/dashboard.js";
import { dateLocal } from "../../../src/tracker/jsonl.js";

const TEST_DIR = ".tracker-selector-warnings-test";

function isoDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return dateLocal(d);
}

function writeLog(
  filename: string,
  entries: Array<{
    workflow: string;
    itemId: string;
    level: string;
    message: string;
    ts: string;
  }>,
): void {
  const path = join(TEST_DIR, filename);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function appendLog(
  filename: string,
  entry: { workflow: string; itemId: string; level: string; message: string; ts: string },
): void {
  appendFileSync(join(TEST_DIR, filename), JSON.stringify(entry) + "\n");
}

describe("buildSelectorWarningsHandler", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  it("returns [] when directory does not exist", () => {
    const missing = ".tracker-missing-" + Date.now();
    const handler = buildSelectorWarningsHandler(missing);
    assert.deepEqual(handler(7), []);
  });

  it("groups and counts `selector fallback triggered: <label>` warns", () => {
    const today = isoDate(0);
    writeLog(`onboarding-${today}-logs.jsonl`, [
      // Legacy (pre-timing) format — kept as a fixture to prove the regex is
      // backward-compatible with older JSONL files on disk.
      {
        workflow: "onboarding",
        itemId: "a",
        level: "warn",
        message: "selector fallback triggered: ucpath.jobData.compRateCodeInput",
        ts: new Date().toISOString(),
      },
      // New slow-success (warn) format emitted by safe.ts after Task 2.1.
      {
        workflow: "onboarding",
        itemId: "b",
        level: "warn",
        message:
          "selector fallback triggered: ucpath.jobData.compRateCodeInput (click took 3400ms — likely fallback-hit or page stall)",
        ts: new Date(Date.now() + 1000).toISOString(),
      },
      // New failure (error) format — shares the same anchor so it aggregates
      // under the same label. Exercises the warn/error OR branch in the
      // handler.
      {
        workflow: "onboarding",
        itemId: "c",
        level: "error",
        message:
          "selector fallback triggered: ucpath.personalData.ssnInput (fill failed after 10000ms — TimeoutError: locator.fill timed out)",
        ts: new Date(Date.now() + 2000).toISOString(),
      },
    ]);

    const handler = buildSelectorWarningsHandler(TEST_DIR);
    const rows = handler(7);
    assert.equal(rows.length, 2);
    // Sorted by count desc — compRateCodeInput (2: 1 legacy + 1 new-format)
    // aggregates under one label regardless of the timing suffix.
    assert.equal(rows[0].label, "ucpath.jobData.compRateCodeInput");
    assert.equal(rows[0].count, 2);
    assert.deepEqual(rows[0].workflows, ["onboarding"]);
    assert.equal(rows[1].label, "ucpath.personalData.ssnInput");
    assert.equal(rows[1].count, 1);
  });

  it("filters out non-warn levels and non-matching messages", () => {
    const today = isoDate(0);
    writeLog(`onboarding-${today}-logs.jsonl`, [
      {
        workflow: "onboarding",
        itemId: "a",
        level: "step",
        message: "selector fallback triggered: ucpath.x",
        ts: new Date().toISOString(),
      },
      {
        workflow: "onboarding",
        itemId: "b",
        level: "warn",
        message: "some other warning message — not a selector fallback",
        ts: new Date().toISOString(),
      },
      {
        workflow: "onboarding",
        itemId: "c",
        level: "warn",
        message: "selector fallback triggered: ucpath.y",
        ts: new Date().toISOString(),
      },
    ]);

    const handler = buildSelectorWarningsHandler(TEST_DIR);
    const rows = handler(7);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, "ucpath.y");
  });

  it("tracks workflows set across multiple source files", () => {
    const today = isoDate(0);
    writeLog(`onboarding-${today}-logs.jsonl`, [
      {
        workflow: "onboarding",
        itemId: "a",
        level: "warn",
        message: "selector fallback triggered: ucpath.shared.input",
        ts: new Date().toISOString(),
      },
    ]);
    writeLog(`separations-${today}-logs.jsonl`, [
      {
        workflow: "separations",
        itemId: "doc-1",
        level: "warn",
        message: "selector fallback triggered: ucpath.shared.input",
        ts: new Date(Date.now() + 1000).toISOString(),
      },
    ]);

    const handler = buildSelectorWarningsHandler(TEST_DIR);
    const rows = handler(7);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 2);
    assert.deepEqual(rows[0].workflows, ["onboarding", "separations"]);
  });

  it("honors the `days` argument — older files are excluded", () => {
    const today = isoDate(0);
    const tenDaysAgo = isoDate(10);
    writeLog(`onboarding-${today}-logs.jsonl`, [
      {
        workflow: "onboarding",
        itemId: "a",
        level: "warn",
        message: "selector fallback triggered: recent",
        ts: new Date().toISOString(),
      },
    ]);
    writeLog(`onboarding-${tenDaysAgo}-logs.jsonl`, [
      {
        workflow: "onboarding",
        itemId: "b",
        level: "warn",
        message: "selector fallback triggered: ancient",
        ts: new Date().toISOString(),
      },
    ]);

    const handler = buildSelectorWarningsHandler(TEST_DIR);
    const rows = handler(7);
    assert.equal(rows.length, 1, "only the file from inside the window is scanned");
    assert.equal(rows[0].label, "recent");
  });

  it("firstTs/lastTs reflect activity envelope", () => {
    const today = isoDate(0);
    const t1 = "2026-04-18T10:00:00.000Z";
    const t2 = "2026-04-18T11:00:00.000Z";
    const t3 = "2026-04-18T12:00:00.000Z";
    writeLog(`onboarding-${today}-logs.jsonl`, [
      {
        workflow: "onboarding",
        itemId: "a",
        level: "warn",
        message: "selector fallback triggered: envelope",
        ts: t2,
      },
    ]);
    appendLog(`onboarding-${today}-logs.jsonl`, {
      workflow: "onboarding",
      itemId: "b",
      level: "warn",
      message: "selector fallback triggered: envelope",
      ts: t1,
    });
    appendLog(`onboarding-${today}-logs.jsonl`, {
      workflow: "onboarding",
      itemId: "c",
      level: "warn",
      message: "selector fallback triggered: envelope",
      ts: t3,
    });

    const handler = buildSelectorWarningsHandler(TEST_DIR);
    const rows = handler(7);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].firstTs, t1);
    assert.equal(rows[0].lastTs, t3);
    assert.equal(rows[0].count, 3);
  });

  it("tolerates malformed JSON lines (skips them)", () => {
    const today = isoDate(0);
    const path = join(TEST_DIR, `onboarding-${today}-logs.jsonl`);
    writeFileSync(
      path,
      [
        JSON.stringify({
          workflow: "onboarding",
          itemId: "a",
          level: "warn",
          message: "selector fallback triggered: okay",
          ts: new Date().toISOString(),
        }),
        "not json",
        JSON.stringify({
          workflow: "onboarding",
          itemId: "b",
          level: "warn",
          message: "selector fallback triggered: okay",
          ts: new Date().toISOString(),
        }),
      ].join("\n") + "\n",
    );

    const handler = buildSelectorWarningsHandler(TEST_DIR);
    const rows = handler(7);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 2);
  });
});
