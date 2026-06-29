/**
 * Unit tests for the notification model behind the NotificationBell — the
 * single structure every inbox-worthy dashboard event follows (`notify()` →
 * store + toast). These pin the pure seam: dedupe-on-record, the live-store ⊕
 * `/api/failures`-backfill merge (live wins on a key collision so a failure
 * isn't double-carded), the unread timestamp watermark, the default
 * `<workflow>:<id>:<runId>:<kind>` dedupe key, and the kind→severity map.
 */

import { test, describe, beforeEach } from "vitest";
import assert from "node:assert/strict";

import {
  NOTIFY_KINDS,
  NOTIFICATION_CAP,
  mergeNotification,
  mergeNotificationLists,
  countUnread,
  defaultDedupeKey,
  severityForKind,
  recordNotification,
  getNotificationsSnapshot,
  __resetNotifications,
  type AppNotification,
} from "@/lib/notifications";

function mk(over: Partial<AppNotification> & { id: string; ts: number }): AppNotification {
  return {
    kind: NOTIFY_KINDS.runCompleted,
    severity: "success",
    title: over.title ?? `n-${over.id}`,
    ...over,
  };
}

describe("severityForKind", () => {
  test("maps known kinds to their default severity", () => {
    assert.equal(severityForKind(NOTIFY_KINDS.runCompleted), "success");
    assert.equal(severityForKind(NOTIFY_KINDS.runFailed), "error");
    assert.equal(severityForKind(NOTIFY_KINDS.runNotFound), "message");
    assert.equal(severityForKind(NOTIFY_KINDS.runCancelled), "warning");
    assert.equal(severityForKind(NOTIFY_KINDS.ocrAwaitingReview), "info");
  });

  test("an explicit override wins over the kind default", () => {
    assert.equal(severityForKind(NOTIFY_KINDS.runCompleted, "warning"), "warning");
  });

  test("an unknown kind falls back to info", () => {
    assert.equal(severityForKind("totally.unknown"), "info");
  });
});

describe("defaultDedupeKey", () => {
  test("composes <workflow>:<id>:<runId>:<kind>", () => {
    assert.equal(
      defaultDedupeKey(NOTIFY_KINDS.runFailed, { workflow: "onboarding", id: "abc", runId: "r1" }),
      "onboarding:abc:r1:run.failed",
    );
  });

  test("tolerates a missing runId", () => {
    assert.equal(
      defaultDedupeKey(NOTIFY_KINDS.runFailed, { workflow: "onboarding", id: "abc" }),
      "onboarding:abc::run.failed",
    );
  });

  test("is undefined without an entity ref (un-collapsible)", () => {
    assert.equal(defaultDedupeKey(NOTIFY_KINDS.captureCompleted), undefined);
  });
});

describe("mergeNotification", () => {
  test("prepends and keeps the list newest-first", () => {
    const list = [mk({ id: "a", ts: 100 })];
    const next = mergeNotification(list, mk({ id: "b", ts: 200 }));
    assert.deepEqual(
      next.map((n) => n.id),
      ["b", "a"],
    );
  });

  test("an out-of-order insert is sorted by ts, not append position", () => {
    const list = [mk({ id: "b", ts: 200 })];
    const next = mergeNotification(list, mk({ id: "a", ts: 100 }));
    assert.deepEqual(
      next.map((n) => n.id),
      ["b", "a"],
    );
  });

  test("a same-dedupeKey record replaces the prior one (no stacking)", () => {
    const list = [mk({ id: "old", ts: 100, dedupeKey: "k" })];
    const next = mergeNotification(list, mk({ id: "new", ts: 150, dedupeKey: "k" }));
    assert.equal(next.length, 1);
    assert.equal(next[0].id, "new");
  });

  test("records without a dedupeKey never collapse each other", () => {
    const list = [mk({ id: "a", ts: 100 })];
    const next = mergeNotification(list, mk({ id: "b", ts: 200 }));
    assert.equal(next.length, 2);
  });

  test("caps the list, dropping the oldest", () => {
    let list: AppNotification[] = [];
    for (let i = 0; i < NOTIFICATION_CAP + 5; i++) {
      list = mergeNotification(list, mk({ id: `n${i}`, ts: i }));
    }
    assert.equal(list.length, NOTIFICATION_CAP);
    // Newest-first, so the freshest survives and the oldest is gone.
    assert.equal(list[0].id, `n${NOTIFICATION_CAP + 4}`);
    assert.ok(!list.some((n) => n.id === "n0"));
  });
});

describe("mergeNotificationLists (live ⊕ backfill)", () => {
  test("dedupes by key with the primary (live) record winning", () => {
    const live = [mk({ id: "live", ts: 300, dedupeKey: "wf:x:r:run.failed" })];
    const backfill = [mk({ id: "backfill", ts: 100, dedupeKey: "wf:x:r:run.failed" })];
    const feed = mergeNotificationLists(live, backfill);
    assert.equal(feed.length, 1);
    assert.equal(feed[0].id, "live");
  });

  test("keeps both when keys differ, newest-first", () => {
    const live = [mk({ id: "live", ts: 300, dedupeKey: "a" })];
    const backfill = [mk({ id: "backfill", ts: 400, dedupeKey: "b" })];
    const feed = mergeNotificationLists(live, backfill);
    assert.deepEqual(
      feed.map((n) => n.id),
      ["backfill", "live"],
    );
  });

  test("a keyless record falls back to its id for dedupe (never dropped against others)", () => {
    const live = [mk({ id: "a", ts: 100 })];
    const backfill = [mk({ id: "b", ts: 200 })];
    const feed = mergeNotificationLists(live, backfill);
    assert.equal(feed.length, 2);
  });
});

describe("countUnread (timestamp watermark)", () => {
  test("counts only entries strictly newer than lastSeenAt", () => {
    const list = [mk({ id: "a", ts: 100 }), mk({ id: "b", ts: 200 }), mk({ id: "c", ts: 300 })];
    assert.equal(countUnread(list, 150), 2);
    assert.equal(countUnread(list, 0), 3);
    assert.equal(countUnread(list, 300), 0);
  });
});

describe("store (recordNotification / snapshot / reset)", () => {
  beforeEach(() => {
    __resetNotifications();
  });

  test("recorded notifications surface newest-first in the snapshot", () => {
    recordNotification(mk({ id: "a", ts: 100 }));
    recordNotification(mk({ id: "b", ts: 200 }));
    assert.deepEqual(
      getNotificationsSnapshot().map((n) => n.id),
      ["b", "a"],
    );
  });

  test("the snapshot identity changes on record (so useSyncExternalStore re-renders)", () => {
    const before = getNotificationsSnapshot();
    recordNotification(mk({ id: "a", ts: 100 }));
    assert.notEqual(getNotificationsSnapshot(), before);
  });

  test("recording the same dedupeKey collapses in the store", () => {
    recordNotification(mk({ id: "old", ts: 100, dedupeKey: "k" }));
    recordNotification(mk({ id: "new", ts: 150, dedupeKey: "k" }));
    const snap = getNotificationsSnapshot();
    assert.equal(snap.length, 1);
    assert.equal(snap[0].id, "new");
  });
});
