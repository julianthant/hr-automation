import { test } from "vitest";
import assert from "node:assert/strict";
import {
  batchQueueTitle,
  queueTitleData,
  readQueueTitle,
  rootQueueTitleData,
} from "../../../src/domain/queue-title.js";

test("batchQueueTitle formats label plus last 4 run id characters", () => {
  assert.equal(batchQueueTitle("Oath", "1234567890ab"), "Oath · #90ab");
  assert.equal(batchQueueTitle("Emergency Contact", "run-3456"), "Emergency Contact · #3456");
});

test("queueTitleData stamps title and kind", () => {
  assert.deepEqual(queueTitleData({ kind: "single", title: "Doe, Jane" }), {
    __queueTitle: "Doe, Jane",
    __queueTitleKind: "single",
  });
  assert.deepEqual(queueTitleData({ kind: "batch", title: "  Emergency Contact · #3456  " }), {
    __queueTitle: "Emergency Contact · #3456",
    __queueTitleKind: "batch",
  });
  assert.deepEqual(queueTitleData({ kind: "single", title: "   " }), {});
  assert.deepEqual(queueTitleData(undefined), {});
});

test("rootQueueTitleData preserves the inherited root title", () => {
  assert.deepEqual(rootQueueTitleData("Oath · #90ab"), {
    __queueTitle: "Oath · #90ab",
    __queueTitleKind: "delegation",
    __queueRootTitle: "Oath · #90ab",
    parentSubject: "Oath · #90ab",
  });
  assert.deepEqual(rootQueueTitleData("   "), {});
  assert.deepEqual(rootQueueTitleData(undefined), {});
});

test("readQueueTitle prefers root title over local title", () => {
  assert.equal(readQueueTitle({ __queueRootTitle: "  Oath · #90ab  ", __queueTitle: "Doe, Jane" }), "Oath · #90ab");
  assert.equal(readQueueTitle({ __queueTitle: "Doe, Jane" }), "Doe, Jane");
  assert.equal(readQueueTitle({ __queueRootTitle: "   ", __queueTitle: "  Doe, Jane  " }), "Doe, Jane");
  assert.equal(readQueueTitle({}), undefined);
  assert.equal(readQueueTitle(undefined), undefined);
});
