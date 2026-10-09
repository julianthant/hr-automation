import { test } from "vitest";
import assert from "node:assert/strict";
import { DEMO_ROWS } from "../../../src/dashboard/components/dev/rebuild-demo/demo-data.js";

/**
 * DEV-ONLY (`?view=rebuild-demo`) — A TOTAL MAY NOT CONTRADICT ITS PARTS.
 *
 * The operator, on the `oath-summer` packet: *"the total times summed doesnt
 * match."* The timeline printed `OCR extraction 2m 8s` + `Roster match 31s` +
 * `Your review 4m 40s` — 7m 19s of steps — under a header that read **6m 59s**.
 *
 * This is not a rounding complaint. It is the same defect the whole rebuild is
 * against, drawn in pixels: **one fact with two independent sources.** A run's
 * total is derived from its `startedAt`/`endedAt` instants; a step's duration is
 * authored on the step. Nothing held the two together, so a fixture could — and
 * did — claim a run finished in less time than the work it says it did.
 *
 * THE INVARIANT, and why it is an inequality rather than an equality:
 *
 *     Σ (step durations)  ≤  endedAt − startedAt
 *
 * A run's wall clock legitimately EXCEEDS the sum of its steps — a handoff
 * between two systems, a browser launch, a lease wait and a gate all pass time
 * that belongs to no step. What can never happen is the reverse: the parts
 * cannot outrun the whole. A surface that says they did is lying about a run,
 * and on a product that files real HR transactions the arithmetic on screen is
 * the cheapest thing there is to get right.
 *
 * It is asserted over EVERY fixture rather than the three that were wrong,
 * because the next fixture is written by someone who has not read this file.
 */

/** `"6m 59s"` / `"31s"` / `"1h 4m"` → seconds. Throws rather than guessing. */
function parseDuration(text: string): number {
  const m = /^(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?$/.exec(text.trim());
  // Fail loud: a duration this cannot read is a duration format the fixtures
  // have quietly changed, and silently returning 0 would make the whole guard
  // pass by accident — the exact "swallowed check" the codebase forbids.
  assert.ok(m && text.trim().length > 0, `unparseable duration: ${JSON.stringify(text)}`);
  const [, h, min, s] = m as RegExpExecArray;
  return Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
}

test("parseDuration reads every shape the fixtures print", () => {
  assert.equal(parseDuration("31s"), 31);
  assert.equal(parseDuration("6m 59s"), 419);
  assert.equal(parseDuration("2m"), 120);
  assert.equal(parseDuration("1h 4m"), 3840);
  assert.throws(() => parseDuration("about a minute"));
});

test("no run's step durations exceed the run's own total", () => {
  const offenders: string[] = [];

  for (const row of Object.values(DEMO_ROWS)) {
    // A run still in flight has no total to reconcile against — its steps are
    // still accumulating, and comparing them to a wall clock that has not
    // stopped would fail a run that is behaving perfectly.
    if (!row.duration) continue;
    const stepSum = row.steps.reduce((a, s) => a + (s.durationSec ?? 0), 0);
    if (stepSum === 0) continue;

    const total = parseDuration(row.duration);
    if (stepSum > total) {
      offenders.push(
        `${row.id}: steps sum to ${stepSum}s but the run reports ${total}s (${row.duration}) — over by ${stepSum - total}s`,
      );
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `a run's parts cannot outrun its whole:\n  ${offenders.join("\n  ")}`,
  );
});

test("every step duration is a non-negative finite number", () => {
  for (const row of Object.values(DEMO_ROWS)) {
    for (const step of row.steps) {
      if (step.durationSec === undefined) continue;
      assert.ok(
        Number.isFinite(step.durationSec) && step.durationSec >= 0,
        `${row.id} / ${step.label}: durationSec is ${step.durationSec}`,
      );
    }
  }
});
