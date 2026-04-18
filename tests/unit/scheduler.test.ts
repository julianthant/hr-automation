import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSchedule } from "../../src/scheduler.js";

// Helper: construct a local-time Date without worrying about UTC.
// Note: all assertions compare Date objects, so we work in local time.
function at(iso: string): Date {
  // ISO with explicit Z → UTC. For local-time anchoring we use a plain
  // constructor form that setHours() rolls against (the schedule spec is
  // explicitly documented as local).
  return new Date(iso);
}

describe("parseSchedule — daily", () => {
  it("returns today's HH:MM when it's still in the future", () => {
    const s = parseSchedule("daily 14:30");
    // Thu 2026-04-16 08:00:00 local
    const now = new Date(2026, 3, 16, 8, 0, 0, 0);
    const next = s.nextRunAfter(now);
    assert.equal(next.getFullYear(), 2026);
    assert.equal(next.getMonth(), 3); // April
    assert.equal(next.getDate(), 16);
    assert.equal(next.getHours(), 14);
    assert.equal(next.getMinutes(), 30);
    assert.equal(next.getSeconds(), 0);
  });

  it("rolls to tomorrow when today's slot already passed", () => {
    const s = parseSchedule("daily 07:00");
    // Thu 2026-04-16 09:00:00 local — 07:00 is gone
    const now = new Date(2026, 3, 16, 9, 0, 0, 0);
    const next = s.nextRunAfter(now);
    assert.equal(next.getDate(), 17);
    assert.equal(next.getHours(), 7);
    assert.equal(next.getMinutes(), 0);
  });

  it("rolls across month boundary", () => {
    const s = parseSchedule("daily 08:00");
    // Apr 30 14:00 local → next run May 1 08:00
    const now = new Date(2026, 3, 30, 14, 0, 0, 0);
    const next = s.nextRunAfter(now);
    assert.equal(next.getMonth(), 4); // May
    assert.equal(next.getDate(), 1);
    assert.equal(next.getHours(), 8);
  });

  it("rolls across year boundary", () => {
    const s = parseSchedule("daily 02:00");
    const now = new Date(2026, 11, 31, 23, 0, 0, 0);
    const next = s.nextRunAfter(now);
    assert.equal(next.getFullYear(), 2027);
    assert.equal(next.getMonth(), 0);
    assert.equal(next.getDate(), 1);
    assert.equal(next.getHours(), 2);
  });

  it("handles HH:MM exactly equal to now as 'already passed' (strict >)", () => {
    const s = parseSchedule("daily 08:00");
    // If it's exactly 08:00, the next run must be tomorrow — firing at the
    // same millisecond would cause a duplicate if the scheduler wakes late.
    const now = new Date(2026, 3, 16, 8, 0, 0, 0);
    const next = s.nextRunAfter(now);
    assert.equal(next.getDate(), 17);
  });
});

describe("parseSchedule — weekly", () => {
  it("returns the next Monday when scheduled Mon and today is Thu", () => {
    const s = parseSchedule("weekly mon 08:00");
    // Thu 2026-04-16
    const now = new Date(2026, 3, 16, 9, 0, 0, 0);
    const next = s.nextRunAfter(now);
    assert.equal(next.getDay(), 1); // Monday
    assert.equal(next.getHours(), 8);
    // 2026-04-20 is the following Monday
    assert.equal(next.getDate(), 20);
  });

  it("returns same-day when today is Monday and HH:MM is still upcoming", () => {
    const s = parseSchedule("weekly mon 17:00");
    // Mon 2026-04-20 10:00
    const now = new Date(2026, 3, 20, 10, 0, 0, 0);
    const next = s.nextRunAfter(now);
    assert.equal(next.getDate(), 20);
    assert.equal(next.getHours(), 17);
  });

  it("rolls to next Monday when today is Monday but HH:MM is past", () => {
    const s = parseSchedule("weekly mon 08:00");
    // Mon 2026-04-20 10:00 — past 08:00
    const now = new Date(2026, 3, 20, 10, 0, 0, 0);
    const next = s.nextRunAfter(now);
    assert.equal(next.getDate(), 27); // following Monday
    assert.equal(next.getDay(), 1);
  });

  it("accepts comma-separated day lists (mon,thu → earliest upcoming wins)", () => {
    const s = parseSchedule("weekly mon,thu 08:00");
    // Tue 2026-04-14 — next mon is 20, next thu is 16; thu wins.
    const now = new Date(2026, 3, 14, 10, 0, 0, 0);
    const next = s.nextRunAfter(now);
    assert.equal(next.getDate(), 16);
    assert.equal(next.getDay(), 4); // Thursday
  });

  it("dedupes duplicate days in the list", () => {
    const s = parseSchedule("weekly mon,mon 08:00");
    const now = new Date(2026, 3, 16, 9, 0, 0, 0);
    const next = s.nextRunAfter(now);
    assert.equal(next.getDay(), 1);
    assert.equal(next.getDate(), 20);
  });

  it("throws on unknown day-of-week", () => {
    assert.throws(
      () => parseSchedule("weekly funday 08:00"),
      /Unknown day-of-week/
    );
  });
});

describe("parseSchedule — interval", () => {
  it("adds N minutes for interval Nm", () => {
    const s = parseSchedule("interval 30m");
    const now = new Date(2026, 3, 16, 12, 0, 0, 0);
    const next = s.nextRunAfter(now);
    assert.equal(next.getTime() - now.getTime(), 30 * 60_000);
  });

  it("adds N hours for interval Nh", () => {
    const s = parseSchedule("interval 2h");
    const now = new Date(2026, 3, 16, 12, 0, 0, 0);
    const next = s.nextRunAfter(now);
    assert.equal(next.getTime() - now.getTime(), 2 * 3_600_000);
  });

  it("rejects non-positive N", () => {
    assert.throws(() => parseSchedule("interval 0m"), /positive/);
  });

  it("rejects bad unit", () => {
    assert.throws(
      () => parseSchedule("interval 30s"),
      /must look like '30m' or '2h'/
    );
  });
});

describe("parseSchedule — errors", () => {
  it("throws on empty spec", () => {
    assert.throws(() => parseSchedule(""), /empty/);
  });

  it("throws on unknown kind", () => {
    assert.throws(() => parseSchedule("hourly 12:00"), /Unknown schedule kind/);
  });

  it("throws on bad HH:MM", () => {
    assert.throws(() => parseSchedule("daily 25:00"), /Hours out of range/);
    assert.throws(() => parseSchedule("daily 08:99"), /Minutes out of range/);
    assert.throws(() => parseSchedule("daily 8am"), /Expected HH:MM/);
  });

  it("throws when daily has wrong arg count", () => {
    assert.throws(
      () => parseSchedule("daily 08:00 extra"),
      /expects 1 argument/
    );
  });

  it("throws when weekly has wrong arg count", () => {
    assert.throws(
      () => parseSchedule("weekly mon"),
      /expects 2 arguments/
    );
  });

  it("retains the spec for later display", () => {
    const s = parseSchedule("  daily 08:00  ");
    assert.equal(s.spec, "daily 08:00");
  });
});

describe("parseSchedule — DST safety (documented behavior)", () => {
  // We use setHours/getHours which are local-time aware. This test documents
  // that interval adds a fixed ms delta — across a DST boundary the wall
  // clock will appear to shift, which is acceptable for interval mode. The
  // daily/weekly modes use setHours so they always land on the declared
  // wall time regardless of DST.
  it("daily fires at declared wall time even across DST (uses setHours)", () => {
    const s = parseSchedule("daily 08:00");
    // Pick a date in late March (any year with DST). The important check is
    // simply that `getHours() === 8` regardless of any UTC offset change.
    const now = new Date(2026, 2, 7, 20, 0, 0, 0); // Mar 7 in DST-aware year
    const next = s.nextRunAfter(now);
    assert.equal(next.getHours(), 8);
    assert.equal(next.getMinutes(), 0);
  });
});
