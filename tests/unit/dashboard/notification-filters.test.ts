/**
 * Unit tests for the pure notification-center filter logic. The bell header
 * renders an adaptive chip set (All · Errors · per-category) and narrows the
 * feed in place — same model as the screenshot gallery. The contracts that
 * matter: the chip set adapts to what's present, errors keep a dedicated
 * cross-category chip, categories are derived from the `domain.event` kind (so a
 * future kind needs no code change), and an unknown filter id degrades to "All"
 * rather than an empty center.
 */

import { test, describe } from "vitest";
import assert from "node:assert/strict";

import type { AppNotification } from "../../../src/dashboard/lib/notifications.js";
import {
  ALL_FILTER,
  ERRORS_FILTER,
  buildNotificationFilters,
  categoryFilterId,
  categoryForNotification,
  categoryLabel,
  filterNotifications,
} from "../../../src/dashboard/components/navigation/notification-filters.js";

function n(kind: string, severity: AppNotification["severity"], id: string): AppNotification {
  return { id, kind, severity, title: id, ts: 1 };
}

const feed: AppNotification[] = [
  n("run.completed", "success", "a"),
  n("run.failed", "error", "b"),
  n("ocr.awaiting_review", "info", "c"),
  n("capture.failed", "error", "d"),
  n("capture.photo_added", "info", "e"),
];

describe("categoryForNotification / categoryLabel", () => {
  test("derives the domain half of the kind", () => {
    assert.equal(categoryForNotification(n("run.failed", "error", "x")), "run");
    assert.equal(categoryForNotification(n("ocr.awaiting_review", "info", "x")), "ocr");
    // A future bare kind (no dot) is its own category.
    assert.equal(categoryForNotification(n("system", "message", "x")), "system");
  });

  test("labels known domains, capitalizes unknown ones", () => {
    assert.equal(categoryLabel("run"), "Runs");
    assert.equal(categoryLabel("ocr"), "OCR");
    assert.equal(categoryLabel("capture"), "Capture");
    assert.equal(categoryLabel("billing"), "Billing");
  });
});

describe("buildNotificationFilters", () => {
  test("All first (with total), then Errors, then categories by count desc", () => {
    const chips = buildNotificationFilters(feed);
    assert.equal(chips[0]!.id, ALL_FILTER);
    assert.equal(chips[0]!.count, 5);
    assert.equal(chips[1]!.id, ERRORS_FILTER);
    assert.equal(chips[1]!.count, 2);
    assert.equal(chips[1]!.tone, "error");
    // capture(2) and run(2) tie → alpha (capture before run); ocr(1) last.
    const catIds = chips.slice(2).map((c) => c.id);
    assert.deepEqual(catIds, [
      categoryFilterId("capture"),
      categoryFilterId("run"),
      categoryFilterId("ocr"),
    ]);
  });

  test("omits the Errors chip when no error notification exists", () => {
    const chips = buildNotificationFilters([n("run.completed", "success", "a")]);
    assert.equal(chips.some((c) => c.id === ERRORS_FILTER), false);
    // A single-category feed yields All + that one category.
    assert.equal(chips.length, 2);
  });

  test("empty feed → just All (count 0)", () => {
    const chips = buildNotificationFilters([]);
    assert.equal(chips.length, 1);
    assert.equal(chips[0]!.id, ALL_FILTER);
    assert.equal(chips[0]!.count, 0);
  });
});

describe("filterNotifications", () => {
  test("Errors → only error-severity entries", () => {
    const ids = filterNotifications(feed, ERRORS_FILTER).map((x) => x.id);
    assert.deepEqual(ids.sort(), ["b", "d"]);
  });

  test("a category id → only that domain", () => {
    const ids = filterNotifications(feed, categoryFilterId("capture")).map((x) => x.id);
    assert.deepEqual(ids.sort(), ["d", "e"]);
  });

  test("All and an unknown/vanished id both fall back to the full list", () => {
    assert.equal(filterNotifications(feed, ALL_FILTER).length, 5);
    assert.equal(filterNotifications(feed, categoryFilterId("gone")).length, 0); // category present-but-empty
    assert.equal(filterNotifications(feed, "totally-unknown").length, 5); // non-category unknown → All
  });
});
