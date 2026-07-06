/**
 * Unit tests for the confidence -> tier/label pure mapping in
 * `src/dashboard/components/ocr/shared/match-confidence.ts`.
 *
 * This is the display half of the audit-verified defect: a low-confidence
 * LLM disambiguation (`applyDisambiguationStd` in
 * `src/services/ocr/forms/shared.ts`) is only ever "low confidence" below the
 * server's own `LLM_HIGH_CONFIDENCE` (0.6) cutoff — pin that boundary here so
 * the badge can never read "high" for a match the server itself flagged for
 * review.
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  formatMatchConfidencePercent,
  matchConfidenceBadgeClass,
  matchConfidenceTier,
  matchConfidenceTierLabel,
} from "../../../../src/dashboard/components/ocr/shared/match-confidence.js";

describe("matchConfidenceTier", () => {
  it("buckets >=0.6 as high (mirrors backend LLM_HIGH_CONFIDENCE)", () => {
    assert.equal(matchConfidenceTier(0.6), "high");
    assert.equal(matchConfidenceTier(0.85), "high");
    assert.equal(matchConfidenceTier(1), "high");
  });

  it("buckets 0.4-0.6 as medium", () => {
    assert.equal(matchConfidenceTier(0.4), "medium");
    assert.equal(matchConfidenceTier(0.5), "medium");
    assert.equal(matchConfidenceTier(0.59), "medium");
  });

  it("buckets <0.4 as low", () => {
    assert.equal(matchConfidenceTier(0.39), "low");
    assert.equal(matchConfidenceTier(0), "low");
  });

  it("treats a non-finite confidence as low, never high", () => {
    assert.equal(matchConfidenceTier(Number.NaN), "low");
    assert.equal(matchConfidenceTier(Number.POSITIVE_INFINITY), "low");
  });
});

describe("matchConfidenceBadgeClass", () => {
  it("maps each tier to a distinct toned class", () => {
    const classes = new Set([
      matchConfidenceBadgeClass("high"),
      matchConfidenceBadgeClass("medium"),
      matchConfidenceBadgeClass("low"),
    ]);
    assert.equal(classes.size, 3);
    assert.match(matchConfidenceBadgeClass("high"), /success/);
    assert.match(matchConfidenceBadgeClass("medium"), /warning/);
    assert.match(matchConfidenceBadgeClass("low"), /destructive/);
  });
});

describe("matchConfidenceTierLabel", () => {
  it("returns a lowercase label per tier", () => {
    assert.equal(matchConfidenceTierLabel("high"), "high");
    assert.equal(matchConfidenceTierLabel("medium"), "medium");
    assert.equal(matchConfidenceTierLabel("low"), "low");
  });
});

describe("formatMatchConfidencePercent", () => {
  it("formats a 0-1 confidence as a rounded percent", () => {
    assert.equal(formatMatchConfidencePercent(0.4), "40%");
    assert.equal(formatMatchConfidencePercent(0.415), "42%"); // 0.415*100=41.5 rounds to 42
    assert.equal(formatMatchConfidencePercent(1), "100%");
    assert.equal(formatMatchConfidencePercent(0), "0%");
  });

  it("clamps out-of-range or non-finite input instead of rendering garbage", () => {
    assert.equal(formatMatchConfidencePercent(-0.5), "0%");
    assert.equal(formatMatchConfidencePercent(1.5), "100%");
    assert.equal(formatMatchConfidencePercent(Number.NaN), "0%");
  });
});
