import { test } from "vitest";
import assert from "node:assert/strict";
import {
  DEMO_ROWS,
  effectiveStatus,
  isTerminal,
  recordStream,
} from "../../../src/dashboard/components/dev/rebuild-demo/demo-data.js";

/**
 * DEV-ONLY (`?view=rebuild-demo`) — RECORDS ARRIVE ONE AT A TIME.
 *
 * The OCR review row carried a count and nothing else — `12 lookups` — which is
 * a summary that only means something once the extraction has finished. On a
 * fifteen-minute read that is fifteen minutes of a number nobody can act on.
 * The operator: *"the 12 should also appear like [a member list] as they get
 * read. so i can see in the queue panel as well in the ocr."*
 *
 * **This is a WIRE change, not a client animation.** The run reports each person
 * as it reads them — one record, one instant — and the surface renders what has
 * arrived. These tests pin the three properties that keep that honest:
 *
 *  1. a record is on screen only once its OWN instant has passed;
 *  2. the ones that have not arrived are a NUMBER, never a drawn placeholder —
 *     a page may turn out to carry nobody, and a row that already drew them
 *     would have to take one away;
 *  3. a run that is still reading must stamp EVERY record, so "unstamped" can
 *     never quietly come to mean "already read" on a live run.
 */

const READING = DEMO_ROWS["ocr-fall"];
const FINISHED = DEMO_ROWS["ocr-spring"];

test("a run that is still reading shows only the records it has actually reported", () => {
  assert.equal(effectiveStatus(READING), "running");
  const at0 = recordStream(READING, 0);
  assert.ok(at0.total > at0.read.length, "the mid-read fixture has reported everything — it proves nothing");
  assert.ok(at0.read.length > 0, "the mid-read fixture has reported nothing — the list would render empty");
  assert.equal(at0.streaming, true);

  // The read set is a PREFIX of the document, in the order the run read it —
  // records do not arrive out of order and none is skipped.
  const all = READING.records ?? [];
  assert.deepEqual(
    at0.read.map((r) => r.id),
    all.slice(0, at0.read.length).map((r) => r.id),
  );
});

test("the count fills in as the clock advances — nothing is predicted, nothing is animated", () => {
  const counts = [0, 60, 120, 200].map((tick) => recordStream(READING, tick).read.length);
  // Monotonic, and it genuinely grows: the reveal is driven by the served
  // per-record instants, so a surface that simply re-renders on the heartbeat
  // shows more people without ever guessing at one.
  for (let i = 1; i < counts.length; i += 1) {
    assert.ok(counts[i] >= counts[i - 1], `the read set shrank between ticks: ${counts.join(" → ")}`);
  }
  assert.ok(counts[counts.length - 1] > counts[0], `nothing arrived over 200s: ${counts.join(" → ")}`);

  // Far enough forward, everything has arrived and the row stops claiming to
  // be streaming.
  const done = recordStream(READING, 10_000);
  assert.equal(done.read.length, done.total);
  assert.equal(done.streaming, false);
});

test("a run that is no longer READING shows every record — terminal or parked at review", () => {
  // A finished run arrived whole: its record set is the answer, not a snapshot
  // of one, and a completed row must never render a partial list because the
  // demo clock happens to sit before an instant.
  assert.ok(isTerminal(effectiveStatus(FINISHED)));
  const done = recordStream(FINISHED, 0);
  assert.equal(done.read.length, done.total);
  assert.equal(done.total, (FINISHED.records ?? []).length);
  assert.equal(done.streaming, false);

  // …and the case that matters as much: `Waiting on you` is NON-terminal but
  // the reading is over — it is waiting on a human, not on a page. A partial
  // list there would claim the extraction is still going, which is the
  // opposite lie to the one the stream exists to fix.
  const gated = DEMO_ROWS["ocr-summer"];
  assert.equal(effectiveStatus(gated), "waiting");
  const atGate = recordStream(gated, 0);
  assert.equal(atGate.read.length, atGate.total);
  assert.equal(atGate.streaming, false);
});

test("a row with no records has no stream, rather than an empty one", () => {
  const plain = DEMO_ROWS["pl-daniel"];
  assert.equal(plain.records, undefined);
  assert.deepEqual(recordStream(plain, 0), { read: [], total: 0, streaming: false });
});

test("every record on a run that is still READING carries its own instant", () => {
  // The load-bearing guard. `readAt === undefined` means "arrived before this
  // view opened", which is true of every run that has finished reading and
  // would be a LIE on one that has not — an unstamped record on a reading run
  // renders as already-read the moment it is authored.
  for (const row of Object.values(DEMO_ROWS)) {
    if (!row.records || row.records.length === 0) continue;
    if (effectiveStatus(row) !== "running") continue;
    for (const rec of row.records) {
      assert.ok(
        rec.readAt !== undefined,
        `${row.id}/${rec.id} is on a ${effectiveStatus(row)} run with no readAt — it would render as already read`,
      );
      assert.doesNotThrow(
        () => {
          const ms = Date.parse(rec.readAt as string);
          assert.ok(Number.isFinite(ms), `${rec.readAt} is not parseable`);
        },
        `${row.id}/${rec.id} stores something that is not a demo instant: ${rec.readAt}`,
      );
    }
  }
});

test("the remainder is a NUMBER — the stream never invents a record", () => {
  const stream = recordStream(READING, 0);
  // Every record in `read` is one the fixture actually authored: the stream is
  // a filter, never a generator.
  const authored = new Set((READING.records ?? []).map((r) => r.id));
  for (const rec of stream.read) assert.ok(authored.has(rec.id), `${rec.id} was not on the document`);
  // …and the pending count is exactly what is missing, so the row's "N more
  // pages to read" cannot drift from the list above it.
  assert.equal(stream.total - stream.read.length, authored.size - stream.read.length);
});
